#!/usr/bin/env python3
"""Render with this checkout's CLI, then replace one verified store image set.

Requires Node 20.12+, the root and CLI npm dependencies, and a local editor
build in out/ or a running editor passed with --editor-url.
"""
import argparse
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
import uuid

REPO = Path(__file__).resolve().parent.parent
DEFAULTS = Path(__file__).with_name("taiga-defaults.json")
TARGETS = {
    "apple": {
        "iphone": ("ios", 1206, 2622),
        "ipad": ("ipad-pro-13", 2064, 2752),
    },
    "google-play": {
        "android": ("android", 1080, 1920),
        "phone": ("android", 1080, 1920),
        "tablet-7": ("tablet-7", 1080, 1920),
        "tablet-10": ("tablet-10", 1440, 2560),
    },
}


def run(cmd, cwd=None, env=None, as_json=False):
    print("+", " ".join(map(str, cmd)), file=sys.stderr)
    result = subprocess.run(cmd, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE if as_json else None, check=False)
    if result.returncode:
        raise RuntimeError(f"Command exited {result.returncode}: {' '.join(map(str, cmd))}")
    if as_json:
        try:
            return json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise RuntimeError("The CLI returned no JSON result") from error
    return None


def path_segment(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise argparse.ArgumentTypeError("Use letters, numbers, dots, underscores or hyphens")
    return value


def local_editor(value):
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise argparse.ArgumentTypeError("Use a local editor URL, such as http://127.0.0.1:9002")
    if parsed.username or parsed.password:
        raise argparse.ArgumentTypeError("The editor URL must not contain credentials")
    return value.rstrip("/")


def project_languages(project):
    for board in project.get("projectData", []):
        localization = board.get("localization")
        if localization:
            return list(dict.fromkeys([localization["baseLocale"]] +
                                      [entry["code"] for entry in localization.get("locales", [])]))
    return []


def read_rendered(rendered, out_dir, locales, board_count, dimensions, available_locales=None):
    if rendered.get("command") != "render" or Path(rendered.get("outDir", "")).resolve() != out_dir.resolve():
        raise RuntimeError("The render manifest does not name this run's output directory")
    entries = rendered.get("files", [])
    if rendered.get("locales") is not None and set(rendered["locales"]) != set(locales):
        raise RuntimeError("The render manifest has different languages from this run")
    if len(entries) != board_count * len(locales):
        raise RuntimeError("The render manifest does not contain one image per artboard and language")
    files = []
    names = set()
    language_counts = Counter()
    for entry in entries:
        name = entry.get("filename", "")
        source = Path(entry.get("path", "")).resolve()
        if not name or Path(name).name != name or "\\" in name or not name.lower().endswith(".png"):
            raise RuntimeError(f"The render manifest contains an invalid PNG name: {name}")
        if name.casefold() in names:
            raise RuntimeError(f"Two rendered images have the same filename: {name}")
        names.add(name.casefold())
        if not source.is_relative_to(out_dir.resolve()) or not source.is_file() or source.name != name:
            raise RuntimeError(f"The rendered image is outside this run's output: {name}")
        data = source.read_bytes()
        if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
            raise RuntimeError(f"The rendered image is not a PNG: {name}")
        if struct.unpack(">II", data[16:24]) != dimensions:
            raise RuntimeError(f"The rendered image has the wrong size for this device: {name}")
        language = next((code for code in (available_locales or locales) if name.startswith(code + "_")), None)
        if language is None and len(locales) == 1:
            language = locales[0]
        if language not in locales:
            raise RuntimeError(f"The rendered image has no requested language: {name}")
        language_counts[language] += 1
        files.append((source, {"file": name, "locale": language, "bytes": len(data),
                               "sha256": hashlib.sha256(data).hexdigest()}))
    if any(language_counts[code] != board_count for code in locales):
        raise RuntimeError("The render manifest has an incomplete language set")
    return files


@contextmanager
def pack_lock(pack_dir):
    pack_dir.parent.mkdir(parents=True, exist_ok=True)
    lock = pack_dir.parent / f".{pack_dir.name}.osg-lock"
    try:
        lock.mkdir()
    except FileExistsError as error:
        raise RuntimeError(f"Another pack run holds {lock}; remove this folder only if that run has stopped") from error
    try:
        yield
    finally:
        lock.rmdir()


def replace_directory(staged, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise RuntimeError(f"The image destination is not a regular directory: {destination}")
    backup = destination.with_name(f".{destination.name}.osg-backup-{uuid.uuid4().hex}")
    had_output = destination.exists()
    try:
        if had_output:
            destination.rename(backup)
        staged.rename(destination)
    except BaseException:
        if backup.exists() and not destination.exists():
            try:
                backup.rename(destination)
            except OSError as error:
                raise RuntimeError(f"Could not restore the image directory; previous images remain at {backup}") from error
        raise
    if had_output:
        try:
            shutil.rmtree(backup)
        except OSError:
            print(f"Verified images were placed; previous images remain at {backup}", file=sys.stderr)


@contextmanager
def checkout_cli(env):
    with pack_lock(REPO / "cli" / "build"):
        run(["node", str(REPO / "cli" / "scripts" / "build.mjs")], cwd=REPO, env=env)
        with tempfile.NamedTemporaryFile(prefix="pack-", suffix=".js", dir=REPO / "cli" / "dist", delete=False) as snapshot:
            snapshot.write((REPO / "cli" / "dist" / "cli.js").read_bytes())
            cli = Path(snapshot.name)
    try:
        yield cli
    finally:
        cli.unlink(missing_ok=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--app-slug", required=True, type=path_segment)
    ap.add_argument("--version", required=True, type=path_segment)
    ap.add_argument("--shots", required=True, help="folder with the app's screenshots in filename order")
    ap.add_argument("--store", default="apple", choices=TARGETS)
    ap.add_argument("--device", help="iphone or ipad for Apple; android, tablet-7 or tablet-10 for Play")
    ap.add_argument("--template", help="Taiga template id or JSON filename")
    ap.add_argument("--locales", help="comma-separated project languages; defaults to ja,en-US")
    ap.add_argument("--pack-root", help="override the store pack root in taiga-defaults.json")
    ap.add_argument("--editor-url", type=local_editor, help="running local editor from this checkout")
    ap.add_argument("--browser", help="Chrome, Edge or Chromium executable")
    ap.add_argument("--validate", action="store_true", help="also run the configured store_listing_pack validator")
    args = ap.parse_args(argv)

    defaults = json.loads(DEFAULTS.read_text())
    device = args.device or ("iphone" if args.store == "apple" else "android")
    if device not in TARGETS[args.store]:
        ap.error(f"Unknown device {device} for {args.store}; choose {', '.join(TARGETS[args.store])}")
    format_id, width, height = TARGETS[args.store][device]
    store = "appstore" if args.store == "apple" else "play"
    template = re.sub(r"\.json$", "", args.template or defaults["defaultTemplate"], flags=re.I)
    template = template.removeprefix("template_")
    template_file = REPO / "public" / "data" / "projects" / f"{template}.json"
    if template_file.parent != REPO / "public" / "data" / "projects" or not template_file.is_file():
        ap.error(f"No local template {template}")
    template_bytes = template_file.read_bytes()
    locales = list(dict.fromkeys(code.strip() for code in args.locales.split(",") if code.strip())) if args.locales else [defaults["baseLocale"], *defaults["additionalLocales"]]
    if not locales:
        ap.error("Choose at least one language")
    shots = Path(args.shots).expanduser().resolve()
    if not shots.is_dir():
        ap.error(f"No screenshot folder at {shots}")
    editor_dir = REPO / "out"
    if not args.editor_url and not ((editor_dir / "index.html").is_file() and (editor_dir / "_next").is_dir()):
        ap.error("Build this checkout's editor with npm run build, or pass --editor-url for its local dev server")
    validator = Path(defaults["storePack"]["validator"]).expanduser()
    if args.validate and not validator.is_file():
        ap.error(f"No pack validator at {validator}")
    pack_root = Path(args.pack_root or defaults["storePack"]["root"]).expanduser().resolve()
    pack_dir = pack_root / args.app_slug / args.version
    relative_images = Path("02_images") / "screenshots" / args.store / device

    env = {**os.environ, "OSG_EDITOR_DIR": str(editor_dir)}
    env.pop("OSG_EDITOR_URL", None)
    env.pop("OSG_CONFIG", None)
    with checkout_cli(env) as cli, tempfile.TemporaryDirectory(prefix="osg-pack-work-") as work_name:
        work = Path(work_name)
        out_dir = work / "out"
        catalog = work / "templates"
        catalog.mkdir()
        (catalog / template_file.name).write_bytes(template_bytes)
        config = {"name": args.app_slug, "project": str(work / "project.json"), "out": str(out_dir),
                  "screenshots": str(shots), "template": template,
                  "templatesDir": str(catalog), "store": store, "formats": [format_id],
                  "locales": locales, "baseLocale": defaults["baseLocale"],
                  "assetsBaseUrl": args.editor_url or "http://127.0.0.1"}
        if args.editor_url:
            config["editorUrl"] = args.editor_url
        if args.browser:
            config["browser"] = args.browser
        config_file = work / "osg.config.json"
        config_file.write_text(json.dumps(config, indent=2) + "\n")
        osg = ["node", str(cli)]
        common = ["--config", str(config_file), "--offline", "--json"]
        run(osg + ["fill", *common, "--format", format_id], cwd=work, env=env, as_json=True)
        project = json.loads((work / "project.json").read_text())
        available = project_languages(project)
        if any(code not in available for code in locales):
            raise RuntimeError(f"The template has languages {available}, but this run requested {locales}")
        rendered = run(osg + ["render", *common], cwd=work, env=env, as_json=True)
        files = read_rendered(rendered, out_dir, locales, len(project["projectData"]), (width, height), available)
        with pack_lock(pack_dir):
            with tempfile.TemporaryDirectory(prefix=".osg-stage-", dir=pack_dir.parent) as stage_name:
                stage_root = Path(stage_name)
                stage_pack = stage_root / args.version
                if args.validate and pack_dir.exists():
                    shutil.copytree(pack_dir, stage_pack)
                staged_images = stage_pack / relative_images
                if staged_images.exists():
                    shutil.rmtree(staged_images)
                staged_images.mkdir(parents=True)
                for source, entry in files:
                    shutil.copy2(source, staged_images / entry["file"])
                verified = run(osg + ["verify", str(staged_images), *common, "--store", store,
                                      "--locales", ",".join(locales), "--formats", format_id],
                               cwd=work, env=env, as_json=True)
                if not verified.get("ok"):
                    raise RuntimeError("The staged screenshots did not pass verification")
                verified["dir"] = str(pack_dir / relative_images)
                receipt = {"formatVersion": 1, "app": args.app_slug, "version": args.version,
                           "store": args.store, "device": device, "format": format_id,
                           "width": width, "height": height, "locales": locales,
                           "cliSha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
                           "template": template, "templateSha256": hashlib.sha256(template_bytes).hexdigest(),
                           "files": [entry for _, entry in files], "verify": verified}
                (staged_images / "osg.manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
                if args.validate:
                    run([sys.executable, str(validator), str(stage_pack)], cwd=work, env=env)
                replace_directory(staged_images, pack_dir / relative_images)
        print(f"Placed {len(files)} verified PNG(s) into {pack_dir / relative_images}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)

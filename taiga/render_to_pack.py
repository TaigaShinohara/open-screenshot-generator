#!/usr/bin/env python3
"""Render store screenshots with the Open Screenshot Generator CLI and place
them into a store_listing_pack folder structure.

Flow: osg fill -> osg render -> osg verify -> copy PNGs into
  ~/workspace/store-packs/<app-slug>/<version>/02_images/screenshots/<store>/<device>/
-> (optional) run the store_listing_pack validator.

The CLI itself is the published npm package (same code as this fork's cli/):
  npx open-screenshot-generator ...
Requires Node 20.12+ and Chrome, Edge or Chromium (the CLI doctor checks).

Usage:
  python3 taiga/render_to_pack.py --app-slug kikkake --version 1.5.0 \
      --shots ./shots --store apple --device iphone \
      [--template taiga-md3.json] [--validate]

Exit codes: 0 ok, 2 a step failed (the failing step is printed).
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

DEFAULTS = Path(__file__).with_name("taiga-defaults.json")


def run(cmd, cwd=None):
    print("+", " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd)
    if r.returncode != 0:
        print(f"FAILED ({r.returncode}): {' '.join(cmd)}", file=sys.stderr)
        sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-slug", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--shots", required=True, help="folder with the app's real screenshots, in order")
    ap.add_argument("--store", default="apple", choices=["apple", "google-play"])
    ap.add_argument("--device", default="iphone")
    ap.add_argument("--template", default=None, help="taiga-md3.json or taiga-glass.json")
    ap.add_argument("--validate", action="store_true", help="run store_listing_pack validate_pack.py at the end")
    args = ap.parse_args()

    defaults = json.loads(DEFAULTS.read_text())
    template = args.template or defaults["defaultTemplate"]
    pack_root = Path(defaults["storePack"]["root"]).expanduser()
    pack_dir = pack_root / args.app_slug / args.version
    out_dir = pack_dir / "02_images" / "screenshots" / args.store / args.device
    out_dir.mkdir(parents=True, exist_ok=True)

    work = Path.cwd() / ".osg-work" / args.app_slug
    work.mkdir(parents=True, exist_ok=True)

    osg = ["npx", "--yes", "open-screenshot-generator"]
    run(osg + ["doctor"], cwd=work)
    run(osg + ["init"], cwd=work)
    run(osg + ["fill", "--screenshots", str(Path(args.shots).resolve()), "--template", template], cwd=work)
    run(osg + ["render"], cwd=work)
    run(osg + ["verify"], cwd=work)

    rendered = sorted(work.rglob("*.png"))
    if not rendered:
        print("No PNGs were rendered; check the CLI output above.", file=sys.stderr)
        sys.exit(2)
    for png in rendered:
        shutil.copy2(png, out_dir / png.name)
    print(f"Placed {len(rendered)} PNG(s) into {out_dir}")

    if args.validate:
        validator = Path(defaults["storePack"]["validator"]).expanduser()
        if validator.exists():
            run([sys.executable, str(validator), str(pack_dir)])
        else:
            print(f"Validator not found, skipped: {validator}")


if __name__ == "__main__":
    main()

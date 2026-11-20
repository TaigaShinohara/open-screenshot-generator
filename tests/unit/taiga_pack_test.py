import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("taiga_pack", Path(__file__).resolve().parents[2] / "taiga/render_to_pack.py")
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)


def png(width=1206, height=2622):
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + bytes([8, 2, 0, 0, 0]) + bytes(4)


class PackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.shots = self.root / "shots"
        self.shots.mkdir()
        self.catalog = self.repo / "public/data/projects"
        self.catalog.mkdir(parents=True)
        (self.catalog / "taiga-md3.json").write_text("{}")
        (self.catalog / "taiga-glass.json").write_text("{}")
        cli = self.repo / "cli/dist/cli.js"
        cli.parent.mkdir(parents=True)
        cli.write_text("local CLI")
        self.defaults = self.root / "defaults.json"
        self.validator = self.root / "validate.py"
        self.validator.write_text("")
        self.defaults.write_text(json.dumps({"baseLocale": "ja", "additionalLocales": ["en-US"],
                                             "defaultTemplate": "taiga-md3.json",
                                             "storePack": {"root": str(self.root / "packs"), "validator": str(self.validator)}}))
        self.addCleanup(patch.stopall)
        patch.object(pack, "REPO", self.repo).start()
        patch.object(pack, "DEFAULTS", self.defaults).start()
        self.commands = []
        self.workdirs = []
        self.failure = None
        self.render_mode = None

    def fake_run(self, cmd, cwd=None, env=None, as_json=False):
        self.commands.append(cmd)
        if len(cmd) < 3 or cmd[2] not in ("fill", "render", "verify"):
            if self.failure == "validator" and cmd[0] != "node":
                raise RuntimeError("validator rejected staged pack")
            return None
        command = cmd[2]
        config = json.loads(Path(cmd[cmd.index("--config") + 1]).read_text())
        if command == self.failure:
            raise RuntimeError(f"{command} rejected")
        if command == "fill":
            self.workdirs.append(cwd)
            snapshot = Path(config["templatesDir"]) / f"{config['template']}.json"
            self.assertEqual(snapshot.read_bytes(), (self.catalog / snapshot.name).read_bytes())
            self.assertNotEqual(snapshot.parent, self.catalog)
            project = {"projectData": [{"localization": {"baseLocale": "ja", "locales": [{"code": "en-US"}]}}] * 2}
            Path(config["project"]).write_text(json.dumps(project))
            old = Path(cwd) / "z-old"
            old.mkdir()
            (old / "ja_01_Hero.png").write_bytes(b"old")
            return {"command": "fill"}
        if command == "render":
            output = Path(config["out"])
            output.mkdir()
            (output / "unlisted-old.png").write_bytes(b"old")
            dimensions = next(target[1:] for target in pack.TARGETS["apple" if config["store"] == "appstore" else "google-play"].values() if target[0] == config["formats"][0])
            files = []
            for language in config["locales"]:
                for index in range(1, 3):
                    name = f"{language}_{index:02}_Hero.png"
                    image = output / name
                    image.write_bytes(png(*dimensions))
                    files.append({"filename": name, "path": str(image), "bytes": image.stat().st_size})
            if self.render_mode == "duplicate":
                files[-1] = files[0]
            if self.render_mode == "wrong-language":
                wrong = output / "fr-FR_01_Hero.png"
                Path(files[-1]["path"]).rename(wrong)
                files[-1] = {"filename": wrong.name, "path": str(wrong)}
            return {"command": "render", "outDir": str(output), "locales": config["locales"], "files": files}
        self.assertEqual(cmd[cmd.index("--formats") + 1], config["formats"][0])
        self.assertEqual(cmd[cmd.index("--store") + 1], config["store"])
        self.assertEqual(len(list(Path(cmd[3]).glob("*.png"))), 4)
        return {"ok": True, "summary": {"files": 4}}

    def invoke(self, *extra):
        args = ["--app-slug", "example", "--version", "1.0", "--shots", str(self.shots),
                "--editor-url", "http://127.0.0.1:9002", *extra]
        with patch.object(pack, "run", self.fake_run):
            return pack.main(args)

    def output(self, version="1.0", store="apple", device="iphone"):
        return self.root / "packs/example" / version / "02_images/screenshots" / store / device

    def test_default_and_glass_use_only_manifest_files_and_allow_repeat_and_next_version(self):
        self.assertEqual(self.invoke(), 0)
        output = self.output()
        self.assertEqual(len(list(output.glob("*.png"))), 4)
        self.assertFalse((output / "unlisted-old.png").exists())
        (output / "stale.png").write_bytes(b"old")
        self.assertEqual(self.invoke("--template", "taiga-glass.json"), 0)
        self.assertFalse((output / "stale.png").exists())
        self.assertEqual(self.invoke("--version", "2.0"), 0)
        self.assertEqual(len(set(self.workdirs)), 3)
        self.assertTrue(self.output(version="2.0").is_dir())
        self.assertTrue(all(cmd[0] != "npx" for cmd in self.commands))
        receipt = json.loads((output / "osg.manifest.json").read_text())
        self.assertEqual(receipt["template"], "taiga-glass")
        self.assertEqual(receipt["locales"], ["ja", "en-US"])

    def test_store_and_device_select_generation_and_verification(self):
        self.assertEqual(self.invoke("--store", "google-play", "--device", "tablet-10"), 0)
        receipt = json.loads((self.output(store="google-play", device="tablet-10") / "osg.manifest.json").read_text())
        self.assertEqual((receipt["width"], receipt["height"]), (1440, 2560))
        self.assertEqual(receipt["format"], "tablet-10")
        with self.assertRaises(SystemExit):
            self.invoke("--device", "mystery")
        with self.assertRaises(SystemExit):
            self.invoke("--store", "google-play", "--device", "iphone")

    def test_render_verify_and_validator_failures_preserve_existing_output(self):
        self.invoke()
        original = {file.name: file.read_bytes() for file in self.output().iterdir()}
        for failure in ("render", "verify", "validator"):
            self.failure = failure
            with self.assertRaises(RuntimeError):
                self.invoke(*(["--validate"] if failure == "validator" else []))
            self.assertEqual({file.name: file.read_bytes() for file in self.output().iterdir()}, original)

    def test_duplicate_names_and_wrong_languages_never_replace_existing_output(self):
        self.invoke()
        original = (self.output() / "osg.manifest.json").read_bytes()
        for mode in ("duplicate", "wrong-language"):
            self.render_mode = mode
            with self.assertRaises(RuntimeError):
                self.invoke()
            self.assertEqual((self.output() / "osg.manifest.json").read_bytes(), original)

    def test_missing_validator_fails_before_render(self):
        self.validator.unlink()
        with self.assertRaises(SystemExit):
            self.invoke("--validate")
        self.assertEqual(self.commands, [])

    def test_lock_rejects_another_run_and_releases_after_failure(self):
        destination = self.root / "packs/example/1.0"
        with pack.pack_lock(destination):
            with self.assertRaises(RuntimeError):
                with pack.pack_lock(destination):
                    pass
        with self.assertRaises(RuntimeError):
            with pack.pack_lock(destination):
                raise RuntimeError("interrupted run")
        with pack.pack_lock(destination):
            pass

    def test_failed_directory_exchange_restores_previous_output(self):
        staged = self.root / "staged"
        output = self.root / "existing"
        staged.mkdir()
        output.mkdir()
        (output / "old.png").write_bytes(b"old")
        original_rename = Path.rename

        def failing_rename(source, destination):
            if source == staged:
                raise OSError("rename rejected")
            return original_rename(source, destination)

        with patch.object(Path, "rename", failing_rename), self.assertRaises(OSError):
            pack.replace_directory(staged, output)
        self.assertEqual((output / "old.png").read_bytes(), b"old")


if __name__ == "__main__":
    unittest.main()

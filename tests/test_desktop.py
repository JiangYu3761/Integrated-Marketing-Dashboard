import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.macos.local_server import PROJECT, SITE_FILES, create_server, read_site, site_version

spec = importlib.util.spec_from_file_location("installer", ROOT / "scripts/install_macos_app.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DesktopServerTests(unittest.TestCase):
    def setUp(self):
        self.server = create_server(ROOT, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)
        self.client = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path, method="GET"):
        return self.client.open(Request(self.base + path, method=method), timeout=5)

    def test_packaged_page_and_assets_are_served_with_correct_types(self):
        for name, mime in SITE_FILES.items():
            with self.subTest(name=name), self.request("/" if name == "index.html" else "/" + name) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], mime)
                self.assertEqual(response.read(), (ROOT / name).read_bytes())
                self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_health_identifies_current_project_version_and_process(self):
        with self.request("/_desktop/health") as response:
            health = json.load(response)
        self.assertEqual(health["project"], PROJECT)
        self.assertEqual(health["version"], site_version(read_site(ROOT)))
        import os
        self.assertEqual(health["pid"], os.getpid())

    def test_head_is_bodyless_with_real_content_length(self):
        with self.request("/src/app.js", method="HEAD") as response:
            self.assertEqual(int(response.headers["Content-Length"]), (ROOT / "src/app.js").stat().st_size)
            self.assertEqual(response.read(), b"")

    def test_non_application_files_and_traversal_are_not_served(self):
        for path in ["/.git/config", "/README.md", "/src/", "/../README.md", "/%2e%2e/README.md", "/src/../state.js", "/local_server.py"]:
            with self.subTest(path=path), self.assertRaises(HTTPError) as result:
                self.request(path)
            self.assertEqual(result.exception.code, 404)
            result.exception.close()

    def test_occupied_port_is_not_reused_or_replaced(self):
        with self.assertRaises(OSError):
            create_server(ROOT, self.server.server_port)
        with self.request("/_desktop/health") as response:
            self.assertEqual(json.load(response)["project"], PROJECT)

    def test_server_rejects_incomplete_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                create_server(Path(directory), 0)

    def test_fingerprint_changes_when_project_asset_changes(self):
        files = read_site(ROOT)
        original = site_version(files)
        files["src/app.js"] += b"\n// updated\n"
        self.assertNotEqual(site_version(files), original)

    def test_server_exits_if_app_parent_is_gone(self):
        result = subprocess.run([sys.executable, str(ROOT / "desktop/macos/local_server.py"),
                                 "--site", str(ROOT), "--port", "0", "--parent-pid", "0"],
                                timeout=10, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.destination = self.root / "产品经营地图.app"

    def bundle(self, path, identifier=None):
        (path / "Contents").mkdir(parents=True)
        (path / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier or installer.BUNDLE_ID,
        }))
        return path

    def test_packaging_copies_only_application_assets(self):
        site = self.root / "site"
        installer.copy_site(site)
        self.assertEqual({str(path.relative_to(site)) for path in site.rglob("*") if path.is_file()}, set(SITE_FILES))
        self.assertEqual(read_site(site), read_site(ROOT))

    def test_dock_entry_uses_encoded_application_url_and_stable_identity(self):
        tile = installer.dock_tile(self.destination)
        self.assertIn("%", tile["tile-data"]["file-data"]["_CFURLString"])
        preferences = {"persistent-apps": [tile]}
        self.assertTrue(installer.dock_contains(preferences, self.destination))
        self.assertFalse(installer.dock_contains({"persistent-apps": []}, self.destination))

    def test_dock_append_preserves_other_entries_and_is_idempotent(self):
        other = {"tile-data": {"bundle-identifier": "com.apple.finder"}}
        preferences = {"persistent-apps": [other], "orientation": "left"}
        exported = subprocess.CompletedProcess([], 0, stdout=plistlib.dumps(preferences))
        with patch.object(installer.subprocess, "run", return_value=exported) as run:
            installer.add_to_dock(self.destination)
            calls = run.call_args_list
            self.assertEqual(calls[1].args[0][:5], ["/usr/bin/defaults", "write", "com.apple.dock", "persistent-apps", "-array-add"])
            xml = b'<?xml version="1.0"?><plist version="1.0">' + calls[1].args[0][5].encode() + b'</plist>'
            self.assertEqual(plistlib.loads(xml), installer.dock_tile(self.destination))
        preferences["persistent-apps"].append(installer.dock_tile(self.destination))
        exported.stdout = plistlib.dumps(preferences)
        with patch.object(installer.subprocess, "run", return_value=exported) as run:
            installer.add_to_dock(self.destination)
            self.assertEqual(run.call_count, 1, "reinstall must not add duplicate Dock icons")

    def test_unreadable_dock_preferences_are_never_overwritten(self):
        with patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaises(RuntimeError):
                installer.add_to_dock(self.destination)
            self.assertEqual(run.call_count, 1)

    def test_install_replaces_only_our_bundle_and_preserves_external_data(self):
        self.bundle(self.destination)
        data = self.root / "WebKit-data"
        data.write_text("existing tasks")
        staged = self.bundle(self.root / "staged.app")
        (staged / "Contents/new-version").write_text("new")
        installer.replace_app(staged, self.destination)
        self.assertTrue((self.destination / "Contents/new-version").is_file())
        self.assertEqual(data.read_text(), "existing tasks")
        self.assertFalse(list(self.root.glob(".dashboard-backup-*")))

    def test_install_preserves_unrelated_application(self):
        self.bundle(self.destination, "another.application")
        staged = self.bundle(self.root / "staged.app")
        with self.assertRaises(RuntimeError):
            installer.replace_app(staged, self.destination)
        self.assertEqual(plistlib.loads((self.destination / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"], "another.application")
        self.assertTrue(staged.exists())

    def test_install_does_not_follow_destination_symlink(self):
        actual = self.bundle(self.root / "actual.app")
        self.destination.symlink_to(actual, target_is_directory=True)
        staged = self.bundle(self.root / "staged.app")
        with self.assertRaises(RuntimeError):
            installer.replace_app(staged, self.destination)
        self.assertTrue(actual.exists())

    def test_failed_replacement_restores_old_application(self):
        self.bundle(self.destination)
        (self.destination / "Contents/original").write_text("old")
        staged = self.bundle(self.root / "staged.app")
        rename = Path.rename

        def fail_new(path, target):
            if path == staged:
                raise OSError("simulated installation failure")
            return rename(path, target)

        with patch.object(Path, "rename", fail_new), self.assertRaises(OSError):
            installer.replace_app(staged, self.destination)
        self.assertEqual((self.destination / "Contents/original").read_text(), "old")

    def test_failed_rollback_keeps_recoverable_backup(self):
        self.bundle(self.destination)
        (self.destination / "Contents/original").write_text("old")
        staged = self.bundle(self.root / "staged.app")
        rename = Path.rename

        def fail_new_and_rollback(path, target):
            if path == staged or path.parent.name.startswith(".dashboard-backup-"):
                raise OSError("simulated filesystem failure")
            return rename(path, target)

        with patch.object(Path, "rename", fail_new_and_rollback), self.assertRaises(RuntimeError):
            installer.replace_app(staged, self.destination)
        backups = list(self.root.glob(".dashboard-backup-*/*/Contents/original"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "old")

    def test_failed_rollback_preserves_backup_when_destination_is_occupied(self):
        self.bundle(self.destination)
        (self.destination / "Contents/original").write_text("old")
        staged = self.bundle(self.root / "staged.app")
        rename = Path.rename

        def occupy_destination(path, target):
            if path == staged:
                self.bundle(self.destination, "different.application")
                raise OSError("destination was occupied during installation")
            return rename(path, target)

        with patch.object(Path, "rename", occupy_destination), self.assertRaises(RuntimeError):
            installer.replace_app(staged, self.destination)
        backups = list(self.root.glob(".dashboard-backup-*/*/Contents/original"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "old")
        self.assertEqual(plistlib.loads((self.destination / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"], "different.application")


if __name__ == "__main__":
    unittest.main()

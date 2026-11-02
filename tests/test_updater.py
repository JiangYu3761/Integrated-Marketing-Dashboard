import copy
import hashlib
import io
import json
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.macos import updater


def fixture_bundle(path, version="1.1.0"):
    resources = path / "Contents/Resources"
    resources.mkdir(parents=True)
    executable = path / "Contents/MacOS/Dashboard"
    executable.parent.mkdir()
    executable.write_bytes(b"native executable fixture")
    executable.chmod(0o755)
    (path / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": updater.BUNDLE_ID,
        "CFBundleShortVersionString": version,
        "DashboardArchitecture": "arm64",
    }))
    (resources / "site-version.txt").write_text("site-" + version)
    return path


def manifest_for(payload=b"archive", version="1.2.0"):
    return {
        "schema": 1, "project": updater.PROJECT, "bundle_id": updater.BUNDLE_ID,
        "version": version, "arch": "arm64", "minimum_os": "14.0.0",
        "url": updater.RELEASES + "/download/v" + version + "/MarketingDashboard-macOS-arm64.zip",
        "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload),
    }


class UpdateValidationTests(unittest.TestCase):
    def test_versions_compare_numerically_and_reject_invalid_versions(self):
        self.assertGreater(updater.version_tuple("1.10.0"), updater.version_tuple("1.9.9"))
        for value in ["latest", "1.1", "01.2.3", "1.2.3-beta", None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                updater.version_tuple(value)

    def test_release_identity_architecture_os_and_checksum_are_required(self):
        self.assertEqual(updater.validate_manifest(manifest_for(), "arm64", "15.0.0")["version"], "1.2.0")
        for key, value in [("project", "another/repo"), ("bundle_id", "other.app"), ("arch", "x86_64"),
                           ("url", "https://example.com/app.zip"), ("sha256", ""), ("size", 0),
                           ("minimum_os", "99.0.0")]:
            invalid = manifest_for()
            invalid[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                updater.validate_manifest(invalid, "arm64", "15.0.0")

    def test_only_trusted_https_redirect_destinations_are_allowed(self):
        for url in ["http://github.com/file", "https://evil.example/file", "https://github.com:8443/file", "https://user:secret@github.com/file"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                updater.trusted_url(url)
        self.assertEqual(updater.trusted_url("https://release-assets.githubusercontent.com/file"), "https://release-assets.githubusercontent.com/file")

    def test_bad_checksum_or_truncated_archive_is_deleted(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "download.zip"
            for payload in [b"changed", b"a"]:
                with self.subTest(payload=payload), self.assertRaises(ValueError):
                    updater.download_archive(manifest_for(), target, lambda _: io.BytesIO(payload))
                self.assertFalse(target.exists())
            updater.download_archive(manifest_for(), target, lambda _: io.BytesIO(b"archive"))
            self.assertEqual(target.read_bytes(), b"archive")

    def test_unsafe_or_unrelated_archive_paths_are_rejected(self):
        for name in ["../outside", "/absolute", "Other.app/Contents/file", updater.APP_NAME + "/../outside", "bad\\path"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                archive = Path(folder) / "app.zip"
                with zipfile.ZipFile(archive, "w") as source:
                    source.writestr(name, b"payload")
                with self.assertRaises(ValueError):
                    updater.extract_archive(archive, Path(folder) / "unpack")
                self.assertFalse((Path(folder) / "outside").exists())

    def test_archive_symlinks_and_unpacked_size_limit_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / "app.zip"
            with zipfile.ZipFile(archive, "w") as source:
                link = zipfile.ZipInfo(updater.APP_NAME + "/link")
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                source.writestr(link, "../../outside")
            with self.assertRaises(ValueError):
                updater.extract_archive(archive, Path(folder) / "unpack")
            with zipfile.ZipFile(archive, "w") as source:
                source.writestr(updater.APP_NAME + "/file", b"too large")
            with patch.object(updater, "MAX_UNPACKED", 2), self.assertRaises(ValueError):
                updater.extract_archive(archive, Path(folder) / "unpack")

    def test_bundle_verification_rejects_failed_signature(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = fixture_bundle(Path(folder) / updater.APP_NAME, "1.2.0")
            error = subprocess.CalledProcessError(1, ["codesign"])
            with patch.object(updater.subprocess, "run", side_effect=error), self.assertRaises(subprocess.CalledProcessError):
                updater.verify_bundle(bundle, manifest_for())


class UpdatePreparationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.application = fixture_bundle(self.root / updater.APP_NAME)
        self.state = self.root / "Updates"
        source = fixture_bundle(self.root / "release" / updater.APP_NAME, "1.2.0")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in source.rglob("*"):
                if path.is_file():
                    archive.write(path, str(path.relative_to(source.parent)))
        self.archive = buffer.getvalue()
        self.manifest = manifest_for(self.archive)
        self.fetched = []

    def opener(self, url):
        self.fetched.append(url)
        return io.BytesIO(self.archive if url.endswith(".zip") else json.dumps(self.manifest).encode())

    def verify(self, bundle, manifest):
        # macOS codesign/lipo are separately invoked by the production verifier
        # and release workflow; Linux fixtures exercise the update transaction.
        self.assertEqual(updater.bundle_info(bundle)["CFBundleShortVersionString"], manifest["version"])

    def prepare(self, manual=False):
        return updater.prepare_update(self.application, self.state, "arm64", "15.0.0", manual, self.opener, self.verify)

    def test_prepare_downloads_verified_bundle_without_modifying_installed_app(self):
        result = self.prepare()
        self.assertEqual(result["phase"], "ready")
        self.assertEqual(updater.bundle_info(self.application)["CFBundleShortVersionString"], "1.1.0")
        job = Path(result["job"])
        self.assertTrue((job / "apply-update.py").is_file())
        binary = job / "unpacked" / updater.APP_NAME / "Contents/MacOS/Dashboard"
        self.assertTrue(binary.stat().st_mode & 0o111)
        self.assertEqual(json.loads((job / "job.json").read_text())["target"], str(self.application.resolve()))

    def test_absent_release_is_reported_without_fake_success(self):
        def absent(url):
            raise HTTPError(url, 404, "Not Found", {}, None)
        result = updater.prepare_update(self.application, self.state, "arm64", "15.0.0", opener=absent)
        self.assertEqual(result["phase"], "unpublished")
        self.assertFalse(self.state.exists())

    def test_equal_or_older_versions_are_not_downloaded(self):
        for version in ["1.1.0", "1.0.9"]:
            self.manifest = manifest_for(self.archive, version)
            self.fetched.clear()
            self.assertEqual(self.prepare()["phase"], "current")
            self.assertEqual(len(self.fetched), 1)

    def test_checksum_failure_does_not_touch_current_app_or_keep_bad_stage(self):
        self.manifest["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(updater.bundle_info(self.application)["CFBundleShortVersionString"], "1.1.0")
        self.assertFalse(list(self.state.glob("update-*")))

    def test_failed_version_is_not_retried_automatically_but_manual_check_can_retry(self):
        self.state.mkdir()
        updater.atomic_json(self.state / "last-result.json", {"phase": "error", "failed_version": "1.2.0"})
        self.assertEqual(self.prepare()["phase"], "error")
        self.assertEqual(len(self.fetched), 1)
        self.assertEqual(self.prepare(manual=True)["phase"], "ready")

    def test_successful_install_reopens_new_app_and_preserves_external_user_data(self):
        data = self.root / "WebKit-user-data"
        data.write_text("existing task records")
        job = Path(self.prepare()["job"])
        launches, readiness = [], []
        updater.install_prepared(job, verifier=self.verify, launcher=lambda *args: launches.append(args),
                                 readiness=lambda version: readiness.append(version))
        self.assertEqual(updater.bundle_info(self.application)["CFBundleShortVersionString"], "1.2.0")
        self.assertEqual(readiness, ["site-1.2.0"])
        self.assertEqual(launches, [(self.application, job)])
        self.assertEqual(data.read_text(), "existing task records")
        self.assertEqual(json.loads((self.state / "last-result.json").read_text())["phase"], "installed")
        self.assertFalse(list(self.root.glob(".dashboard-update-*")))

    def test_failed_new_launch_restores_old_app_and_reopens_it(self):
        job = Path(self.prepare()["job"])
        launches, stopped = [], []
        def failure(_version):
            raise TimeoutError("new app failed startup")
        with self.assertRaises(RuntimeError):
            updater.install_prepared(job, verifier=self.verify, launcher=lambda *args: launches.append(args),
                                     readiness=failure, stopper=lambda *args: stopped.append(args))
        self.assertEqual(updater.bundle_info(self.application)["CFBundleShortVersionString"], "1.1.0")
        self.assertEqual(len(stopped), 1)
        self.assertEqual(launches[-1], (self.application,))
        self.assertEqual(json.loads((self.state / "last-result.json").read_text())["failed_version"], "1.2.0")

    def test_failed_rollback_keeps_backup_even_with_an_old_success_record(self):
        job = Path(self.prepare()["job"])
        updater.atomic_json(self.state / "last-result.json", {"phase": "installed", "version": "1.1.0"})
        rename = Path.rename
        def fail_restore(path, target):
            if path.name == "previous.app":
                raise OSError("rollback blocked")
            return rename(path, target)
        def failure(_version):
            raise TimeoutError("startup failed")
        with patch.object(Path, "rename", fail_restore), self.assertRaises(OSError):
            updater.install_prepared(job, verifier=self.verify, launcher=lambda *args: None,
                                     readiness=failure, stopper=lambda *args: None)
        backups = list(self.root.glob(".dashboard-update-*/previous.app"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(updater.bundle_info(backups[0])["CFBundleShortVersionString"], "1.1.0")

    def test_install_lock_prevents_concurrent_replacements(self):
        with updater.update_lock(self.state):
            with self.assertRaises(BlockingIOError):
                with updater.update_lock(self.state):
                    self.fail("second update acquired the installation lock")


if __name__ == "__main__":
    unittest.main()

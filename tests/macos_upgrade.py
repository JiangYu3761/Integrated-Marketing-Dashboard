"""Apply the release ZIP with the previous Mac client's updater and reopen its WebKit data."""

import argparse
import json
from pathlib import Path
import platform
import runpy
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def run_app(application, phase, directory):
    report = directory / (phase + ".json")
    subprocess.run(["/usr/bin/open", "-W", "-n", str(application), "--args",
                    "--smoke-report", str(report), "--smoke-phase", phase], check=True, timeout=90)
    result = json.loads(report.read_text())
    if result.get("phase") != phase or result.get("ok") is not True:
        raise RuntimeError(str(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-app", required=True, type=Path)
    args = parser.parse_args()
    baseline = args.baseline_app.resolve()
    previous = runpy.run_path(str(baseline / "Contents/Resources/updater.py"))
    release = ROOT / "outputs/release"
    arch = platform.machine()
    manifest_file = release / ("update-macos-" + arch + ".json")
    manifest = json.loads(manifest_file.read_text())
    archive = release / ("MarketingDashboard-macOS-" + arch + ".zip")

    # Exercise the old client's normal prepare/verification path using the two
    # release assets before they are available via GitHub's public URLs.
    sources = {
        previous["RELEASES"] + "/latest/download/" + manifest_file.name: manifest_file,
        manifest["url"]: archive,
    }
    with tempfile.TemporaryDirectory(prefix="dashboard-upgrade-") as temporary:
        directory = Path(temporary)
        application = directory / baseline.name
        shutil.copytree(baseline, application)
        run_app(application, "exercise", directory)
        previous["wait_for_port_close"]()
        os_version = (platform.mac_ver()[0].split(".") + ["0", "0"])[:3]
        result = previous["prepare_update"](
            application, directory / "updates", arch, ".".join(os_version),
            opener=lambda url: sources[url].open("rb"))
        if result.get("phase") != "ready":
            raise RuntimeError("Old client could not prepare this release: " + str(result))

        def launch_isolated(path, job=None):
            run_app(path, "restore-upgrade" if job else "restore", directory)
            previous["wait_for_port_close"]()

        def verify_restored_site(expected):
            # The native restore phase only runs after main.swift verifies the
            # live local service's PID and packaged site fingerprint.
            actual = (application / "Contents/Resources/site-version.txt").read_text().strip()
            if actual != expected or previous["bundle_info"](application)["CFBundleShortVersionString"] != manifest["version"]:
                raise RuntimeError("The relaunched site's build differs from the release package.")

        previous["install_prepared"](Path(result["job"]), launcher=launch_isolated, readiness=verify_restored_site)
    print("PASS: previous Mac client applied the signed release archive and retained task data and completion time.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Create an architecture-specific archive and matching GitHub update manifest."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.macos.updater import BUNDLE_ID, PROJECT, RELEASES, bundle_info, validate_manifest, verify_bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT / "outputs/macos/产品经营地图.app")
    parser.add_argument("--output", type=Path, default=ROOT / "outputs/release")
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    info = bundle_info(args.app)
    version, arch = info["CFBundleShortVersionString"], info["DashboardArchitecture"]
    if arch not in {"arm64", "x86_64"}:
        raise ValueError("发布架构必须为 arm64 或 x86_64。")
    if args.tag != "v" + version:
        raise ValueError("发布标签必须与 desktop/macos/version.json 中的版本一致。")
    verify_bundle(args.app, {"version": version, "arch": arch})
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / ("MarketingDashboard-macOS-" + arch + ".zip")
    subprocess.run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(args.app), str(archive)], check=True)
    manifest = {
        "schema": 1, "project": PROJECT, "bundle_id": BUNDLE_ID,
        "version": version, "arch": arch, "minimum_os": "14.0.0",
        "url": RELEASES + "/download/" + args.tag + "/" + archive.name,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "size": archive.stat().st_size,
    }
    validate_manifest(manifest, arch, "14.0.0")
    target = args.output / ("update-macos-" + arch + ".json")
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    print("已生成：" + archive.name + "、" + target.name)


if __name__ == "__main__":
    main()

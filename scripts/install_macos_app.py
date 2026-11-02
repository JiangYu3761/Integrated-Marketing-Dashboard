#!/usr/bin/env python3
"""Build and install this checkout as a native macOS Dock application."""

import argparse
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.macos.local_server import SITE_FILES, read_site, site_version
from desktop.macos.updater import version_tuple

APP_NAME = "产品经营地图"
BUNDLE_ID = "com.jiangyu3761.integrated-marketing-dashboard"


def copy_site(destination):
    for name in SITE_FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)


def dock_contains(preferences, application):
    uri = application.resolve().as_uri()
    for tile in preferences.get("persistent-apps", []):
        data = tile.get("tile-data", {})
        location = data.get("file-data", {}).get("_CFURLString", "").rstrip("/")
        if location == uri or data.get("bundle-identifier") == BUNDLE_ID:
            return True
    return False


def dock_tile(application):
    return {
        "tile-data": {
            "file-data": {"_CFURLString": application.resolve().as_uri() + "/", "_CFURLStringType": 15},
            "file-label": APP_NAME,
            "bundle-identifier": BUNDLE_ID,
            "file-type": 41,
        },
        "tile-type": "file-tile",
    }


def add_to_dock(application):
    result = subprocess.run(["/usr/bin/defaults", "export", "com.apple.dock", "-"], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError("无法读取现有 Dock 配置；请将应用手动拖入 Dock。")
    preferences = plistlib.loads(result.stdout)
    if dock_contains(preferences, application):
        return
    # Append only this app's tile; preserve every existing Dock entry/settings.
    tile = plistlib.dumps(dock_tile(application)).decode("utf-8")
    tile = tile[tile.index("<dict>"):tile.rindex("</dict>") + len("</dict>")]
    subprocess.run(["/usr/bin/defaults", "write", "com.apple.dock", "persistent-apps", "-array-add", tile], check=True)
    subprocess.run(["/usr/bin/killall", "Dock"], check=False, capture_output=True)


def replace_app(staged, destination):
    if destination.is_symlink():
        raise RuntimeError("安装路径是符号链接；请先移走该链接，再重新安装。")
    if destination.exists():
        info = destination / "Contents/Info.plist"
        if not info.is_file() or plistlib.loads(info.read_bytes()).get("CFBundleIdentifier") != BUNDLE_ID:
            raise RuntimeError("安装位置已有其他应用，已保留原文件。请先手动移走它。")
    # Keep a recoverable old bundle until the replacement succeeds. Application
    # data lives in WebKit's user data store, never inside either bundle.
    backup = Path(tempfile.mkdtemp(prefix=".dashboard-backup-", dir=destination.parent))
    previous = backup / destination.name
    installed = False
    try:
        if destination.exists():
            destination.rename(previous)
        try:
            staged.rename(destination)
            installed = True
        except BaseException:
            if previous.exists():
                try:
                    previous.rename(destination)
                except OSError as error:
                    raise RuntimeError("安装回滚失败，旧应用已保留在：" + str(previous)) from error
            raise
    finally:
        # If rollback itself fails, leave the recoverable old bundle on disk.
        if installed or not previous.exists():
            shutil.rmtree(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-only", action="store_true", help="仅生成 outputs/macos 下的 .app，不安装、不改 Dock、不打开窗口")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise RuntimeError("此安装器仅用于 macOS。请在 Mac 上双击“安装到Dock.command”。")
    if tuple(map(int, platform.mac_ver()[0].split(".")[:2])) < (14, 0):
        raise RuntimeError("应用需要 macOS 14 Sonoma 或更新版本，以支持网页现有的交互功能。")
    if sys.version_info < (3, 9):
        raise RuntimeError("需要 Python 3.9 或更新版本。")
    toolchain = subprocess.run(["/usr/bin/xcrun", "--find", "swiftc"], capture_output=True, text=True)
    if toolchain.returncode != 0:
        raise RuntimeError("尚未安装 Apple 命令行开发工具。请先在终端运行 xcode-select --install，完成后重新双击安装脚本。")
    sdk = subprocess.run(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], capture_output=True, text=True)
    if sdk.returncode != 0 or not Path(sdk.stdout.strip()).is_dir():
        raise RuntimeError("未找到 macOS SDK。请安装或更新 Apple 命令行开发工具后重试。")

    parent = ROOT / "outputs/macos" if args.build_only else Path.home() / "Applications"
    destination = parent / (APP_NAME + ".app")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".dashboard-build-", dir=destination.parent) as work:
        work = Path(work)
        bundle = work / destination.name
        contents = bundle / "Contents"
        resources = contents / "Resources"
        executable = contents / "MacOS" / "Dashboard"
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        copy_site(resources / "site")
        for name in ["local_server.py", "updater.py"]:
            shutil.copy2(ROOT / "desktop/macos" / name, resources / name)
        app_version = json.loads((ROOT / "desktop/macos/version.json").read_text())["version"]
        version_tuple(app_version)
        version = site_version(read_site(resources / "site"))
        (resources / "site-version.txt").write_text(version + "\n", encoding="utf-8")
        info = {
            "CFBundleName": APP_NAME, "CFBundleDisplayName": APP_NAME,
            "CFBundleIdentifier": BUNDLE_ID, "CFBundleExecutable": "Dashboard",
            "CFBundlePackageType": "APPL", "CFBundleShortVersionString": app_version,
            "CFBundleVersion": app_version, "CFBundleIconFile": "AppIcon",
            "LSMinimumSystemVersion": "14.0", "NSHighResolutionCapable": True,
            "NSPrincipalClass": "NSApplication",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
            "DashboardPython": sys.executable,
            "DashboardArchitecture": platform.machine(),
            "NSHumanReadableCopyright": "Integrated Marketing Dashboard",
        }
        (contents / "Info.plist").write_bytes(plistlib.dumps(info))
        print("正在编译独立应用窗口（首次可能需要几分钟）…", flush=True)
        subprocess.run([toolchain.stdout.strip(), "-O", "-target", platform.machine() + "-apple-macosx14.0", "-sdk", sdk.stdout.strip(),
                        "-framework", "Cocoa", "-framework", "WebKit",
                        str(ROOT / "desktop/macos/main.swift"), str(ROOT / "desktop/macos/AppUpdates.swift"),
                        str(ROOT / "desktop/macos/NativeSmoke.swift"), "-o", str(executable)], check=True)
        if not args.build_only and subprocess.run([str(executable), "--check-running"]).returncode != 0:
            raise RuntimeError("应用当前正在运行。请先按 ⌘Q 退出产品经营地图，再重新安装。原应用和数据未改动。")
        iconset = work / "AppIcon.iconset"
        iconset.mkdir()
        subprocess.run([str(executable), "--make-icon", str(iconset)], check=True)
        subprocess.run(["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(resources / "AppIcon.icns")], check=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(bundle)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(bundle)], check=True)
        replace_app(bundle, destination)

    if args.build_only:
        print("已生成应用（未安装或启动）：" + str(destination))
        return
    try:
        add_to_dock(destination)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print("应用已安装，Dock 图标未能自动添加：" + str(error))
        print("请在 Finder 中将以下应用拖入 Dock：" + str(destination))
        subprocess.run(["/usr/bin/open", "-R", str(destination)], check=False)
    subprocess.run(["/usr/bin/open", str(destination)], check=True)
    print("已安装并打开：" + str(destination))
    print("以后点击 Dock 图标即可打开；正式新版可在应用底部自动或手动检查安装。")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print("安装未完成：" + str(error), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Verified GitHub Release downloads and an out-of-process macOS app update."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import zipfile

PROJECT = "JiangYu3761/Integrated-Marketing-Dashboard"
BUNDLE_ID = "com.jiangyu3761.integrated-marketing-dashboard"
APP_NAME = "产品经营地图.app"
RELEASES = "https://github.com/" + PROJECT + "/releases"
TRUSTED_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_UNPACKED = 256 * 1024 * 1024


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("版本号格式无效。")
    return tuple(map(int, version.split(".")))


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def trusted_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in TRUSTED_HOSTS or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("更新地址不属于此项目的可信 HTTPS 下载来源。")
    return url


class ReleaseRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        trusted_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def fetch(url):
    request = Request(trusted_url(url), headers={"User-Agent": "IntegratedMarketingDashboard-Updater", "Cache-Control": "no-cache"})
    # Keep certificate verification and inherited proxy/CA configuration enabled.
    return build_opener(ReleaseRedirects()).open(request, timeout=30)


def validate_manifest(value, arch, os_version):
    if arch not in {"arm64", "x86_64"} or value.get("schema") != 1 or value.get("project") != PROJECT or value.get("bundle_id") != BUNDLE_ID or value.get("arch") != arch:
        raise ValueError("更新包的项目、格式或处理器架构不匹配。")
    version_tuple(value.get("version"))
    if version_tuple(value.get("minimum_os")) > version_tuple(os_version):
        raise ValueError("新版需要更新的 macOS；当前应用可继续使用。")
    expected_url = RELEASES + "/download/v" + value["version"] + "/MarketingDashboard-macOS-" + arch + ".zip"
    if value.get("url") != expected_url:
        raise ValueError("更新包不属于该版本的项目发布目录。")
    trusted_url(value["url"])
    if not re.fullmatch(r"[a-f0-9]{64}", value.get("sha256", "")):
        raise ValueError("更新包校验信息缺失。")
    if type(value.get("size")) is not int or not 0 < value["size"] <= MAX_ARCHIVE:
        raise ValueError("更新包大小无效。")
    return value


def download_archive(manifest, destination, opener=fetch):
    digest, size = hashlib.sha256(), 0
    try:
        with opener(manifest["url"]) as response, destination.open("xb") as output:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > manifest["size"] or size > MAX_ARCHIVE:
                    raise ValueError("更新包大小与发布记录不符。")
                digest.update(block)
                output.write(block)
        if size != manifest["size"] or digest.hexdigest() != manifest["sha256"]:
            raise ValueError("更新包 SHA-256 校验失败，未安装。")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def extract_archive(archive, destination):
    with zipfile.ZipFile(archive) as source:
        entries, total, names = source.infolist(), 0, set()
        if len(entries) > 4000:
            raise ValueError("更新包文件数量异常。")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or not path.parts:
                raise ValueError("更新包含有不安全路径。")
            if path.parts[0] == "__MACOSX":
                continue  # ditto resource-fork metadata, not executable content.
            if path.parts[0] != APP_NAME or entry.filename in names:
                raise ValueError("更新包包含重复文件或其他应用。")
            names.add(entry.filename)
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("更新包不允许符号链接或特殊文件。")
            total += entry.file_size
            if total > MAX_UNPACKED:
                raise ValueError("更新包解压大小异常。")
            target = destination.joinpath(*path.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as incoming, target.open("xb") as output:
                    shutil.copyfileobj(incoming, output)
                target.chmod(mode & 0o777 or 0o644)
    return destination / APP_NAME


def bundle_info(application):
    if application.is_symlink():
        raise ValueError("应用路径不能是符号链接。")
    info = plistlib.loads((application / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise ValueError("应用标识不匹配，未替换任何文件。")
    return info


def verify_bundle(application, manifest):
    info = bundle_info(application)
    if info.get("CFBundleShortVersionString") != manifest["version"] or info.get("DashboardArchitecture") != manifest["arch"]:
        raise ValueError("应用版本或架构与发布记录不一致。")
    binary = application / "Contents/MacOS/Dashboard"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError("更新包缺少可执行文件。")
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(application)], check=True, capture_output=True)
    architectures = subprocess.check_output(["/usr/bin/lipo", "-archs", str(binary)], text=True).split()
    if manifest["arch"] not in architectures:
        raise ValueError("更新包的二进制架构不匹配。")


def prepare_update(application, state, arch, os_version, manual=False, opener=fetch, verifier=verify_bundle):
    current = bundle_info(application)["CFBundleShortVersionString"]
    version_tuple(current)
    if arch not in {"arm64", "x86_64"}:
        raise ValueError("当前处理器暂不支持自动更新。")
    try:
        with opener(RELEASES + "/latest/download/update-macos-" + arch + ".json") as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("更新描述文件过大。")
        manifest = validate_manifest(json.loads(raw), arch, os_version)
    except HTTPError as error:
        if error.code == 404:
            return {"phase": "unpublished", "message": "暂未找到可用的已发布更新。"}
        raise
    if version_tuple(manifest["version"]) <= version_tuple(current):
        return {"phase": "current", "message": "当前已是最新版本。"}
    state.mkdir(parents=True, exist_ok=True)
    previous = state / "last-result.json"
    if previous.is_file() and not manual:
        result = json.loads(previous.read_text())
        if result.get("failed_version") == manifest["version"]:
            return {"phase": "error", "message": "上次更新失败，已保留旧版。可手动检查重试。"}
    if not os.access(application.parent, os.W_OK):
        raise ValueError("应用安装目录不可写，请重新安装到个人 Applications 文件夹。")
    job = Path(tempfile.mkdtemp(prefix="update-", dir=state))
    try:
        archive = job / "application.zip"
        download_archive(manifest, archive, opener)
        staged = extract_archive(archive, job / "unpacked")
        verifier(staged, manifest)
        shutil.copy2(Path(__file__), job / "apply-update.py")
        atomic_json(job / "job.json", {"schema": 1, "project": PROJECT, "target": str(application.resolve()), "manifest": manifest})
        return {"phase": "ready", "message": "新版已下载，将在当前编辑结束后自动安装并重启。", "version": manifest["version"], "job": str(job)}
    except BaseException:
        shutil.rmtree(job)
        raise


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def wait_for_exit(pid, timeout=60):
    deadline = time.monotonic() + timeout
    while process_alive(pid):
        if time.monotonic() >= deadline:
            raise TimeoutError("应用未退出，更新已取消。")
        time.sleep(0.2)


def launch(application, job=None):
    args = ["/usr/bin/open", str(application)]
    if job:
        args += ["--args", "--update-job", str(job)]
    subprocess.run(args, check=True, capture_output=True)


def wait_for_site(version, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen("http://127.0.0.1:18876/_desktop/health", timeout=0.5) as response:
                health = json.load(response)
            if health.get("project") == PROJECT and health.get("version") == version:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise TimeoutError("新版启动检查未通过。")


def wait_for_port_close(timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", 18876), timeout=0.3):
                pass
        except OSError:
            return
        time.sleep(0.2)
    raise TimeoutError("旧版本地服务仍在运行，未替换应用。")


def stop_failed_launch(application, job):
    pid_file = job / "launched.pid"
    if not pid_file.is_file():
        return
    pid = int(pid_file.read_text())
    if not process_alive(pid):
        wait_for_port_close()
        return
    # Only terminate the exact executable launched for this update, never free
    # a port by terminating unknown processes.
    command = subprocess.check_output(["/bin/ps", "-ww", "-p", str(pid), "-o", "comm="], text=True).strip()
    if command != str(application / "Contents/MacOS/Dashboard"):
        raise RuntimeError("无法确认新版应用进程；旧应用备份已保留。")
    os.kill(pid, signal.SIGTERM)
    wait_for_exit(pid, timeout=8)
    wait_for_port_close()


def install_prepared(job, verifier=verify_bundle, launcher=launch, readiness=wait_for_site, stopper=stop_failed_launch):
    record = json.loads((job / "job.json").read_text())
    if record.get("schema") != 1 or record.get("project") != PROJECT:
        raise ValueError("更新任务无效。")
    application = Path(record["target"])
    bundle_info(application)
    manifest = record["manifest"]
    staged = job / "unpacked" / APP_NAME
    verifier(staged, manifest)
    version = (staged / "Contents/Resources/site-version.txt").read_text().strip()
    transaction = Path(tempfile.mkdtemp(prefix=".dashboard-update-", dir=application.parent))
    backup, candidate = transaction / "previous.app", transaction / APP_NAME
    installed = False
    try:
        shutil.copytree(staged, candidate)
        verifier(candidate, manifest)
        application.rename(backup)
        try:
            candidate.rename(application)
            launcher(application, job)
            readiness(version)
        except BaseException as error:
            if application.exists():
                stopper(application, job)
                application.rename(transaction / "failed.app")
            backup.rename(application)
            atomic_json(job.parent / "last-result.json", {"phase": "error", "failed_version": manifest["version"], "message": "更新未成功，已恢复旧版。可手动检查重试。"})
            launcher(application)
            raise RuntimeError("更新未成功，已恢复旧版。") from error
        atomic_json(job.parent / "last-result.json", {"phase": "installed", "version": manifest["version"], "message": "已自动更新到 " + manifest["version"] + "。"})
        installed = True
    finally:
        # Retain a recoverable backup if restoring it also failed.
        if installed or not backup.exists():
            shutil.rmtree(transaction)


@contextmanager
def update_lock(state):
    state.mkdir(parents=True, exist_ok=True)
    with (state / ".install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--app", type=Path, required=True)
    prepare.add_argument("--state", type=Path, required=True)
    prepare.add_argument("--arch", required=True)
    prepare.add_argument("--os-version", required=True)
    prepare.add_argument("--manual", action="store_true")
    apply = commands.add_parser("apply")
    apply.add_argument("--job", type=Path, required=True)
    apply.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise RuntimeError("自动安装仅适用于独立 Mac 应用。")
    if args.command == "prepare":
        with update_lock(args.state):
            result = prepare_update(args.app, args.state, args.arch, args.os_version, args.manual)
        print(json.dumps(result, ensure_ascii=False))
    else:
        job = args.job.resolve()
        with update_lock(job.parent):
            atomic_json(job / "handoff.json", {"ready": True})
            try:
                wait_for_exit(args.parent_pid)
                wait_for_port_close()
            except Exception:
                # Before any replacement, the old bundle is still intact.
                record = json.loads((job / "job.json").read_text())
                application = Path(record["target"])
                bundle_info(application)
                launch(application)
                raise
            install_prepared(job)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"phase": "error", "message": "更新未完成：" + str(error)}, ensure_ascii=False))
        sys.exit(1)

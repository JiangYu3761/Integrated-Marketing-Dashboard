#!/usr/bin/env python3
"""Exercise the actual AppKit/WebKit app with a separate persistent test profile."""

import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.macos.updater import wait_for_port_close


def main():
    if sys.platform != "darwin":
        raise RuntimeError("Native smoke tests require macOS; no native checks executed.")
    application = ROOT / "outputs/macos/产品经营地图.app"
    reports = []
    with tempfile.TemporaryDirectory(prefix="dashboard-native-smoke-") as directory:
        for phase in ["exercise", "restore"]:
            report = Path(directory) / (phase + ".json")
            subprocess.run(["/usr/bin/open", "-W", "-n", str(application), "--args",
                            "--smoke-report", str(report), "--smoke-phase", phase], check=True, timeout=90)
            if not report.is_file():
                raise RuntimeError("Native app exited without its smoke report: " + phase)
            result = json.loads(report.read_text())
            if result.get("phase") != phase or result.get("ok") is not True:
                raise RuntimeError(json.dumps(result, ensure_ascii=False))
            reports.append(result)
            wait_for_port_close()
            print("PASS: native " + phase + " — " + ", ".join(result["checks"]))
    output = ROOT / "outputs" / ("native-smoke-" + platform.machine() + ".json")
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

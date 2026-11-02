#!/usr/bin/env python3
"""Preserve a check's exit status and surface failures as GitHub annotations."""

import os
import subprocess
import sys


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: ci_run.py <command> [arguments...]")
    result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            encoding="utf-8", errors="replace")
    sys.stdout.write(result.stdout)
    if result.returncode and os.environ.get("GITHUB_ACTIONS") == "true":
        diagnostic = result.stdout[-3500:] or "The check failed without output."
        diagnostic = diagnostic.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print("::error title=Check failed::" + diagnostic)
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    sys.exit(main())

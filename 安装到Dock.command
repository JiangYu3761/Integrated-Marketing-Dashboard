#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo '请在 Mac 上运行本安装器。'
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo '需要 Python 3.9 或更新版本。请先安装 Python 3，再重新双击本脚本。'
  read -r -p '按回车关闭窗口…' || true
  exit 1
fi

if python3 scripts/install_macos_app.py; then
  read -r -p '安装完成，按回车关闭此窗口…' || true
else
  read -r -p '安装未完成，请查看上方提示。按回车关闭窗口…' || true
  exit 1
fi

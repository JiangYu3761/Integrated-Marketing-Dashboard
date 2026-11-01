#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
print '产品经营地图：http://127.0.0.1:8876/'
print '保持此窗口打开，停止服务按 Ctrl+C。'
exec python3 -m http.server 8876 --bind 127.0.0.1

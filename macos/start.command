#!/bin/bash
# 企业经营风险预警平台 · macOS 源码运行版启动脚本
#
# 用途：在不使用 Electron 打包产物（无需解除 Gatekeeper 隔离）的情况下，
#      用本机 Python 直接拉起后端 + 前端，浏览器访问。
#
# 首次运行会在 ~/.risk-warning-platform 下创建虚拟环境并安装依赖（约 3~8 分钟）。
# 之后每次启动只需几秒。
set -u
cd "$(dirname "$0")" || exit 1

APP_HOME="$HOME/.risk-warning-platform"
VENV="$APP_HOME/venv"
DATA="$APP_HOME/data"
WEB="$PWD/web/dist"
LOG="$APP_HOME/server.log"

echo "==============================================="
echo " 企业经营风险预警平台 · macOS 源码运行版"
echo "==============================================="
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3。"
  echo "请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/macos/"
  echo "（安装后在终端执行 python3 --version 验证）"
  read -r -p "按回车键退出…"
  exit 1
fi

echo "Python: $(python3 --version 2>&1)"
mkdir -p "$APP_HOME" "$DATA"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[1/3] 创建 Python 虚拟环境…"
  python3 -m venv "$VENV" || { echo "[错误] 创建虚拟环境失败"; read -r -p "按回车键退出…"; exit 1; }
fi

echo "[2/3] 检查依赖（首次运行约 3~8 分钟，请耐心等待）…"
"$VENV/bin/python" -m pip install --upgrade pip --quiet
if ! "$VENV/bin/python" -m pip install --quiet -r server/requirements.txt; then
  echo "[错误] 依赖安装失败，请检查网络后重试。"
  read -r -p "按回车键退出…"
  exit 1
fi

echo "[3/3] 启动本地服务…"
: > "$LOG"
cd server || exit 1
RWP_SAMPLES_DIR="$(cd .. && pwd)/data/samples" \
  "$VENV/bin/python" desktop_entry.py --port 0 --data-dir "$DATA" --web-dist "$WEB" >> "$LOG" 2>&1 &
PID=$!

cleanup() {
  echo
  echo "正在关闭服务…"
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  echo "已退出。"
  exit 0
}
trap cleanup INT TERM

PORT=""
for _ in $(seq 1 90); do
  PORT=$(grep -o 'RWP_PORT=[0-9]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2)
  [ -n "$PORT" ] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[错误] 后端进程已退出，日志如下："
    tail -20 "$LOG"
    read -r -p "按回车键退出…"
    exit 1
  fi
  sleep 1
done

if [ -z "$PORT" ]; then
  echo "[错误] 启动超时，日志：$LOG"
  tail -20 "$LOG"
  read -r -p "按回车键退出…"
  exit 1
fi

URL="http://127.0.0.1:$PORT"
echo
echo "服务已就绪：$URL"
echo "（浏览器将自动打开；关闭本窗口或按 Ctrl+C 可退出服务）"
echo
open "$URL" 2>/dev/null || echo "请手动在浏览器打开上面的地址。"

wait "$PID"

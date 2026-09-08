# -*- coding: utf-8 -*-
"""桌面端（Electron）后端入口。

由 Electron 主进程拉起：
    risk-api.exe --port 8123 --data-dir "%APPDATA%\\RiskWarningPlatform" --web-dist "<resources>/web"

行为：
- 端口 0 时自动选空闲端口，并把实际端口写入 stdout 的 `RWP_PORT=<port>`（Electron 读取）
- 数据目录通过 RWP_DATA_DIR 传给配置层
- 前端静态目录通过 RWP_WEB_DIST 传给应用（托管 + SPA fallback）
"""

import argparse
import os
import socket
import sys
from pathlib import Path


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="risk-warning-platform desktop backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--web-dist", default="")
    args = parser.parse_args()

    port = args.port or _free_port()
    if args.data_dir:
        os.environ["RWP_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())
    if args.web_dist:
        os.environ["RWP_WEB_DIST"] = str(Path(args.web_dist).expanduser().resolve())

    # 必须在导入 app 之前设置环境变量（配置在导入时读取）
    import uvicorn

    from app.main import app

    print(f"RWP_PORT={port}", flush=True)
    print(f"RWP_DATA_DIR={os.environ.get('RWP_DATA_DIR', '')}", flush=True)
    uvicorn.run(app, host=args.host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)

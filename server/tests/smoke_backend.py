# -*- coding: utf-8 -*-
"""打包后端冒烟测试：直接运行 PyInstaller 产物，等 /api/health 通过。

用途：
- CI 在 electron-builder 之前验证"冻结后的后端"能真正启动
  （能捕捉"本机开发可用、打包后导入即崩"的问题，例如 Python 版本注解求值差异）；
- 本地构建后也可手工运行。

用法（server 目录）：
    python tests/smoke_backend.py --dir ../desktop/resources/backend/risk-api
    python tests/smoke_backend.py --exe /path/to/risk-api
"""

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def resolve_exe(args: argparse.Namespace) -> str:
    if args.exe:
        return args.exe
    base = pathlib.Path(args.dir or "")
    for name in ("risk-api", "risk-api.exe"):
        candidate = base / name
        if candidate.exists():
            return str(candidate)
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="packaged backend smoke test")
    parser.add_argument("--dir", default="", help="risk-api 目录（自动识别 risk-api / risk-api.exe）")
    parser.add_argument("--exe", default="", help="直接指定可执行文件路径")
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()

    exe = resolve_exe(args)
    if not exe or not pathlib.Path(exe).exists():
        print(f"FAIL: 未找到后端可执行文件（dir={args.dir!r} exe={args.exe!r}）")
        return 1
    print(f"== 打包后端冒烟：{exe}")

    data_dir = pathlib.Path(tempfile.mkdtemp(prefix="rwp-smoke-"))
    proc = subprocess.Popen(
        [exe, "--port", "0", "--data-dir", str(data_dir)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    deadline = time.time() + args.timeout
    port: int | None = None
    tail: list[str] = []
    code = 0
    try:
        # 1) 等待启动横幅里的 RWP_PORT=<port>
        while time.time() < deadline:
            line = proc.stdout.readline() if proc.stdout else ""
            if not line:
                if proc.poll() is not None:
                    print("FAIL: 后端进程提前退出，exit=", proc.returncode)
                    code = 1
                    break
                continue
            tail.append(line.rstrip())
            print("  |", line.rstrip()[:160])
            if line.startswith("RWP_PORT="):
                port = int(line.split("=", 1)[1].strip())
                break

        # 2) 轮询健康检查
        if code == 0 and port is None:
            print("FAIL: 未在后端输出中获取到 RWP_PORT")
            code = 1
        if code == 0:
            while time.time() < deadline:
                if proc.poll() is not None:
                    print("FAIL: 后端进程退出，exit=", proc.returncode)
                    code = 1
                    break
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as resp:
                        body = json.loads(resp.read().decode("utf-8"))
                    print("  health:", body)
                    # 再验证一个真实业务接口，确保依赖（sqlalchemy/数据目录）正常
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/finance/overview", timeout=15) as resp:
                        overview = json.loads(resp.read().decode("utf-8"))
                    print("  finance overview total:", overview.get("total"))
                    print(f"SMOKE_BACKEND_OK port={port}")
                    code = 0
                    break
                except Exception:  # noqa: BLE001 —— 启动期连接失败属正常
                    time.sleep(0.5)
            else:
                print("FAIL: 健康检查超时")
                code = 1
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        if code != 0 and tail:
            print("---- 后端输出末尾 ----")
            for line in tail[-25:]:
                print("  |", line[:200])
    return code


if __name__ == "__main__":
    sys.exit(main())

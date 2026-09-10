# -*- coding: utf-8 -*-
"""导入自检：导入 app.main 与全部子模块，捕捉"导入期才暴露"的错误。

为什么需要它：
- 注解求值时机在 Python 版本间不同（≤3.13 即时求值、3.14 惰性求值），
  某些写法只在旧版本上于**导入时**崩溃（如类体内方法名遮蔽内置类型
  `list`/`dict` 后又被注解引用 → TypeError: 'function' object is not subscriptable）；
- 本机开发用 3.14 可能一切正常，而 CI/桌面包用 3.12 直接起不来。

用法（server 目录，任意 Python 3.10+）：
    python tests/check_imports.py
"""

import importlib
import pathlib
import pkgutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    print(f"python {sys.version.split()[0]} | root {ROOT}")
    failures: list[str] = []
    try:
        import app.main  # noqa: F401
        print("  ok  app.main")
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        failures.append(f"app.main: {type(exc).__name__}: {exc}")

    import app

    for mod in pkgutil.walk_packages(app.__path__, prefix="app."):
        name = mod.name
        if name.split(".")[-1].startswith("_"):
            continue
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: {type(exc).__name__}: {exc}")

    if failures:
        print(f"\n导入失败 {len(failures)} 个模块：")
        for f in failures:
            print("  ✗ " + f)
        return 1
    print("全部模块导入通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())

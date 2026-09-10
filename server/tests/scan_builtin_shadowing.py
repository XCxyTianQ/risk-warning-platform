# -*- coding: utf-8 -*-
"""扫描"类体内方法名遮蔽内置类型，后续注解/默认值再用该内置类型"的隐患。

这类代码在 Python ≤3.13（即时求值注解）下会于**导入时**抛
TypeError: 'function' object is not subscriptable，
而 Python 3.14（PEP 649 惰性注解）不会报错 —— 典型的环境差异崩溃。

用法：python server/tests/scan_builtin_shadowing.py
"""

import ast
import pathlib
import sys

BUILTINS = {
    "list", "dict", "set", "tuple", "str", "int", "float", "bool", "bytes",
    "type", "object", "id", "input", "format", "filter", "map", "vars", "hash",
}

ROOT = pathlib.Path(__file__).resolve().parents[1] / "app"


def annotation_names(node: ast.AST) -> set[str]:
    """收集注解表达式里出现的名字（含 subscript 的基名）。"""
    names: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name):
            names.add(sub.id)
    return names


def scan(path: pathlib.Path) -> list[str]:
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src, filename=str(path))
    problems: list[str] = []
    for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
        # 类体内被方法名遮蔽的内置类型 → {名字: 首次定义行}
        shadowed: dict[str, int] = {}
        for item in cls.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name in BUILTINS:
                shadowed.setdefault(item.name, item.lineno)
        if not shadowed:
            continue
        # 检查遮蔽之后的注解与默认值
        for item in cls.body:
            if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            nodes: list[ast.AST] = []
            for arg in list(item.args.args) + list(item.args.kwonlyargs) + list(item.args.posonlyargs):
                if arg.annotation is not None:
                    nodes.append(arg.annotation)
            for default in list(item.args.defaults) + list(item.args.kw_defaults):
                if default is not None:
                    nodes.append(default)
            if item.returns is not None:
                nodes.append(item.returns)
            for node in nodes:
                for name in annotation_names(node):
                    start = shadowed.get(name)
                    if start is not None and item.lineno >= start:
                        problems.append(
                            f"{path}:{item.lineno} 类 {cls.name}：方法 {item.name} 的注解/默认值使用 `{name}`，"
                            f"但该类在第 {start} 行定义了同名方法 → Python ≤3.13 导入即崩"
                        )
    return problems


def main() -> int:
    all_problems: list[str] = []
    for path in sorted(ROOT.rglob("*.py")):
        all_problems += scan(path)
    if all_problems:
        print(f"发现 {len(all_problems)} 处隐患：")
        for p in all_problems:
            print("  " + p)
        return 1
    print("未发现内置类型遮蔽隐患")
    return 0


if __name__ == "__main__":
    sys.exit(main())

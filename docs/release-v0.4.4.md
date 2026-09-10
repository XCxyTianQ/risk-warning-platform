# v0.4.4 · 修复桌面端后端无法启动（Python 注解求值差异）

> 发布日期：2026-09-09　｜　适用：Windows 10/11、macOS 11+（Apple Silicon / Intel）
>
> **重要：v0.4.0 ~ v0.4.3 的安装包后端均无法启动，请务必升级到本版。**

---

## 问题现象

打开桌面端后，界面能显示，但后端立即异常退出（macOS 上尤为明显）：

```
File "app/agent/session.py", line 324, in SessionStore
    def batch_delete(self, db: DbSession, ids: list[str]) -> dict:
TypeError: 'function' object is not subscriptable
```

## 根因

`SessionStore` 里有一个方法叫 **`list`**，而它之后定义的方法注解里用了 `list[str]`。
Python 的**类体作用域**会先查到同名的那个方法，于是 `list[str]` 变成了"对函数取下标"。

关键在**注解的求值时机因 Python 版本而异**：

| Python | 注解求值 | 结果 |
|---|---|---|
| ≤ 3.13（CI / 打包用的 3.12） | 定义时立即求值 | **导入即崩溃**（后端起不来） |
| 3.14（本机开发环境） | PEP 649 惰性求值 | 完全正常，问题被隐藏 |

所以：本地开发、本机打包一切正常，而 CI 打出来的包（Windows 与 macOS 都是 Python 3.12）后端**一启动就退出**。
v0.3.0 是本机用 3.14 打包的，因此没受影响；v0.4.0 起改为 CI 打包，问题随之出现。

## 修复

1. **重命名方法**：`SessionStore.list` → `list_sessions`（消除对内置 `list` 的遮蔽），并更新调用点；
2. **新增导入自检** `server/tests/check_imports.py`：导入 `app.main` 与全部子模块，任何导入期异常直接失败；
3. **新增遮蔽扫描** `server/tests/scan_builtin_shadowing.py`：静态检查"类体内方法名遮蔽内置类型，后续注解/默认值又使用该类型"的写法；
4. **新增打包后端冒烟** `server/tests/smoke_backend.py`：直接运行 PyInstaller 产物，等 `/api/health` 与一个业务接口通过；
5. **CI 三道闸门**（Windows / macOS arm64 / macOS x64 全部启用）：导入自检 → 遮蔽扫描 → 打包后端冒烟，任一失败即终止发布。

> 原先 CI 只验证"能构建出文件"，不验证"构建出的后端能启动"，所以这个问题一路发到了用户手里。

## 验证

| 检查 | 结果 |
|---|---|
| v0.4.3 源码 + Python 3.11（与 3.12 同为立即求值） | 复现同一报错（session.py:324） |
| 修复后 + Python 3.11，全部模块导入 | 通过 |
| 修复后 + Python 3.11，启动后端并访问 `/api/health`、`/api/finance/overview` | 通过 |
| 修复后 + Python 3.14（本机） | 通过 |
| 打包后端冒烟（PyInstaller 产物） | 通过 |

---

## 下载

| 平台 | 文件 |
|---|---|
| Windows 10/11 | `RiskWarningPlatform-0.4.4-x64.exe`、`RiskWarningPlatform-0.4.4-portable.exe` |
| macOS Apple Silicon | `RiskWarningPlatform-0.4.4-mac-arm64.dmg` / `.zip` |
| macOS Intel | `RiskWarningPlatform-0.4.4-mac-x64.dmg` / `.zip` |
| macOS 免签名回退 | `RiskWarningPlatform-0.4.4-macos-source.zip` |

校验：`SHA256SUMS-windows.txt` / `SHA256SUMS-macos-arm64.txt` / `SHA256SUMS-macos-x64.txt`

## macOS 首次打开

右键 App →「打开」→ 再点「打开」；或
`xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
或用 `-macos-source.zip`（右键 `start.command` → 打开）。

## 后续计划

本版仍是 Python 后端。为解决"解释器版本 / 打包 / 架构匹配"这类根本性兼容问题，
后端将用 **Rust** 重写（单静态二进制、四平台交叉编译、无运行时依赖），
API 契约与前端保持不变，并用"金标准测试"逐项比对迁移前后的评分与财务指标。

> 数据来自公开信源，模型结果为规则化测算，不构成投资建议。

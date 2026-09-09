# 桌面端（Electron · Windows / macOS）

把「Vue 前端 + FastAPI 后端」打包成 Windows / macOS 桌面应用。

## 架构

```
Electron 主进程 (main.js)
  ├─ 选空闲端口 → 拉起 Python 后端（开发=venv python；打包=resources/backend/risk-api[.exe]）
  ├─ 轮询 /api/health 就绪
  └─ BrowserWindow 加载 http://127.0.0.1:<port>   ← 后端同时托管前端静态文件（SPA fallback）
```

| 平台 | 数据目录 | 日志 |
|---|---|---|
| Windows | `%APPDATA%\RiskWarningPlatform\data\platform.db` | `%APPDATA%\RiskWarningPlatform\logs\backend.log` |
| macOS | `~/Library/Application Support/RiskWarningPlatform/data/platform.db` | 同上目录下 `logs/backend.log` |

- 首次运行自动灌入样例企业数据；
- 后端进程随窗口退出而结束（Windows `taskkill /T /F`；macOS 向进程组发 SIGTERM，1.5s 后 SIGKILL）。

## 开发运行

```bash
# 1) 后端依赖（只需一次）
cd server
python -m venv .venv
# Windows: .\.venv\Scripts\pip install -r requirements.txt
# macOS:   ./.venv/bin/pip install -r requirements.txt

# 2) 前端构建产物
cd ../web
npm install
npm run build

# 3) 启动桌面端（开发模式：用 venv python 拉起后端）
cd ../desktop
npm install
npm run dev
```

自检：

```bash
npm run smoke          # 只验证"后端能拉起 + 健康检查通过"
npm run smoke:window   # 再验证窗口能真正渲染出页面
```

## 打包

```bash
cd desktop

# Windows
npm run dist           # 前端 + PyInstaller 后端 + electron-builder（NSIS 安装包 + 便携版）
npm run dist:dir       # 只出免安装目录（调试用，最快）

# macOS（必须在 macOS 上执行；跨架构请用对应架构的机器/runner）
npm run dist:mac:arm64 # Apple Silicon
npm run dist:mac:x64   # Intel Mac
```

产物在 `desktop/release/`：

| 平台 | 文件 |
|---|---|
| Windows | `RiskWarningPlatform-<ver>-x64.exe`（NSIS 安装包）、`RiskWarningPlatform-<ver>-portable.exe` |
| macOS | `RiskWarningPlatform-<ver>-mac-arm64.dmg` / `.zip`、`RiskWarningPlatform-<ver>-mac-x64.dmg` / `.zip` |

### 打包脚本说明

- `scripts/build-web.js`：构建 `web/dist` 并复制到 `desktop/resources/web`
- `scripts/build-backend.js`：PyInstaller onedir → `desktop/resources/backend/risk-api/`
  - Python 解释器解析顺序：`RWP_PYTHON` → `server/.venv` → PATH 上的 `python`/`python3`（CI 用后者）
  - 打包前自检 akshare/fastapi 等依赖，缺失直接失败（避免产出"能启动但刷不了数据"的包）
  - macOS 上对主程序与全部 `.so`/`.dylib` 做 ad-hoc 签名（Apple Silicon 要求）
- `scripts/make_icons.py`：生成 1024×1024 `build/icon.png`（macOS 打包要求 ≥512）与 `build/icon.ico`

## 未签名说明（macOS）

本项目**没有** Apple 开发者账号，产物未签名、未公证，首次打开会被 Gatekeeper 拦截：

1. 把 App 拖入「应用程序」→ 右键 App → **打开** → 弹窗里再点「打开」；
2. 或执行 `xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
3. 或用仓库中的 `macos/start.command`（源码运行，完全绕开签名，需本机 Python 3.10+）。

## 队内分发建议

1. 用 **portable 版**（Windows）或 **zip**（macOS）分发，避免杀软/隔离属性带来的额外摩擦；
2. 后端用 PyInstaller **onedir**，首启快；
3. API Key 由使用者在「设置」面板各自填写，**不要**打进分发文件；
4. 版本号显示在窗口标题与「关于」对话框，便于确认队友测的是哪一版。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动后白屏 | 前端未构建 / `resources/web` 缺失 | 执行 `npm run build:web` |
| 后端启动超时（90s） | PyInstaller 产物缺失或 Python 环境异常 | 看「文件 → 打开日志」的 `backend.log` |
| macOS 提示"已损坏" | 下载隔离属性（quarantine） | `xattr -dr com.apple.quarantine <app>` |
| macOS 点开无反应 | 架构不匹配（Intel 用了 arm64 包） | 下载对应架构的包；或用 `macos/start.command` |
| 数据想重置 | 需要空库 | 删除数据目录下的 `data/` |
| 杀软报毒 | PyInstaller 常见误报 | 加白名单；正式分发时考虑代码签名 |

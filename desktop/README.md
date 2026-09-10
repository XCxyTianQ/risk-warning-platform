# 桌面端（Electron · Windows / macOS）

把「Vue 前端 + Rust 后端」打包成 Windows / macOS 桌面应用。

## 架构

```
Electron 主进程 (main.js)
  ├─ 选空闲端口 → 拉起 Rust 后端（打包=resources/backend/risk-warning-backend[.exe]；
  │                             开发=backend/target/{release,debug}/…，旧 Python 包与 venv 仍可兜底）
  ├─ 轮询 /api/health 就绪
  └─ BrowserWindow 加载 http://127.0.0.1:<port>   ← 后端同时托管前端静态文件（SPA fallback）
```

| 平台 | 数据目录 | 日志 |
|---|---|---|
| Windows | `%APPDATA%\RiskWarningPlatform\data\platform.db` | `%APPDATA%\RiskWarningPlatform\logs\backend.log` |
| macOS | `~/Library/Application Support/RiskWarningPlatform/data/platform.db` | 同上目录下 `logs/backend.log` |

- 首次运行自动灌入样例企业数据 + 内置技能/预设；
- 后端进程随窗口退出而结束（Windows `taskkill /T /F`；macOS 向进程组发 SIGTERM，1.5s 后 SIGKILL）。

## 开发运行

```bash
# 1) 后端（Rust，单文件二进制）
cd backend
cargo build --release        # 产物：backend/target/release/risk-warning-backend[.exe]

# 2) 前端构建产物
cd ../web
npm install
npm run build

# 3) 启动桌面端（自动探测 backend/target/{release,debug} 下的二进制）
cd ../desktop
npm install
npm run dev
```

自检：

```bash
npm run smoke          # 只验证"后端能拉起 + 健康检查通过"
npm run smoke:window   # 再验证窗口能真正渲染出页面
node scripts/smoke-backend.js   # 直接冒烟后端二进制（不启动 Electron）
```

## 打包

```bash
cd desktop

# Windows
npm run dist           # 前端 + cargo 构建后端 + electron-builder（NSIS 安装包 + 便携版）
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
- `scripts/build-backend.js`：`cargo build --release` → 复制**单个二进制**到 `desktop/resources/backend/`
  - 目标平台用 `RWP_TARGET`（如 `aarch64-apple-darwin`）指定，缺省为宿主；
  - `RWP_CARGO` 可指定 cargo 路径，`RWP_SKIP_BUILD=1` 只做拷贝（本地联调）；
  - macOS 上对二进制做 ad-hoc 签名（Gatekeeper/Apple Silicon 要求）；
  - 不再需要 PyInstaller，也不依赖目标机器的 Python。
- `scripts/smoke-backend.js`：拉起二进制 → 等 `RWP_PORT=` → 请求 `/api/health` → 退出（CI 闸门）
- `scripts/make_icons.py`：生成 1024×1024 `build/icon.png`（macOS 打包要求 ≥512）与 `build/icon.ico`

## 未签名说明（macOS）

本项目**没有** Apple 开发者账号，产物未签名、未公证，首次打开会被 Gatekeeper 拦截：

1. 把 App 拖入「应用程序」→ 右键 App → **打开** → 弹窗里再点「打开」；
2. 或执行 `xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
3. 或使用发布页的 `RiskWarningPlatform-<ver>-macos-source.zip`（源码方式运行，需本机 Python 3.10+）。

## 队内分发建议

1. 用 **portable 版**（Windows）或 **zip**（macOS）分发，避免杀软/隔离属性带来的额外摩擦；
2. 后端是单文件静态二进制（约 9 MB），无需附带运行时；
3. API Key 由使用者在「设置」面板各自填写（存本地 `app_setting` 表），**不要**打进分发文件；
4. 版本号显示在窗口标题与「关于」对话框，便于确认队友测的是哪一版。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动后白屏 | 前端未构建 / `resources/web` 缺失 | 执行 `npm run build:web` |
| 启动即报"后端缺失" | 未构建 Rust 二进制 | `cd backend && cargo build --release`，或 `node scripts/build-backend.js` |
| 后端启动超时 | 二进制被杀软拦截 / 数据目录不可写 | 看「文件 → 打开日志」的 `backend.log` |
| macOS 提示"已损坏" | 下载隔离属性（quarantine） | `xattr -dr com.apple.quarantine <app>` |
| macOS 点开无反应 | 架构不匹配（Intel 用了 arm64 包） | 下载对应架构的包；或用 `-macos-source.zip` |
| 数据想重置 | 需要空库 | 删除数据目录下的 `data/` |
| 杀软报毒 | 未签名可执行文件常见误报 | 加白名单；正式分发时考虑代码签名 |

# 桌面端（Electron）

把「Vue 前端 + FastAPI 后端」打包成 Windows 桌面应用。

## 架构

```
Electron 主进程 (main.js)
  ├─ 选空闲端口 → 拉起 Python 后端（开发=venv python；打包=resources/backend/risk-api.exe）
  ├─ 轮询 /api/health 就绪
  └─ BrowserWindow 加载 http://127.0.0.1:<port>   ← 后端同时托管前端静态文件（SPA fallback）
```

- 数据目录：`%APPDATA%\RiskWarningPlatform\data\platform.db`（首次运行自动灌入样例企业数据）
- 日志：`%APPDATA%\RiskWarningPlatform\logs\backend.log`（菜单「文件 → 打开日志」）
- 后端进程随窗口退出而结束（`taskkill /T /F` 清理进程树）

## 开发运行

```powershell
# 1) 后端依赖（只需一次）
cd ..\server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

# 2) 前端构建产物
cd ..\web
npm install
npm run build

# 3) 启动桌面端（开发模式：用 venv python 拉起后端）
cd ..\desktop
npm install
npm run dev
```

自检（只验证"后端能拉起 + 健康检查通过"，不弹窗口）：

```powershell
npm run smoke
```

## 打包 exe

```powershell
cd desktop
npm run dist          # 构建前端 + PyInstaller 打包后端 + electron-builder 出安装包/便携版
npm run dist:dir      # 只出免安装目录（调试用，最快）
```

产物在 `desktop/release/`：
- `RiskWarningPlatform-<version>-x64.exe`（NSIS 安装包）
- `RiskWarningPlatform-<version>-portable.exe`（便携版，双击即用）

## 队内分发建议

1. 用 **portable 版** 或 **onedir 压缩包** 分发，避免杀软对 onefile 的误报；
2. 后端用 PyInstaller **onedir**（`resources/backend/` 目录），首启快；
3. API Key 由使用者在「设置」面板各自填写，**不要**打进分发文件；
4. 版本号显示在窗口标题，便于确认队友测的是哪一版。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动后白屏 | 前端未构建 / `resources/web` 缺失 | 执行 `npm run build:web` |
| 后端启动超时（90s） | PyInstaller 产物缺失或 Python 环境异常 | 看「文件 → 打开日志」的 `backend.log` |
| 提示端口被占用 | 极少见（动态端口） | 重启应用；或检查安全软件拦截 |
| 数据想重置 | 需要空库 | 删除 `%APPDATA%\RiskWarningPlatform\data\` |
| 杀软报毒 | PyInstaller 常见误报 | 加白名单；正式分发时考虑代码签名 |

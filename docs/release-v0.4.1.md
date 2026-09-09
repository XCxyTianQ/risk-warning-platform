# v0.4.1 · 企业检索支持股票代码

> 发布日期：2026-09-09　｜　适用：Windows 10/11、macOS 11+（Apple Silicon / Intel）
>
> 本版为 v0.4.0 的修补版本，功能范围与 v0.4.0 一致（金融分析模块 + 双平台桌面端），
> 主要修复"直接输入股票代码查不到企业"的问题。已装 v0.4.0 的同事建议升级。

---

## 修复内容

**问题**：此前在对话、企业档案搜索、智能研判等入口输入股票代码（如 `600518`），
系统查不到对应企业——名称/行业匹配逻辑没有覆盖代码字段，且代码未做归一化
（`SH600519`、`600519.SH`、`000001.XSHE` 等写法都不认）。

**修复后**：所有入口都同时接受**企业名称**与**股票代码**，支持常见写法：

| 输入 | 结果 |
|---|---|
| `600518` | 康美药业股份有限公司 |
| `SH600519` / `600519.SH` / `sh.600519` | 贵州茅台酒股份有限公司 |
| `300750` | 宁德时代新能源科技股份有限公司 |
| `601398`（平台未建档） | 提示"未找到股票代码 601398（工商银行），可添加建档" |

覆盖的入口：

- 对话区（Agent 自动按代码检索；快捷问题新增「600518 的财务分析给我看看」）；
- 企业档案搜索框（名称 / 股票代码 / 行业）；
- 命令面板 Ctrl+K（企业项显示"行业 · 代码"，可用代码筛选）；
- 智能研判输入框（可直接输入代码）；
- 添加企业（可直接填代码建档，并按代码查重，避免重复建档）；
- HTTP 接口：`GET /api/enterprises?q=600518`、`GET /api/resolve_stock?name=600518`、
  `POST /api/enterprises/analyze_by_name`。

---

## 下载

| 平台 | 文件 |
|---|---|
| Windows 10/11 | `RiskWarningPlatform-0.4.1-x64.exe`（安装包）、`RiskWarningPlatform-0.4.1-portable.exe`（便携版） |
| macOS Apple Silicon | `RiskWarningPlatform-0.4.1-mac-arm64.dmg` / `.zip` |
| macOS Intel | `RiskWarningPlatform-0.4.1-mac-x64.dmg` / `.zip` |
| macOS 免签名回退 | `RiskWarningPlatform-0.4.1-macos-source.zip`（本机 Python 运行，见下） |

校验文件：`SHA256SUMS-windows.txt` / `SHA256SUMS-macos-arm64.txt` / `SHA256SUMS-macos-x64.txt`

---

## macOS 首次打开（重要）

安装包未做 Apple 开发者签名与公证，首次打开会被 Gatekeeper 拦截，按任一方式处理：

1. 把 App 拖入「应用程序」→ **右键 App → 打开 → 弹窗中再点「打开」**（只需一次）；
2. 或终端执行：`xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
3. 若仍无法启动：用 `RiskWarningPlatform-0.4.1-macos-source.zip`，解压后右键 `start.command` → 打开
   （需本机 Python 3.10+，首次安装依赖 3~8 分钟，完全绕开签名）。

---

## 首次使用

1. 打开应用 → 右上角 **⚙ 设置**；
2. 「模型服务」选择提供商（或"自定义"）→ 填入 API Key → 点击「获取可用模型」→ 选择模型；
3. 对话区提问，例如：
   - `600518 现在风险怎么样？`
   - `600519 和 300750 哪个更稳？`
   - `康美药业最新财报的盈利质量怎么样？`

API Key 只保存在本机数据库，不随安装包分发。

---

## 数据目录

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\RiskWarningPlatform\data` |
| macOS | `~/Library/Application Support/RiskWarningPlatform/data` |

应用菜单「文件 → 打开数据目录 / 打开日志」可直接跳转。

---

## 已知限制

1. 安装包未签名、未公证，macOS 首次打开需手动放行（见上）；
2. 股票代码仅支持沪深京 A 股；输入非 A 股代码会提示无法解析；
3. 财务数据来自公开信源，模型结果为规则化测算，**不构成投资建议**。

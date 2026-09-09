# v0.4.0 · 金融分析模块 + macOS 支持

> 发布日期：2026-09-09　｜　适用：Windows 10/11、macOS 11+（Apple Silicon / Intel）

---

## 本次更新

### 1. 新增「金融分析」模块

独立的财务分析工作台，把财报从"几个字段"变成可计算、可建模、可对标的结论：

- **关键指标**：营收、归母净利润、扣非净利润、毛利率、净利率、ROE、ROA、资产负债率、经营现金流、现金含量、增速、周转天数、商誉占比等 16 项，带同比与趋势方向；
- **杜邦分解**：ROE = 销售净利率 × 总资产周转率 × 权益乘数，并给出三因素归因（贡献之和 = ROE 变动）；
- **财务预警模型**：Altman Z / Z''、Piotroski F-Score（9 项信号逐条）、Beneish M-Score（8 项指数，> −1.78 提示盈余操纵嫌疑）；
- **同业对标**：9 项指标分位数 + 雷达图；
- **异常勾稽**：10 条规则（有利润无现金、应收与营收背离、杠杆跳升、存货/应收恶化、商誉过重、扣非占比低等）；
- **一键报告**：确定性 Markdown 分析报告，可导出。

入口：左侧功能栏 **📈 金融分析**，或在企业评分画像中点击「📈 金融分析」。

### 2. macOS 支持

- 新增 Apple Silicon（arm64）与 Intel（x64）两种架构的 `.dmg` / `.zip`；
- 应用菜单、编辑菜单（Cmd+C/V）、托盘图标、后端进程终止、数据目录均按 macOS 适配；
- 数据目录：`~/Library/Application Support/RiskWarningPlatform/`。

### 3. 打包修复

- `akshare` 纳入后端依赖清单：此前用 CI 构建的安装包缺少该依赖，会导致「数据源刷新」失败；
- 图标升级为 1024×1024（macOS 打包要求 ≥512×512）。

---

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 10/11 | `RiskWarningPlatform-0.4.0-x64.exe` | NSIS 安装包（可选安装目录） |
| Windows 10/11 | `RiskWarningPlatform-0.4.0-portable.exe` | 免安装便携版，双击即用 |
| macOS Apple Silicon | `RiskWarningPlatform-0.4.0-mac-arm64.dmg` | M1/M2/M3/M4 芯片 |
| macOS Apple Silicon | `RiskWarningPlatform-0.4.0-mac-arm64.zip` | 免安装版（解压后拖入「应用程序」） |
| macOS Intel | `RiskWarningPlatform-0.4.0-mac-x64.dmg` | Intel 芯片 Mac |
| macOS Intel | `RiskWarningPlatform-0.4.0-mac-x64.zip` | 免安装版 |
| macOS 通用回退 | `RiskWarningPlatform-0.4.0-macos-source.zip` | 用本机 Python 运行，**无需解除 Gatekeeper**，见下文 |

校验文件：`SHA256SUMS-windows.txt` / `SHA256SUMS-macos-arm64.txt` / `SHA256SUMS-macos-x64.txt`

---

## macOS 首次打开（重要）

安装包**未做 Apple 开发者签名与公证**（个人/学生团队无付费开发者账号），因此首次打开会被 Gatekeeper 拦截，提示"无法验证开发者"或"已损坏"。按以下任一方式处理：

**方式一（推荐）**：把 App 拖入「应用程序」后，在「应用程序」里 **右键点击 App → 打开 → 在弹窗中再点"打开"**。只需一次，之后双击即可。

**方式二**：在「终端」执行（把路径换成实际位置）：

```bash
xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"
```

如果提示"应用程序已损坏，无法打开"，说明隔离属性仍在，用方式二处理后重试。

**方式三（完全绕开签名）**：下载 `RiskWarningPlatform-0.4.0-macos-source.zip`，解压后右键 `start.command` → 打开。它会用本机 Python 创建虚拟环境并启动同一套前后端，浏览器访问。首次需等待依赖安装（3~8 分钟），前提是本机已安装 Python 3.10+。详见压缩包内 `README.txt`。

---

## 首次使用

1. 打开应用 → 右上角 **⚙ 设置**；
2. 「模型服务」选择提供商（或"自定义"）→ 填入 API Key → 点击「获取可用模型」→ 选择模型；
3. 回到对话区即可提问，例如：
   - `康美药业最新财报的盈利质量怎么样？`
   - `宁德时代和贵州茅台哪个更稳？`
   - `毛利率低于 20% 的企业有哪些？`

**API Key 只保存在本机数据库**（`~/Library/Application Support/RiskWarningPlatform/data/platform.db` 或 `%APPDATA%\RiskWarningPlatform\data\platform.db`），不会随安装包分发。

---

## 数据目录与日志

| 平台 | 数据 | 日志 |
|---|---|---|
| Windows | `%APPDATA%\RiskWarningPlatform\data` | `%APPDATA%\RiskWarningPlatform\logs\backend.log` |
| macOS | `~/Library/Application Support/RiskWarningPlatform/data` | `~/Library/Application Support/RiskWarningPlatform/logs/backend.log` |

应用菜单「文件 → 打开数据目录 / 打开日志」可直接跳转。

---

## 校验下载完整性

Windows（PowerShell）：

```powershell
Get-FileHash .\RiskWarningPlatform-0.4.0-x64.exe -Algorithm SHA256
```

macOS：

```bash
shasum -a 256 RiskWarningPlatform-0.4.0-mac-arm64.dmg
```

将输出与 Release 中的 `SHA256SUMS-*.txt` 对照。

---

## 已知限制

1. 安装包未签名、未公证，macOS 首次打开需手动放行（见上）；
2. 财务数据来自公开信源（东方财富 / 新浪财经 / 巨潮资讯），免费接口偶发不可用，界面会标注数据状态；
3. Altman Z（市值口径）需要实时市值，若接口不可用则只展示 Z''（账面口径）；
4. 样例数据为公开信息整理，模型结果为规则化测算，**不构成投资建议**。

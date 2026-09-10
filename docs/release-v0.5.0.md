# v0.5.0 · 后端整体迁移到 Rust（单文件二进制，兼容性问题从根上消除）

> 发布日期：2026-09-10　｜　适用：Windows 10/11、macOS 11+（Apple Silicon / Intel）
>
> **本版把后端从 Python 换成 Rust 重写版**：安装包体积下降约 36%，不再依赖目标机器上的
> Python 解释器与第三方库版本，也就不会再出现 v0.4.0~v0.4.3 那种"打包出来后端起不来"的问题。
> **API 契约与前端完全不变**，界面、功能、数据目录、数据库表结构均与 v0.4.4 一致，
> 直接覆盖安装即可，已有对话与数据继续可用。

---

## 为什么要换

v0.4.4 修掉的是"Python 注解在 3.12 与 3.14 上求值时机不同"导致的崩溃，但它暴露的是一类
结构性问题：**后端行为依赖运行环境**（解释器小版本、第三方库版本、CPU 架构、PyInstaller 打包细节）。
团队里 5 个人、3 种机器（Windows / Apple Silicon / Intel Mac），每次都要赌"这次打出来的包能不能跑"。

Rust 版把这些问题一次性消掉：

| | Python 版（v0.4.4） | Rust 版（v0.5.0） |
|---|---|---|
| 运行依赖 | 需打包解释器 + pandas/akshare 等 | **无**（静态二进制，系统库之外零依赖） |
| 后端体积 | ~180 MB（onedir） | **9.3 MB**（单文件） |
| Windows 安装包 | 142.9 MB | **92.3 MB** |
| 启动方式 | 解释器加载 → 依赖导入 → 起服务 | 直接起服务（冷启动明显更快） |
| 跨平台构建 | 每个平台各打一次 PyInstaller | 每个平台 `cargo build --release`（原生编译） |
| 版本差异风险 | 解释器/库版本敏感 | 编译期确定 |

## 迁移范围（功能对齐，不是重写产品）

后端 7,875 行 Python 逐模块迁到 Rust，**API 契约、数据库、前端一行未改**：

- 六维评分引擎、预警生成与处置闭环、报告导出
- 数据源直连（新浪财务/三表、东方财富公告、巨潮诉讼、按需股票代码解析）
- Agent 循环（SSE 流式、工具调用、授权、上下文压缩、前缀缓存预热）
- 16 个内置工具 + 金融分析引擎（KPI / 杜邦 / Altman Z·Z'' / Piotroski F / Beneish M / 同业对标 / 异常勾稽）
- 技能库与 Agent 预设、手搓插件（声明式 HTTP 工具）、MCP 双向、设置面板、会话导出/导入/分享
- `run_risk_analysis`（LLM 研判）与风险事实接口

## 怎么保证"换语言但结果一样"

用**金标准比对**：把 Python 版正在用的数据库复制一份给 Rust 版，两边同时跑，逐项对比输出。

| 比对项 | 规模 | 结果 |
|---|---|---|
| 六维评分（9 家企业 × 综合分 + 6 维度） | 63 项 | 0 差异 |
| 金融引擎（4 家企业 × KPI / 杜邦 / 模型 / 异常 / 对标） | 272 项 | 0 差异 |
| P4 端点与内容（技能/预设/插件/设置/MCP/风险事实/会话导出） | 55 项 | 0 差异 |
| 空库播种（内置 5 技能 + 4 预设内容、设置元数据） | 43 项 | 0 差异 |
| 工具装配（内置 + 插件 + MCP 是否真进了模型 tools、预设白名单） | 15 项 | 0 差异 |
| LLM 研判与对话内工具链（含授权） | 35 项 | 0 差异 |

其中会话 **Markdown 导出与 Python 版逐字节一致**（3,040 字符），JSON 导出结构一致，
`/api/chat/usage` 全局统计一致。合计 **483 个比对项，0 处差异**。

> 时间戳也统一了：两个后端共用一个库文件时，落库形态与读出的 ISO 形态完全同形，
> 不会出现 `2026-09-08 12:09` 与 `2026-09-08T12:09` 混存。

## 体积与性能

| 指标 | v0.4.4 | v0.5.0 |
|---|---|---|
| 后端二进制 | ~180 MB（目录 + 解释器） | 9.3 MB |
| Windows 安装包 / 便携版 | 142.9 / 142.6 MB | 92.3 / 92.1 MB |
| 端到端对话（真实模型，3 次工具调用） | — | 4.2s，首字 0.27s，缓存命中 94% |
| 金融分析接口 | — | 与 Python 版同值，响应更快（无解释器开销） |

## 安装 / 升级

| 平台 | 文件 |
|---|---|
| Windows 10/11 | `RiskWarningPlatform-0.5.0-x64.exe`、`RiskWarningPlatform-0.5.0-portable.exe` |
| macOS Apple Silicon | `RiskWarningPlatform-0.5.0-mac-arm64.dmg` / `.zip` |
| macOS Intel | `RiskWarningPlatform-0.5.0-mac-x64.dmg` / `.zip` |
| macOS 免签名回退（源码方式运行） | `RiskWarningPlatform-0.5.0-macos-source.zip` |

校验：`SHA256SUMS-windows.txt` / `SHA256SUMS-macos-arm64.txt` / `SHA256SUMS-macos-x64.txt`

- 覆盖安装即可，**数据目录不变**（Windows `%APPDATA%\RiskWarningPlatform\data`，
  macOS `~/Library/Application Support/RiskWarningPlatform/data`），历史会话与已采集数据保留；
- 设置面板里的模型配置（`app_setting` 表）同样保留。

## macOS 首次打开

右键 App →「打开」→ 再点「打开」；或
`xattr -dr com.apple.quarantine "/Applications/企业经营风险预警平台.app"`；
或用 `-macos-source.zip`（右键 `start.command` → 打开）。

## 已知事项

- 安装包仍未做代码签名（无 Apple/微软开发者证书），macOS 首次打开需上述操作；
- `Altman Z`（市值口径）需要市值数据源，未配置时报告会明确写"不可计算"，以 `Z''`（账面口径）为准；
- macOS 源码回退包仍基于 Python 版后端（`server/`），作为免签名兜底保留，后续版本视情况下线。

## 后续计划

- 补市值数据源，让 Altman Z（市值口径）可用；
- 接入更多数据源与 MCP 服务，丰富手搓插件模板；
- 视团队使用情况决定是否彻底移除 `server/`（Python 参考实现目前仍用于金标准比对）。

> 数据来自公开信源，模型结果为规则化测算，不构成投资建议。

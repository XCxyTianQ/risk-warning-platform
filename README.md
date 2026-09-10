# risk-warning-platform

基于多模态大模型的企业经营风险预警平台（中国国际大学生创新创业大赛项目）。

## 技术栈决策（负责人确认后不再变更）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | **Rust（axum + tokio + rusqlite）** | v0.5.0 起由 Python 重写为单静态二进制，无运行时依赖 |
| 数据 | SQLite（原型期，表结构与 Python 版一致） | 后续可换 PostgreSQL |
| 前端 | Vue 3 + TypeScript + Vite + ECharts | 移动端之后再说 |
| 大模型 | OpenAI 兼容接口（DeepSeek / Qwen / GLM / vLLM / mock） | 三参数：base_url + api_key + model |
| 部署 | Docker（后置）+ 单台云服务器（后置） | 先本地跑通 |

MVP 边界：只做 **财务 / 法律 / 舆情** 三个风险维度；每维度先少量规则，先跑通纵向切片。

## 目录结构

```
risk-warning-platform/
├── docs/        # 调研、架构、设计文档（★ 骨架技术设计.md = 总设计文档）
├── backend/     # Rust 后端（正式实现，单文件二进制）
│   ├── src/
│   │   ├── main.rs        # 入口 + 建库 + 播种 + 绑定端口（打印 RWP_PORT）
│   │   ├── agent/         # Agent 循环、工具、会话与压缩、审批
│   │   ├── llm/           # 模型接入层（流式 + 工具调用 + 预热）
│   │   ├── services/      # 评分/金融/预警/研判/技能/预设/MCP/设置
│   │   └── api/           # HTTP 路由
│   └── tests/             # 金标准比对探针（与 Python 版逐项对比）
├── server/      # Python 后端（参考实现，仅用于金标准比对与 macOS 源码兜底）
├── web/         # Vue3 + TS 前端
├── desktop/     # Electron 桌面端（内嵌 Rust 二进制）
├── data/        # 数据与产物目录（样本数据、SQLite 等，git 忽略）
└── scripts/     # 辅助脚本
```

## 快速开始

后端（Rust，推荐）：

```powershell
cd backend
cargo run -- --port 8001 --data-dir ../data --web-dist ../web/dist
# http://127.0.0.1:8001/api/health
```

后端（Python 参考实现，仅迁移期比对用）：

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8001
# 注：8000 被本机另一服务占用，项目统一用 8001
```

前端：

```powershell
cd web
npm install
npm run dev        # http://localhost:5173 （/api 已代理到 8001）
```

模型接入：默认指向本地 mock（`http://127.0.0.1:9000/v1`），启动：

```powershell
python server/tests/mock_llm.py
```

## 当前进度

- [x] 阶段 0：技术方案确认
- [x] 阶段 1：工程初始化（本骨架）
- [x] 阶段 2：最小纵向切片（企业研判 → 六维评分画像 → 证据链）
- [x] **Agent 化重构（对话式研判）**：SSE 流式对话 + 工具循环（搜索/画像/事实/研判），对齐 Harness/Codex 设计哲学
- [x] **数据源接入**：多信源直连（东财/新浪/巨潮）+ 自由添加企业 + 数据状态门控
- [x] **预警中心闭环**：评分自动生成工单 → 处置流转 → 处理流水 → 报告导出
- [x] **成本控制**：对话压缩（DSH 前缀缓存复用）+ 缓存命中/用量常驻可视化 + 提示词缓存预热
- [x] **生态能力**：MCP 双向接入 + 技能库 + Agent 预设/手搓插件 + JSON 导入导出
- [x] **对话管理**：搜索/置顶/重命名/清空/导出 MD+JSON/只读分享链接
- [x] **桌面端**：Electron + 内嵌**Rust 单文件后端**（动态端口 / 独立数据目录 / 托盘菜单）
- [x] **后端 Rust 化**：7,875 行 Python 逐模块迁移，API 契约与前端不变，483 项金标准比对 0 差异
- [ ] 阶段 3：数据层扩展（100 家企业批量采集）
- [ ] 阶段 6：测试评测部署材料

## 桌面端（Windows exe / macOS dmg）

见 [`desktop/README.md`](desktop/README.md) 与 [`docs/桌面端-Windows-exe方案评估.md`](docs/桌面端-Windows-exe方案评估.md)。

```powershell
cd desktop
npm install
npm run dev      # 开发运行（自动探测 backend/target/{release,debug} 下的 Rust 二进制）
npm run dist     # 打包安装包 + 便携版（node scripts/build-backend.js 会用 cargo 构建后端）
```

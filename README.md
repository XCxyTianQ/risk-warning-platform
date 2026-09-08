# risk-warning-platform

基于多模态大模型的企业经营风险预警平台（中国国际大学生创新创业大赛项目）。

## 技术栈决策（负责人确认后不再变更）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Python 3.14 + FastAPI + uvicorn | 轻量异步，开发效率高 |
| 数据 | PostgreSQL（原型期 SQLite） | 见 `server/.env.example` 的 `DATABASE_URL` |
| 前端 | Vue 3 + TypeScript + Vite + ECharts | 移动端之后再说 |
| 大模型 | OpenAI 兼容接口（DeepSeek / Qwen / GLM / vLLM / mock） | 三参数：base_url + api_key + model |
| 部署 | Docker（后置）+ 单台云服务器（后置） | 先本地跑通 |

MVP 边界：只做 **财务 / 法律 / 舆情** 三个风险维度；每维度先少量规则，先跑通纵向切片。

## 目录结构

```
risk-warning-platform/
├── docs/        # 调研、架构、设计文档（★ 骨架技术设计.md = 总设计文档）
├── server/      # FastAPI 后端
│   ├── app/
│   │   ├── main.py        # 入口 + /api/health + CORS
│   │   ├── core/config.py # 环境变量配置（LLM 三参数、数据库）
│   │   └── llm/           # 大模型接入层（client/agent/tools/memory 骨架）
│   └── tests/             # mock_llm.py 离线模拟器等
├── web/         # Vue3 + TS 前端
├── data/        # 数据与产物目录（样本数据、SQLite 等，git 忽略）
└── scripts/     # 辅助脚本
```

## 快速开始

后端：

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8001
# http://127.0.0.1:8001/api/health （注：8000 被本机另一服务占用，项目统一用 8001）
```

前端：

```powershell
cd web
npm install
npm run dev        # http://localhost:5173 （/api 已代理到 8000）
```

模型接入：默认指向本地 mock（`http://127.0.0.1:9000/v1`），启动：

```powershell
python server/tests/mock_llm.py
```

## 当前进度

- [x] 阶段 0：技术方案确认
- [x] 阶段 1：工程初始化（本骨架）
- [ ] 阶段 2：最小纵向切片（1 家企业 → 3 类数据 → mock 推理 → 规则 → 详情页）
- [ ] 阶段 3：数据层扩展
- [ ] 阶段 4：预警引擎成形
- [ ] 阶段 5：平台页面完整化
- [ ] 阶段 6：测试评测部署材料

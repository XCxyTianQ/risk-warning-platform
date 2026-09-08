# data/ 数据目录说明

本目录存放原始数据与处理产物，**全部被 .gitignore 忽略**（样例数据、SQLite 库等不入库）。

规划：

- `samples/`        — 样例企业（阶段2：1 家企业的涉诉/新闻/财报 3 类数据）
- `enterprises/`    — 100 家企业公开信息（成员3 按模板收集）
- `platform.db`     — SQLite 原型库（由 DATABASE_URL 指定）

模板与脚本在 `data/` 配套提交，数据本体只在本地 / 网盘流转。

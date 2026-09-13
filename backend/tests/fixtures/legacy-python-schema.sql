-- 旧库夹具（Python/SQLAlchemy 时代 schema，Rust 迁移前的真实形状）
--
-- 用途：bench 的 legacy-db-compat 套件用它建一个"升级前"的数据库，专门验证
--       Rust 后端在旧 schema 上仍能正常写入（旧库很多列是 NOT NULL 但没有 DEFAULT，
--       而 Rust 侧 INSERT 只写关心的列、其余依赖默认值）。
-- 来源：用 server/ 下的 Python 参考实现（uvicorn）指向空目录首次启动自动建表后导出。
-- 重新生成：python -c "..."（见 docs/v1 方案 9.8 节）或直接跑 bench 的夹具脚本。
-- 注意：这里只含**表结构与两条演示企业**，不含任何真实用户数据。

CREATE TABLE agent_preset (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	description VARCHAR(300) NOT NULL, 
	prompt_extra TEXT NOT NULL, 
	tools_json TEXT NOT NULL, 
	skills_json TEXT NOT NULL, 
	model_override VARCHAR(80) NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	builtin BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE TABLE alert (
	id INTEGER NOT NULL, 
	enterprise_id INTEGER NOT NULL, 
	level VARCHAR(10) NOT NULL, 
	dimension VARCHAR(30) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	summary TEXT NOT NULL, 
	evidence_json TEXT NOT NULL, 
	score FLOAT, 
	status VARCHAR(16) NOT NULL, 
	source VARCHAR(20) NOT NULL, 
	fingerprint VARCHAR(120) NOT NULL, 
	handler VARCHAR(60) NOT NULL, 
	notes_json TEXT NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	handled_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(enterprise_id) REFERENCES enterprise (id)
);
CREATE TABLE app_setting (
	"key" VARCHAR(60) NOT NULL, 
	value TEXT NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY ("key")
);
CREATE TABLE chat_message (
	id INTEGER NOT NULL, 
	session_id VARCHAR(40) NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	content TEXT NOT NULL, 
	tool_calls_json TEXT NOT NULL, 
	tool_call_id VARCHAR(60) NOT NULL, 
	tool_name VARCHAR(60) NOT NULL, 
	ts DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(session_id) REFERENCES chat_session (id)
);
CREATE TABLE chat_session (
	id VARCHAR(40) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	summary TEXT NOT NULL, 
	compacted_until INTEGER NOT NULL, 
	compact_count INTEGER NOT NULL, 
	pinned BOOLEAN NOT NULL, 
	share_token VARCHAR(32) NOT NULL, 
	share_created_at DATETIME, 
	prompt_tokens INTEGER NOT NULL, 
	completion_tokens INTEGER NOT NULL, 
	cache_hit_tokens INTEGER NOT NULL, 
	cache_miss_tokens INTEGER NOT NULL, 
	llm_calls INTEGER NOT NULL, 
	est_cost FLOAT NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE custom_tool (
	id INTEGER NOT NULL, 
	name VARCHAR(60) NOT NULL, 
	description VARCHAR(300) NOT NULL, 
	parameters_json TEXT NOT NULL, 
	method VARCHAR(10) NOT NULL, 
	url VARCHAR(400) NOT NULL, 
	headers_json TEXT NOT NULL, 
	body_template TEXT NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	require_approval BOOLEAN NOT NULL, 
	builtin BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE TABLE enterprise (
	id INTEGER NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	unified_code VARCHAR(40) NOT NULL, 
	stock_code VARCHAR(10) NOT NULL, 
	legal_rep VARCHAR(80) NOT NULL, 
	reg_capital_wan FLOAT NOT NULL, 
	reg_date VARCHAR(20) NOT NULL, 
	industry VARCHAR(80) NOT NULL, 
	address VARCHAR(300) NOT NULL, 
	data_note TEXT NOT NULL, 
	data_status_json TEXT NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE finance (
	id INTEGER NOT NULL, 
	enterprise_id INTEGER NOT NULL, 
	year VARCHAR(10) NOT NULL, 
	report_type VARCHAR(40) NOT NULL, 
	total_assets FLOAT NOT NULL, 
	total_liabilities FLOAT NOT NULL, 
	revenue FLOAT NOT NULL, 
	net_profit FLOAT NOT NULL, 
	debt_ratio FLOAT NOT NULL, 
	source VARCHAR(200) NOT NULL, 
	metrics_json TEXT NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(enterprise_id) REFERENCES enterprise (id)
);
CREATE TABLE legal_record (
	id INTEGER NOT NULL, 
	enterprise_id INTEGER NOT NULL, 
	case_no VARCHAR(60) NOT NULL, 
	doc_type VARCHAR(40) NOT NULL, 
	title VARCHAR(300) NOT NULL, 
	court VARCHAR(120) NOT NULL, 
	cause VARCHAR(120) NOT NULL, 
	amount FLOAT NOT NULL, 
	status VARCHAR(40) NOT NULL, 
	judgment_date VARCHAR(20) NOT NULL, 
	source VARCHAR(200) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(enterprise_id) REFERENCES enterprise (id)
);
CREATE TABLE mcp_server (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	url VARCHAR(300) NOT NULL, 
	auth_header VARCHAR(300) NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	require_approval BOOLEAN NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	status_detail TEXT NOT NULL, 
	tools_json TEXT NOT NULL, 
	tool_count INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	synced_at DATETIME, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE TABLE news (
	id INTEGER NOT NULL, 
	enterprise_id INTEGER NOT NULL, 
	title VARCHAR(300) NOT NULL, 
	content TEXT NOT NULL, 
	source VARCHAR(120) NOT NULL, 
	url VARCHAR(400) NOT NULL, 
	published_at VARCHAR(20) NOT NULL, 
	sentiment VARCHAR(20) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(enterprise_id) REFERENCES enterprise (id)
);
CREATE TABLE risk_fact (
	id INTEGER NOT NULL, 
	enterprise_id INTEGER NOT NULL, 
	dimension VARCHAR(30) NOT NULL, 
	text TEXT NOT NULL, 
	evidence_json TEXT NOT NULL, 
	confidence FLOAT NOT NULL, 
	ts DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(enterprise_id) REFERENCES enterprise (id)
);
CREATE TABLE skill (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	description VARCHAR(300) NOT NULL, 
	content TEXT NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	builtin BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (name)
);
CREATE INDEX ix_alert_created_at ON alert (created_at);
CREATE INDEX ix_alert_enterprise_id ON alert (enterprise_id);
CREATE INDEX ix_alert_fingerprint ON alert (fingerprint);
CREATE INDEX ix_alert_level ON alert (level);
CREATE INDEX ix_alert_status ON alert (status);
CREATE INDEX ix_chat_message_session_id ON chat_message (session_id);
CREATE INDEX ix_chat_session_pinned ON chat_session (pinned);
CREATE INDEX ix_chat_session_share_token ON chat_session (share_token);
CREATE INDEX ix_chat_session_updated_at ON chat_session (updated_at);
CREATE UNIQUE INDEX ix_enterprise_name ON enterprise (name);
CREATE INDEX ix_enterprise_stock_code ON enterprise (stock_code);
CREATE INDEX ix_enterprise_unified_code ON enterprise (unified_code);
CREATE INDEX ix_finance_enterprise_id ON finance (enterprise_id);
CREATE INDEX ix_legal_record_enterprise_id ON legal_record (enterprise_id);
CREATE INDEX ix_news_enterprise_id ON news (enterprise_id);
CREATE INDEX ix_risk_fact_enterprise_id ON risk_fact (enterprise_id);
INSERT INTO enterprise (name, unified_code, stock_code, industry, legal_rep, reg_capital_wan, reg_date, address, data_note, data_status_json) VALUES ('杭州深度求索人工智能基础技术研究有限公司', '_', '', '人工智能', '梁文锋', '1500.0', '2023-07-17', '浙江省杭州市（公开信息）', '非上市：无公开财报；工商/商标信息来自公开报道。', '{"finance": "never", "legal": "ok", "news": "ok"}');
INSERT INTO enterprise (name, unified_code, stock_code, industry, legal_rep, reg_capital_wan, reg_date, address, data_note, data_status_json) VALUES ('贵州茅台酒股份有限公司', '9152000071430580XT', '600519', '白酒制造', '张德芹', '125619.78', '1999-11-20', '贵州省仁怀市茅台镇', '上市公司（600519）；财务为演示数据，参考公开年报口径。', '{"finance": "ok", "legal": "empty", "news": "ok"}');

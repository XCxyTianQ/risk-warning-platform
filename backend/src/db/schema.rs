//! 数据库 schema（SQLite）。
//!
//! 表结构与原 Python 版 `app/db/models.py` 保持一致，便于前端与迁移期对照：
//! 时间统一存 ISO8601 文本，JSON 字段存文本。

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS enterprise (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    unified_code     TEXT NOT NULL DEFAULT '',
    stock_code       TEXT NOT NULL DEFAULT '',
    legal_rep        TEXT NOT NULL DEFAULT '',
    reg_capital_wan  REAL NOT NULL DEFAULT 0,
    reg_date         TEXT NOT NULL DEFAULT '',
    industry         TEXT NOT NULL DEFAULT '',
    address          TEXT NOT NULL DEFAULT '',
    data_note        TEXT NOT NULL DEFAULT '',
    data_status_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_enterprise_name ON enterprise(name);
CREATE INDEX IF NOT EXISTS idx_enterprise_code ON enterprise(stock_code);
CREATE INDEX IF NOT EXISTS idx_enterprise_unified ON enterprise(unified_code);

CREATE TABLE IF NOT EXISTS legal_record (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_id  INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    case_no        TEXT NOT NULL DEFAULT '',
    doc_type       TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL DEFAULT '',
    court          TEXT NOT NULL DEFAULT '',
    cause          TEXT NOT NULL DEFAULT '',
    amount         REAL NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT '',
    judgment_date  TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_legal_ent ON legal_record(enterprise_id);

CREATE TABLE IF NOT EXISTS news (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_id INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    title         TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL DEFAULT '',
    sentiment     TEXT NOT NULL DEFAULT 'neutral'
);
CREATE INDEX IF NOT EXISTS idx_news_ent ON news(enterprise_id);

CREATE TABLE IF NOT EXISTS finance (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_id     INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    year              TEXT NOT NULL DEFAULT '',
    report_type       TEXT NOT NULL DEFAULT '',
    total_assets      REAL NOT NULL DEFAULT 0,
    total_liabilities REAL NOT NULL DEFAULT 0,
    revenue           REAL NOT NULL DEFAULT 0,
    net_profit        REAL NOT NULL DEFAULT 0,
    debt_ratio        REAL NOT NULL DEFAULT 0,
    source            TEXT NOT NULL DEFAULT '',
    metrics_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_finance_ent ON finance(enterprise_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_key ON finance(enterprise_id, year, report_type);

CREATE TABLE IF NOT EXISTS risk_fact (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_id INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    dimension     TEXT NOT NULL DEFAULT '',
    text          TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '',
    confidence    REAL NOT NULL DEFAULT 0,
    ts            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fact_ent ON risk_fact(enterprise_id);

CREATE TABLE IF NOT EXISTS alert (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enterprise_id INTEGER NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    level         TEXT NOT NULL DEFAULT '',
    dimension     TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    score         REAL,
    status        TEXT NOT NULL DEFAULT 'pending',
    source        TEXT NOT NULL DEFAULT 'scoring',
    fingerprint   TEXT NOT NULL DEFAULT '',
    handler       TEXT NOT NULL DEFAULT '',
    notes_json    TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT '',
    handled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON alert(status);
CREATE INDEX IF NOT EXISTS idx_alert_fp ON alert(fingerprint);

CREATE TABLE IF NOT EXISTS chat_session (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT '新对话',
    created_at        TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL DEFAULT '',
    summary           TEXT NOT NULL DEFAULT '',
    compacted_until   INTEGER NOT NULL DEFAULT 0,
    compact_count     INTEGER NOT NULL DEFAULT 0,
    pinned            INTEGER NOT NULL DEFAULT 0,
    share_token       TEXT NOT NULL DEFAULT '',
    share_created_at  TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
    llm_calls         INTEGER NOT NULL DEFAULT 0,
    est_cost          REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_updated ON chat_session(updated_at);

CREATE TABLE IF NOT EXISTS chat_message (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    tool_calls_json TEXT NOT NULL DEFAULT '',
    tool_call_id    TEXT NOT NULL DEFAULT '',
    tool_name       TEXT NOT NULL DEFAULT '',
    ts              TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_message_session ON chat_message(session_id);

CREATE TABLE IF NOT EXISTS mcp_server (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    url              TEXT NOT NULL,
    auth_header      TEXT NOT NULL DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    require_approval INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'unknown',
    status_detail    TEXT NOT NULL DEFAULT '',
    tools_json       TEXT NOT NULL DEFAULT '[]',
    tool_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT '',
    synced_at        TEXT
);

CREATE TABLE IF NOT EXISTS skill (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS custom_tool (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    description      TEXT NOT NULL DEFAULT '',
    parameters_json  TEXT NOT NULL DEFAULT '{}',
    method           TEXT NOT NULL DEFAULT 'GET',
    url              TEXT NOT NULL DEFAULT '',
    headers_json     TEXT NOT NULL DEFAULT '{}',
    body_template    TEXT NOT NULL DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    require_approval INTEGER NOT NULL DEFAULT 0,
    builtin          INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agent_preset (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    description    TEXT NOT NULL DEFAULT '',
    prompt_extra   TEXT NOT NULL DEFAULT '',
    tools_json     TEXT NOT NULL DEFAULT '[]',
    skills_json    TEXT NOT NULL DEFAULT '[]',
    model_override TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    builtin        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT '',
    updated_at     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);
"#;

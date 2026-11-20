// node:sqlite 单例 + 建表(幂等)+ meta KV
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { DATA_DIR, DB_PATH } from './config.js';

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  platform      TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'live',
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  collected_at  TEXT NOT NULL,
  engagement    INTEGER NOT NULL DEFAULT 0,
  extra         TEXT NOT NULL DEFAULT '{}',
  dedup_key     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_signals_collected ON signals(collected_at);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);

CREATE TABLE IF NOT EXISTS hotspots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '其他',
  keywords      TEXT NOT NULL DEFAULT '[]',
  heat_score    INTEGER NOT NULL DEFAULT 0,
  heat_trend    TEXT NOT NULL DEFAULT 'new',
  lifecycle     TEXT NOT NULL DEFAULT '萌芽',
  heat_series   TEXT NOT NULL DEFAULT '[]',
  signal_count  INTEGER NOT NULL DEFAULT 0,
  source_type   TEXT NOT NULL DEFAULT 'live',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hotspots_date ON hotspots(date);
CREATE INDEX IF NOT EXISTS idx_hotspots_source ON hotspots(source_type);

CREATE TABLE IF NOT EXISTS hotspot_signals (
  hotspot_id  INTEGER NOT NULL REFERENCES hotspots(id) ON DELETE CASCADE,
  signal_id   INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  is_original INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (hotspot_id, signal_id)
);

CREATE TABLE IF NOT EXISTS extend_results (
  hotspot_id INTEGER PRIMARY KEY REFERENCES hotspots(id) ON DELETE CASCADE,
  sections   TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  hotspot_id INTEGER PRIMARY KEY REFERENCES hotspots(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hotspot_id INTEGER NOT NULL REFERENCES hotspots(id) ON DELETE CASCADE,
  section    TEXT NOT NULL,
  rating     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (hotspot_id, section)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_cache (
  cache_key  TEXT PRIMARY KEY,
  markdown   TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT '中',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyze_cache (
  cache_key  TEXT PRIMARY KEY,
  sections   TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart (
  hotspot_id INTEGER PRIMARY KEY REFERENCES hotspots(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  page       TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  date       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(date);

CREATE TABLE IF NOT EXISTS app_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rating     INTEGER NOT NULL DEFAULT 5,
  text       TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  page       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- ---- 账号 / 会员 / 计费 ----

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,          -- 存前 lowercase 归一
  pass_hash     TEXT NOT NULL,                 -- 自描述: scrypt$N$r$p$saltB64$hashB64
  tier          TEXT NOT NULL DEFAULT 'free',  -- free|mid|high
  credits       INTEGER NOT NULL DEFAULT 0,
  trial_ends_at TEXT,                          -- ISO 时间;NULL = 无试用(老用户/已结束)
  plan_ends_at  TEXT NOT NULL DEFAULT '',      -- 时长卡到期时间(空=无;存前 2020-01-01 视为无)
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                 -- crypto.randomBytes(32).hex
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL                     -- created + SESSION_TTL_DAYS
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id      TEXT NOT NULL,                  -- p100/p300/p1000/d30/d90/d365/custom
  points       INTEGER NOT NULL,               -- 下单时积分快照(包改价不影响旧单)
  amount_cny   REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',-- pending|paid|cancelled
  plan_days    INTEGER NOT NULL DEFAULT 0,     -- 时长卡天数(积分包为 0)
  plan_tier    TEXT NOT NULL DEFAULT '',       -- 时长卡档位(时长卡生效后 effectiveTier)
  channel      TEXT NOT NULL DEFAULT '',       -- 支付渠道: alipay|mock|admin
  created_at   TEXT NOT NULL,
  paid_at      TEXT,
  confirmed_by TEXT                            -- 管理员邮箱 / 'payment:alipay' / 'payment:mock'
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS credit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,              -- +100 注册赠送 / +N 充值 / -1|-3|-10 扣费
  balance_after INTEGER NOT NULL,
  type          TEXT NOT NULL,                 -- register_gift|recharge|extend|analyze|report
  ref           TEXT NOT NULL DEFAULT '',      -- 如 'extend:12:why' / 'order:R20261023-x'
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_logs_user ON credit_logs(user_id, id DESC);
`);

// ---- 轻量迁移:为既有表补列 ----

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}

// 收藏兴趣层级:普通 / 高兴趣 / 有意向
ensureColumn('favorites', 'level', `ALTER TABLE favorites ADD COLUMN level TEXT NOT NULL DEFAULT '普通'`);

// 时长卡与支付渠道(计费改版)
ensureColumn('users', 'plan_ends_at', `ALTER TABLE users ADD COLUMN plan_ends_at TEXT NOT NULL DEFAULT ''`);
ensureColumn('users', 'plan_tier', `ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT ''`);
ensureColumn('orders', 'plan_days', `ALTER TABLE orders ADD COLUMN plan_days INTEGER NOT NULL DEFAULT 0`);
ensureColumn('orders', 'plan_tier', `ALTER TABLE orders ADD COLUMN plan_tier TEXT NOT NULL DEFAULT ''`);
ensureColumn('orders', 'channel', `ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT ''`);

export function metaGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function metaSet(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export const nowIso = () => new Date().toISOString();

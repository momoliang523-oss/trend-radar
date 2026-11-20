// 运营数据:停留时长上报 + 客户反馈 + 统计聚合(管理员专属 /api/stats)
import { db, metaGet, nowIso } from './db.js';
import { fmtLocalDate } from './util.js';
import { getProviderStatus } from './llm.js';
import { isCollecting } from './collectors/index.js';

// POST /api/track {session_id, page, ms} → 写入 visits
export function handleTrack(body) {
  const sessionId = String(body.session_id || '').slice(0, 64);
  const page = String(body.page || '').slice(0, 32);
  const ms = Math.max(0, Math.min(Number(body.ms) || 0, 24 * 3600 * 1000));
  if (!sessionId || !page) return { error: '缺少 session_id 或 page' };
  if (ms <= 0) return { ok: true, skipped: true };
  db.prepare(
    `INSERT INTO visits (session_id, page, duration_ms, date, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, page, Math.round(ms), fmtLocalDate(), nowIso());
  return { ok: true };
}

// POST /api/feedback {rating, text, contact, page} → 写入 app_feedback
export function handleFeedback(body) {
  const rating = Math.max(1, Math.min(Number(body.rating) || 5, 5));
  const text = String(body.text || '').slice(0, 2000);
  const contact = String(body.contact || '').slice(0, 200);
  const page = String(body.page || '').slice(0, 32);
  if (!text.trim()) return { error: '反馈内容不能为空' };
  db.prepare(
    `INSERT INTO app_feedback (rating, text, contact, page, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(Math.round(rating), text, contact, page, nowIso());
  return { ok: true };
}

// GET /api/feedback → 最近 N 条
export function getFeedback(limit = 50) {
  const rows = db.prepare('SELECT * FROM app_feedback ORDER BY id DESC LIMIT ?').all(limit);
  return { items: rows };
}

// GET /api/stats → 平均停留 + 反馈聚合 + 采集/LLM/数据量(仅管理员可见)
export function getOpsStats() {
  const total = db.prepare('SELECT COUNT(*) AS n, AVG(duration_ms) AS avg_ms FROM visits').get();
  const byPage = db
    .prepare('SELECT page, COUNT(*) AS n, AVG(duration_ms) AS avg_ms FROM visits GROUP BY page ORDER BY n DESC')
    .all();
  const fb = db.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg_rating FROM app_feedback').get();
  const recent = db.prepare('SELECT * FROM app_feedback ORDER BY id DESC LIMIT 5').all();
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const pendingOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`).get().n;
  return {
    dwell: {
      totalVisits: total.n || 0,
      avgSeconds: total.n ? Math.round(total.avg_ms / 1000) : 0,
      byPage: byPage.map((d) => ({ page: d.page, visits: d.n, avgSeconds: Math.round(d.avg_ms / 1000) })),
    },
    feedback: {
      count: fb.n || 0,
      avgRating: fb.n ? Math.round(fb.avg_rating * 10) / 10 : 0,
      recent,
    },
    ops: {
      collecting: isCollecting(),
      last_collect: metaGet('last_collect', ''),
      last_full_run: metaGet('last_full_run', ''),
      errors: {
        hn: metaGet('collect_error:hn', ''),
        reddit: metaGet('collect_error:reddit', ''),
        bing_news: metaGet('collect_error:bing_news', ''),
        google_news: metaGet('collect_error:google_news', ''),
        youtube: metaGet('collect_error:youtube', ''),
        bbc: metaGet('collect_error:bbc', ''),
        producthunt: metaGet('collect_error:producthunt', ''),
      },
      providers: getProviderStatus(),
      counts: {
        signals: count('signals'),
        hotspots: count('hotspots'),
        favorites: count('favorites'),
        extends: count('extend_results'),
        users: count('users'),
        orders_pending: pendingOrders,
      },
    },
  };
}

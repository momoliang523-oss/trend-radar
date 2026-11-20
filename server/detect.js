// 热点识别(简化版 PRD 6.2):token 重叠聚类 → 热度分 → 生命周期 → 落库
import { db, nowIso } from './db.js';
import { todayStr, clamp } from './util.js';
import { guessCategory } from './categories.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'this', 'that', 'these', 'those',
  'from', 'into', 'onto', 'about', 'your', 'you', 'how', 'why', 'what', 'when', 'where',
  'who', 'whom', 'will', 'was', 'were', 'are', 'been', 'has', 'have', 'had', 'not',
  'new', 'get', 'got', 'out', 'now', 'just', 'like', 'one', 'two', 'via', 'using',
  'make', 'made', 'shows', 'show', 'first', 'look', 'watch', 'video', 'day', 'today',
]);

function tokenize(s) {
  const words = (s || '').toLowerCase().replace(/[^\w#\s-]/g, ' ').split(/[\s-]+/);
  const out = new Set();
  for (let w of words) {
    w = w.replace(/^#/, '');
    if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return [...out];
}

function overlap(a, b) {
  const s = new Set(a);
  return b.filter((t) => s.has(t)).length;
}

// 热度分:互动量对数 + 跨源覆盖 + 增长 + 时效
function computeHeat(signals, olderCount) {
  const engagement = signals.reduce((a, s) => a + (s.engagement || 0), 0);
  const sources = new Set(signals.map((s) => s.platform)).size;
  let score = 12 * Math.log10(engagement + 1); // 互动量维度
  score += Math.min(15, 5 * (sources - 1)); // 跨源共振
  const avgAgeH = signals.reduce((a, s) => a + (Date.now() - new Date(s.collected_at).getTime()), 0) / signals.length / 3600000;
  score += olderCount > 0 ? 8 : 10; // 增长(此前无同类信号 = 新起势)
  score -= Math.min(10, avgAgeH * 0.15); // 时效衰减
  return Math.round(clamp(score, 5, 100));
}

export function detectHotspots() {
  const today = todayStr();
  const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(`SELECT * FROM signals WHERE source_type = 'live' AND collected_at >= ? ORDER BY engagement DESC`)
    .all(cutoff);
  if (!rows.length) return 0;

  // 聚类:与已有簇共享 ≥2 token 则并入
  const clusters = [];
  for (const s of rows) {
    const tokens = tokenize(s.title + ' ' + s.text);
    if (!tokens.length) continue;
    let best = null;
    for (const c of clusters) {
      const n = overlap(c.tokens, tokens);
      if (n >= 2 && (!best || n > best.n)) best = { c, n };
    }
    if (best) {
      best.c.signals.push(s);
      best.c.tokens = [...new Set([...best.c.tokens, ...tokens])].slice(0, 12);
    } else {
      clusters.push({ tokens, signals: [s] });
    }
  }

  const now = nowIso();
  const existingRows = db
    .prepare(`SELECT id, keywords FROM hotspots WHERE date = ? AND source_type = 'live'`)
    .all(today);
  const existing = existingRows.map((r) => ({ id: r.id, title: r.title, keywords: JSON.parse(r.keywords || '[]') }));

  // 先按热度排序:单条信号的热点数量设上限,避免日历被灌满(合并入既有热点的不受限)
  const candidates = [];
  for (const c of clusters) {
    // 成立条件:≥2 条信号或互动量 ≥800
    const engagement = c.signals.reduce((a, s) => a + (s.engagement || 0), 0);
    if (c.signals.length < 2 && engagement < 800) continue;
    const olderCount = db
      .prepare(`SELECT COUNT(*) AS n FROM signals WHERE source_type='live' AND collected_at < ? AND collected_at >= ?`)
      .get(cutoff, new Date(Date.now() - 96 * 3600 * 1000).toISOString()).n;
    candidates.push({ ...c, engagement, heat: computeHeat(c.signals, olderCount) });
  }
  candidates.sort((a, b) => b.heat - a.heat);

  // 单次运行最多新增 15 条,且当日 live 热点总量不超过 20 条(避免日历被灌满)
  const NEW_HOTSPOT_CAP = 15;
  const DAILY_LIVE_CAP = 20;
  const liveTodayCount = db
    .prepare(`SELECT COUNT(*) AS n FROM hotspots WHERE date = ? AND source_type = 'live'`)
    .get(today).n;
  let newCount = 0;
  let updated = 0;
  for (const c of candidates) {
    const engagement = c.engagement;
    const top = c.signals[0];

    // 同关键词/同标题的热点今天已存在 → 并入(不受数量上限约束)
    let hotspotId = null;
    for (const e of existing) {
      const ov = overlap(e.keywords, c.tokens);
      // 词集很小时放宽到 1 个共同词,否则要求 ≥2;标题完全相同直接并入
      if (ov >= 2 || (ov >= 1 && e.keywords.length <= 2) || e.title === top.title) {
        hotspotId = e.id;
        break;
      }
    }
    if (!hotspotId) {
      if (newCount >= NEW_HOTSPOT_CAP || liveTodayCount + newCount >= DAILY_LIVE_CAP) continue;
      newCount++;
    }

    const heat = c.heat;
    const category = guessCategory(c.signals[0].title, c.signals[0].text);

    if (hotspotId) {
      // 并入既有热点:补信号、重算热度
      const link = db.prepare('INSERT OR IGNORE INTO hotspot_signals (hotspot_id, signal_id, is_original) VALUES (?, ?, 0)');
      let cnt = 0;
      for (const s of c.signals) {
        const r = link.run(hotspotId, s.id);
        if (Number(r.changes) > 0) cnt++;
      }
      const hs = db.prepare('SELECT * FROM hotspots WHERE id = ?').get(hotspotId);
      const series = JSON.parse(hs.heat_series || '[]');
      if (!series.some(([d]) => d === today)) series.push([today, heat]);
      db.prepare(
        `UPDATE hotspots SET heat_score = ?, heat_trend = ?, lifecycle = ?, heat_series = ?, signal_count = (SELECT COUNT(*) FROM hotspot_signals WHERE hotspot_id = ?), updated_at = ? WHERE id = ?`
      ).run(heat, trendOf(series), stageOf(series), JSON.stringify(series.slice(-14)), hotspotId, now, hotspotId);
      updated++;
    } else {
      // 新热点
      const title = top.title;
      const summary = `「${title.slice(0, 60)}」在 ${top.platform} 上热度快速上升,当前热度 ${heat}/100。`;
      const series = [[today, heat]];
      const r = db.prepare(
        `INSERT INTO hotspots (date, title, summary, category, keywords, heat_score, heat_trend, lifecycle, heat_series, signal_count, source_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)`
      ).run(today, title, summary, category, JSON.stringify(c.tokens.slice(0, 8)), heat, 'new', stageOf(series), JSON.stringify(series), c.signals.length, now, now);
      const id = Number(r.lastInsertRowid);
      const link = db.prepare('INSERT OR IGNORE INTO hotspot_signals (hotspot_id, signal_id, is_original) VALUES (?, ?, ?)');
      c.signals.slice(0, 4).forEach((s) => link.run(id, s.id, 1));
      c.signals.slice(4).forEach((s) => link.run(id, s.id, 0));
      // 加入 existing,防止本次运行内重复创建
      existing.push({ id, title, keywords: c.tokens.slice(0, 8) });
      updated++;
    }
  }
  return updated;
}

function stageOf(series) {
  if (series.length <= 1) return '萌芽';
  const last = series[series.length - 1][1];
  const prev = series[series.length - 2][1];
  if (last >= prev && last >= 60) return '峰值';
  if (last >= prev) return '上升';
  return '衰退';
}

function trendOf(series) {
  if (series.length <= 1) return 'new';
  const d = series[series.length - 1][1] - series[series.length - 2][1];
  if (d > 3) return 'up';
  if (d < -3) return 'down';
  return 'flat';
}

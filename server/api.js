// REST 处理器:meta / calendar / hotspots / hotspot 详情 / favorites / collect / seed
import { db, metaGet, metaSet, nowIso } from './db.js';
import { APP_NAME, APP_VERSION, CATEGORIES, PLATFORMS, PORT } from './config.js';
import { fmtLocalDate, monthOf, safeJson } from './util.js';
import { getCachedExtend, getHotspot, getSignalsForHotspot } from './extend.js';
import { reseed } from './seed.js';
import { isCollecting, runCollect } from './collectors/index.js';

export const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

function cardFromRow(h, favoriteMap, cartMap) {
  return {
    id: h.id,
    date: h.date,
    title: h.title,
    summary: h.summary,
    category: h.category,
    heat_score: h.heat_score,
    heat_trend: h.heat_trend,
    lifecycle: h.lifecycle,
    platforms: (h.platforms || '').split(',').filter(Boolean),
    signal_count: h.signal_count,
    source_type: h.source_type,
    is_favorite: favoriteMap ? favoriteMap.has(h.id) : false,
    is_in_cart: cartMap ? cartMap.has(h.id) : false,
    level: favoriteMap ? (favoriteMap.get(h.id) || '普通') : '普通',
  };
}

function favoriteMap() {
  return new Map(db.prepare('SELECT hotspot_id, level FROM favorites').all().map((r) => [r.hotspot_id, r.level]));
}

function cartMap() {
  return new Set(db.prepare('SELECT hotspot_id FROM cart').all().map((r) => r.hotspot_id));
}

const HOTSPOT_SELECT = `
  SELECT h.*, (SELECT GROUP_CONCAT(DISTINCT s.platform) FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id WHERE hs.hotspot_id = h.id) AS platforms
  FROM hotspots h
`;

export async function getMeta() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  // 对外仅暴露应用常量;LLM 供应商/采集/运营数据一律在 /api/stats(管理员)里
  return {
    app: APP_NAME,
    version: APP_VERSION,
    tz,
    port: PORT,
    today: fmtLocalDate(),
    constants: { categories: CATEGORIES, platforms: PLATFORMS },
  };
}

// 周历条圆点:某月每天的热点数与最高热度(可随平台/品类过滤联动)
export function getCalendar(url) {
  const month = url.searchParams.get('month') || monthOf(fmtLocalDate());
  const platform = url.searchParams.get('platform') || '';
  const category = url.searchParams.get('category') || '';
  const where = ['h.date LIKE ?'];
  const args = [`${month}%`];
  if (platform) {
    where.push(`EXISTS (SELECT 1 FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id WHERE hs.hotspot_id = h.id AND s.platform = ?)`);
    args.push(platform);
  }
  if (category) {
    where.push('h.category = ?');
    args.push(category);
  }
  const rows = db
    .prepare(`SELECT h.date, COUNT(*) AS cnt, MAX(h.heat_score) AS mx FROM hotspots h WHERE ${where.join(' AND ')} GROUP BY h.date`)
    .all(...args);
  const days = {};
  for (const r of rows) days[r.date] = { count: r.cnt, max_heat: r.mx };
  return { month, platform, category, days };
}

// 热点卡片查询:
//  - 单日:date=YYYY-MM-DD(默认今天)
//  - 时间区间:from=YYYY-MM-DD&to=YYYY-MM-DD(日历区间模式)
//  - 关键词搜索:q=关键词(全库搜索,话题标题/摘要/关键词/信号标题文本)
//  - 通用筛选:platform / category / categories(我的类目)/ heat / trend
export function getHotspots(url) {
  const q = (url.searchParams.get('q') || '').trim();
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const date = url.searchParams.get('date') || fmtLocalDate();
  const platform = url.searchParams.get('platform') || '';
  const category = url.searchParams.get('category') || '';
  const heat = url.searchParams.get('heat') || ''; // hot|warm|cool
  const trend = url.searchParams.get('trend') || ''; // new|up|down|flat
  const categories = (url.searchParams.get('categories') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean); // 「只看我的」多类目
  const favs = favoriteMap();
  const carts = cartMap();
  const where = [];
  const args = [];
  if (q) {
    const like = `%${q}%`;
    where.push(`(h.title LIKE ? OR h.summary LIKE ? OR h.keywords LIKE ?
      OR EXISTS (SELECT 1 FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id
                 WHERE hs.hotspot_id = h.id AND (s.title LIKE ? OR s.text LIKE ?)))`);
    args.push(like, like, like, like, like);
  } else if (from && to) {
    where.push('h.date >= ? AND h.date <= ?');
    args.push(from, to);
  } else {
    where.push('h.date = ?');
    args.push(date);
  }
  if (platform) {
    where.push(`EXISTS (SELECT 1 FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id WHERE hs.hotspot_id = h.id AND s.platform = ?)`);
    args.push(platform);
  }
  if (category) {
    where.push('h.category = ?');
    args.push(category);
  } else if (categories.length) {
    where.push(`h.category IN (${categories.map(() => '?').join(',')})`);
    args.push(...categories);
  }
  if (heat === 'hot') where.push('h.heat_score >= 70');
  else if (heat === 'warm') where.push('h.heat_score >= 40 AND h.heat_score < 70');
  else if (heat === 'cool') where.push('h.heat_score < 40');
  if (trend) {
    where.push('h.heat_trend = ?');
    args.push(trend);
  }
  // 搜索场景跨全库,限制条数防刷屏;单日/区间按热度排序全量
  const limit = q ? ' LIMIT 50' : '';
  const rows = db.prepare(`${HOTSPOT_SELECT} WHERE ${where.join(' AND ')} ORDER BY h.heat_score DESC, h.id DESC${limit}`).all(...args);
  return { date, from, to, q, platform, category, heat, trend, items: rows.map((h) => cardFromRow(h, favs, carts)) };
}

// 热点详情:头部 + 原始/关联信号 + 缓存延伸结果 + 收藏态 + 反馈
export function getHotspotDetail(url, id) {
  const hotspot = getHotspot(id);
  if (!hotspot) return { error: '热点不存在', status: 404 };
  const signals = getSignalsForHotspot(id).map((s) => ({
    id: s.id,
    platform: s.platform,
    source: s.source,
    source_type: s.source_type,
    title: s.title,
    text: s.text,
    url: s.url,
    author: s.author,
    published_at: s.published_at,
    collected_at: s.collected_at,
    engagement: s.engagement,
    extra: safeJson(s.extra, {}),
  }));
  const original = signals.filter((_, i) => i < 4);
  const related = signals.slice(4);
  const extend = getCachedExtend(id);
  const feedbackRows = db.prepare('SELECT section, rating FROM feedback WHERE hotspot_id = ?').all(id);
  const feedback = {};
  for (const f of feedbackRows) feedback[f.section] = f.rating;
  return {
    hotspot: {
      id: hotspot.id,
      date: hotspot.date,
      title: hotspot.title,
      summary: hotspot.summary,
      category: hotspot.category,
      keywords: safeJson(hotspot.keywords, []),
      heat_score: hotspot.heat_score,
      heat_trend: hotspot.heat_trend,
      lifecycle: hotspot.lifecycle,
      heat_series: safeJson(hotspot.heat_series, []),
      signal_count: hotspot.signal_count,
      source_type: hotspot.source_type,
    },
    signals: { original, related },
    extend: extend ? { sections: sanitizeSections(extend.sections), created_at: extend.created_at, updated_at: extend.updated_at } : null,
    feedback,
    is_favorite: db.prepare('SELECT 1 FROM favorites WHERE hotspot_id = ?').get(id) !== undefined,
  };
}

// 出口脱敏:分区剥离 provider/model,降级标志唯一依据 = degraded
export function sanitizeSections(sections) {
  const out = {};
  for (const [k, v] of Object.entries(sections || {})) {
    out[k] = {
      status: v.status,
      markdown: v.markdown,
      confidence: v.confidence,
      citations: v.citations,
      degraded: v.provider === 'template',
    };
  }
  return out;
}

// 收藏
export function getFavorites() {
  const favs = favoriteMap();
  const carts = cartMap();
  const rows = db
    .prepare(
      `${HOTSPOT_SELECT} JOIN favorites f ON f.hotspot_id = h.id ORDER BY f.created_at DESC, h.date DESC`
    )
    .all();
  const items = rows.map((h) => cardFromRow(h, favs, carts));
  return { items, suggestion: favoriteSuggestion() };
}

export function addFavorite(id, level = '普通') {
  const h = getHotspot(id);
  if (!h) return { error: '热点不存在', status: 404 };
  db.prepare('INSERT OR IGNORE INTO favorites (hotspot_id, level, created_at) VALUES (?, ?, ?)').run(id, level, nowIso());
  return { ok: true, is_favorite: true, level };
}

export function removeFavorite(id) {
  db.prepare('DELETE FROM favorites WHERE hotspot_id = ?').run(id);
  return { ok: true, is_favorite: false };
}

// 选品购物车
export function getCart() {
  const favs = favoriteMap();
  const carts = cartMap();
  const rows = db
    .prepare(`${HOTSPOT_SELECT} JOIN cart c ON c.hotspot_id = h.id ORDER BY c.created_at DESC, h.date DESC`)
    .all();
  return { items: rows.map((h) => cardFromRow(h, favs, carts)) };
}

export function addToCart(id) {
  const h = getHotspot(id);
  if (!h) return { error: '热点不存在', status: 404 };
  db.prepare('INSERT OR IGNORE INTO cart (hotspot_id, created_at) VALUES (?, ?)').run(id, nowIso());
  return { ok: true, is_in_cart: true };
}

export function removeFromCart(id) {
  db.prepare('DELETE FROM cart WHERE hotspot_id = ?').run(id);
  return { ok: true, is_in_cart: false };
}

const LEVELS = ['普通', '高兴趣', '有意向'];

export function setFavoriteLevel(id, level) {
  if (!LEVELS.includes(level)) return { error: '未知层级', status: 400 };
  const r = db.prepare('UPDATE favorites SET level = ? WHERE hotspot_id = ?').run(level, id);
  if (Number(r.changes) === 0) return { error: '尚未收藏该热点', status: 404 };
  return { ok: true, level };
}

// 同品类收藏 ≥3 条且均为「普通」→ 提示升级层级
function favoriteSuggestion() {
  const rows = db
    .prepare(
      `SELECT h.category, COUNT(*) AS n, MAX(CASE f.level WHEN '高兴趣' THEN 1 WHEN '有意向' THEN 1 ELSE 0 END) AS upgraded
       FROM favorites f JOIN hotspots h ON h.id = f.hotspot_id GROUP BY h.category HAVING n >= 3`
    )
    .all();
  const hit = rows.find((r) => !r.upgraded);
  return hit ? { category: hit.category, count: hit.n } : null;
}

// 手动采集(异步执行,立即返回)
export function triggerCollect() {
  if (isCollecting()) return { started: false, reason: 'already-running' };
  runCollect().then((r) => console.log('[api] 手动采集完成:', JSON.stringify(r.report || []).slice(0, 300)));
  return { started: true };
}

// 重建演示数据
export function resetSeed() {
  const r = reseed();
  return { ok: true, seeded: r.hotspots, signals: r.signals };
}

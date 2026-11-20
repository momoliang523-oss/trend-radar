// UN Comtrade 贸易数据客户端:按 HS 编码统计主要市场的进口额(确定性统计,用于选品出图)
// 用官方「公开预览接口」,无需注册、无需 API key:
//   GET /public/v1/preview/C/A/HS?reporterCode=...&period=YYYY&partnerCode=0&cmdCode=...&flowCode=M
// 预览限制:单次 1 个 period、500 条记录、约 2 秒限 1 次 → 请求串行 + 间隔 + 429 重试
// 拆成两段:latest 一次请求(~3 秒,先出柱图)/ trend 五次请求(~25 秒,后台补折线)
// 降级:关键词匹配不到 HS 编码 / 接口失败 → 前端整块隐藏,不影响主分析
import { db, nowIso } from './db.js';
import { todayStr } from './util.js';

const BASE = process.env.COMTRADE_BASE_URL || 'https://comtradeapi.un.org';
const TIMEOUT_MS = 25000;
const TREND_YEARS = 5;

// 主要出海市场(UN M49 代码 → 中文名)
const MARKETS = [
  [842, '美国'], [276, '德国'], [826, '英国'], [392, '日本'], [250, '法国'],
  [484, '墨西哥'], [76, '巴西'], [410, '韩国'], [124, '加拿大'], [36, '澳大利亚'],
  [724, '西班牙'], [380, '意大利'],
];

// 中文关键词 → HS 编码(6 位或 4 位)。只收录常见铺货品类,保证「图上的数字确实是这个品类」
const HS_DICT = [
  { kw: ['猫粮', '狗粮', '宠物粮', '猫罐头', '狗罐头', '宠物食品'], code: '230910', label: '狗粮/猫粮' },
  { kw: ['假睫毛', '睫毛', '假发', '接发'], code: '670420', label: '假发/假睫毛' },
  { kw: ['帐篷', '露营', '天幕', '野营'], code: '630622', label: '帐篷' },
  { kw: ['睡袋'], code: '940430', label: '睡袋' },
  { kw: ['保温杯', '水杯', '马克杯', '杯子'], code: '961700', label: '保温杯/真空容器' },
  { kw: ['玩具', '积木', '毛绒'], code: '9503', label: '玩具' },
  { kw: ['手机壳', '保护壳'], code: '392690', label: '塑料制品(含手机壳)' },
  { kw: ['耳机', '蓝牙耳机', '耳麦'], code: '851830', label: '耳机/耳麦' },
  { kw: ['充电宝', '移动电源'], code: '850760', label: '锂离子电池(充电宝)' },
  { kw: ['充电器', '充电头'], code: '850440', label: '充电器' },
  { kw: ['数据线', '充电线'], code: '854442', label: '数据线' },
  { kw: ['空气炸锅', '电烤箱', '烤箱'], code: '851660', label: '电烤箱/空气炸锅' },
  { kw: ['吹风机'], code: '851631', label: '吹风机' },
  { kw: ['电动牙刷'], code: '850980', label: '电动牙刷' },
  { kw: ['吸尘器'], code: '850811', label: '吸尘器' },
  { kw: ['咖啡机'], code: '851671', label: '咖啡机' },
  { kw: ['化妆品', '护肤品', '面膜', '彩妆', '美妆'], code: '330499', label: '护肤品/化妆品' },
  { kw: ['口红', '唇膏'], code: '330410', label: '口红' },
  { kw: ['香水'], code: '330300', label: '香水' },
  { kw: ['洗发水', '洗发液'], code: '330510', label: '洗发水' },
  { kw: ['瑜伽垫', '健身器材', '哑铃', '健身'], code: '950691', label: '健身器材' },
  { kw: ['自行车'], code: '871200', label: '自行车' },
  { kw: ['电动滑板车', '滑板车'], code: '871160', label: '电动滑板车' },
  { kw: ['led灯', '灯串', '照明', '台灯'], code: '9405', label: '灯具' },
  { kw: ['家具', '沙发', '桌椅'], code: '9403', label: '家具' },
  { kw: ['餐具', '餐盘'], code: '392410', label: '塑料餐具' },
  { kw: ['包包', '背包', '手提包', '钱包'], code: '4202', label: '箱包' },
  { kw: ['鞋子', '运动鞋', '拖鞋'], code: '6404', label: '鞋类' },
  { kw: ['饰品', '首饰', '项链', '耳环'], code: '7117', label: '仿首饰' },
];

export function tradeMatch(q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return null;
  for (const d of HS_DICT) {
    const hit = d.kw.find((k) => s === k || s.includes(k));
    if (hit) return { ...d, matchedWord: hit };
  }
  return null;
}

// 预览接口限流:约 2 秒 1 次,429 时按提示等待重试;请求串行化,避免互相挤掉
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;
async function throttle() {
  const wait = Math.max(0, lastAt + 2100 - Date.now());
  if (wait) await sleep(wait);
  lastAt = Date.now();
}

async function preview({ period, cmdCode }) {
  const reporters = MARKETS.map((m) => m[0]).join(',');
  const url = `${BASE}/public/v1/preview/C/A/HS?reporterCode=${reporters}&period=${period}&partnerCode=0&cmdCode=${cmdCode}&flowCode=M`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 429) { await sleep(2200); continue; }
    if (!r.ok) throw new Error(`comtrade HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(`comtrade: ${String(d.error).slice(0, 120)}`);
    return (d.data || []).map((x) => ({ reporter: Number(x.reporterCode), value: Number(x.primaryValue) || 0 }));
  }
  throw new Error('comtrade 限流(429)');
}

const cacheGet = (key) => {
  const hit = db.prepare('SELECT sections, created_at FROM analyze_cache WHERE cache_key = ?').get(key);
  if (!hit) return null;
  try { return { ...JSON.parse(hit.sections), created_at: hit.created_at }; } catch { return null; }
};
const cachePut = (key, data) => {
  db.prepare(
    `INSERT INTO analyze_cache (cache_key, sections, provider, model, created_at) VALUES (?, ?, 'comtrade', '', ?)
     ON CONFLICT(cache_key) DO UPDATE SET sections = excluded.sections, created_at = excluded.created_at`
  ).run(key, JSON.stringify(data), nowIso());
};

// 最近一个完整年度(当年数据不完整);若该年没数据,最多往前退 2 年
async function collectLatest(code) {
  const nameOf = new Map(MARKETS);
  const start = new Date().getFullYear() - 1;
  for (const y of [start, start - 1, start - 2]) {
    const rows = await preview({ period: y, cmdCode: code });
    const latest = rows
      .filter((x) => nameOf.has(x.reporter) && x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((x) => ({ name: nameOf.get(x.reporter), value: Math.round((x.value / 1e8) * 100) / 100 }));
    if (latest.length) return { latestYear: y, latest };
  }
  return { latestYear: start, latest: [] };
}

// 近 5 年合计(串行,约 25 秒);0 = 该年未检索到数据,不是插值
async function collectTrend(code) {
  const nameOf = new Map(MARKETS);
  const latestYear = new Date().getFullYear() - 1;
  const years = [];
  for (let i = TREND_YEARS - 1; i >= 0; i--) years.push(latestYear - i);
  const byYear = new Map();
  let lastErr = null;
  for (const y of years) {
    try { byYear.set(y, await preview({ period: y, cmdCode: code })); } catch (e) { lastErr = e; }
  }
  if (!byYear.size) throw lastErr || new Error('comtrade unavailable');
  const trend = years.map((y) => {
    const rows = byYear.get(y) || [];
    const sum = rows.reduce((a, x) => a + (nameOf.has(x.reporter) ? x.value : 0), 0);
    return { date: String(y), avg: Math.round((sum / 1e8) * 100) / 100 };
  });
  return { trend };
}

const inflight = new Map();

function cachedCall(part, q, collector) {
  const m = tradeMatch(q);
  if (!m) return Promise.resolve({ enabled: true, matched: false });
  const key = `ct${part === 'latest' ? 'L' : 'T'}:${m.code}:${todayStr()}`;
  const hit = cacheGet(key);
  if (hit) return Promise.resolve({ enabled: true, matched: true, cached: true, code: m.code, label: m.label, ...hit });
  if (inflight.has(key)) return inflight.get(key);
  const p = collector(m.code)
    .then((data) => {
      cachePut(key, data);
      return { enabled: true, matched: true, cached: false, code: m.code, label: m.label, ...data };
    })
    .catch((e) => ({
      enabled: true,
      matched: true,
      code: m.code,
      label: m.label,
      error: String(e.message || e).slice(0, 160),
      ...(part === 'latest' ? { latestYear: new Date().getFullYear() - 1, latest: [] } : { trend: [] }),
    }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// 主入口:q → HS 编码 → 当日缓存;part=latest(柱图)/ trend(折线)
export function getTradeLatest(q) { return cachedCall('latest', q, collectLatest); }
export function getTradeTrend(q) { return cachedCall('trend', q, collectTrend); }

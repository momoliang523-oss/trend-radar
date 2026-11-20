// 类目品分析 API:
// GET /api/category/context?q=&cat= → 匹配上下文(候选类目 + 数据图表数据,不消耗积分,开放)
// GET /api/category/research?q=&cat= → 行业研报(发现报告):研报卡 + 月度覆盖/机构分布(需登录,不扣积分)
// GET /api/category/trade?q= → 品类进口趋势(UN Comtrade 免注册预览接口):主要市场进口额(需登录,不扣积分)
// GET /api/category/stream?q=&cat=&force=1 → SSE(需登录,余额预检在前)
// GET /api/category/cached?q=&cat= → 缓存预读(已脱敏)
// GET /api/category/copy?q=&cat= → SSE 文字版自媒体文案(仅管理员,不扣费)
import { runCategorySearch, getCachedCategorySearch, runCategoryCopy, buildSearchContext } from './category.js';
import { getResearch } from './fxbaogao.js';
import { getTradeLatest, getTradeTrend } from './comtrade.js';
import { precheckCredits } from './billing.js';
import { json } from './api.js';

const readParams = (url) => ({
  q: (url.searchParams.get('q') || '').trim().slice(0, 40),
  cat: (url.searchParams.get('cat') || '').trim().slice(0, 30),
});

// 匹配上下文(先选类目阶段用):候选类目/关联词 + 市场数据(图表渲染用),不消耗积分
export function handleCategoryContext(url) {
  const { q, cat } = readParams(url);
  if (!q) return { q: '', error: '请输入要分析的类目或产品关键词', categories: [], relatedWords: [] };
  const ctx = buildSearchContext(q, cat);
  if (ctx.error) return { q, cat, error: ctx.error, categories: [], relatedWords: [] };
  return { q, cat, scope: ctx.scope, focusMiss: ctx.focusMiss, window: ctx.window, matched: ctx.matched, stats: ctx.stats };
}

// 行业研报(发现报告):不调用 LLM、不扣积分;未配置 FXBAOGAO_API_KEY → { enabled:false }
export async function handleCategoryResearch(url) {
  const { q, cat } = readParams(url);
  if (!q) return { enabled: true, error: '缺少关键词', reports: [], monthly: [], orgs: [], industries: [], total: 0 };
  return getResearch(q, cat);
}

// 品类进口趋势(UN Comtrade 公开预览接口,无需注册):不调用 LLM、不扣积分;关键词匹配不到 HS 编码 → { matched:false }
// ?part=latest(默认,柱图,约 3 秒)/ ?part=trend(折线,约 25 秒)
export async function handleCategoryTrade(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
  const part = url.searchParams.get('part') === 'trend' ? 'trend' : 'latest';
  if (!q) return { enabled: true, matched: false, error: '缺少关键词' };
  return part === 'trend' ? getTradeTrend(q) : getTradeLatest(q);
}

export function handleCategoryStream(req, res, url, auth) {
  const { q, cat } = readParams(url);
  const force = url.searchParams.get('force') === '1';
  const targetPlatforms = (url.searchParams.get('platforms') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // ?model= 一律忽略:模型只由会员档位决定

  if (!q) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '请输入要分析的类目或产品关键词' }));
  }

  // 余额预检(类目分析 3 个分区)
  const pre = precheckCredits(auth.user, 3);
  if (!pre.ok) return json(res, 402, { error: pre.error, code: pre.code, credits: pre.credits });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });

  const send = ({ event, data }) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  runCategorySearch({ q, cat, force, onEvent: send, signal: abort.signal, targetPlatforms, user: auth.user })
    .catch((e) => send({ event: 'error', data: { message: String(e.message || e).slice(0, 300) } }))
    .finally(() => {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    });
}

// 预取缓存:GET /api/category/cached?q=&cat= → {cached: {...}|null}(已脱敏)
export function handleCategoryCached(url) {
  const { q, cat } = readParams(url);
  if (!q) return { cached: null };
  const cached = getCachedCategorySearch(q, cat);
  if (!cached) return { cached: null };
  const sections = {};
  for (const [k, v] of Object.entries(cached.sections || {})) {
    const { provider, model, ...rest } = v;
    sections[k] = { ...rest, degraded: provider === 'template' };
  }
  return { cached: { sections, created_at: cached.created_at } };
}

// 文字版自媒体文案(仅管理员,不扣费):SSE delta {text} / done {ok, markdown}
export function handleCategoryCopy(req, res, url) {
  const { q, cat } = readParams(url);
  if (!q) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少关键词' }));
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });

  const send = ({ event, data }) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  runCategoryCopy({ q, cat, onEvent: send, signal: abort.signal })
    .catch((e) => send({ event: 'error', data: { message: String(e.message || e).slice(0, 300) } }))
    .finally(() => {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    });
}

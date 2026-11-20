// 深度分析 API:GET /api/analyze/stream?scope=category|hotspot&key|id&type&end&force → SSE(需登录,余额预检在前)
import { runAnalyze, getCachedAnalyze, stripSection } from './analyze.js';
import { REPORT_TYPES, periodRange } from './report.js';
import { fmtLocalDate } from './util.js';
import { precheckCredits } from './billing.js';
import { json } from './api.js';

function parseParams(url) {
  const scope = url.searchParams.get('scope') === 'hotspot' ? 'hotspot' : 'category';
  const key = url.searchParams.get('key') || '';
  const id = Number(url.searchParams.get('id') || 0);
  const type = REPORT_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'month';
  const end = url.searchParams.get('end') || fmtLocalDate();
  return { scope, key, id, type, end };
}

export function handleAnalyzeStream(req, res, url, auth) {
  const { scope, key, id, type, end } = parseParams(url);
  const force = url.searchParams.get('force') === '1';
  const targetPlatforms = (url.searchParams.get('platforms') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // ?model= 一律忽略:模型只由会员档位决定

  if (scope === 'category' && !key) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少品类参数 key' }));
  }
  if (scope === 'hotspot' && !id) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少热点参数 id' }));
  }

  // 余额预检(深度分析 3 个分区)
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

  runAnalyze({ scope, key, id, type, end, force, onEvent: send, signal: abort.signal, targetPlatforms, user: auth.user })
    .catch((e) => send({ event: 'error', data: { message: String(e.message || e).slice(0, 300) } }))
    .finally(() => {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    });
}

// 预取缓存:GET /api/analyze/cached?scope&key|id&type&end → {cached: {...}|null}(已脱敏)
export function handleAnalyzeCached(url) {
  const { scope, key, id, type, end } = parseParams(url);
  const { end: endStr } = periodRange(type, end);
  const cacheKey = scope === 'hotspot' ? String(id) : key;
  const cached = getCachedAnalyze(scope, cacheKey, endStr);
  if (!cached) return { cached: null };
  const sections = {};
  for (const [k, v] of Object.entries(cached.sections || {})) sections[k] = stripSection(v);
  return { cached: { sections, created_at: cached.created_at } };
}

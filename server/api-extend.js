// 一键延伸 SSE 端点 + 分区重试 + 反馈(SSE 前置:登录 401 / 余额 402,均在 writeHead 之前)
import { json } from './api.js';
import { db, nowIso } from './db.js';
import { runExtend, runExtendSection, retrySection, isGenerating, isGeneratingSection, getHotspot } from './extend.js';
import { SECTION_ORDER } from './prompts.js';
import { precheckCredits, currentBalance } from './billing.js';

// GET /api/extend/:id?force=&section=&platforms= → SSE 流(带 section 则单分区)
export async function handleExtendSSE(req, res, id, auth) {
  const url = new URL(req.url, 'http://x');
  const force = url.searchParams.get('force') === '1';
  const section = url.searchParams.get('section') || '';
  const targetPlatforms = (url.searchParams.get('platforms') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // ?model= 一律忽略:模型只由会员档位决定

  if (!getHotspot(id)) return json(res, 404, { error: '热点不存在' });
  if (section) {
    if (!SECTION_ORDER.includes(section)) return json(res, 400, { error: '未知分区' });
    if (isGeneratingSection(id, section)) return json(res, 409, { error: 'generating', message: '该分区正在生成中,请稍候' });
  } else if (isGenerating(id)) {
    return json(res, 409, { error: 'generating', message: '该热点正在生成分析中,请稍候' });
  }

  // 余额预检(试用期不限次;全量按 4 分区)
  const units = section ? 1 : 4;
  const pre = precheckCredits(auth.user, units);
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

  // 入场余额(单分区路径无 meta 事件,这里统一发一次)
  send({ event: 'meta', data: { hotspotId: id, credits: currentBalance(auth.user.id) } });

  try {
    const result = section
      ? await runExtendSection({ hotspotId: id, section, user: auth.user, force, onEvent: send, signal: abort.signal, targetPlatforms })
      : await runExtend({ hotspotId: id, user: auth.user, force, onEvent: send, signal: abort.signal, targetPlatforms });
    if (result.error && !res.writableEnded) send('error', { message: result.error });
    else if (result.conflict && !res.writableEnded) send('error', { message: 'generating' });
  } catch (e) {
    send('error', { message: String(e.message || e).slice(0, 300) });
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

// POST /api/extend/:id/retry {section}(需登录,按 1 分区预检与扣费)
export async function handleRetry(req, res, id, auth) {
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const section = String(body.section || '');
  if (!SECTION_ORDER.includes(section)) return json(res, 400, { error: '未知分区' });

  const pre = precheckCredits(auth.user, 1);
  if (!pre.ok) return json(res, 402, { error: pre.error, code: pre.code, credits: pre.credits });

  const result = await retrySection({ hotspotId: id, section, user: auth.user });
  if (result.error) return json(res, 500, { error: result.error });
  return json(res, 200, { ok: true, section: result.section, credits: result.credits });
}

// POST /api/extend/:id/feedback {section, rating}
export async function handleFeedback(req, res, id) {
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const section = String(body.section || '');
  const rating = String(body.rating || '');
  if (!SECTION_ORDER.includes(section)) return json(res, 400, { error: '未知分区' });
  if (!['useful', 'useless'].includes(rating)) return json(res, 400, { error: '未知评价' });
  db.prepare(
    `INSERT INTO feedback (hotspot_id, section, rating, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(hotspot_id, section) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at`
  ).run(id, section, rating, nowIso());
  return json(res, 200, { ok: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('too large'));
    });
    req.on('end', () => resolve(JSON.parse(data || '{}')));
    req.on('error', reject);
  });
}

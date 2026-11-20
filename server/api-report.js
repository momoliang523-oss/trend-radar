// 周期报告 API:统计(GET)+ 洞察流(SSE,需登录,余额预检在前)+ 文字版文案(SSE,仅管理员)
import { json } from './api.js';
import { REPORT_TYPES, REGIONS, computeStats, getCachedNarrative, generateReportStream, runReportCopy } from './report.js';
import { fmtLocalDate } from './util.js';
import { precheckCredits } from './billing.js';

// 地区筛选参数(白名单,空 = 全地区)
function regionParam(url) {
  const r = url.searchParams.get('region');
  return REGIONS.includes(r) ? r : '';
}

// GET /api/reports?type=week&end=2026-09-17&q=关键词&region=美国 → 统计 + 搜索匹配 + 已缓存洞察
// 未登录不返回 AI 洞察(游客报告页不展示 AI 内容)
export function handleReports(url, auth) {
  const type = REPORT_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'week';
  const end = url.searchParams.get('end') || fmtLocalDate();
  const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
  const region = regionParam(url);
  const stats = computeStats(type, end, q, region);
  return {
    ...stats,
    narrative: auth ? getCachedNarrative(type, stats.end, region) : null,
  };
}

// GET /api/reports/stream?type=&end=&force=1 → SSE(先 stats 后流式洞察)
export function handleReportStream(req, res, url, auth) {
  const type = REPORT_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'week';
  const end = url.searchParams.get('end') || fmtLocalDate();
  const force = url.searchParams.get('force') === '1';
  const region = regionParam(url);

  // 余额预检(洞察报告 1 单位)
  const pre = precheckCredits(auth.user, 1);
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

  generateReportStream({ type, end, force, onEvent: send, signal: abort.signal, user: auth.user, region })
    .catch((e) => send({ event: 'error', data: { message: String(e.message || e).slice(0, 300) } }))
    .finally(() => {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    });
}

// GET /api/reports/copy?type=&end= → SSE 文字版自媒体文案(仅管理员,不扣费)
export function handleReportCopy(req, res, url) {
  const type = REPORT_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'week';
  const end = url.searchParams.get('end') || fmtLocalDate();
  const region = regionParam(url);

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

  runReportCopy({ type, end, onEvent: send, signal: abort.signal, region })
    .catch((e) => send({ event: 'error', data: { message: String(e.message || e).slice(0, 300) } }))
    .finally(() => {
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    });
}

// 采集器注册与调度:逐个源独立 try/catch,单飞防重;可作 CLI 运行
import { db, metaGet, metaSet, nowIso } from '../db.js';
import { todayStr } from '../util.js';
import { detectHotspots } from '../detect.js';

const collectors = [
  (await import('./hackernews.js')).default,
  (await import('./reddit.js')).default,
  (await import('./bingNews.js')).default,
  (await import('./googleNews.js')).default,
  (await import('./youtube.js')).default,
  (await import('./bbc.js')).default,
  (await import('./producthunt.js')).default,
];

const insert = db.prepare(`INSERT OR IGNORE INTO signals
  (source, platform, source_type, url, title, text, author, published_at, collected_at, engagement, extra, dedup_key)
  VALUES (?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

let running = false;

export async function runCollect() {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  const report = [];
  try {
    for (const c of collectors) {
      if (!c.enabled) {
        report.push({ id: c.id, status: 'disabled' });
        continue;
      }
      try {
        const signals = await c.collect();
        let inserted = 0;
        for (const s of signals) {
          const r = insert.run(
            c.id,
            s.platform,
            s.url,
            s.title,
            s.text || '',
            s.author || '',
            s.published_at || null,
            nowIso(),
            s.engagement || 0,
            JSON.stringify(s.extra || {}),
            s.dedup_key
          );
          if (Number(r.changes) > 0) inserted++;
        }
        report.push({ id: c.id, status: 'ok', fetched: signals.length, inserted });
        metaSet(`collect_error:${c.id}`, '');
      } catch (e) {
        const msg = String(e.message || e).slice(0, 200);
        report.push({ id: c.id, status: 'error', error: msg });
        metaSet(`collect_error:${c.id}`, msg);
      }
    }
    metaSet('last_collect', nowIso());
    // 采集后跑热点识别
    let detected = 0;
    try {
      detected = detectHotspots();
    } catch (e) {
      report.push({ id: '_detect', status: 'error', error: String(e.message || e).slice(0, 200) });
    }
    return { ok: true, at: nowIso(), report, detected };
  } finally {
    running = false;
  }
}

export function isCollecting() {
  return running;
}

// CLI:npm run collect
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log(`[collect] 开始采集 ${todayStr()} ...`);
  runCollect().then((r) => {
    console.log('[collect] 完成');
    for (const row of r.report) {
      console.log(`  - ${row.id}: ${row.status}${row.inserted != null ? ` (新增 ${row.inserted}/${row.fetched})` : ''}${row.error ? ` — ${row.error}` : ''}`);
    }
    console.log(`  - 热点识别: ${r.detected} 个真实热点更新`);
    process.exit(0);
  });
}

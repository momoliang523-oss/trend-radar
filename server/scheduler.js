// 进程内调度:启动补种/补采、小时级刷新、每日 08:00 前全量、信号清理
import { db, metaGet, metaSet, nowIso } from './db.js';
import { todayStr, sleep } from './util.js';
import { autoSeedIfEmpty, reseed } from './seed.js';
import { runCollect } from './collectors/index.js';
import { DAILY_FULL_RUN_HOUR, SIGNAL_RETENTION_DAYS } from './config.js';

let collectTimer = null;
let dailyTimer = null;
let started = false;

async function collectOnce(tag) {
  console.log(`[scheduler] ${tag} 采集开始`);
  try {
    const r = await runCollect();
    const ok = (r.report || []).filter((x) => x.status === 'ok').length;
    console.log(`[scheduler] ${tag} 完成:${ok}/${r.report?.length || 0} 源成功,热点识别更新 ${r.detected}`);
  } catch (e) {
    console.error(`[scheduler] ${tag} 采集失败:`, e.message);
  }
}

function msUntilNextHour() {
  const d = new Date();
  return (60 - d.getMinutes()) * 60000 - d.getSeconds() * 1000 + 5000;
}

function msUntilNextDaily() {
  const d = new Date();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAILY_FULL_RUN_HOUR, 0, 0);
  if (target <= d) target.setDate(target.getDate() + 1);
  return target - d;
}

function scheduleDaily() {
  dailyTimer = setTimeout(async () => {
    await collectOnce('每日全量');
    metaSet('last_full_run', nowIso());
    refreshDemoIfSafe();
    scheduleDaily(); // 重新排期下一天
  }, msUntilNextDaily());
}

function scheduleHourly() {
  collectTimer = setInterval(() => collectOnce('小时级'), 60 * 60000);
}

// 演示数据随日期滚动:过天后自动重建到「今天」;若用户已在演示热点上收藏/生成过分析,则跳过以保护用户数据
function refreshDemoIfSafe() {
  const seedAt = metaGet('seed_at');
  if (seedAt === todayStr()) return;
  const protectedCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM hotspots h WHERE h.source_type = 'demo'
       AND (EXISTS (SELECT 1 FROM favorites f WHERE f.hotspot_id = h.id)
         OR EXISTS (SELECT 1 FROM extend_results e WHERE e.hotspot_id = h.id))`
    )
    .get().n;
  if (protectedCount > 0) {
    console.log('[scheduler] 演示数据上有用户沉淀,跳过自动刷新');
    return;
  }
  const r = reseed();
  console.log(`[scheduler] 演示数据已随日期刷新:${r.hotspots} 条热点`);
}

function cleanupOldSignals() {
  // 只清理未被热点引用的超期信号(引用的信号保留,保证溯源)
  const cutoff = new Date(Date.now() - SIGNAL_RETENTION_DAYS * 86400000).toISOString();
  const r = db
    .prepare(
      `DELETE FROM signals WHERE collected_at < ? AND id NOT IN (SELECT DISTINCT signal_id FROM hotspot_signals)`
    )
    .run(cutoff);
  if (Number(r.changes) > 0) console.log(`[scheduler] 清理超期信号 ${r.changes} 条`);
}

export function boot() {
  if (started) return;
  started = true;

  // 1) 演示数据补种 / 随日期滚动刷新
  autoSeedIfEmpty();
  refreshDemoIfSafe();

  // 2) 启动补采:今天尚未全量且已过目标时刻 → 立即全量;否则距上次采集超 1 小时 → 补一次
  const lastCollect = metaGet('last_collect');
  const lastFull = metaGet('last_full_run');
  const now = new Date();
  const isAfterFullHour = now.getHours() >= DAILY_FULL_RUN_HOUR;
  if (lastFull !== todayStr() && isAfterFullHour) {
    collectOnce('启动补采(全量)').then(() => metaSet('last_full_run', nowIso()));
  } else if (!lastCollect || Date.now() - new Date(lastCollect).getTime() > 3600000) {
    collectOnce('启动补采');
  }

  // 3) 周期任务
  scheduleHourly();
  scheduleDaily();

  // 4) 清理
  cleanupOldSignals();
  setInterval(cleanupOldSignals, 12 * 3600000);
}

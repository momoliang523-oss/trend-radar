// 周期报告(周/月/季):数据统计聚合(即时)+ AI 趋势洞察(SSE 流式 + 缓存 + 模板兜底)
import { db, nowIso } from './db.js';
import { charFuzzyScore, fmtLocalDate } from './util.js';
import { streamChat } from './llm.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { costForUser, modelForUser } from './auth.js';
import { chargeSection, currentBalance } from './billing.js';
import { runCopyStream } from './copy.js';

export const REPORT_TYPES = ['week', 'month', 'quarter'];
// 地区列表(seed 的地区主题写入 keywords,可据此过滤;参考 HotPilot 工具栏地区筛选)
export const REGIONS = ['美国', '欧洲', '东南亚', '中东', '日本', '拉美', '墨西哥', '俄罗斯'];

// 国家/城市词典兜底:标题/摘要/关键词里出现这些词即归属对应地区(纯拉丁词按整词匹配,避免 UK 命中 duck)
const COUNTRY_HINTS = [
  ['墨西哥', '墨西哥'], ['墨西哥城', '墨西哥'], ['Mexico', '墨西哥'],
  ['美国', '美国'], ['美区', '美国'], ['北美', '美国'], ['USA', '美国'], ['纽约', '美国'], ['德州', '美国'], ['洛杉矶', '美国'], ['硅谷', '美国'],
  ['巴西', '拉美'], ['Brazil', '拉美'], ['阿根廷', '拉美'], ['智利', '拉美'], ['秘鲁', '拉美'], ['哥伦比亚', '拉美'], ['拉美', '拉美'],
  ['欧洲', '欧洲'], ['英国', '欧洲'], ['伦敦', '欧洲'], ['UK', '欧洲'], ['德国', '欧洲'], ['柏林', '欧洲'], ['法国', '欧洲'], ['巴黎', '欧洲'], ['意大利', '欧洲'], ['西班牙', '欧洲'], ['荷兰', '欧洲'], ['波兰', '欧洲'], ['北欧', '欧洲'], ['瑞典', '欧洲'], ['挪威', '欧洲'], ['丹麦', '欧洲'], ['芬兰', '欧洲'], ['EU', '欧洲'],
  ['中东', '中东'], ['阿联酋', '中东'], ['UAE', '中东'], ['迪拜', '中东'], ['沙特', '中东'], ['利雅得', '中东'], ['土耳其', '中东'], ['斋月', '中东'], ['以色列', '中东'],
  ['俄罗斯', '俄罗斯'], ['Russia', '俄罗斯'], ['莫斯科', '俄罗斯'],
  ['东南亚', '东南亚'], ['泰国', '东南亚'], ['越南', '东南亚'], ['印尼', '东南亚'], ['菲律宾', '东南亚'], ['马来西亚', '东南亚'], ['新加坡', '东南亚'], ['雅加达', '东南亚'],
  ['日本', '日本'], ['Japan', '日本'], ['东京', '日本'], ['大阪', '日本'], ['日区', '日本'],
];

// 从 keywords 提取地区;无地区词时用国家/城市词典 + 语言文字特征兜底(西里尔→俄罗斯、阿拉伯→中东、假名→日本)
function regionOf(r) {
  const kws = [];
  try {
    kws.push(...JSON.parse(r.keywords || '[]'));
  } catch {
    /* 忽略 */
  }
  for (const k of kws) if (REGIONS.includes(k)) return k;
  const text = `${r.title || ''} ${r.summary || ''} ${kws.join(' ')}`;
  for (const [hint, rg] of COUNTRY_HINTS) {
    const hit = /[a-z]/i.test(hint) ? new RegExp(`\\b${hint}\\b`, 'i').test(text) : text.includes(hint);
    if (hit) return rg;
  }
  if (/[Ѐ-ӿ]/.test(text)) return '俄罗斯';
  if (/[؀-ۿ]/.test(text)) return '中东';
  if (/[぀-ヿ]/.test(text)) return '日本';
  // 兜底:采集主源为英文互联网(HN/Reddit/X 等),无地区信号的实时话题默认计入美国市场;完全没有信号的才落「其他」
  return (r.signal_count || 0) > 0 ? '美国' : '';
}

// 涨幅:heat_series = [[date, heat], ...] → 当前热度分对比话题首次记录的变化(明确「什么在上升」)
function changeOf(r) {
  let series = [];
  try {
    series = JSON.parse(r.heat_series || '[]');
  } catch {
    /* 忽略 */
  }
  const last = series[series.length - 1];
  const first = series[0];
  if (!last || !first) return { change_pct: null, change_days: null, peak_pct: null, series: [] };
  const days = Math.max(1, Math.round((new Date(`${last[0]}T00:00:00`) - new Date(`${first[0]}T00:00:00`)) / 86400000));
  const pct = first[1] > 0 ? Math.round(((last[1] - first[1]) / first[1]) * 100) : null;
  // 较峰值回落(退潮榜用:当前热度对比该话题周期内最高值)
  const peak = Math.max(...series.map((p) => p[1]));
  const peakPct = peak > 0 ? Math.round(((last[1] - peak) / peak) * 100) : null;
  return { change_pct: pct, change_days: days, peak_pct: peakPct, series: series.slice(-14) };
}

// 两日期(YYYY-MM-DD)的天数差(阶段带/窗口估算用)
function dayDiff(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

// 按标题去重(同一话题每天一行,报告按话题计,取最新一天)
function dedupeByTitle(rows) {
  const byTitle = new Map();
  for (const r of rows) {
    const prev = byTitle.get(r.title);
    if (!prev || r.date > prev.date || (r.date === prev.date && r.id > prev.id)) byTitle.set(r.title, r);
  }
  return [...byTitle.values()];
}

// 计算周期边界:end 日期会被吸附到所在周期
export function periodRange(type, endDate) {
  const [y, m, d] = endDate.split('-').map(Number);
  const end = new Date(y, m - 1, d);
  let start, endStr, label, next, prev;

  if (type === 'week') {
    const mon = new Date(end);
    mon.setDate(end.getDate() - ((end.getDay() + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    start = mon;
    endStr = fmtLocalDate(sun);
    label = `${fmtLocalDate(mon)} 至 ${endStr}`;
    next = fmtLocalDate(new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + 1));
    prev = fmtLocalDate(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 1));
  } else if (type === 'month') {
    start = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    endStr = fmtLocalDate(last);
    label = `${y}年${m}月`;
    next = fmtLocalDate(new Date(y, m, 1));
    prev = fmtLocalDate(new Date(y, m - 1, 0));
  } else {
    const q = Math.floor((m - 1) / 3);
    start = new Date(y, q * 3, 1);
    const last = new Date(y, q * 3 + 3, 0);
    endStr = fmtLocalDate(last);
    label = `${y}年 Q${q + 1}`;
    next = fmtLocalDate(new Date(y, q * 3 + 3, 1));
    prev = fmtLocalDate(new Date(y, q * 3, 0));
  }
  return { start: fmtLocalDate(start), end: endStr, label, next, prev };
}

// ---------- 统计聚合(纯 DB,即时返回) ----------

export function computeStats(type, endDate, q = '', region = '') {
  const { start, end, label, next, prev } = periodRange(type, endDate);
  const HOTSPOT_SQL = `SELECT h.*, (SELECT GROUP_CONCAT(DISTINCT s.platform) FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id WHERE hs.hotspot_id = h.id) AS platforms
       FROM hotspots h WHERE h.date >= ? AND h.date <= ?`;
  const all = db.prepare(HOTSPOT_SQL).all(start, end);

  // 地区分布(未过滤,筛选 chips 始终显示全量计数;按话题去重)
  const regionMap = new Map();
  for (const r of dedupeByTitle(all)) {
    const rg = regionOf(r) || '其他';
    regionMap.set(rg, (regionMap.get(rg) || 0) + 1);
  }
  const regions = [...regionMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // 地区过滤 → 按标题去重(之后计数/榜单均按话题,走势仍按天)
  const rows = region ? all.filter((r) => regionOf(r) === region) : all;
  const uniq = dedupeByTitle(rows);

  const total = uniq.length;
  const avgHeat = total ? Math.round(uniq.reduce((a, r) => a + r.heat_score, 0) / total) : 0;
  const maxHeat = total ? Math.max(...uniq.map((r) => r.heat_score)) : 0;

  // 品类分布
  const catMap = new Map();
  for (const r of uniq) catMap.set(r.category, (catMap.get(r.category) || 0) + 1);
  const categories = [...catMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // 平台分布
  const platMap = new Map();
  for (const r of uniq) {
    for (const p of (r.platforms || '').split(',').filter(Boolean)) {
      platMap.set(p, (platMap.get(p) || 0) + 1);
    }
  }
  const platforms = [...platMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // 日均热度(迷你走势,按天不分话题)
  const dayMap = new Map();
  for (const r of rows) {
    if (!dayMap.has(r.date)) dayMap.set(r.date, { sum: 0, n: 0, max: 0 });
    const d = dayMap.get(r.date);
    d.sum += r.heat_score;
    d.n += 1;
    d.max = Math.max(d.max, r.heat_score);
  }
  const daily = [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, avg: Math.round(v.sum / v.n), max: v.max, count: v.n }));

  // 品类 × 日均热度序列(趋势洞察图表用):前 4 个品类的热度趋势对比
  const topCats = categories.slice(0, 4).map((c) => c.name);
  const catDayMap = new Map();
  for (const r of rows) {
    if (!topCats.includes(r.category)) continue;
    if (!catDayMap.has(r.category)) catDayMap.set(r.category, new Map());
    const dm = catDayMap.get(r.category);
    if (!dm.has(r.date)) dm.set(r.date, { sum: 0, n: 0 });
    const d = dm.get(r.date);
    d.sum += r.heat_score;
    d.n += 1;
  }
  const dailyByCat = topCats
    .map((name) => ({
      name,
      daily: [...catDayMap.get(name).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, avg: Math.round(v.sum / v.n), count: v.n })),
    }))
    .filter((c) => c.daily.length);

  // ===== 五板块数据(报告页固定四段:一句话结论 → 五张趋势图 → 明细表 → 下周期动作)=====
  // 先定这一屏要回答什么,再由问题反推图型:区域热点=哪个市场在起(多国折线)、
  // 类目机会=该不该加码(分组柱)、话题风向=内容怎么跟(堆叠柱)、
  // 生命周期=还来不来得及(阶段带)、竞品与价格=利润还在不在(散点)。
  // 归一化:热度分本身就是 0-100 指数(采集端四路信号归一加权);周桶:缺数据的周留空档,不插值。

  // 上一周期(「本周 vs 上周」对比基准)+ 跨周期全量(话题首末日期、阶段时长统计)
  const prevRange = periodRange(type, prev);
  const prevAll = db.prepare(HOTSPOT_SQL).all(prevRange.start, start);
  const span = region ? [...prevAll, ...all].filter((r) => regionOf(r) === region) : [...prevAll, ...all];
  const curSpan = region ? rows : all;
  const prevSpan = region ? prevAll.filter((r) => regionOf(r) === region) : prevAll;

  // 切周期桶:周报按天(7 点),月/季报按周(4-5 / 12-13 桶);桶含上一周期,便于「比上周」
  const bucketStep = type === 'week' ? 1 : 7;
  const buckets = [];
  {
    const t = new Date(`${prevRange.start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    while (t <= last) {
      const bEnd = new Date(t);
      bEnd.setDate(bEnd.getDate() + bucketStep - 1);
      if (bEnd > last) bEnd.setTime(last.getTime());
      buckets.push({ s: fmtLocalDate(t), e: fmtLocalDate(bEnd), label: fmtLocalDate(t).slice(5) });
      t.setDate(t.getDate() + bucketStep);
    }
  }

  // ① 区域热点:各地区每桶平均热度(多国折线;只有该地区有数据的桶才有点 → 留空档不插值)
  const regionLineMap = new Map();
  for (const b of buckets) {
    const per = new Map();
    for (const r of span) {
      if (r.date < b.s || r.date > b.e) continue;
      const rg = regionOf(r);
      if (!rg) continue; // 「其他」不是市场,不进折线
      const v = per.get(rg) || { sum: 0, n: 0 };
      v.sum += r.heat_score;
      v.n += 1;
      per.set(rg, v);
    }
    for (const [rg, v] of per) {
      const line = regionLineMap.get(rg) || { name: rg, points: [] };
      line.points.push({ date: b.e, avg: Math.round(v.sum / v.n) });
      regionLineMap.set(rg, line);
    }
  }
  const regionLines = [...regionLineMap.values()].filter((l) => l.points.length >= 2);
  // 每个地区:本周末桶 vs 上周末桶(「哪个市场比上周更热」的一行读法数据)
  const regionMoves = regionLines.map((l) => {
    const curPts = l.points.filter((p) => p.date >= start);
    const prevPts = l.points.filter((p) => p.date < start);
    const a = prevPts.length ? prevPts[prevPts.length - 1].avg : null;
    const b = curPts.length ? curPts[curPts.length - 1].avg : null;
    return { name: l.name, from: a, to: b, delta: a != null && b != null ? b - a : null };
  });

  // ② 类目机会:本周 vs 上周平均热度(分组柱,前 6 类目按本周话题数)
  const catAgg = (list) => {
    const m = new Map();
    for (const r of list) {
      const v = m.get(r.category) || { sum: 0, n: 0 };
      v.sum += r.heat_score;
      v.n += 1;
      m.set(r.category, v);
    }
    return [...m.entries()].map(([name, v]) => ({ name, avg: Math.round(v.sum / v.n), count: v.n }));
  };
  const prevCat = new Map(catAgg(prevSpan).map((c) => [c.name, c]));
  const catCompare = catAgg(curSpan)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((c) => ({ name: c.name, cur: c.avg, curCount: c.count, prev: prevCat.get(c.name)?.avg ?? null, prevCount: prevCat.get(c.name)?.count ?? 0 }));

  // ③ 话题风向:每桶新上榜 / 延续 / 退场话题数(堆叠柱看构成变化);
  // 「新话题是否从旧话题长出」= 本周期新上榜话题中,类目与上一周期话题同类的数量
  const topicSpan = new Map();
  for (const r of span) {
    const t = topicSpan.get(r.title);
    if (!t) topicSpan.set(r.title, { first: r.date, last: r.date, cat: r.category });
    else {
      if (r.date < t.first) t.first = r.date;
      if (r.date > t.last) t.last = r.date;
      t.cat = r.category;
    }
  }
  const spanMaxDate = span.reduce((a, r) => (r.date > a ? r.date : a), prevRange.start);
  const flowBuckets = buckets.map((b) => {
    let nw = 0;
    let cont = 0;
    let exit = 0;
    for (const t of topicSpan.values()) {
      if (t.first >= b.s && t.first <= b.e) nw += 1;
      // 退场:本桶最后一次出现,且之后还有数据(最后有数据的桶不算退场)
      else if (t.last >= b.s && t.last <= b.e && b.e < spanMaxDate) exit += 1;
      else if (t.first < b.s && t.last >= b.s) cont += 1; // 跨桶延续
    }
    return { label: b.label, nw, cont, exit };
  });
  const prevCats = new Set(prevSpan.map((r) => r.category));
  let newTotal = 0;
  let grewFromOld = 0;
  for (const t of topicSpan.values()) {
    if (t.first >= start && t.first <= end) {
      newTotal += 1;
      if (prevCats.has(t.cat)) grewFromOld += 1;
    }
  }

  // ④ 生命周期:逐日阶段还原(复现 detect 的阶段判定)→ 合并成四态区段;
  // 「还剩几天窗口」= 历史各阶段平均时长 - 当前阶段已持续天数(纯统计估算)
  const stagesOf = (series) => {
    const segs = [];
    let cur = null;
    series.forEach(([d, v], i) => {
      let st;
      if (i === 0) st = '萌芽';
      else {
        const pv = series[i - 1][1];
        st = v >= pv && v >= 60 ? '峰值' : v >= pv ? '上升' : '衰退';
      }
      if (cur && cur.stage === st) cur.to = d;
      else {
        cur = { stage: st, from: d, to: d };
        segs.push(cur);
      }
    });
    return segs;
  };
  const stageDurs = { 萌芽: [], 上升: [], 峰值: [], 衰退: [] };
  for (const r of span) {
    let s = [];
    try {
      s = JSON.parse(r.heat_series || '[]');
    } catch {
      /* 忽略 */
    }
    for (const seg of stagesOf(s)) stageDurs[seg.stage].push(dayDiff(seg.from, seg.to) + 1);
  }
  const stageAvg = Object.fromEntries(
    Object.entries(stageDurs).map(([k, v]) => [k, v.length ? Math.max(1, Math.round(v.reduce((a, b) => a + b, 0) / v.length)) : 0])
  );
  const lifeBands = uniq
    .slice()
    .sort((a, b) => b.heat_score - a.heat_score)
    .slice(0, 8)
    .map((r) => {
      const ch = changeOf(r);
      const segs = stagesOf(ch.series);
      const cur = segs[segs.length - 1];
      const stageDays = dayDiff(cur.from, cur.to) + 1;
      const avg = stageAvg[cur.stage] || 0;
      return {
        id: r.id,
        title: r.title,
        lifecycle: r.lifecycle,
        stage: cur.stage,
        stageDays,
        stageAvg: avg,
        // 峰值 = 窗口就在当下;衰退 = 窗口已过;萌芽/上升 = 历史均值 - 已持续天数
        window: cur.stage === '峰值' || cur.stage === '衰退' ? 0 : Math.max(0, avg - stageDays),
        segments: segs,
      };
    });

  // ⑤ 竞品与价格:暂无结构化价格数据,以 热度 × 来源数 观察竞争密度(散点);
  // 接入竞品价格源后替换为 价格 × 动销(动销代理 = 信号 engagement)
  const rivalScatter = uniq.map((r) => ({
    id: r.id,
    title: r.title,
    heat: r.heat_score,
    sources: r.signal_count || 0,
    lifecycle: r.lifecycle || '萌芽',
    category: r.category,
  }));

  const card = (r) => {
    const ch = changeOf(r);
    return {
      id: r.id,
      date: r.date,
      title: r.title,
      category: r.category,
      heat_score: r.heat_score,
      heat_trend: r.heat_trend,
      lifecycle: r.lifecycle,
      platforms: (r.platforms || '').split(',').filter(Boolean),
      source_type: r.source_type,
      signal_count: r.signal_count || 0,
      region: regionOf(r),
      change_pct: ch.change_pct,
      change_days: ch.change_days,
      peak_pct: ch.peak_pct,
      series: ch.series,
    };
  };

  // 关键词搜索:字符级模糊匹配(查询词任一字出现在标题/摘要/关键词即命中,
  // 命中字数越多越靠前),按热度排序(报告页搜索框用;同样按话题去重)
  let search = { q: '', items: [] };
  if (q) {
    const hits = uniq
      .map((r) => ({ r, s: Math.max(charFuzzyScore(q, r.title), charFuzzyScore(q, r.summary), charFuzzyScore(q, r.keywords)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.r.heat_score - a.r.heat_score)
      .slice(0, 50)
      .map((x) => card(x.r));
    search = { q, items: hits };
  }

  const risingAll = uniq.filter((r) => r.heat_trend === 'up' || r.heat_trend === 'new');
  const fallingAll = uniq.filter((r) => r.heat_trend === 'down');

  return {
    type,
    requested_end: endDate,
    start,
    end,
    label,
    next,
    prev,
    region: region || '',
    stats: {
      total,
      avgHeat,
      maxHeat,
      liveCount: uniq.filter((r) => r.source_type === 'live').length,
      risingTotal: risingAll.length,
      risingFast: risingAll.filter((r) => (changeOf(r).change_pct ?? 0) >= 20).length,
      fallingTotal: fallingAll.length,
      categories,
      platforms,
      regions,
      daily,
      dailyByCat,
      top: uniq.slice().sort((a, b) => b.heat_score - a.heat_score).slice(0, 9).map(card),
      // 上升按涨幅排序(涨幅 = 热度分对比话题首次记录),退潮按「较峰值回落」排序
      rising: risingAll.sort((a, b) => (changeOf(b).change_pct ?? -Infinity) - (changeOf(a).change_pct ?? -Infinity)).slice(0, 6).map(card),
      falling: fallingAll.sort((a, b) => (changeOf(a).peak_pct ?? Infinity) - (changeOf(b).peak_pct ?? Infinity)).slice(0, 6).map(card),
      search,
      // 五板块(报告页固定四段:一句话结论 → 五张趋势图 → 明细表 → 下周期 3 个动作)
      regionLines, // ① 区域热点:多国折线(缺数据的周留空档)
      regionMoves, //   各市场 本周 vs 上周(「哪个市场在起」的一行读法)
      catCompare, //  ② 类目机会:分组柱(本周 vs 上周平均热度)
      topicFlow: { buckets: flowBuckets, newTotal, grewFromOld }, // ③ 话题风向:堆叠柱(新上榜/延续/退场)
      lifeBands, //   ④ 生命周期:阶段带(四态区段)+ 窗口估算
      stageAvg, //      历史各阶段平均时长(窗口估算依据)
      rivalScatter, // ⑤ 竞品与价格:散点(热度 × 来源数,价格源接入后换 价格 × 动销)
      table: uniq.slice().sort((a, b) => b.heat_score - a.heat_score).slice(0, 30).map(card), // ③ 明细表(可下钻)
    },
  };
}

// ---------- AI 趋势洞察(缓存 + 模板兜底) ----------

const CACHE_KEY = (type, end, region = '') => (region ? `${type}:${end}:${region}` : `${type}:${end}`);

export function getCachedNarrative(type, endDate, region = '') {
  const row = db
    .prepare('SELECT * FROM report_cache WHERE cache_key = ?')
    .get(CACHE_KEY(type, endDate, region));
  if (!row) return null;
  return {
    markdown: row.markdown,
    confidence: row.confidence,
    created_at: row.created_at,
    degraded: row.provider === 'template', // 出口脱敏:不暴露 provider/model
  };
}

function saveNarrative(type, endDate, { markdown, provider, model, confidence }, region = '') {
  db.prepare(
    `INSERT INTO report_cache (cache_key, markdown, provider, model, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET markdown = excluded.markdown, provider = excluded.provider,
       model = excluded.model, confidence = excluded.confidence, created_at = excluded.created_at`
  ).run(CACHE_KEY(type, endDate, region), markdown, provider, model, confidence, nowIso());
}

function buildReportPrompt(stats) {
  const s = stats.stats;
  const topList = s.top.map((t, i) => `${i + 1}. ${t.title}(热度 ${t.heat_score},${t.category},${t.heat_trend === 'up' || t.heat_trend === 'new' ? '上升' : t.heat_trend === 'down' ? '回落' : '持平'})`).join('\n');
  const catList = s.categories.map((c) => `${c.name} ${c.count} 条`).join('、');
  const platList = s.platforms.map((p) => `${p.name} ${p.count} 条`).join('、');
  const chgOf = (t) => (t.change_pct != null ? `,较 ${t.change_days} 天前 ${t.change_pct > 0 ? '+' : ''}${t.change_pct}%` : '');
  const riseList = s.rising.map((t) => `- ${t.title}(热度 ${t.heat_score}${chgOf(t)})`).join('\n') || '- 无';
  const fallList = s.falling.map((t) => `- ${t.title}(热度 ${t.heat_score}${chgOf(t)})`).join('\n') || '- 无';
  const regionLine = (s.regionMoves || [])
    .filter((m) => m.delta != null)
    .map((m) => `${m.name} ${m.delta >= 0 ? '+' : ''}${m.delta}`)
    .join('、') || '—';
  return `【周期】${stats.label}(${stats.type})
【区域】${stats.region || '全地区'}
【区域热度对比】${regionLine}(各市场平均热度,本周 vs 上周)
【样本】共 ${s.total} 条热点(实时 ${s.liveCount} 条),平均热度 ${s.avgHeat},峰值 ${s.maxHeat};上升信号 ${s.risingTotal} 个(其中涨幅 ≥20% 的 ${s.risingFast} 个),退潮 ${s.fallingTotal} 条
【Top 榜】
${topList}
【品类分布】${catList}
【平台分布】${platList}
【上升热点】
${riseList}
【退潮热点】
${fallList}

任务:基于以上统计,以海外市场调研分析师身份输出该周期的趋势洞察(简体中文 Markdown):
## 趋势主线(2-4 条,每条说明判断依据,数据只能引用上面统计)
## 内容与选品提示(3-5 条要点)
## 退潮提醒(如有)
## 下期预判(1-2 条,标注为参考性质)

若样本不足 10 条,如实说明样本有限、结论仅供参考。`;
}

// 模板兜底:纯数据陈述,不做推断
function templateNarrative(stats) {
  const s = stats.stats;
  const top = s.top.slice(0, 5).map((t, i) => `${i + 1}. ${t.title} — 热度 ${t.heat_score}(${t.category})`).join('\n');
  const cat = s.categories.map((c) => `${c.name} ${c.count} 条`).join('、') || '无';
  const plat = s.platforms.map((p) => `${p.name} ${p.count} 条`).join('、') || '无';
  const rise = s.rising.map((t) => t.title).join('、') || '无';
  const fall = s.falling.map((t) => t.title).join('、') || '无';
  return `## 周期概览

> ⚠️ AI 深度分析暂不可用,以下为统计数据的自动汇总,置信度较低。

- 周期内共 **${s.total}** 条热点(实时 ${s.liveCount} 条),平均热度 **${s.avgHeat}**,峰值 **${s.maxHeat}**
- 覆盖品类:${cat}
- 覆盖平台:${plat}

## Top 热点

${top || '- 本周期无热点'}

## 上升与退潮

- 上升中:${rise}
- 已退潮:${fall}

## 说明

趋势主线与下期预判需 AI 深度分析生成,可点击「重新生成」重试。`;
}

// SSE 生成:先发 stats,再流式发洞察(命中缓存直接返回)
export async function generateReportStream({ type, end, force = false, onEvent, signal, user, region = '' }) {
  const stats = computeStats(type, end, '', region);
  onEvent({ event: 'stats', data: stats });

  let credits = currentBalance(user.id);
  const cached = force ? null : getCachedNarrative(type, stats.end, region);
  if (cached) {
    onEvent({ event: 'narrative', data: { cached: true, ...cached, credits } });
    onEvent({ event: 'done', data: { ok: true, cached: true, credits } });
    return { cached: true };
  }

  const prompt = buildReportPrompt(stats);
  let text = '';
  let meta = { provider: '', model: '', truncated: false };
  let failed = false;
  try {
    for await (const c of streamChat({ system: SYSTEM_PROMPT, user: prompt, model: modelForUser(user), signal })) {
      if (c.text) {
        text += c.text;
        onEvent({ event: 'delta', data: { text: c.text } });
      }
      if (c.done) meta = { provider: c.provider, model: c.model, truncated: !!c.truncated };
    }
    if (!text.trim()) throw new Error('空响应');
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') {
      // 客户端断开:不生成模板、不写缓存
      return { aborted: true };
    }
    failed = true;
  }

  let result;
  if (failed || !text.trim()) {
    // L3 模板兜底(同一 SSE 路径流式输出,不扣分)
    const tpl = templateNarrative(stats);
    for (const chunk of chunkText(tpl, 30)) onEvent({ event: 'delta', data: { text: chunk } });
    result = { markdown: tpl, provider: 'template', model: 'template', confidence: '低' };
  } else {
    result = {
      markdown: text.trim(),
      provider: meta.provider,
      model: meta.model,
      confidence: meta.truncated ? '中' : '高',
    };
    const ch = chargeSection(user.id, costForUser(user), 'report', `report:${type}:${stats.end}:${region || 'all'}`);
    if (!ch.ok) console.error('[billing] 扣费失败(报告已生成):', user.id, type, stats.end, region);
    credits = ch.balance;
  }
  saveNarrative(type, stats.end, result, region);
  onEvent({
    event: 'narrative',
    data: { cached: false, markdown: result.markdown, confidence: result.confidence, degraded: result.provider === 'template', credits },
  });
  onEvent({ event: 'done', data: { ok: true, cached: false, credits } });
  return { ok: true };
}

function* chunkText(text, size) {
  let i = 0;
  while (i < text.length) {
    yield text.slice(i, i + size);
    i += size;
  }
}

// ---------- 文字版自媒体文案(仅管理员,不扣费) ----------

export async function runReportCopy({ type, end, onEvent, signal, region = '' }) {
  const stats = computeStats(type, end, '', region);
  const narrative = getCachedNarrative(type, stats.end, region);

  const prompt = `【文案素材】以下为出海热点雷达「${stats.label}」周期报告(区域:${stats.region || '全地区'})${narrative ? '的趋势洞察' : '的统计数据'}。

${buildReportPrompt(stats)}

${narrative && !narrative.degraded ? `【趋势洞察结论】(改写文案时以此为准)\n${narrative.markdown}` : ''}

任务:把上述报告改写为微信小程序 / 小红书风格的爆款文案(文字版,用于自媒体传播)。
- 面向受众:跨境电商卖家、想做 TikTok 带货的内容创作者
- 有趋势洞察时以其结论为准;没有时基于统计数据自行归纳(只引用上述数据,不编造)
- 按系统要求的 Markdown 结构输出`;

  return runCopyStream({ prompt, onEvent, signal });
}

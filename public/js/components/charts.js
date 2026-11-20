// 共享图表组件(零依赖 SVG):折线趋势图 / 多序列折线 / 点状分布图 / 饼图 + 图例
// 全部经 el() 构建,悬停原生 <title> 提示;数据一律来自服务器统计,不渲染模型输出
// 每张卡右上角自带「🖼 图片」按钮(components/cardImage.js,本地光栅化,不扣积分)
import { el } from '../fmt.js';
import { cardImageBtn } from './cardImage.js';

// PRD 配色:--brand 主 / --accent 次 / 热度三档,均可在深浅主题下辨识
const PALETTE_LIGHT = ['#4f46e5', '#0ea5a4', '#f59e0b', '#f97316', '#dc2626', '#818cf8', '#2dd4bf', '#94a3b8'];
const PALETTE_DARK = ['#818cf8', '#2dd4bf', '#fbbf24', '#fb923c', '#f87171', '#a5b4fc', '#5eead4', '#64748b'];

// 热度渐变(PRD 5.1 --heat-gradient),SVG 线性渐变供折线/面积使用
function heatGradientDefs(svg, id) {
  svg.append(
    el('defs', {}, [
      el('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '0' }, [
        el('stop', { offset: '0%', style: 'stop-color:var(--heat-1)' }),
        el('stop', { offset: '50%', style: 'stop-color:var(--heat-2)' }),
        el('stop', { offset: '100%', style: 'stop-color:var(--heat-3)' }),
      ]),
    ])
  );
}

function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

export function palette(i) {
  const p = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
  return p[i % p.length];
}

// 卡片容器:标题行(标题 + 转图片小按钮)+ 图 + 注释
export function chartCard(title, body, note) {
  const sec = el('section', { class: 'set-group' });
  sec.append(el('div', { class: 'chart-head' }, [el('div', { class: 'chart-title', text: title }), cardImageBtn(sec)]));
  sec.append(body);
  if (note) sec.append(el('div', { class: 'chart-note', text: note }));
  return sec;
}

// 折线趋势图(单序列):daily = [{date, avg, count?}],折线 + 圆点 + 起止日期 + 纵轴刻度 + 首尾数值
export function lineChart(daily, { height = 132 } = {}) {
  const W = 320;
  const H = height;
  const PAD = 10;
  const YL = 24; // 纵轴刻度区宽度
  const max = Math.max(...daily.map((d) => d.avg), 1);
  const n = daily.length;
  const x = (i) => YL + PAD + (i / Math.max(1, n - 1)) * (W - YL - PAD * 2);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2 - 12);
  const pts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.avg).toFixed(1)}`).join(' ');

  const svg = el('svg', { class: 'dash-line', viewBox: `0 0 ${W} ${H}` });
  const gid = 'hg' + Math.random().toString(36).slice(2, 8);
  heatGradientDefs(svg, gid);
  // 纵轴刻度(0 / 中值 / 峰值)+ 虚线网格
  for (const v of [...new Set([0, Math.round(max / 2), Math.round(max)])]) {
    const yy = y(v).toFixed(1);
    svg.append(el('line', { x1: YL, y1: yy, x2: W - PAD, y2: yy, stroke: 'var(--line)', 'stroke-width': '1', 'stroke-dasharray': '3 3' }));
    svg.append(el('text', { x: YL - 4, y: Number(yy) + 3, 'text-anchor': 'end', class: 'dash-axis-lab', text: String(v) }));
  }
  svg.append(el('polyline', { points: pts, fill: 'none', stroke: `url(#${gid})`, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  daily.forEach((d, i) => {
    const dot = el('circle', { cx: x(i).toFixed(1), cy: y(d.avg).toFixed(1), r: i === 0 || i === n - 1 ? 3.5 : 2.2, fill: i === 0 ? 'var(--heat-1)' : i === n - 1 ? 'var(--heat-3)' : 'var(--heat-2)' });
    dot.append(el('title', { text: `${d.date}:平均热度 ${d.avg}${d.count != null ? `(${d.count} 条)` : ''}` }));
    svg.append(dot);
  });
  // 首尾数值标注(否则看不出这组数是多少)
  svg.append(el('text', { x: x(0) + 5, y: y(daily[0].avg) - 5, 'text-anchor': 'start', class: 'dash-val-lab', text: String(Math.round(daily[0].avg)) }));
  if (n > 1) svg.append(el('text', { x: x(n - 1) - 5, y: y(daily[n - 1].avg) - 5, 'text-anchor': 'end', class: 'dash-val-lab', text: String(Math.round(daily[n - 1].avg)) }));

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  wrap.append(
    el('div', { class: 'dash-line-x' }, [el('span', { text: daily[0].date.slice(5) }), el('span', { text: daily[n - 1].date.slice(5) })])
  );
  return wrap;
}

// 多序列折线(区域 × 平均热度):series = [{name, color, points: [{date, v}]}],缺测日期自动断线
// 纵轴固定 0-100(热度分 = 归一化指数),左轴刻度 + 虚线网格;图例带各区最新值
export function multiLine(series, { height = 150 } = {}) {
  const W = 320;
  const H = height;
  const PAD = 12;
  const YL = 24; // 纵轴刻度区宽度
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  if (!dates.length) return el('div', { class: 'mini-empty', text: '无趋势数据' });
  const byDate = new Map(dates.map((d, i) => [d, i]));
  const x = (i) => YL + PAD + (i / Math.max(1, dates.length - 1)) * (W - YL - PAD * 2);
  const y = (v) => H - PAD - (v / 100) * (H - PAD * 2 - 10);

  const svg = el('svg', { class: 'dash-line', viewBox: `0 0 ${W} ${H}` });
  // 纵轴:热度分 0-100,刻度 + 虚线网格
  for (const v of [0, 50, 100]) {
    const yy = y(v).toFixed(1);
    svg.append(el('line', { x1: YL, y1: yy, x2: W - PAD, y2: yy, stroke: 'var(--line)', 'stroke-width': '1', 'stroke-dasharray': '3 3' }));
    svg.append(el('text', { x: YL - 4, y: Number(yy) + 3, 'text-anchor': 'end', class: 'dash-axis-lab', text: String(v) }));
  }
  for (const s of series) {
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        svg.append(el('polyline', { points: seg.join(' '), fill: 'none', stroke: s.color, 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
      seg = [];
    };
    for (const p of s.points) {
      if (p.v == null) {
        flush();
        continue;
      }
      seg.push(`${x(byDate.get(p.date)).toFixed(1)},${y(p.v).toFixed(1)}`);
    }
    flush();
    for (const p of s.points) {
      if (p.v == null) continue;
      const dot = el('circle', { cx: x(byDate.get(p.date)).toFixed(1), cy: y(p.v).toFixed(1), r: 2.2, fill: s.color });
      dot.append(el('title', { text: `${s.name} · ${p.date}:平均热度 ${p.v}` }));
      svg.append(dot);
    }
  }

  // 图例:地区名 + 最新一期热度分(数值一眼可读)
  const legend = el('div', { class: 'dash-legend inline' });
  series.forEach((s) => {
    const last = [...s.points].reverse().find((p) => p.v != null);
    legend.append(
      el('div', { class: 'dash-legend-row' }, [
        el('span', { class: 'dash-legend-dot', style: `background:${s.color}` }),
        el('span', { class: 'dash-legend-name', text: s.name }),
        last ? el('span', { class: 'dash-legend-val', text: String(Math.round(last.v)) }) : null,
      ])
    );
  });

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  wrap.append(
    el('div', { class: 'dash-line-x' }, [el('span', { text: dates[0].slice(5) }), el('span', { text: dates[dates.length - 1].slice(5) })])
  );
  wrap.append(legend);
  return wrap;
}

// 单序列柱状图(确定性计数):items = [{label, value}],柱顶标数值,底部标签(多于 6 列时隔一显示)
export function barTrend(items, { height = 150, color = 'var(--brand)' } = {}) {
  const W = 320;
  const H = height;
  const PAD = 12;
  const n = items.length;
  if (!n) return el('div', { class: 'mini-empty', text: '暂无数据' });
  const max = Math.max(1, ...items.map((x) => x.value || 0));
  const slot = (W - PAD * 2) / n;
  const bw = Math.min(18, slot * 0.6);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2 - 18);

  const svg = el('svg', { class: 'dash-bars', viewBox: `0 0 ${W} ${H}` });
  svg.append(el('line', { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  items.forEach((x, i) => {
    const cx = PAD + slot * i + slot / 2;
    const v = x.value || 0;
    if (v > 0) {
      const r = el('rect', { x: (cx - bw / 2).toFixed(1), y: y(v).toFixed(1), width: bw.toFixed(1), height: Math.max(1, H - PAD - y(v)).toFixed(1), rx: '2', fill: color });
      r.append(el('title', { text: `${x.label}:${v}` }));
      svg.append(r);
      svg.append(el('text', { x: cx.toFixed(1), y: (y(v) - 3).toFixed(1), 'text-anchor': 'middle', class: 'dash-val-lab', text: String(v) }));
    }
    if (n <= 6 || i % 2 === 0) svg.append(el('text', { x: cx.toFixed(1), y: H - 3, 'text-anchor': 'middle', class: 'dash-bar-lab', text: x.label }));
  });

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  return wrap;
}

// 图例行(pairs = [[color, name], ...])
function legendRow(pairs) {
  const legend = el('div', { class: 'dash-legend inline' });
  for (const [color, name] of pairs) {
    legend.append(
      el('div', { class: 'dash-legend-row' }, [
        el('span', { class: 'dash-legend-dot', style: `background:${color}` }),
        el('span', { class: 'dash-legend-name', text: name }),
      ])
    );
  }
  return legend;
}

// 分组柱(本周 vs 上周):items = [{name, cur, prev, curCount?, prevCount?}]
// 深色柱 = 本周(--brand),灰柱 = 上周(--text-3);悬停看数值
export function groupedBars(items, { height = 150 } = {}) {
  const W = 320;
  const H = height;
  const PAD = 12;
  const n = items.length;
  const max = Math.max(1, ...items.map((c) => Math.max(c.cur || 0, c.prev || 0)));
  const slot = (W - PAD * 2) / Math.max(1, n);
  const bw = Math.min(13, slot * 0.26);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2 - 18);

  const svg = el('svg', { class: 'dash-bars', viewBox: `0 0 ${W} ${H}` });
  svg.append(el('line', { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  items.forEach((c, i) => {
    const cx = PAD + slot * i + slot / 2;
    const bar = (val, off, fill, tip) => {
      const bh = Math.max(1, H - PAD - y(val));
      const r = el('rect', { x: (cx - bw + off).toFixed(1), y: y(val).toFixed(1), width: bw.toFixed(1), height: bh.toFixed(1), rx: '2', fill });
      r.append(el('title', { text: tip }));
      svg.append(r);
    };
    bar(c.prev || 0, 0, 'var(--text-3)', `${c.name} · 上周平均热度 ${c.prev ?? '—'}(${c.prevCount ?? 0} 条)`);
    bar(c.cur || 0, bw + 2, 'var(--brand)', `${c.name} · 本周平均热度 ${c.cur}(${c.curCount ?? 0} 条)`);
    // 柱顶数值标注(灰 = 上周,品牌色 = 本周)
    if (c.prev) svg.append(el('text', { x: (cx - bw / 2).toFixed(1), y: (y(c.prev) - 3).toFixed(1), 'text-anchor': 'middle', class: 'dash-axis-lab', text: String(Math.round(c.prev)) }));
    if (c.cur) svg.append(el('text', { x: (cx + 2 + bw / 2).toFixed(1), y: (y(c.cur) - 3).toFixed(1), 'text-anchor': 'middle', class: 'dash-val-lab', text: String(Math.round(c.cur)) }));
    const lab = el('text', { x: cx.toFixed(1), y: H - 3, 'text-anchor': 'middle', class: 'dash-bar-lab', text: c.name.slice(0, 4) });
    lab.append(el('title', { text: c.name }));
    svg.append(lab);
  });

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  wrap.append(legendRow([['var(--brand)', '本周'], ['var(--text-3)', '上周']]));
  return wrap;
}

// 堆叠柱(构成变化):buckets = [{label, nw, cont, exit}] → 新上榜 / 延续 / 退场三段堆叠
export function stackedBars(buckets, { height = 150 } = {}) {
  const W = 320;
  const H = height;
  const PAD = 12;
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => b.nw + b.cont + b.exit));
  const slot = (W - PAD * 2) / Math.max(1, n);
  const bw = Math.min(22, slot * 0.55);
  const plotH = H - PAD * 2 - 18;
  const SEGS = [
    ['exit', 'var(--text-3)', '退场'],
    ['cont', 'var(--accent)', '延续'],
    ['nw', 'var(--brand)', '新上榜'],
  ];

  const svg = el('svg', { class: 'dash-bars', viewBox: `0 0 ${W} ${H}` });
  buckets.forEach((b, i) => {
    const cx = PAD + slot * i + slot / 2;
    let acc = 0;
    for (const [key, fill, name] of SEGS) {
      const v = b[key] || 0;
      if (!v) continue;
      const hgt = Math.max(0.8, (v / max) * plotH);
      const r = el('rect', { x: (cx - bw / 2).toFixed(1), y: (H - PAD - acc - hgt).toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1), fill });
      r.append(el('title', { text: `${b.label} · ${name} ${v} 个` }));
      svg.append(r);
      acc += hgt;
    }
    const total = b.nw + b.cont + b.exit;
    if (total) svg.append(el('text', { x: cx.toFixed(1), y: (H - PAD - acc - 3).toFixed(1), 'text-anchor': 'middle', class: 'dash-val-lab', text: String(total) }));
    svg.append(el('text', { x: cx.toFixed(1), y: H - 3, 'text-anchor': 'middle', class: 'dash-bar-lab', text: b.label }));
  });

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  wrap.append(legendRow([['var(--brand)', '新上榜'], ['var(--accent)', '延续'], ['var(--text-3)', '退场']]));
  return wrap;
}

// 阶段带(四态区段):items = [{title, stage, segments: [{stage, from, to}]}]
// 每行 = 一个话题的生命周期时间轴:萌芽(accent)/ 上升(heat-1)/ 峰值(heat-3)/ 衰退(text-3),右端 = 最新一天
export function stageBands(items, { } = {}) {
  if (!items.length) return el('div', { class: 'mini-empty', text: '无生命周期数据' });
  const W = 320;
  const PAD = 10;
  const LAB = 88;
  const ROW = 20;
  const H = PAD + items.length * ROW + 14;
  const dates = [...new Set(items.flatMap((t) => t.segments.flatMap((s) => [s.from, s.to])))].sort();
  if (!dates.length) return el('div', { class: 'mini-empty', text: '无生命周期数据' });
  const d0 = new Date(`${dates[0]}T00:00:00`).getTime();
  const d1 = new Date(`${dates[dates.length - 1]}T00:00:00`).getTime();
  const spanMs = Math.max(1, d1 - d0);
  const x = (ds) => LAB + ((new Date(`${ds}T00:00:00`).getTime() - d0) / spanMs) * (W - LAB - PAD);
  const STAGE_COLOR = { 萌芽: 'var(--accent)', 上升: 'var(--heat-1)', 峰值: 'var(--heat-3)', 衰退: 'var(--text-3)' };

  const svg = el('svg', { class: 'dash-bands', viewBox: `0 0 ${W} ${H}` });
  items.forEach((t, i) => {
    const yTop = PAD + i * ROW + 2;
    const title = el('text', { x: LAB - 6, y: yTop + 9, 'text-anchor': 'end', class: 'dash-band-title', text: t.title.length > 7 ? t.title.slice(0, 7) + '…' : t.title });
    title.append(el('title', { text: t.title }));
    svg.append(title);
    for (const seg of t.segments) {
      const x0 = x(seg.from);
      const x1 = Math.max(x0 + 2, x(seg.to) + 1);
      const r = el('rect', { x: x0.toFixed(1), y: yTop.toFixed(1), width: (x1 - x0).toFixed(1), height: '10', rx: '2', fill: STAGE_COLOR[seg.stage] || 'var(--text-3)' });
      r.append(el('title', { text: `${t.title} · ${seg.stage}:${seg.from} → ${seg.to}` }));
      svg.append(r);
    }
  });
  svg.append(el('text', { x: LAB, y: H - 3, 'text-anchor': 'start', class: 'dash-bar-lab', text: dates[0].slice(5) }));
  svg.append(el('text', { x: W - PAD, y: H - 3, 'text-anchor': 'end', class: 'dash-bar-lab', text: dates[dates.length - 1].slice(5) }));

  const wrap = el('div', { class: 'dash-line-wrap' });
  wrap.append(svg);
  wrap.append(legendRow([['var(--accent)', '萌芽'], ['var(--heat-1)', '上升'], ['var(--heat-3)', '峰值'], ['var(--text-3)', '衰退']]));
  return wrap;
}

// 散点(热度 × 来源数):items = [{id, title, heat, sources, lifecycle, category}]
// x = 来源数(竞争密度),y = 热度分,点色 = 生命周期阶段;点击进详情
// 价格 × 动销散点需接入竞品价格数据源,当前以此观察竞争密度
// 来源数轴上限 30(大综述类话题来源数百条,贴右边缘,悬停看真实值)
export function xyScatter(items, { height = 150 } = {}) {
  const W = 320;
  const H = height;
  const PAD = 14;
  const maxX = Math.min(30, Math.max(5, ...items.map((t) => t.sources || 0)));
  const x = (v) => PAD + (Math.min(v, maxX) / maxX) * (W - PAD * 2);
  const y = (v) => H - PAD - (v / 100) * (H - PAD * 2 - 12);
  const LC = { 萌芽: 'var(--accent)', 上升: 'var(--heat-1)', 峰值: 'var(--heat-3)', 衰退: 'var(--text-3)' };

  const svg = el('svg', { class: 'dash-scatter', viewBox: `0 0 ${W} ${H}` });
  svg.append(el('line', { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  svg.append(el('line', { x1: PAD, y1: PAD, x2: PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  const clipped = items.some((t) => (t.sources || 0) > maxX);
  svg.append(el('text', { x: W - PAD, y: H - 3, 'text-anchor': 'end', class: 'dash-scatter-axis', text: clipped ? '来源数 →(超 30 贴边)' : '来源数 →' }));
  svg.append(el('text', { x: PAD + 2, y: PAD + 9, 'text-anchor': 'start', class: 'dash-scatter-axis', text: '↑ 热度' }));
  // 纵轴刻度:热度分 0 / 50 / 100
  for (const v of [0, 50, 100]) {
    svg.append(el('text', { x: PAD - 3, y: (y(v) + 3).toFixed(1), 'text-anchor': 'end', class: 'dash-axis-lab', text: String(v) }));
  }

  items.forEach((t) => {
    const dot = el('circle', {
      cx: x(t.sources || 0).toFixed(1),
      cy: y(t.heat).toFixed(1),
      r: 5,
      fill: LC[t.lifecycle] || 'var(--text-3)',
      opacity: '0.85',
      onclick: () => {
        location.hash = `#/detail/${t.id}`;
      },
    });
    dot.append(el('title', { text: `${t.title} · 热度 ${t.heat} · 来源 ${t.sources} 条 · ${t.lifecycle}(${t.category})` }));
    svg.append(dot);
  });

  const wrap = el('div', { class: 'dash-scatter-wrap' });
  wrap.append(svg);
  wrap.append(legendRow([['var(--accent)', '萌芽'], ['var(--heat-1)', '上升'], ['var(--heat-3)', '峰值'], ['var(--text-3)', '衰退']]));
  return wrap;
}

// 点状分布图:items = [{id, title, date, heat_score, category}]
// x = 热度分,y = 周期内日期位置(越靠上越新),悬停看标题,点击进详情
export function scatterChart(items, { color = 'var(--accent)', start, end, height = 132 } = {}) {
  const wrap = el('div', { class: 'dash-scatter-wrap' });
  if (!items.length) {
    wrap.append(el('div', { class: 'mini-empty', text: '本周期无数据' }));
    return wrap;
  }
  const W = 320;
  const H = height;
  const PAD = 14;
  const maxHeat = 100;
  const minHeat = Math.max(0, Math.min(30, ...items.map((t) => t.heat_score)) - 5);
  const x = (v) => PAD + ((v - minHeat) / (maxHeat - minHeat)) * (W - PAD * 2);
  const d0 = start ? new Date(`${start}T00:00:00`).getTime() : 0;
  const d1 = end ? new Date(`${end}T00:00:00`).getTime() : 1;
  const y = (date) => PAD + ((d1 - new Date(`${date}T00:00:00`).getTime()) / Math.max(1, d1 - d0)) * (H - PAD * 2);

  const svg = el('svg', { class: 'dash-scatter', viewBox: `0 0 ${W} ${H}` });
  svg.append(el('line', { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  svg.append(el('line', { x1: PAD, y1: PAD, x2: PAD, y2: H - PAD, stroke: 'var(--line)', 'stroke-width': '1' }));
  svg.append(el('text', { x: W - PAD, y: H - 3, 'text-anchor': 'end', class: 'dash-scatter-axis', text: '热度 →' }));
  svg.append(el('text', { x: PAD + 2, y: PAD + 8, 'text-anchor': 'start', class: 'dash-scatter-axis', text: '↑ 新' }));

  items.forEach((t) => {
    const dot = el('circle', {
      cx: x(t.heat_score).toFixed(1),
      cy: y(t.date).toFixed(1),
      r: 5.5,
      fill: color,
      opacity: '0.85',
      onclick: () => {
        location.hash = `#/detail/${t.id}`;
      },
    });
    dot.append(el('title', { text: `${t.date} · ${t.title} — 热度 ${t.heat_score}` }));
    svg.append(dot);
  });

  wrap.append(svg);
  return wrap;
}

// 饼图:items = [{name, count}],实心扇形 + 中心总数 + 图例
export function pieChart(items, { size = 116 } = {}) {
  const total = items.reduce((a, c) => a + c.count, 0) || 1;
  const C = size / 2;
  const R = C * 0.78;
  const svg = el('svg', { class: 'dash-pie', viewBox: `0 0 ${size} ${size}`, style: `width:${size}px;height:${size}px` });

  let a0 = -Math.PI / 2;
  items.slice(0, 8).forEach((c, i) => {
    const a1 = a0 + (c.count / total) * Math.PI * 2;
    const x0 = C + R * Math.cos(a0);
    const y0 = C + R * Math.sin(a0);
    const x1 = C + R * Math.cos(a1);
    const y1 = C + R * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = el('path', {
      d: `M ${C} ${C} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
      fill: palette(i),
    });
    path.append(el('title', { text: `${c.name}:${c.count}(${Math.round((c.count / total) * 100)}%)` }));
    svg.append(path);
    a0 = a1;
  });
  svg.append(el('text', { x: C, y: C + 4, 'text-anchor': 'middle', class: 'dash-donut-num', text: String(total) }));
  svg.append(el('text', { x: C, y: C + 20, 'text-anchor': 'middle', class: 'dash-donut-lab', text: '热点数' }));

  const legend = el('div', { class: 'dash-legend' });
  items.slice(0, 8).forEach((c, i) => {
    legend.append(
      el('div', { class: 'dash-legend-row' }, [
        el('span', { class: 'dash-legend-dot', style: `background:${palette(i)}` }),
        el('span', { class: 'dash-legend-name', text: c.name }),
        el('span', { class: 'dash-legend-val', text: `${c.count} · ${Math.round((c.count / total) * 100)}%` }),
      ])
    );
  });

  const row = el('div', { class: 'dash-donut-wrap' });
  row.append(svg, legend);
  return row;
}

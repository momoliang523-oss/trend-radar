// 图表图片生成:AntV G2 本地渲染(public/vendor/g2.min.js,懒加载),
// 把当前页面的真实统计数据画成 1080×1440 中文图表海报(PNG 可下载)。
// 全程本地计算:不依赖远程生图服务、不扣积分、数字与页面完全一致。
import { el } from '../fmt.js';
import { toast } from './toast.js';
import { showImage } from './cardImage.js';

const W = 1080;
const H = 1440;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const INK = '#4f46e5'; // 主色(与站点 --brand 同系)

let g2Ready = null;
function loadG2() {
  if (g2Ready) return g2Ready;
  g2Ready = new Promise((resolve, reject) => {
    if (window.G2) return resolve();
    const s = document.createElement('script');
    s.src = '/vendor/g2.min.js';
    s.onload = () => resolve();
    s.onerror = () => {
      g2Ready = null;
      reject(new Error('图表组件加载失败'));
    };
    document.head.append(s);
  });
  return g2Ready;
}

// 在隐藏容器里渲染一个 G2 图表,返回其 canvas(失败返回 null)
async function renderChart(spec, w, h) {
  const host = el('div', { style: `position:fixed;left:-99999px;top:0;width:${w}px;height:${h}px` });
  document.body.append(host);
  try {
    const chart = new window.G2.Chart({ container: host, width: w, height: h });
    chart.options(spec);
    await chart.render();
    return { canvas: host.querySelector('canvas'), chart };
  } catch (e) {
    console.error('[chart] AntV 渲染失败:', e);
    host.remove();
    return null;
  }
}

const AXIS_X = { labelFontSize: 20, labelFill: '#94a3b8', line: false, tick: false, grid: false };
const AXIS_Y = { labelFontSize: 20, labelFill: '#94a3b8', gridStroke: '#e2e8f0', line: false, tick: false };

function lineSpec(daily) {
  return {
    type: 'line',
    data: daily.map((d) => ({ t: String(d.date || '').slice(5), v: d.avg })),
    encode: { x: 't', y: 'v' },
    style: { stroke: INK, lineWidth: 4 },
    point: { shape: 'circle', size: 9, style: { fill: INK, stroke: '#ffffff', lineWidth: 2 } },
    labels: [{ text: 'v', fontSize: 20, fill: '#475569', dy: -16 }],
    axis: { x: AXIS_X, y: AXIS_Y },
    tooltip: false,
  };
}

function pieSpec(items, palette) {
  return {
    type: 'interval',
    coordinate: { type: 'theta' },
    transform: [{ type: 'stackY' }],
    data: items,
    encode: { y: 'value', color: 'name' },
    scale: { color: { range: palette } },
    legend: { color: { position: 'right', labelFontSize: 20 } },
    tooltip: false,
  };
}

function barSpec(top) {
  return {
    type: 'interval',
    data: top.map((t) => ({ name: String(t.title || '').slice(0, 14), value: t.heat_score })),
    encode: { x: 'value', y: 'name' },
    coordinate: { transform: [{ type: 'transpose' }] },
    scale: { y: { range: [0, 1] } },
    axis: { x: AXIS_X, y: { ...AXIS_X, labelFontSize: 18 } },
    style: { fill: INK, radiusTopRight: 8, radiusBottomRight: 8 },
    labels: [{ text: 'value', fontSize: 20, fill: '#ffffff' }],
    tooltip: false,
  };
}

const PALETTE = ['#4f46e5', '#0ea5a4', '#f59e0b', '#f97316', '#dc2626', '#818cf8', '#2dd4bf', '#94a3b8'];

function text(ctx, s, x, y, font, color = '#0f172a', align = 'center') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

// 组装海报:标题 + 折线 + 饼图×2(+ 报告页 Top 榜横条)+ 落款
async function buildPoster({ type, payload }) {
  await loadG2();
  const poster = document.createElement('canvas');
  poster.width = W;
  poster.height = H;
  const ctx = poster.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, 14);

  const title = type === 'category' ? `「${payload.q || ''}」出海市场热度分析` : payload.label || '出海热点周期报告';
  text(ctx, title, W / 2, 92, `bold 50px ${FONT}`);
  const sub =
    type === 'category'
      ? `${payload.cat ? '聚焦类目:' + payload.cat + ' · ' : ''}数据窗口 ${payload.dateSpan || '近 30 天'}`
      : '出海热点雷达 · 周期数据报告';
  text(ctx, sub, W / 2, 154, `26px ${FONT}`, '#94a3b8');

  const norm = (items) => (items || []).map((c) => ({ name: c.name, value: c.count })).filter((x) => x.value > 0);
  const daily = Array.isArray(payload.daily) ? payload.daily.slice(-14) : [];
  const pies = [];
  if (type === 'category') {
    const stages = Object.entries(payload.stageCount || {})
      .map(([name, value]) => ({ name, value }))
      .filter((x) => x.value > 0);
    if (stages.length) pies.push({ title: '生命周期阶段分布', items: stages });
    const cats = norm(payload.cats).slice(0, 6);
    if (cats.length) pies.push({ title: '相关盘品类分布', items: cats });
  } else {
    const cats = norm(payload.categories).slice(0, 6);
    if (cats.length) pies.push({ title: '品类分布', items: cats });
    const plats = norm(payload.platforms).slice(0, 6);
    if (plats.length) pies.push({ title: '平台分布', items: plats });
  }

  let y = 200;
  if (daily.length > 1) {
    text(ctx, '热度走势(日均热度分)', 70, y + 26, `bold 28px ${FONT}`, '#475569', 'left');
    const r = await renderChart(lineSpec(daily), 1000, 360);
    if (r) {
      ctx.drawImage(r.canvas, 40, y + 56, 1000, 360);
      r.chart.destroy();
      r.canvas.parentElement?.remove();
    }
    y += 430;
  }

  if (pies.length) {
    const w = 500;
    pies.slice(0, 2).forEach((p, i) => {
      text(ctx, p.title, 40 + (w + 20) * i + 24, y + 24, `bold 26px ${FONT}`, '#475569', 'left');
    });
    for (let i = 0; i < Math.min(pies.length, 2); i++) {
      const r = await renderChart(pieSpec(pies[i].items, PALETTE), 480, 340);
      if (r) {
        ctx.drawImage(r.canvas, 40 + (w + 20) * i, y + 50, 480, 340);
        r.chart.destroy();
        r.canvas.parentElement?.remove();
      }
    }
    y += 430;
  }

  if (type === 'report' && (payload.top || []).length) {
    text(ctx, 'Top 热点榜(热度分)', 70, y + 26, `bold 28px ${FONT}`, '#475569', 'left');
    const r = await renderChart(barSpec(payload.top.slice(0, 8)), 1000, 280);
    if (r) {
      ctx.drawImage(r.canvas, 40, y + 56, 1000, 280);
      r.chart.destroy();
      r.canvas.parentElement?.remove();
    }
    y += 340;
  }

  text(ctx, '数据来源:出海热点雷达 · ' + new Date().toISOString().slice(0, 10) + ' 生成', W / 2, y + 36, `24px ${FONT}`, '#94a3b8');
  return poster;
}

export function chartImageBtn({ type, payload, label = '🖼 生成图表图片', note = '本地渲染图表海报 · 不扣积分 · 可保存分享', compact = false }) {
  const row = el('div', { class: 'genimg-row' + (compact ? ' compact' : '') }, [
    el('button', { class: 'genimg-btn' + (compact ? ' sm' : ''), text: label, onclick: () => run() }),
    compact ? null : el('span', { class: 'genimg-note', text: note }),
  ]);

  async function run() {
    const btn = row.querySelector('.genimg-btn');
    btn.disabled = true;
    btn.textContent = '⏳ 渲染中…';
    try {
      const poster = await buildPoster({ type, payload });
      showImage(poster.toDataURL('image/png'), '📊 图表海报 · 本地实时渲染');
    } catch (e) {
      toast(e.message || '图表生成失败,请稍后重试', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  return row;
}

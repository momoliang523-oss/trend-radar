// 格式化工具:数字、相对时间、热度色、本地日期
export function fmtEngagement(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (Number.isNaN(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return fmtLocalDate(new Date(t));
}

// 本地日期(与后端同口径,禁用 toISOString)
export function fmtLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return fmtLocalDate(new Date(y, m - 1, d + n));
}

export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = (dt.getDay() + 6) % 7;
  return fmtLocalDate(new Date(y, m - 1, d - wd));
}

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WD[new Date(y, m - 1, d).getDay()];
}

export function heatClass(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cool';
}

export function heatColor(score) {
  // 与 CSS 变量对应的内联色(热力条)
  if (score >= 70) return 'var(--hot)';
  if (score >= 40) return 'var(--warm)';
  return 'var(--cool)';
}

export function trendLabel(t) {
  return { up: '↑ 上升', down: '↓ 回落', flat: '→ 持平', new: '✨ 新上榜' }[t] || t;
}

export function platformEmoji(p) {
  return (
    {
      TikTok: '🎵',
      X: '𝕏',
      Instagram: '📸',
      Reddit: '👽',
      YouTube: '▶️',
      Amazon: '📦',
      'TikTok Shop': '🛍️',
      Shopee: '🛒',
      'Hacker News': '🧡',
      新闻: '📰',
      'Google News': '📰',
      'Bing News': '📰',
      'BBC News': '📰',
    }[p] || '🔗'
  );
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

// SVG 元素必须落在 SVG 命名空间,否则浏览器当作未知 HTML 元素不渲染(图表会塌成 0 高)
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'line', 'polyline', 'polygon', 'rect', 'text', 'g', 'defs', 'use', 'title']);
export function el(tag, attrs = {}, children = []) {
  const isSvg = SVG_TAGS.has(tag);
  const node = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') (isSvg ? node.setAttribute('class', v) : (node.className = v));
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // 仅用于静态模板,禁止拼模型输出
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// 单卡转图片:把任意图表卡片(标题 + SVG 图 + 注释)光栅化为 PNG。
// 方案:克隆卡片 → 递归内联 computed style(CSS 变量/class 全解析)→
// foreignObject 嵌入 SVG → Image → canvas(2x 清晰度)→ PNG dataURL。
// 全程本地,所见即所得(含当前主题配色),数字与页面完全一致。
import { el } from '../fmt.js';

// 定位/可见性属性基于页面上下文,内联后会跑位或隐身,跳过;其余(含 width/height 的 px 计算值)全部固化
const INLINE_SKIP = ['position', 'inset', 'left', 'top', 'right', 'bottom', 'z-index', 'visibility', 'opacity'];

// 递归内联 computed style;SVG 内元素的 fill/stroke/font 同样固化。
// 注意:Chrome 的 getComputedStyle().cssText 恒为空字符串,必须逐属性枚举。
function inlineStyles(root) {
  const walk = (node) => {
    if (node.nodeType === 1) {
      try {
        const cs = getComputedStyle(node);
        const parts = [];
        for (const p of cs) {
          if (INLINE_SKIP.some((k) => p.startsWith(k))) continue;
          parts.push(p + ':' + cs.getPropertyValue(p));
        }
        node.setAttribute('style', parts.join(';') + ';' + (node.getAttribute('style') || ''));
      } catch {
        /* 无样式元素忽略 */
      }
      node.removeAttribute('class');
      // 交互元素在图片里无效,去掉悬停 title 与点击属性
      if (node.tagName === 'TITLE') node.remove();
    }
    for (const c of node.children) walk(c);
  };
  walk(root);
}

export async function cardToPng(card) {
  const w = card.offsetWidth || 320;
  const h = card.offsetHeight || 240;
  const clone = card.cloneNode(true);
  // 去掉卡片里的转图片按钮自身,避免按钮出现在图片里
  clone.querySelectorAll('.card-img-btn').forEach((b) => b.remove());
  // detached 元素没有 computed style,先挂进隐藏容器(与卡片同宽保证布局一致)再内联
  const host = el('div', { style: `position:fixed;left:-99999px;top:0;width:${w}px;pointer-events:none;opacity:0` });
  document.body.append(host);
  host.append(clone);
  inlineStyles(clone);
  const html = clone.innerHTML;
  host.remove();

  // 外层用主题面板底色垫底(卡片自身背景已内联,这里只兜底)
  const bg = getComputedStyle(card).backgroundColor || '#ffffff';
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${w}px;background:${bg};`;
  wrap.innerHTML = html;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${wrap.innerHTML}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export function showImage(dataUrl, title = '📊 图表图片') {
  const mask = el('div', { class: 'img-modal-mask' });
  const card = el('div', { class: 'img-modal' }, [
    el('div', { class: 'img-modal-title', text: title }),
    el('img', { class: 'img-modal-img', src: dataUrl, alt: title }),
    el('div', { class: 'img-modal-actions' }, [
      el('a', { class: 'go-btn', href: dataUrl, download: 'trend-radar-chart.png', text: '💾 下载图片' }),
      el('button', { class: 'go-btn ghost', text: '关闭', onclick: () => mask.remove() }),
    ]),
  ]);
  mask.append(card);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) mask.remove();
  });
  document.body.append(mask);
}

// 图表卡片右上角的小按钮:把本卡转成图片(本地,不扣积分)
export function cardImageBtn(card) {
  const btn = el('button', {
    class: 'card-img-btn',
    text: '🖼 图片',
    title: '把本图表转成图片(可下载)',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        const dataUrl = await cardToPng(card);
        showImage(dataUrl);
      } catch (e) {
        console.error('[cardImage] 转图片失败:', e);
        el('div', { class: 'chart-note', text: '转图片失败,请重试' });
      } finally {
        btn.disabled = false;
        btn.textContent = '🖼 图片';
      }
    },
  });
  return btn;
}

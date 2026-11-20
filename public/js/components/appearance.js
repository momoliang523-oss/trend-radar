// 外观面板:右上角 ⚙️ 悬浮按钮 → 底部弹层(主题三选 + 字号三选)
import { el } from '../fmt.js';
import { store, saveTheme, saveFontSize } from '../store.js';

const THEMES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
];

const FONT_SIZES = [
  { value: 's', label: '小' },
  { value: 'm', label: '中' },
  { value: 'l', label: '大' },
];

export function initAppearance() {
  const root = document.getElementById('appearance-root');
  if (!root) return;

  root.append(el('button', { class: 'appearance-fab', text: '⚙️', title: '外观设置', onclick: open }));

  function open() {
    if (document.querySelector('.appearance-mask')) return;

    const sheet = el('div', { class: 'appearance-sheet' });
    const rerender = () => {
      sheet.innerHTML = '';
      sheet.append(
        el('div', { class: 'ap-title', text: '⚙️ 外观设置' }),
        el('div', { class: 'fb-label', text: '主题' }),
        el('div', { class: 'ap-seg' }, THEMES.map((t) =>
          el('button', {
            class: `ap-seg-btn${store.theme === t.value ? ' on' : ''}`,
            text: t.label,
            onclick: () => {
              saveTheme(t.value);
              rerender();
            },
          })
        )),
        el('div', { class: 'fb-label', text: '字体大小' }),
        el('div', { class: 'ap-seg' }, FONT_SIZES.map((f) =>
          el('button', {
            class: `ap-seg-btn${store.fontSize === f.value ? ' on' : ''}`,
            text: f.label,
            onclick: () => {
              saveFontSize(f.value);
              rerender();
            },
          })
        )),
      );
    };
    rerender();

    const mask = el('div', { class: 'appearance-mask' });
    mask.append(sheet);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.remove();
    });
    document.body.append(mask);
  }
}

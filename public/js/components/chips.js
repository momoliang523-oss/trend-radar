// 单选 chip 组(横向滚动)
import { el } from '../fmt.js';

// options: [{value, label}]; current: 当前值('' = 全部); onChange(value)
export function chips(options, current, onChange, allLabel = '全部') {
  const row = el('div', { class: 'chip-row' });
  const items = [{ value: '', label: allLabel }, ...options];
  for (const opt of items) {
    row.append(
      el(
        'button',
        {
          class: `chip${opt.value === current ? ' selected' : ''}`,
          text: opt.label,
          onclick: () => onChange(opt.value),
        },
        []
      )
    );
  }
  return row;
}

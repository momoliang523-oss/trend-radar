// 轻量 toast
import { el } from '../fmt.js';

let root = null;

function getRoot() {
  if (!root) root = document.getElementById('toast-root');
  return root;
}

export function toast(msg, type = 'info', ms = 2600) {
  const r = getRoot();
  if (!r) return;
  const t = el('div', { class: `toast${type === 'err' ? ' err' : ''}`, text: msg });
  r.append(t);
  setTimeout(() => t.remove(), ms);
}

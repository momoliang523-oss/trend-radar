// XSS 安全的微型 Markdown 渲染:只白名单 ##/###/#### 标题、**加粗**、- 列表、
// 1. 列表、> 引用、[n] 引用角标、http(s) 链接;一律经 textContent 写入,绝不 innerHTML 拼模型输出
import { el } from './fmt.js';

function inlineToNodes(text, citeClick) {
  const frag = document.createDocumentFragment();
  // 按优先级拆分:**bold** / [n] / http(s) 链接
  const re = /(\*\*[^*]+\*\*|\[\d+\]|https?:\/\/[^\s)\]>]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**') && tok.endsWith('**')) {
      frag.append(el('strong', {}, [tok.slice(2, -2)]));
    } else if (/^\[\d+\]$/.test(tok)) {
      frag.append(
        el('span', { class: 'cite', title: '查看引用来源', onclick: () => citeClick?.(Number(tok.slice(1, -1))) }, [tok])
      );
    } else {
      frag.append(el('a', { href: tok, target: '_blank', rel: 'noopener noreferrer' }, [tok]));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// Markdown 表格行(| a | b |),分隔行(|---|:--|)校验
const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
const isTableSep = (s) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.includes('-') && !/[^|\s:—-]/.test(s);
function tableCells(s) {
  return s
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function mdToDOM(md, { citeClick } = {}) {
  const frag = document.createDocumentFragment();
  const lines = (md || '').split('\n');
  let listEl = null; // 当前列表容器
  let listType = '';

  const closeList = () => {
    if (listEl) {
      frag.append(listEl);
      listEl = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    // 表格:表头行 + 分隔行 → <table>(数据对比内容以表格直观呈现)
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const table = el('table', { class: 'md-table' });
      const thead = el('thead', {}, [el('tr', {}, tableCells(line).map((c) => el('th', {}, [inlineToNodes(c, citeClick)])))]);
      const tbody = el('tbody');
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        tbody.append(el('tr', {}, tableCells(lines[j]).map((c) => el('td', {}, [inlineToNodes(c, citeClick)]))));
        j++;
      }
      table.append(thead, tbody);
      frag.append(table);
      i = j - 1;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = Math.min(2 + h[1].length, 4); // # → h2
      frag.append(el(`h${level}`, {}, [h[2]]));
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!listEl || listType !== 'ul') {
        closeList();
        listEl = el('ul');
        listType = 'ul';
      }
      listEl.append(el('li', {}, [inlineToNodes(bullet[1], citeClick)]));
      continue;
    }
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (num) {
      if (!listEl || listType !== 'ol') {
        closeList();
        listEl = el('ol');
        listType = 'ol';
      }
      listEl.append(el('li', {}, [inlineToNodes(num[1], citeClick)]));
      continue;
    }
    if (line.startsWith('>')) {
      closeList();
      frag.append(el('blockquote', {}, [inlineToNodes(line.replace(/^>\s*/, ''), citeClick)]));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      frag.append(el('hr'));
      continue;
    }
    closeList();
    frag.append(el('p', {}, [inlineToNodes(line, citeClick)]));
  }
  closeList();
  return frag;
}

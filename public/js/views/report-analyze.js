// 报告页 · 品类/单品深度分析模块:选品建议 + 实施建议 + 风险分析(SSE 流式)
import { el } from '../fmt.js';
import { getJSON, sseStream } from '../api.js';
import { mdToDOM } from '../md.js';
import { toast } from '../components/toast.js';
import { store, isLoggedIn } from '../store.js';

const SECTIONS = [
  { key: 'suggest', icon: '📦', title: '① 全面选品建议' },
  { key: 'plan', icon: '🚀', title: '② 实施建议' },
  { key: 'risk', icon: '⚠️', title: '③ 风险分析' },
];

const state = {
  scope: 'category',
  key: '', // 品类名或热点 id
  streamAbort: null,
  context: null,
  sections: null,
  sectionEls: {},
};

let options = { type: 'month', end: '', stats: null, favItems: [] }; // 外部注入

export function destroyAnalyzeBlock() {
  state.streamAbort?.();
  state.streamAbort = null;
}

// container: 挂载点;opts: {type, end, stats, favItems}
export async function renderAnalyzeBlock(container, opts) {
  options = opts;
  state.scope = 'category';
  state.key = '';
  state.context = null;
  state.sections = null;
  state.sectionEls = {};

  const head = el('div', { class: 'analyze-head' }, [
    el('span', { class: 'chart-title', style: 'padding:12px 0 0 14px', text: '🎯 品类 / 单品深度分析' }),
    el('span', { class: 'chart-note', text: '选品建议 · 实施建议 · 风险分析' }),
  ]);

  const controls = el('div', { class: 'analyze-controls' });
  const targetWrap = el('div', { class: 'analyze-target' });
  const result = el('div', { id: 'analyze-result' });

  const block = el('section', { class: 'set-group' }, [head, controls, targetWrap, result]);
  container.innerHTML = '';
  container.append(block);

  renderControls(controls, targetWrap);
  updateResult();
}

// ---------- 选择器 ----------

function renderControls(controls, targetWrap) {
  controls.innerHTML = '';

  // 维度切换:品类 / 单品
  const scopeRow = el('div', { class: 'analyze-controls-row' });
  for (const s of [
    { value: 'category', label: '品类' },
    { value: 'hotspot', label: '单品' },
  ]) {
    scopeRow.append(
      el('button', {
        class: `chip${state.scope === s.value ? ' selected' : ''}`,
        text: s.label,
        onclick: () => {
          if (state.scope === s.value) return;
          state.scope = s.value;
          state.key = '';
          state.sections = null;
          state.context = null;
          renderControls(controls, targetWrap);
          updateResult();
        },
      })
    );
  }
  controls.append(scopeRow);
  renderTarget(targetWrap);
}

function renderTarget(targetWrap) {
  targetWrap.innerHTML = '';
  if (state.scope === 'category') {
    // 品类 chips:高意向收藏品类优先,再补当前周期品类
    const favCats = options.favItems
      .filter((i) => i.level !== '普通')
      .map((i) => ({ name: i.category, level: i.level }));
    const statCats = (options.stats?.categories || []).map((c) => c.name);
    const cats = [
      ...favCats.map((c) => ({ ...c, fav: true })),
      ...statCats.filter((c) => !favCats.some((f) => f.name === c)).map((c) => ({ name: c, fav: false })),
    ];
    if (!cats.length) {
      targetWrap.append(el('div', { class: 'mini-empty', text: '本周期暂无品类数据' }));
      return;
    }
    if (!state.key) state.key = cats[0].name;
    const row = el('div', { class: 'analyze-controls-row' });
    for (const c of cats.slice(0, 10)) {
      row.append(
        el('button', {
          class: `chip${state.key === c.name ? ' selected' : ''}`,
          onclick: () => {
            if (state.key === c.name) return;
            state.key = c.name;
            state.sections = null;
            state.context = null;
            renderTarget(targetWrap);
            updateResult();
          },
        }, [
          c.fav ? el('span', { class: `tier-dot ${c.level}` }) : null,
          c.name,
        ])
      );
    }
    targetWrap.append(row);
  } else {
    // 单品:下拉选择(高意向收藏置顶)
    const favHotspots = options.favItems.filter((i) => i.level !== '普通');
    const statTop = (options.stats?.top || []).filter((t) => !favHotspots.some((f) => f.id === t.id));
    const options_list = [...favHotspots.map((f) => ({ id: f.id, title: f.title, fav: true })), ...statTop.slice(0, 12).map((t) => ({ id: t.id, title: t.title, fav: false }))];
    if (!options_list.length) {
      targetWrap.append(el('div', { class: 'mini-empty', text: '本周期暂无热点数据' }));
      return;
    }
    if (!state.key) state.key = String(options_list[0].id);
    const sel = el('select', { class: 'analyze-select', onchange: () => {
      state.key = sel.value;
      state.sections = null;
      state.context = null;
      renderTarget(targetWrap);
      updateResult();
    } });
    for (const o of options_list.slice(0, 15)) {
      sel.append(el('option', { value: String(o.id), text: `${o.fav ? '🎯 ' : ''}${o.title.slice(0, 40)}` }));
    }
    sel.value = state.key;
    targetWrap.append(sel);
  }
}

// ---------- 结果区 ----------

async function updateResult() {
  const result = document.getElementById('analyze-result');
  if (!result) return;
  result.innerHTML = '';
  if (!state.key) return;

  // 先查缓存
  let cached = null;
  try {
    const q = analyzeQs(false);
    const d = await getJSON(`/api/analyze/cached?${q}`);
    cached = d.cached;
  } catch {
    /* 忽略 */
  }

  if (cached?.sections) {
    state.sections = cached.sections;
    result.append(
      el('div', { class: 'chart-note', text: `已缓存的分析结果 · ${timeLabel(cached.created_at)}` })
    );
    renderSections(result, cached.sections);
    appendRegenerate(result);
  } else {
    result.append(
      el('div', { class: 'analyze-empty' }, [
        el('div', { class: 'desc', text: `将基于 ${state.scope === 'category' ? '该品类' : '该单品'}在当前周期的信号,输出选品建议、实施建议与风险分析(约 1-2 分钟)` }),
        el('button', { class: 'go-btn', text: '⚡ 生成深度分析', onclick: () => startAnalyze() }),
      ])
    );
  }
}

function analyzeQs(force) {
  const q = new URLSearchParams({ scope: state.scope, type: options.type, end: options.end });
  if (state.scope === 'category') q.set('key', state.key);
  else q.set('id', state.key);
  if (force) q.set('force', '1');
  if (store.profile.platforms.length) q.set('platforms', store.profile.platforms.join(','));
  return q;
}

function startAnalyze(force = false) {
  if (!isLoggedIn()) {
    toast('请先登录后使用完整功能', 'info');
    location.hash = '#/me';
    return;
  }
  if (state.streamAbort) return;
  const result = document.getElementById('analyze-result');
  result.innerHTML = '';
  state.sectionEls = {};
  state.sections = null;

  // 概况卡容器(SSE 的 context 事件填充)
  const contextBox = el('div', { id: 'analyze-context' });
  contextBox.append(el('div', { class: 'chart-note', text: '正在装载分析上下文…' }));
  result.append(contextBox);

  for (const s of SECTIONS) {
    result.append(buildSectionCard(s));
  }

  const controller = new AbortController();
  state.streamAbort = controller.abort.bind(controller);

  sseStream(
    `/api/analyze/stream?${analyzeQs(force)}`,
    {
      onContext: (ctx) => {
        state.context = ctx;
        const probe = document.getElementById('analyze-context');
        if (probe) renderContextCard(probe, ctx);
      },
      onSectionStart: () => {},
      onDelta: ({ section, text }) => {
        const s = state.sectionEls[section];
        if (!s) return;
        s.text += text;
        s.body.replaceChildren(mdToDOM(s.text));
      },
      onSectionDone: ({ section, confidence, citations, markdown, degraded, partial }) => {
        finalizeSection(section, { markdown, confidence, citations, degraded, partial });
      },
      onCached: (d) => {
        // 服务端缓存命中(与预检查竞态)
        state.sections = d.sections;
        result.innerHTML = '';
        result.append(
          el('div', { class: 'chart-note', text: `已缓存的分析结果 · ${timeLabel(d.created_at)}` })
        );
        renderSections(result, d.sections);
        appendRegenerate(result);
        state.streamAbort = null;
      },
      onDone: () => {
        state.streamAbort = null;
        toast('✅ 深度分析已生成');
      },
      onError: (e) => {
        state.streamAbort = null;
        toast(e.message, 'err');
        updateResult();
      },
    },
    controller.signal
  );
}

// ---------- 概况卡 ----------

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function renderContextCard(card, ctx) {
  card.innerHTML = '';
  const box = el('div', { class: 'analyze-context' });
  if (ctx.error) {
    box.append(el('div', { class: 'desc', text: ctx.error }));
    card.append(box);
    return;
  }
  const tierBadge = ctx.favoriteLevel && ctx.favoriteLevel !== '普通'
    ? el('span', { class: `badge tier ${ctx.favoriteLevel}`, text: `🎯 用户意向:${ctx.favoriteLevel}` })
    : null;
  const rows = [];
  if (ctx.scope === 'category' && ctx.stats) {
    rows.push(`周期 ${ctx.period.label} · ${ctx.stats.total} 条热点 · 平均热度 ${ctx.stats.avgHeat} · 峰值 ${ctx.stats.maxHeat}`);
    rows.push(`上升 ${ctx.stats.rising} 条 / 退潮 ${ctx.stats.falling} 条 · 平台:${ctx.stats.platforms.map((p) => p.name).join('、') || '—'}`);
    if (ctx.favoriteTitles?.length) rows.push(`你的收藏:${ctx.favoriteTitles.slice(0, 3).join('、')}`);
  } else if (ctx.hotspot) {
    const h = ctx.hotspot;
    rows.push(`${h.title} · 热度 ${h.heat_score} · ${h.lifecycle}期 · ${h.date}`);
    rows.push(`同类市场:${ctx.market.length} 条同类热点`);
  }
  box.append(
    el('div', { class: 'analyze-context-title', text: ctx.target.label }),
    tierBadge,
    ...rows.map((r) => el('div', { class: 'chart-note', text: r }))
  );
  card.append(box);
}

// ---------- 分区卡 ----------

function buildSectionCard(sec) {
  const card = el('div', { class: 'sec-card' });
  const head = el('div', { class: 'sec-head' }, [
    el('span', { class: 'sec-title', text: `${sec.icon} ${sec.title}` }),
    el('span', { class: 'sec-badges' }, [el('span', { class: 'sec-provider', text: '等待生成…' })]),
  ]);
  const body = el('div', { class: 'sec-body' });
  const cites = el('div', { class: 'sec-cites' });
  const foot = el('div', { class: 'sec-foot' });
  card.append(head, body, cites, foot);
  body.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }), el('div', { class: 'sk-line w90 skeleton' }));
  state.sectionEls[sec.key] = { card, body, cites, foot, text: '' };
  return card;
}

function finalizeSection(key, sec) {
  const s = state.sectionEls[key];
  if (!s) return;
  s.text = sec.markdown || s.text;
  s.body.replaceChildren(mdToDOM(s.text));

  const badges = s.card.querySelector('.sec-badges');
  badges.innerHTML = '';
  badges.append(el('span', { class: `badge conf ${sec.confidence}`, text: `可信度 ${sec.confidence}` }));
  if (sec.degraded || sec.partial) {
    badges.append(el('span', { class: 'sec-provider', text: '降级摘要', style: 'color:var(--warm)' }));
  }

  s.cites.innerHTML = '';
  if ((sec.citations || []).length) {
    s.cites.append(el('div', { class: 'cites-title', text: '📎 引用来源(点击回源)' }));
    for (const c of sec.citations) {
      s.cites.append(
        el('a', { class: 'cite-chip', href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.url }, [
          el('span', { class: 'n', text: String(c.index) }),
          el('span', { class: 't', text: `${c.platform} · ${c.title}` }),
        ])
      );
    }
  }

  s.foot.innerHTML = '';
  s.foot.append(el('button', { class: 'copy-btn', text: '📋 复制', onclick: () => copyText(s.text) }));
}

function renderSections(result, sections) {
  state.sectionEls = {};
  const degraded = Object.values(sections).some((s) => s?.degraded);
  if (degraded) {
    result.append(
      el('div', { class: 'analyze-context', style: 'border:1px dashed var(--warm)' }, [
        el('div', { class: 'analyze-context-title', text: '⚠️ 上次生成时智能分析不可用,当前为数据自动汇总' }),
        el('button', { class: 'go-btn', text: '↻ 重新生成完整分析', onclick: () => startAnalyze(true) }),
      ])
    );
  }
  for (const sec of SECTIONS) {
    const s = sections[sec.key];
    if (!s) continue;
    result.append(buildSectionCard(sec));
    finalizeSection(sec.key, { ...s, markdown: s.markdown });
  }
}

function appendRegenerate(result) {
  const foot = el('div', { class: 'sec-foot' }, [
    el('button', { class: 'retry-btn', text: '↻ 重新生成', onclick: () => startAnalyze(true) }),
  ]);
  result.append(foot);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制到剪贴板');
  }
}

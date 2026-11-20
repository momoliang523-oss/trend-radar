// 选品视图:① 类目/产品关键词分析(登录解锁、消耗积分;先选类目 → 图表 + 精要文字,SSE 流式)
// ② 选品车列表 + 一键复制清单;管理员另有「文字版」自媒体文案(仅管理员可见)
import { el } from '../fmt.js';
import { getJSON, sseStream } from '../api.js';
import { mdToDOM } from '../md.js';
import { hotspotCard } from '../components/hotspotCard.js';
import { lineChart, pieChart, chartCard, barTrend } from '../components/charts.js';
import { chartImageBtn } from '../components/chartImage.js';
import { refreshCart, store, isLoggedIn } from '../store.js';
import { toast } from '../components/toast.js';

const SECTIONS = [
  { key: 'map', icon: '🧭', title: '① 类目定位与关联类目' },
  { key: 'cycle', icon: '📈', title: '② 产品生命周期信号' },
  { key: 'pick', icon: '📦', title: '③ 选品建议' },
];

const state = {
  q: '',
  cat: '',
  streamAbort: null,
  sectionEls: {},
};

export default {
  async render(mount) {
    state.streamAbort = null;
    state.sectionEls = {};
    const page = el('div', { class: 'page' });
    const topbar = el('div', { class: 'topbar' }, [
      el('div', { class: 'topbar-inner' }, [
        el('div', { class: 'topbar-row' }, [
          el('div', { class: 'app-title' }, [el('span', { class: 'logo', text: '🛒' }), '选品']),
          el('div', { id: 'cart-copy-wrap' }),
        ]),
        el('div', { class: 'app-sub', text: '类目分析 + 选品车清单' }),
      ]),
    ]);
    mount.append(topbar, page);

    // ① 类目 / 产品关键词分析
    page.append(buildCategorySearch());

    // ② 选品车
    const list = el('div', { class: 'card-list', style: 'margin-top:12px' });
    page.append(list);

    list.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }));
    try {
      const d = await getJSON('/api/cart');
      renderCopyBtn(d.items);
      list.innerHTML = '';
      if (!d.items.length) {
        list.append(
          el('div', { class: 'empty' }, [
            el('span', { class: 'emoji', text: '🛒' }),
            el('div', { class: 'title', text: '选品车还是空的' }),
            el('div', { class: 'desc', text: '在热点卡片或详情页点 🛒,把值得做的品收进来' }),
            el('button', { class: 'go-btn', text: '去日历选品', onclick: () => (location.hash = '#/calendar') }),
          ])
        );
        return;
      }
      d.items.forEach((item, i) => {
        item.rank = i + 1;
        list.append(
          hotspotCard(item, {
            onCartChange: () => refreshCart().then(() => location.reload()),
          })
        );
      });
    } catch (e) {
      list.innerHTML = '';
      list.append(el('div', { class: 'empty' }, [el('div', { class: 'desc', text: e.message || '加载失败' })]));
    }
  },

  destroy() {
    state.streamAbort?.();
    state.streamAbort = null;
  },
};

// ---------- ① 类目 / 产品关键词分析 ----------

function buildCategorySearch() {
  const input = el('input', {
    class: 'search-input',
    type: 'search',
    value: state.q,
    placeholder: '🔍 输入类目或产品关键词,如:假睫毛 / 露营 / 清洁剂',
    onkeydown: (e) => {
      if (e.key === 'Enter') startSearch(input);
    },
  });

  const result = el('div', { id: 'cat-result' });

  const sec = el('section', { class: 'set-group' }, [
    el('div', { class: 'analyze-head' }, [
      el('span', { class: 'chart-title', style: 'padding:12px 0 0 14px', text: '🔍 类目 / 产品分析' }),
      el('span', { class: 'chart-note', text: isLoggedIn() ? '消耗积分 · 按次计费' : '🔒 登录解锁' }),
    ]),
    el('div', { class: 'search-bar', style: 'padding:8px 14px 4px' }, [
      input,
      el('button', { class: 'search-btn', text: '⚡ 开始分析', onclick: () => startSearch(input) }),
    ]),
    el('div', { class: 'chart-note', text: '输入产品关键词,先选类目,再输出市场热度、图表与选品建议' }),
    result,
  ]);
  return sec;
}

// 阶段一:匹配候选类目,让用户先选(选定后才输出市场热度分析)
async function startSearch(input) {
  const q = input.value.trim();
  if (!q) {
    toast('请输入要分析的类目或产品关键词', 'info');
    return;
  }
  if (!isLoggedIn()) {
    toast('类目分析消耗积分,请先登录解锁', 'info');
    location.hash = '#/me';
    return;
  }
  if (state.streamAbort) return;
  state.q = q;
  state.cat = '';

  const result = document.getElementById('cat-result');
  if (!result) return;
  result.innerHTML = '';
  state.sectionEls = {};

  const box = el('div', { id: 'cat-context' });
  box.append(el('div', { class: 'chart-note', text: '正在匹配关联类目…' }));
  result.append(box);

  let ctx = null;
  try {
    ctx = await getJSON(`/api/category/context?q=${encodeURIComponent(q)}`);
  } catch {
    ctx = null;
  }
  result.innerHTML = '';
  if (!ctx) {
    result.append(el('div', { class: 'analyze-empty' }, [el('div', { class: 'desc', text: '匹配类目失败,请重试' })]));
    return;
  }
  if (ctx.error) {
    result.append(el('div', { class: 'analyze-empty' }, [el('div', { class: 'desc', text: ctx.error })]));
    return;
  }
  renderCatPicker(result, ctx, q, input);
}

function renderCatPicker(result, ctx, q, input) {
  const card = el('div', { class: 'cat-pick-card' });
  card.append(
    el('div', { class: 'cat-pick-title', text: `「${q}」可能属于这些类目,先选一个:` }),
    el('div', { class: 'cat-pick-sub', text: '选定类目后再输出市场热度分析(选贴合产品的类目更精准,可返回重选)' })
  );

  const chips = el('div', { class: 'pick-chips' });
  (ctx.matched?.categories || []).slice(0, 6).forEach((c) => {
    chips.append(
      el('button', { class: 'pick-chip', onclick: () => runPhase2(result, q, c.name, input) }, [
        el('span', { class: 't', text: c.name }),
        el('span', { class: 'cnt', text: `${c.count} 条` }),
      ])
    );
  });
  chips.append(el('button', { class: 'pick-chip any', text: '不限类目 · 直接分析', onclick: () => runPhase2(result, q, '', input) }));
  card.append(chips);

  const words = (ctx.matched?.relatedWords || []).slice(0, 6);
  if (words.length) {
    card.append(el('div', { class: 'pick-group-label', text: '或按关联方向聚焦:' }));
    const wchips = el('div', { class: 'pick-chips' });
    words.forEach((w) => {
      wchips.append(
        el('button', { class: 'pick-chip word', onclick: () => runPhase2(result, q, w, input) }, [el('span', { class: 't', text: w })])
      );
    });
    card.append(wchips);
  }

  result.append(card);
}

// 阶段二:选定类目后 → 图表模块 + 流式分区分析
async function runPhase2(result, q, cat, input) {
  if (state.streamAbort) return;
  state.cat = cat;
  result.innerHTML = '';
  state.sectionEls = {};

  const contextBox = el('div', { id: 'cat-context' });
  contextBox.append(
    el('div', { class: 'chart-note', text: cat ? `已选「${cat}」,正在生成市场热度分析…` : '正在匹配类目与装配数据…' })
  );
  result.append(contextBox);
  const chartsBox = el('div', { id: 'cat-charts' });
  result.append(chartsBox);
  mountResearch(result, q, cat);
  mountTrade(result, q);

  const qsFor = () => {
    const qs = new URLSearchParams({ q });
    if (cat) qs.set('cat', cat);
    return qs;
  };

  // 先查当天缓存(命中则不再扣积分)
  let cached = null;
  let ctx = null;
  try {
    const d = await getJSON(`/api/category/cached?${qsFor()}`);
    cached = d.cached;
  } catch {
    /* 忽略 */
  }
  try {
    ctx = await getJSON(`/api/category/context?${qsFor()}`);
  } catch {
    /* 忽略 */
  }
  if (ctx && !ctx.error) {
    renderContextCard(document.getElementById('cat-context'), ctx);
    renderCharts(document.getElementById('cat-charts'), ctx);
  }

  if (cached?.sections) {
    result.append(el('div', { class: 'chart-note', text: `已缓存的分析结果 · ${timeLabel(cached.created_at)}` }));
    renderSections(result, cached.sections);
    renderAdminCopy(result, q, cat);
    return;
  }

  for (const s of SECTIONS) result.append(buildSectionCard(s));

  const controller = new AbortController();
  state.streamAbort = controller.abort.bind(controller);

  const qs = qsFor();
  if (store.profile.platforms.length) qs.set('platforms', store.profile.platforms.join(','));

  sseStream(
    `/api/category/stream?${qs}`,
    {
      onContext: (c) => {
        ctx = c; // 流内上下文为准(含选定类目后的精确数据)
        const probe = document.getElementById('cat-context');
        if (probe) renderContextCard(probe, c);
        renderCharts(document.getElementById('cat-charts'), c);
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
        state.sectionEls = {};
        result.innerHTML = '';
        const box = el('div', { id: 'cat-context' });
        result.append(box, el('div', { id: 'cat-charts' }));
        mountResearch(result, q, cat);
        mountTrade(result, q);
        if (ctx && !ctx.error) {
          renderContextCard(box, ctx);
          renderCharts(document.getElementById('cat-charts'), ctx);
        }
        result.append(el('div', { class: 'chart-note', text: `已缓存的分析结果 · ${timeLabel(d.created_at)}` }));
        renderSections(result, d.sections);
        renderAdminCopy(result, q, cat);
        state.streamAbort = null;
      },
      onDone: () => {
        state.streamAbort = null;
        toast('✅ 类目分析已生成');
        renderAdminCopy(result, q, cat);
      },
      onError: (e) => {
        state.streamAbort = null;
        toast(e.message, 'err');
        const r = document.getElementById('cat-result');
        if (r) {
          r.innerHTML = '';
          r.append(el('div', { class: 'analyze-empty' }, [el('div', { class: 'desc', text: e.message || '生成失败' })]));
        }
      },
    },
    controller.signal
  );
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 概况卡:匹配情况 + 关联类目 + 市场概况
function renderContextCard(card, ctx) {
  card.innerHTML = '';
  if (ctx.error) {
    card.append(el('div', { class: 'analyze-context' }, [el('div', { class: 'chart-note', text: ctx.error })]));
    return;
  }
  const m = ctx.matched || {};
  const s = ctx.stats || {};
  const scope = ctx.cat || (ctx.scope && ctx.scope !== 'search' ? ctx.scope : '');
  const rows = [
    `近 30 天(${ctx.window?.start || ''} ~ ${ctx.window?.end || ''}):话题命中 ${m.topicHits ?? 0} 条 · 信号命中 ${m.signalHits ?? 0} 条 · 类目命中 ${m.categoryHits ?? 0} 条`,
    `关联类目:${(m.categories || []).map((c) => `${c.name}(${c.count})`).join('、') || '无直接命中'}`,
    `相关盘 ${s.total ?? 0} 条热点 · 平均热度 ${s.avgHeat ?? 0} · 峰值 ${s.maxHeat ?? 0} · 上升 ${s.rising ?? 0} / 退潮 ${s.falling ?? 0}`,
  ];
  card.append(
    el('div', { class: 'analyze-context' }, [
      el('div', { class: 'analyze-context-title', text: `${scope ? `「${ctx.q} · ${scope}」` : `「${ctx.q}」`}类目品分析` }),
      ...rows.map((r) => el('div', { class: 'chart-note', text: r })),
    ])
  );
}

// ---------- 行业研报(发现报告):研报卡 + 月度覆盖/机构分布(服务器数据,不来自模型文本) ----------

function mountResearch(result, q, cat) {
  const box = el('div', { id: 'cat-research' });
  result.append(box);
  loadResearch(box, q, cat);
}

async function loadResearch(box, q, cat) {
  const qs = new URLSearchParams({ q });
  if (cat) qs.set('cat', cat);
  box.append(el('div', { class: 'chart-note', style: 'padding:8px 14px', text: '📚 正在检索行业研报…' }));
  let d = null;
  try {
    d = await getJSON(`/api/category/research?${qs}`);
  } catch {
    d = null;
  }
  if (!box.isConnected) return; // 用户已切换分析,丢弃旧结果
  box.innerHTML = '';
  if (!d || !d.enabled || !(d.reports || []).length) return; // 未配置 key / 失败 / 无结果 → 整块隐藏
  renderResearch(box, d);
}

function renderResearch(box, d) {
  const sec = el('section', { class: 'set-group' });
  sec.append(el('div', { class: 'chart-head' }, [el('div', { class: 'chart-title', text: '📚 行业研报 · 发现报告' })]));
  sec.append(
    el('div', {
      class: 'chart-note',
      text: `近 12 个月检索到 ${d.total} 篇相关研报${d.cached ? ' · 今日已缓存' : ''} · 与「${d.q}」相关,点击卡片阅读原文`,
    })
  );

  const cols = el('div', { class: 'dash-cols' });
  if ((d.monthly || []).some((x) => x.value > 0)) {
    cols.append(chartCard('📅 研报月度覆盖', barTrend(d.monthly), '柱 = 当月发布的相关研报数(0 = 该月未检索到,不是缺失插值)'));
  }
  if ((d.orgs || []).length) {
    cols.append(chartCard('🏢 研报机构分布', pieChart(d.orgs), '扇区 = 发布机构篇数占比'));
  }
  if (cols.childNodes.length) sec.append(cols);

  const list = el('div', { class: 'rpt-research-list' });
  for (const r of d.reports) {
    const excerpt = r.summary || r.paragraphs?.[0]?.content || '';
    list.append(
      el('a', { class: 'rpt-item', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, [
        el('div', { class: 'rpt-title', text: r.title }),
        el('div', { class: 'rpt-meta', text: [r.org, r.pubTimeStr, r.industry].filter(Boolean).join(' · ') || '—' }),
        excerpt ? el('div', { class: 'rpt-excerpt', text: excerpt }) : null,
        el('div', { class: 'rpt-go', text: '阅读原文 →' }),
      ])
    );
  }
  sec.append(list);
  box.append(sec);
}

// ---------- 品类进口趋势(UN Comtrade 公开预览接口,无需注册):确定性统计数据 ----------

function mountTrade(result, q) {
  const box = el('div', { id: 'cat-trade' });
  result.append(box);
  loadTrade(box, q);
}

async function loadTrade(box, q) {
  box.append(el('div', { class: 'chart-note', style: 'padding:8px 14px', text: '🌍 正在检索品类进口数据…' }));
  let d = null;
  try {
    d = await getJSON(`/api/category/trade?part=latest&q=${encodeURIComponent(q)}`);
  } catch {
    d = null;
  }
  if (!box.isConnected) return; // 用户已切换分析,丢弃旧结果
  box.innerHTML = '';
  if (!d || !d.enabled || !d.matched || !(d.latest || []).length) return; // 关键词匹配不到 HS 编码 / 失败 → 整块隐藏
  const cols = renderTrade(box, d);

  // 近 5 年趋势较慢(约 25 秒),后台补进同一张卡
  try {
    const t = await getJSON(`/api/category/trade?part=trend&q=${encodeURIComponent(q)}`);
    if (!box.isConnected || !t || !t.matched || !(t.trend || []).length) return;
    cols.append(chartCard('📈 近 5 年进口额合计', lineChart(t.trend), '折线 = 12 个主要市场进口额合计(亿美元);0 = 该年未检索到数据,不是插值'));
  } catch {
    /* 趋势失败不影响柱图 */
  }
}

function renderTrade(box, d) {
  const sec = el('section', { class: 'set-group' });
  sec.append(el('div', { class: 'chart-head' }, [el('div', { class: 'chart-title', text: '🌍 品类进口趋势 · UN Comtrade' })]));
  sec.append(
    el('div', {
      class: 'chart-note',
      text: `按 HS ${d.code}(${d.label})统计主要市场进口额 · 单位:亿美元${d.cached ? ' · 今日已缓存' : ''} · 数据源 UN Comtrade`,
    })
  );
  const cols = el('div', { class: 'dash-cols' });
  const bars = (d.latest || []).map((x) => ({ label: x.name, value: x.value }));
  cols.append(chartCard(`📊 ${d.latestYear} 年主要市场进口额`, barTrend(bars), '柱 = 该市场当年进口额(亿美元),显示前 8 大市场'));
  sec.append(cols);
  sec.append(el('div', { class: 'chart-note', text: '注:进口额不等于销量;HS 编码按关键词自动匹配,仅作市场规模参考' }));
  box.append(sec);
  return cols;
}

// 图表模块:折线趋势 + 饼图(生命周期/品类分布),数据全部来自服务器统计
function renderCharts(root, ctx) {
  root.innerHTML = '';
  if (!ctx || ctx.error) return;
  const s = ctx.stats || {};
  const wrap = el('div');
  if ((s.daily || []).length > 1) {
    wrap.append(chartCard(`📈 相关盘热度趋势(${s.daily.length} 天有数据)`, lineChart(s.daily), '折线 = 当日相关热点平均热度 · 点住圆点看数值'));
  }
  const cols = el('div', { class: 'dash-cols' });
  const stages = Object.entries(s.stageCount || {})
    .map(([name, count]) => ({ name, count }))
    .filter((x) => x.count > 0);
  if (stages.length) cols.append(chartCard('🌱 生命周期阶段分布', pieChart(stages), '扇区 = 相关盘热点所处阶段'));
  if ((s.cats || []).length) cols.append(chartCard('🏷 相关盘品类分布', pieChart(s.cats), '扇区 = 相关盘热点品类占比'));
  if (cols.childNodes.length) wrap.append(cols);

  // 整页海报:AntV G2 本地渲染(不依赖远程生图、不扣积分);单卡转图用每卡右上角「🖼 图片」
  const posterRow = el('div', { class: 'dash-head' }, [
    el('div', { class: 'chart-note', text: '每张图表卡右上角「🖼 图片」可单独转图 · 下面按钮合成整页海报' }),
    chartImageBtn({
      type: 'category',
      payload: {
        q: state.q,
        cat: state.cat || (ctx.scope && ctx.scope !== 'search' ? ctx.scope : ''),
        daily: (s.daily || []).slice(-14),
        stageCount: s.stageCount || {},
        cats: (s.cats || []).slice(0, 6),
        topTitles: (s.topTitles || []).slice(0, 5),
        dateSpan: s.dateSpan || '',
      },
      label: '🖼 整页海报',
      note: '',
      compact: true,
    }),
  ]);
  wrap.append(posterRow);
  if (wrap.childNodes.length) root.append(wrap);
}

// 管理员专属:文字版自媒体文案(微信小程序 / 小红书爆款文案)
function renderAdminCopy(result, q, cat) {
  if (!store.auth.user?.is_admin) return;
  const body = el('div', { id: 'cat-copy-body', class: 'narrative-body' });
  body.append(el('div', { class: 'chart-note', text: '微信小程序 / 小红书爆款文案,仅管理员可见(用于自媒体传播)' }));
  body.append(el('button', { class: 'go-btn', text: '⚡ 生成文字版文案', onclick: () => startCatCopy(q, cat) }));
  result.append(
    el('section', { class: 'set-group copy-card' }, [
      el('div', { class: 'chart-title', text: '📝 文字版(自媒体传播文案)' }),
      body,
    ])
  );
}

function startCatCopy(q, cat) {
  const body = document.getElementById('cat-copy-body');
  if (!body || state.streamAbort) return;
  body.innerHTML = '';
  body.append(el('div', { class: 'extend-progress' }, [el('span', { class: 'spinner' }), '文案生成中…']));

  const qs = new URLSearchParams({ q });
  if (cat) qs.set('cat', cat);
  const controller = new AbortController();
  state.streamAbort = controller.abort.bind(controller);
  let text = '';

  sseStream(
    `/api/category/copy?${qs}`,
    {
      onDelta: ({ text: t }) => {
        text += t;
        body.replaceChildren(mdToDOM(text));
      },
      onDone: () => {
        state.streamAbort = null;
        body.append(
          el('div', { class: 'sec-foot', style: 'margin-top:10px' }, [
            el('button', { class: 'copy-btn', text: '📋 复制文案', onclick: () => copyText(text) }),
            el('button', { class: 'retry-btn', text: '↻ 重新生成', onclick: () => startCatCopy(q, cat) }),
          ])
        );
        toast('✅ 文案已生成(仅管理员可见)');
      },
      onError: (e) => {
        state.streamAbort = null;
        body.innerHTML = '';
        body.append(el('div', { class: 'desc', style: 'padding:8px 0', text: e.message || '生成失败' }));
        body.append(el('button', { class: 'go-btn', text: '⚡ 重试', onclick: () => startCatCopy(q, cat) }));
        toast(e.message, 'err');
      },
    },
    controller.signal
  );
}

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

// ---------- ② 选品车清单 ----------

function renderCopyBtn(items) {
  const wrap = document.getElementById('cart-copy-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!items.length) return;
  wrap.append(
    el('button', { class: 'action-btn primary', text: '📋 复制清单', onclick: () => copyList(items) })
  );
}

async function copyList(items) {
  const lines = items.map((it, i) => {
    const heat = it.heat_score;
    const trend = { up: '↑', down: '↓', new: '✨', flat: '→' }[it.heat_trend] || '';
    const plats = (it.platforms || []).slice(0, 4).join('/');
    return `${i + 1}. ${it.title}\n   类目:${it.category} · 热度:${heat}${trend} · 平台:${plats || '—'}`;
  });
  const text = `【出海选品清单】共 ${items.length} 条\n\n${lines.join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('清单已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('清单已复制到剪贴板');
  }
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

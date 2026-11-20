// 报告视图:周期(周/月/季)选择 + 固定四段(一句话结论 → 五张趋势图 → 明细表 → 下周期 3 个动作)
// 五个板块五个问题五种图:区域热点(多国折线)/ 类目机会(分组柱)/ 话题风向(堆叠柱)/ 生命周期(阶段带)/ 竞品与价格(散点)
// 规则:先定这一屏要回答什么,再由问题反推图型;每张图下一行读法(人话结论);周桶缺数据留空档,不插值
import { el, fmtLocalDate } from '../fmt.js';
import { getJSON, sseStream } from '../api.js';
import { mdToDOM } from '../md.js';
import { toast } from '../components/toast.js';
import { isLoggedIn, store } from '../store.js';
import { multiLine, groupedBars, stackedBars, stageBands, xyScatter, chartCard, palette } from '../components/charts.js';
import { renderAnalyzeBlock, destroyAnalyzeBlock } from './report-analyze.js';

const TYPE_OPTIONS = [
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'quarter', label: '季' },
];

const HEAT_OPTIONS = [
  { value: '', label: '全部热度' },
  { value: 'hot', label: '🔥 高 ≥70' },
  { value: 'warm', label: '🌤 中 40-69' },
  { value: 'cool', label: '❄ 低 <40' },
];

const state = {
  type: 'week',
  end: fmtLocalDate(),
  region: '', // 地区筛选(参考 HotPilot 工具栏:美国 / 欧洲 / 东南亚 / 中东…;空 = 全地区)
  q: '', // 话题关键词搜索(非空时榜单 = 搜索结果,按热度排序)
  heat: '', // 搜索结果的热度筛选 hot|warm|cool
  data: null,
  streamAbort: null,
};

export default {
  async render(mount) {
    state.streamAbort = null;
    mount.append(buildShell());
    await load();
  },

  destroy() {
    state.streamAbort?.();
    state.streamAbort = null;
    destroyAnalyzeBlock();
  },
};

function buildShell() {
  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'topbar-inner' }, [
      el('div', { class: 'topbar-row' }, [
        el('div', { class: 'app-title' }, [el('span', { class: 'logo', text: '📊' }), '周期报告']),
        el('div', { id: 'report-nav' }),
      ]),
      el('div', { class: 'app-sub', text: '周度总结 · 月度回顾 · 季度复盘' }),
    ]),
  ]);

  const page = el('div', { class: 'page', style: 'padding-top:12px' });
  const controls = el('div', { class: 'report-controls' });
  const searchEl = el('div', { class: 'report-search' });
  const statsEl = el('div', { id: 'report-stats' });
  const narrativeEl = el('div', { id: 'report-narrative' });
  const copyEl = el('div', { id: 'report-copy' });
  const analyzeEl = el('div', { id: 'report-analyze' });
  page.append(controls, searchEl, statsEl, narrativeEl, copyEl, analyzeEl);

  const frag = document.createDocumentFragment();
  frag.append(topbar, page);
  return frag;
}

function renderControls() {
  const wrap = document.querySelector('.report-controls');
  wrap.innerHTML = '';

  const row = el('div', { class: 'report-controls-row' });
  // 周期类型 chips
  for (const t of TYPE_OPTIONS) {
    row.append(
      el('button', {
        class: `chip${state.type === t.value ? ' selected' : ''}`,
        text: t.label,
        onclick: () => {
          if (state.type === t.value) return;
          state.type = t.value;
          load();
        },
      })
    );
  }
  // 日期选择
  const dateInput = el('input', {
    class: 'date-input',
    type: 'date',
    value: state.end,
    max: fmtLocalDate(),
    onchange: () => {
      state.end = dateInput.value || fmtLocalDate();
      load();
    },
  });
  row.append(dateInput);
  wrap.append(row);

  // 地区筛选 chips(参考 HotPilot 工具栏;计数 = 本周期该地区热点数,「其他」不参与筛选)
  const regionRow = el('div', { class: 'report-region-row' });
  const regionList = (state.data?.stats?.regions || []).filter((r) => r.name !== '其他');
  // 全部地区 = 各地区计数之和(含「其他」;与当前筛选无关)
  const allCount = state.data ? regionList.reduce((a, r) => a + r.count, 0) + (state.data.stats.regions.find((r) => r.name === '其他')?.count || 0) : null;
  for (const rc of [{ name: '全部地区', value: '', count: allCount }, ...regionList.map((r) => ({ name: r.name, value: r.name, count: r.count }))]) {
    regionRow.append(
      el('button', {
        class: `chip${state.region === rc.value ? ' selected' : ''}`,
        title: rc.count != null ? `${rc.name}:本周期 ${rc.count} 条热点` : rc.name,
        onclick: () => {
          if (state.region === rc.value) return;
          state.region = rc.value;
          load();
        },
      }, [el('span', { text: rc.name }), rc.count != null ? el('span', { class: 'rc-count', text: String(rc.count) }) : null])
    );
  }
  wrap.append(regionRow);

  if (state.data) {
    const nav = el('div', { class: 'report-period-nav' }, [
      el('button', { class: 'cal-nav', text: '‹', title: '上一周期', onclick: () => { state.end = state.data.prev; load(); } }),
      el('span', { class: 'report-period-label', text: state.data.label }),
      el('button', { class: 'cal-nav', text: '›', title: '下一周期', onclick: () => { state.end = state.data.next; load(); } }),
    ]);
    wrap.append(nav);
    // 管理员「文字版」自媒体文案(仅管理员可见)
    if (store.auth.user?.is_admin) {
      wrap.append(
        el('div', { class: 'dash-cta-row' }, [
          el('button', {
            class: 'go-btn dash-btn copy',
            text: '📝 文字版(自媒体文案)',
            title: '生成微信小程序 / 小红书爆款文案,仅管理员可见',
            onclick: () => startReportCopy(),
          }),
        ])
      );
    }
  }

  renderSearchBar();
}

// 话题搜索框 + 热度筛选(结果 = 周期内匹配话题,按热度排序)
function renderSearchBar() {
  const wrap = document.querySelector('.report-search');
  if (!wrap) return;
  wrap.innerHTML = '';

  const input = el('input', {
    class: 'search-input',
    type: 'search',
    value: state.q,
    placeholder: '🔍 搜索本周期话题关键词,如:宠物 / 墨西哥 / 露营',
    onkeydown: (e) => {
      if (e.key === 'Enter') doSearch(input);
    },
    onsearch: () => {
      if (!input.value.trim() && state.q) doSearch(input);
    },
  });
  const bar = el('div', { class: 'search-bar', style: 'padding:6px 0 2px' }, [
    input,
    el('button', { class: 'search-btn', text: '搜索', onclick: () => doSearch(input) }),
    state.q ? el('button', { class: 'search-clear', text: '✕', title: '清除搜索', onclick: () => { state.q = ''; state.heat = ''; load(); } }) : null,
  ]);
  wrap.append(bar);

  // 热度筛选(仅搜索态显示)
  if (state.q) {
    const row = el('div', { class: 'report-controls-row', style: 'padding-top:4px' });
    for (const h of HEAT_OPTIONS) {
      row.append(
        el('button', {
          class: `chip${state.heat === h.value ? ' selected' : ''}`,
          text: h.label,
          onclick: () => {
            state.heat = h.value;
            renderSearchBar();
            renderStats(document.getElementById('report-stats'), state.data);
          },
        })
      );
    }
    wrap.append(row);
  }
}

function doSearch(input) {
  const v = input.value.trim();
  if (!v && !state.q) return;
  state.q = v;
  state.heat = '';
  load();
}

async function load() {
  renderControls();
  const statsEl = document.getElementById('report-stats');
  const narrativeEl = document.getElementById('report-narrative');
  const copyEl = document.getElementById('report-copy');
  statsEl.innerHTML = '';
  narrativeEl.innerHTML = '';
  if (copyEl) copyEl.innerHTML = '';
  statsEl.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }));

  try {
    const qs = new URLSearchParams({ type: state.type, end: state.end });
    if (state.q) qs.set('q', state.q);
    if (state.region) qs.set('region', state.region);
    const d = await getJSON(`/api/reports?${qs}`);
    state.data = d;
    renderControls();
    renderStats(statsEl, d);
    renderNarrative(narrativeEl, d);
    renderAnalyze(d);
  } catch (e) {
    statsEl.innerHTML = '';
    statsEl.append(el('div', { class: 'empty' }, [el('div', { class: 'desc', text: e.message || '加载失败' })]));
  }
}

// ---------- 统计区:固定四段,顺序不换 ----------
// ① 一句话结论 → ② 五张趋势图(一图一板块)→ ③ 明细表(可下钻)→ ④ 下周期 3 个动作

function renderStats(root, d) {
  root.innerHTML = '';
  const s = d.stats;
  if (!s.total) {
    root.append(
      el('div', { class: 'empty' }, [
        el('span', { class: 'emoji', text: '🛰️' }),
        el('div', { class: 'title', text: state.region ? `「${state.region}」本周期暂无热点` : '本周期暂无热点数据' }),
        el('div', { class: 'desc', text: state.region ? '切换其他地区或周期试试' : '切换其他周期,或等待采集器积累更多数据' }),
      ])
    );
    return;
  }

  const wrap = el('div');

  // 搜索态:匹配话题表(按热度排序 + 热度筛选;游客第 4 条起锁定)
  if (state.q) {
    let items = s.search?.items || [];
    if (state.heat === 'hot') items = items.filter((t) => t.heat_score >= 70);
    else if (state.heat === 'warm') items = items.filter((t) => t.heat_score >= 40 && t.heat_score < 70);
    else if (state.heat === 'cool') items = items.filter((t) => t.heat_score < 40);
    const sec = el('section', { class: 'set-group' }, [
      el('div', { class: 'chart-title', text: `🔍 「${state.q}」相关话题${items.length ? `(${items.length} 条 · 按热度排序)` : ''}` }),
      el('div', { class: 'chart-note', text: '点击任意一行下钻话题详情' }),
    ]);
    if (!items.length) sec.append(el('div', { class: 'mini-empty', text: '本周期没有匹配的话题,试试其他关键词或切换周期' }));
    else sec.append(lockedTable(items));
    wrap.append(sec);
    root.append(wrap);
    return;
  }

  wrap.append(conclusionCard(d));
  wrap.append(chartsSection(s));
  wrap.append(tableSection(s));
  wrap.append(actionsSection(s));

  root.append(wrap);
}

// ① 一句话结论(纯统计,不依赖模型):先定这一屏要回答什么,再给答案
function conclusionCard(d) {
  const s = d.stats;
  const moves = (s.regionMoves || []).filter((m) => m.delta != null);
  const hot = [...moves].sort((a, b) => b.delta - a.delta)[0];
  const cat = (s.catCompare || []).filter((c) => c.prev != null).sort((a, b) => (b.cur - b.prev) - (a.cur - a.prev))[0];
  const rise = (s.rising || [])[0];

  const parts = [
    `${state.region || '全地区'} · ${d.label}:共 ${s.total} 条热点,抓到 ${s.risingTotal} 个上升信号,其中 ${s.risingFast} 个涨幅 ≥20%,退潮 ${s.fallingTotal} 条`,
  ];
  // 热度分变化 ≥3 才算「更热/值得加码」,避免把 ±1 的噪声说成机会
  if (hot && hot.delta >= 3) parts.push(`${hot.name} 市场比上周更热(热度 ${hot.from} → ${hot.to})`);
  if (cat && cat.cur - cat.prev >= 3) parts.push(`${cat.name} 热度环比 +${cat.cur - cat.prev},值得加码`);
  if (rise) parts.push(`优先跟进「${rise.title}」(涨幅 ${rise.change_pct > 0 ? '+' : ''}${rise.change_pct}%)`);

  return el('section', { class: 'set-group conclusion-card' }, [
    el('div', { class: 'chart-title', text: '📌 一句话结论' }),
    el('div', { class: 'conclusion-text', text: parts.join(';') + '。' }),
  ]);
}

// ② 五张趋势图(一图一板块),图型 = 问题反推;每张图下一行读法(人话结论),否则图只是装饰
function chartsSection(s) {
  const wrap = el('div');

  // 板块 1 区域热点:哪个市场在起 → 多国折线对比(缺数据的周留空档,不插值)
  const lines = s.regionLines || [];
  if (lines.length > 1) {
    const series = lines.map((l, i) => ({
      name: l.name,
      color: palette(i),
      points: l.points.map((p) => ({ date: p.date, v: p.avg })),
    }));
    wrap.append(chartCard('① 区域热点 · 哪个市场在起', multiLine(series), regionTakeaway(s)));
  } else if (lines.length === 1) {
    const series = lines.map((l, i) => ({
      name: l.name,
      color: palette(i),
      points: l.points.map((p) => ({ date: p.date, v: p.avg })),
    }));
    wrap.append(chartCard('① 区域热点 · 哪个市场在起', multiLine(series), regionTakeaway(s)));
  } else {
    wrap.append(chartCard('① 区域热点 · 哪个市场在起', el('div', { class: 'mini-empty', text: state.region ? '该地区数据不足,切回「全部地区」看多国对比' : '暂无地区趋势数据' }), ''));
  }

  // 板块 2 类目机会:该不该加码 → 分组柱(本周 vs 上周)
  const cats = (s.catCompare || []).filter((c) => c.cur != null);
  if (cats.length) wrap.append(chartCard('② 类目机会 · 该不该加码', groupedBars(cats), catTakeaway(cats)));
  else wrap.append(chartCard('② 类目机会 · 该不该加码', el('div', { class: 'mini-empty', text: '本周期无类目数据' }), ''));

  // 板块 3 话题风向:内容怎么跟 → 堆叠柱(构成变化:新上榜/延续/退场)
  const flow = (s.topicFlow?.buckets || []).filter((b) => b.nw + b.cont + b.exit > 0);
  if (flow.length) wrap.append(chartCard('③ 话题风向 · 内容怎么跟', stackedBars(flow), flowTakeaway(s)));
  else wrap.append(chartCard('③ 话题风向 · 内容怎么跟', el('div', { class: 'mini-empty', text: '暂无话题构成数据' }), ''));

  // 板块 4 生命周期:还来不来得及 → 阶段带(四态区段)+ 窗口估算
  const bands = (s.lifeBands || []).filter((b) => b.segments?.length);
  if (bands.length) wrap.append(chartCard('④ 生命周期 · 还来不来得及', stageBands(bands), bandTakeaway(bands)));
  else wrap.append(chartCard('④ 生命周期 · 还来不来得及', el('div', { class: 'mini-empty', text: '暂无生命周期数据' }), ''));

  // 板块 5 竞品与价格:利润还在不在 → 散点(热度 × 来源数;价格源接入后换 价格 × 动销)
  const rivals = s.rivalScatter || [];
  if (rivals.length) wrap.append(chartCard('⑤ 竞品与价格 · 利润还在不在', xyScatter(rivals), rivalTakeaway(rivals)));
  else wrap.append(chartCard('⑤ 竞品与价格 · 利润还在不在', el('div', { class: 'mini-empty', text: '暂无竞品数据' }), ''));

  return wrap;
}

// 每张图的一行读法(人话结论,纯统计推导):
function regionTakeaway(s) {
  const moves = (s.regionMoves || []).filter((m) => m.delta != null);
  const hot = [...moves].sort((a, b) => b.delta - a.delta)[0];
  const lead = [...moves].sort((a, b) => (b.to ?? -1) - (a.to ?? -1))[0];
  if (hot && hot.delta >= 3) return `${hot.name} 比上周更热(热度 ${hot.from} → ${hot.to},+${hot.delta});热度已归一化为 0-100 指数,缺数据的周留空档不插值`;
  if (hot && hot.delta > 0) return `各市场仅微幅波动,${hot.name} 环比 +${hot.delta};热度已归一化为 0-100 指数,缺数据的周留空档不插值`;
  if (lead) return `各市场环比未升温,${lead.name} 当前热度最高(${lead.to});热度已归一化为 0-100 指数,缺数据的周留空档不插值`;
  return '热度已归一化为 0-100 指数;缺数据的周留空档,不插值';
}

function catTakeaway(cats) {
  // 热度分变化 ≥3 才算「值得多投」,±1-2 视为平稳噪声
  const up = cats.filter((c) => c.prev != null && c.cur - c.prev >= 3).sort((a, b) => (b.cur - b.prev) - (a.cur - a.prev));
  if (up.length) {
    const two = up.slice(0, 2);
    return `${two.map((c) => `${c.name}(+${c.cur - c.prev})`).join('、')} 热度环比上升,值得多投;柱 = 平均热度,本周 vs 上周`;
  }
  return `本周类目热度整体平稳(环比变化均 <3),${cats[0].name} 话题最多(${cats[0].curCount} 条);柱 = 平均热度,本周 vs 上周`;
}

function flowTakeaway(s) {
  const f = s.topicFlow || {};
  return `本周期 ${f.newTotal ?? 0} 个新话题上榜,其中 ${f.grewFromOld ?? 0} 个与上周话题同品类(从旧话题长出);堆叠柱 = 每周新上榜 / 延续 / 退场话题数`;
}

function bandTakeaway(bands) {
  const t = bands[0];
  if (t.stage === '峰值') return `「${t.title}」已达峰值,备货窗口就在当下;阶段带 = 话题生命周期四态区段(萌芽→上升→峰值→衰退)`;
  if (t.stage === '衰退') return `「${t.title}」已进入衰退,窗口已过;阶段带 = 话题生命周期四态区段`;
  const tail = t.window >= 1 ? `窗口约剩 ${t.window} 天` : '窗口已收窄(达到历史平均时长)';
  return `「${t.title}」${t.stage} 第 ${t.stageDays} 天(历史均值 ${t.stageAvg} 天),${tail};窗口 = 历史各阶段平均时长估算`;
}

function rivalTakeaway(rivals) {
  const dense = rivals.filter((t) => t.heat >= 70 && t.sources >= 6);
  const denseCats = [...new Set(dense.map((t) => t.category))].slice(0, 3).join('、');
  const base = dense.length
    ? `高热度 × 高来源(竞品密集)话题 ${dense.length} 个${denseCats ? `,集中在 ${denseCats}` : ''};点色 = 生命周期阶段`
    : '暂无竞品密集区(高热度 × 高来源);点色 = 生命周期阶段';
  return `${base}。价格 × 动销散点需接入竞品价格数据源,当前以热度 × 来源数观察竞争密度`;
}

// ③ 明细表(可下钻):每行一个话题,点击进详情;游客前 3 行可见,其余模糊 + 登录解锁
function tableSection(s) {
  const sec = el('section', { class: 'set-group' });
  sec.append(el('div', { class: 'chart-title', text: '📋 明细表' }));
  sec.append(el('div', { class: 'chart-note', text: '点击任意一行下钻话题详情 · 涨幅 = 热度分对比话题首次记录' }));
  const items = s.table || [];
  if (!items.length) {
    sec.append(el('div', { class: 'mini-empty', text: '本周期暂无热点' }));
    return sec;
  }
  sec.append(lockedTable(items));
  return sec;
}

// 明细表:游客前 3 行可见,其余模糊 + 「登录查看」按钮(≤3 条则全部可见)
function lockedTable(items) {
  const logged = isLoggedIn();
  const wrap = el('div', { class: 'rpt-table-wrap' });
  if (logged || items.length <= 3) {
    wrap.append(topicTable(items));
    return wrap;
  }
  wrap.append(topicTable(items.slice(0, 3)));
  const lock = el('div', { class: 'report-lock' });
  lock.append(topicTable(items));
  wrap.append(lock);
  wrap.append(
    el('div', { class: 'lock-bar' }, [
      el('button', {
        class: 'lock-btn',
        text: `🔒 登录查看全部 ${items.length} 条明细`,
        onclick: () => {
          toast('登录后即可查看完整明细', 'info');
          location.hash = '#/me';
        },
      }),
    ])
  );
  return wrap;
}

function topicTable(items) {
  const tbl = el('table', { class: 'rpt-table' });
  tbl.append(
    el('thead', {}, [
      el('tr', {}, ['#', '话题', '地区', '类目', '热度', '涨幅', '生命周期', '来源'].map((h) => el('th', { text: h }))),
    ])
  );
  const tbody = el('tbody');
  items.forEach((t, i) => {
    tbody.append(
      el('tr', { onclick: () => { location.hash = `#/detail/${t.id}`; } }, [
        el('td', { class: 'td-rank', text: String(i + 1) }),
        el('td', { class: 'td-title', title: t.title, text: t.title }),
        el('td', { text: t.region || '—' }),
        el('td', { text: t.category }),
        el('td', { class: 'td-num', text: String(t.heat_score) }),
        el('td', {}, [changeBadge(t)]),
        el('td', {}, [el('span', { class: `pill ${t.lifecycle || '萌芽'}`, text: t.lifecycle || '萌芽' })]),
        el('td', { class: 'td-num', text: t.signal_count != null ? String(t.signal_count) : String((t.platforms || []).length) }),
      ])
    );
  });
  tbl.append(tbody);
  return tbl;
}

// 涨幅徽标:明确「什么在上升」= 热度分对比话题首次记录(带符号与箭头,PRD 5.4)
// peak 模式:↓ -X%(退潮,热度分对比周期内最高值)
function changeBadge(t, peak = false) {
  const pct = peak ? t.peak_pct : t.change_pct;
  if (pct == null) {
    return el('span', { class: 'change-badge flat', title: peak ? '该话题暂无周期内峰值对比' : '话题首次上榜,暂无对比数据', text: peak ? '→ 无对比' : '→ 新上榜' });
  }
  const up = pct > 0;
  const cls = up ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = up ? '↑' : pct < 0 ? '↓' : '→';
  const tail = peak ? '较峰值' : t.change_days >= 1 ? `较 ${t.change_days} 天前` : '';
  const title = (peak ? '热度分对比该话题周期内峰值' : '热度分对比话题首次记录值的变化') + (tail ? `(${tail})` : '');
  return el('span', { class: `change-badge ${cls}`, title, text: `${arrow} ${up ? '+' : ''}${pct}%` });
}

// ④ 下周期 3 个动作(选品 / 内容 / 观察):纯统计推导,参考性质
function actionsSection(s) {
  const sec = el('section', { class: 'set-group' });
  sec.append(el('div', { class: 'chart-title', text: '🎯 下周期 3 个动作' }));
  sec.append(el('div', { class: 'chart-note', text: '选品 / 内容 / 观察,按本周期统计推导(参考性质)' }));

  const rise = (s.rising || [])[0];
  const top = (s.top || [])[0];
  const moves = (s.regionMoves || []).filter((m) => m.delta != null);
  const hotRegion = [...moves].sort((a, b) => b.delta - a.delta)[0];
  const coldRegion = [...moves].sort((a, b) => a.delta - b.delta)[0];

  const acts = [];
  // 选品:跟进涨幅最大的上升话题
  if (rise) {
    acts.push(actCard('🛒', '选品动作', `跟进「${rise.title}」:热度 ${rise.heat_score},涨幅 ${rise.change_pct > 0 ? '+' : ''}${rise.change_pct}%,${rise.category}`, rise.id));
  } else {
    acts.push(actCard('🛒', '选品动作', '本周期无上升话题,先按明细表 Top 热度话题观察证据再决定备货', top?.id ?? null));
  }
  // 内容:押注当前最热话题
  if (top) {
    acts.push(actCard('🎬', '内容动作', `内容押注「${top.title}」:热度 ${top.heat_score},${top.category},覆盖 ${(top.platforms || []).slice(0, 3).join(' / ') || '多平台'}`, top.id));
  }
  // 观察:升温最快的市场(或回落最快的市场)+ 退潮避免补货;变化 ≥3 才算趋势
  if (hotRegion && hotRegion.delta >= 3) {
    acts.push(actCard('🔭', '观察动作', `观察 ${hotRegion.name} 市场(热度 ${hotRegion.from} → ${hotRegion.to},+${hotRegion.delta});${s.fallingTotal} 个退潮话题避免补货`, null));
  } else if (coldRegion && coldRegion.delta <= -3) {
    acts.push(actCard('🔭', '观察动作', `各市场环比未升温,${coldRegion.name} 回落最快(${coldRegion.delta});${s.fallingTotal} 个退潮话题避免补货`, null));
  } else {
    acts.push(actCard('🔭', '观察动作', `市场整体平稳(环比变化均 <3),观察 ${s.risingTotal} 个上升信号的后续走向再出手`, null));
  }

  const grid = el('div', { class: 'act-grid' });
  acts.forEach((a) => grid.append(a));
  sec.append(grid);
  if (!isLoggedIn()) sec.append(el('div', { class: 'chart-note', text: '🔒 登录后查看每个动作对应话题的完整证据与延伸分析' }));
  return sec;
}

function actCard(icon, tag, text, id) {
  const c = el('div', { class: 'card act-card', onclick: id ? () => { location.hash = `#/detail/${id}`; } : null }, [
    el('div', { class: 'act-tag', text: `${icon} ${tag}` }),
    el('div', { class: 'act-text', text }),
  ]);
  if (id) c.append(el('div', { class: 'act-go', text: '查看详情 →' }));
  return c;
}

// ---------- 深度分析区 ----------

async function renderAnalyze(d) {
  const container = document.getElementById('report-analyze');
  if (!container) return;
  // 游客不展示深度分析(登录后可见)
  if (!isLoggedIn()) {
    container.innerHTML = '';
    return;
  }
  let favItems = [];
  try {
    const f = await getJSON('/api/favorites');
    favItems = f.items || [];
  } catch {
    /* 忽略 */
  }
  await renderAnalyzeBlock(container, {
    type: state.type,
    end: d.end,
    stats: d.stats,
    favItems,
  });
}

// ---------- 趋势洞察区 ----------

function renderNarrative(root, d) {
  root.innerHTML = '';
  // 游客不展示趋势洞察(报告页保持简短,登录后可见)
  if (!isLoggedIn()) return;
  const card = el('section', { class: 'set-group' });
  root.append(card);

  const head = el('div', { class: 'narrative-head' }, [
    el('span', { class: 'chart-title', text: '🧠 趋势洞察' }),
    el('span', { class: 'sec-provider', text: d.narrative ? timeLabel(d.narrative.created_at) : '' }),
  ]);

  const body = el('div', { class: 'narrative-body' });
  const foot = el('div', { class: 'sec-foot' });
  card.append(head, body, foot);

  if (d.narrative) {
    body.append(mdToDOM(d.narrative.markdown));
    foot.append(
      el('button', { class: 'copy-btn', text: '📋 复制', onclick: () => copyText(d.narrative.markdown) }),
      el('span', { class: `badge conf ${d.narrative.confidence}`, text: `可信度 ${d.narrative.confidence}` }),
      el('button', { class: 'retry-btn', text: '↻ 重新生成', onclick: () => startNarrative(true) })
    );
  } else {
    body.append(
      el('div', { class: 'empty', style: 'padding:20px' }, [
        el('div', { class: 'desc', text: `将基于本周期 ${d.stats.total} 条热点,归纳趋势主线、内容选品提示与下期预判` }),
        el('button', { class: 'go-btn', text: '⚡ 生成趋势洞察', onclick: () => startNarrative() }),
      ])
    );
  }
}

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日生成`;
}

function startNarrative(force = false) {
  if (!isLoggedIn()) {
    toast('请先登录后使用完整报告功能', 'info');
    location.hash = '#/me';
    return;
  }
  if (state.streamAbort) return;
  const root = document.getElementById('report-narrative');
  root.innerHTML = '';
  const card = el('section', { class: 'set-group' });
  card.append(
    el('div', { class: 'narrative-head' }, [
      el('span', { class: 'chart-title', text: '🧠 趋势洞察' }),
      el('span', { class: 'extend-progress' }, [el('span', { class: 'spinner' }), '生成中…']),
    ])
  );
  const body = el('div', { class: 'narrative-body' });
  const foot = el('div', { class: 'sec-foot' });
  card.append(body, foot);
  root.append(card);

  let text = '';
  const qs = new URLSearchParams({ type: state.type, end: state.end });
  if (force) qs.set('force', '1');
  if (state.region) qs.set('region', state.region);
  const controller = new AbortController();
  state.streamAbort = controller.abort.bind(controller);

  sseStream(
    `/api/reports/stream?${qs}`,
    {
      onStats: (d) => {
        // 周期导航数据可能已随统计更新
        if (!state.data || state.data.label !== d.label) {
          state.data = d;
          renderControls();
        }
      },
      onDelta: ({ text: t }) => {
        text += t;
        body.replaceChildren(mdToDOM(text));
      },
      onNarrative: (n) => {
        if (state.data) state.data.narrative = n;
        body.replaceChildren(mdToDOM(n.markdown));
        foot.innerHTML = '';
        foot.append(
          el('button', { class: 'copy-btn', text: '📋 复制', onclick: () => copyText(n.markdown) }),
          el('span', { class: `badge conf ${n.confidence}`, text: `可信度 ${n.confidence}` }),
          el('button', { class: 'retry-btn', text: '↻ 重新生成', onclick: () => startNarrative(true) })
        );
        if (n.degraded) {
          body.prepend(el('div', { class: 'chart-note', text: '⚠️ 智能分析暂不可用,当前为统计自动汇总(可点「重新生成」重试)' }));
        }
      },
      onDone: () => {
        state.streamAbort = null;
        toast('✅ 趋势洞察已生成');
      },
      onError: (e) => {
        state.streamAbort = null;
        toast(e.message, 'err');
        renderNarrative(root, state.data || { stats: { total: 0 } });
      },
    },
    controller.signal
  );
}

// 管理员专属:文字版自媒体文案(微信小程序 / 小红书爆款文案,不扣费)
function startReportCopy() {
  if (!store.auth.user?.is_admin) return;
  const root = document.getElementById('report-copy');
  if (!root) return;
  if (state.streamAbort) return;
  root.innerHTML = '';

  const card = el('section', { class: 'set-group copy-card' });
  card.append(
    el('div', { class: 'chart-title', text: '📝 文字版(自媒体传播文案)' }),
    el('div', { class: 'chart-note', text: '仅管理员可见 · 微信小程序 / 小红书爆款文案(基于本周期报告生成)' })
  );
  const body = el('div', { class: 'narrative-body' });
  body.append(el('div', { class: 'extend-progress' }, [el('span', { class: 'spinner' }), '文案生成中…']));
  const foot = el('div', { class: 'sec-foot' });
  card.append(body, foot);
  root.append(card);
  root.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const qs = new URLSearchParams({ type: state.type, end: state.end });
  if (state.region) qs.set('region', state.region);
  const controller = new AbortController();
  state.streamAbort = controller.abort.bind(controller);
  let text = '';

  sseStream(
    `/api/reports/copy?${qs}`,
    {
      onDelta: ({ text: t }) => {
        text += t;
        body.replaceChildren(mdToDOM(text));
      },
      onDone: () => {
        state.streamAbort = null;
        foot.append(
          el('button', { class: 'copy-btn', text: '📋 复制文案', onclick: () => copyText(text) }),
          el('button', { class: 'retry-btn', text: '↻ 重新生成', onclick: () => startReportCopy() })
        );
        toast('✅ 文案已生成(仅管理员可见)');
      },
      onError: (e) => {
        state.streamAbort = null;
        body.innerHTML = '';
        body.append(el('div', { class: 'desc', style: 'padding:8px 0', text: e.message || '生成失败' }));
        body.append(el('button', { class: 'go-btn', text: '⚡ 重试', onclick: () => startReportCopy() }));
        toast(e.message, 'err');
      },
    },
    controller.signal
  );
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

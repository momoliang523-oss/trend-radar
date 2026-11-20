// 日历视图:顶栏 + 搜索行 + 月视图(可展开/收起为周视图)+ 平台/品类筛选 + 热点卡片列表
// 选中具体标签(平台/品类)时,日历进入时间区间模式:点选起止两天 → 出该区间的热点列表
import { el, fmtLocalDate, addDays, mondayOf, weekdayOf } from '../fmt.js';
import { getJSON } from '../api.js';
import { store } from '../store.js';
import { chips } from '../components/chips.js';
import { hotspotCard } from '../components/hotspotCard.js';
import { toast } from '../components/toast.js';

const PLATFORM_OPTIONS = ['TikTok', 'X', 'Instagram', 'Reddit', 'YouTube', 'Amazon', 'TikTok Shop', 'Shopee', 'Temu', 'Hacker News', '新闻'].map((v) => ({ value: v, label: v }));
const CATEGORY_OPTIONS = ['美妆个护', '3C数码', '家居', '服饰', '母婴宠物', '食品', '运动户外', '其他'].map((v) => ({ value: v, label: v }));
const HEAT_OPTIONS = [
  { value: 'hot', label: '🔥 高 ≥70' },
  { value: 'warm', label: '🌤 中 40-69' },
  { value: 'cool', label: '❄ 低 <40' },
];
const TREND_OPTIONS = [
  { value: 'new', label: '✨ 新上榜' },
  { value: 'up', label: '↑ 上升' },
  { value: 'flat', label: '→ 持平' },
  { value: 'down', label: '↓ 回落' },
];
const WD = ['一', '二', '三', '四', '五', '六', '日'];

let abort = null;
let state = {
  date: store.selectedDate,
  platform: store.platform,
  category: store.category,
  heat: '',
  trend: '',
  myOnly: false,
  q: '', // 搜索关键词(非空时列表=搜索结果)
  range: { from: '', to: '' }, // 时间区间(选中具体标签时可用)
  expanded: localStorage.getItem('tr_cal_expanded') !== '0', // 默认月视图,用户收起后记住
  monthDots: null,
  monthDotsKey: '',
  loading: false,
};

export default {
  async render(mount) {
    abort = new AbortController();
    mount.append(buildDom());
    await loadMonthDots();
    await loadHotspots();
  },

  destroy() {
    abort?.abort();
    abort = null;
  },
};

function buildDom() {
  const frag = document.createDocumentFragment();
  const page = el('div', { class: 'page' });

  const refreshBtn = el('button', {
    class: 'icon-btn', text: '🔄', title: '刷新',
    onclick: async () => {
      refreshBtn.classList.add('spinning');
      await Promise.all([loadMonthDots(), loadHotspots()]);
      refreshBtn.classList.remove('spinning');
    },
  });

  const countEl = el('b', { text: '…' });
  const dateLabel = el('span', { text: dateText() });
  const subWrap = el('div', { class: 'app-sub' });

  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'topbar-inner' }, [
      el('div', { class: 'topbar-row' }, [
        el('div', { class: 'app-title' }, [el('span', { class: 'logo', text: '📡' }), '出海热点雷达', el('span', { class: 'tag', text: '智能分析师' })]),
        refreshBtn,
      ]),
      subWrap,
    ]),
  ]);

  // 搜索行(关键词 → 相关话题)
  const searchInput = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '🔍 搜索话题关键词,如:宠物 / 露营 / 清洁剂',
    onkeydown: (e) => {
      if (e.key === 'Enter') doSearch();
    },
    onsearch: () => {
      if (!searchInput.value.trim() && state.q) doSearch();
    },
  });
  const searchBar = el('div', { class: 'search-bar' }, [
    searchInput,
    el('button', { class: 'search-btn', text: '搜索', onclick: doSearch }),
    state.q ? el('button', { class: 'search-clear', text: '✕', title: '清除搜索', onclick: clearSearch }) : null,
  ]);

  // 日历区(月/周);区间标签(时间区间)放在日历左上方
  const rangeTag = el('div');
  const calHead = el('div', { class: 'cal-head' }, [
    el('button', { class: 'cal-nav', text: '‹', title: '上一页', onclick: () => shiftCal(-1) }),
    rangeTag,
    el('div', { class: 'cal-title', text: '…' }),
    el('button', { class: 'cal-nav', text: '›', title: '下一页', onclick: () => shiftCal(1) }),
    el('button', { class: 'cal-toggle', title: '展开/收起', onclick: toggleCal }),
  ]);
  const calBody = el('div', { class: 'cal-body' });

  const myWrap = el('div');
  const platformChipsWrap = el('div');
  const categoryChipsWrap = el('div');
  const heatChipsWrap = el('div');
  const trendChipsWrap = el('div');
  const list = el('div', { class: 'card-list' });

  page.append(searchBar, calHead, calBody, myWrap, platformChipsWrap, categoryChipsWrap, heatChipsWrap, trendChipsWrap, list);
  frag.append(topbar, page);
  state.els = { page, subWrap, countEl, dateLabel, calHead, calBody, rangeTag, myWrap, platformChipsWrap, categoryChipsWrap, heatChipsWrap, trendChipsWrap, list, searchInput, searchBar };
  renderChips();
  renderCal();
  renderRangeBar();
  updateSubLine();
  return frag;
}

function dateText() {
  const d = state.date;
  const today = fmtLocalDate();
  if (d === today) return `${d} · 今天`;
  return `${d} · ${weekdayOf(d)}`;
}

// 顶栏副行:单日 / 区间 / 搜索三种语境
function updateSubLine() {
  const wrap = state.els.subWrap;
  wrap.replaceChildren();
  if (state.q) {
    wrap.append(el('span', { text: `搜索「${state.q}」 · 相关话题 ` }), state.els.countEl, el('span', { text: ' 条' }));
  } else if (state.range.from && state.range.to) {
    wrap.append(el('span', { text: `${state.range.from} ~ ${state.range.to} · 区间 ` }), state.els.countEl, el('span', { text: ' 条热点' }));
  } else {
    wrap.append(state.els.dateLabel, el('span', { text: ' · 今日 ' }), state.els.countEl, el('span', { text: ' 条热点' }));
  }
}

// ---------- 搜索 ----------

function doSearch() {
  const v = state.els.searchInput.value.trim();
  state.q = v;
  if (v) state.range = { from: '', to: '' }; // 搜索时退出区间模式
  renderCal();
  renderRangeBar();
  rebuildSearchBar();
  updateSubLine();
  loadHotspots();
}

function clearSearch() {
  state.els.searchInput.value = '';
  state.q = '';
  rebuildSearchBar();
  updateSubLine();
  loadHotspots();
}

function rebuildSearchBar() {
  const bar = state.els.searchBar;
  const oldClear = bar.querySelector('.search-clear');
  if (oldClear) oldClear.remove();
  if (state.q) {
    bar.append(el('button', { class: 'search-clear', text: '✕', title: '清除搜索', onclick: clearSearch }));
  }
}

// ---------- 日历(月视图 / 周视图) ----------

function toggleCal() {
  state.expanded = !state.expanded;
  localStorage.setItem('tr_cal_expanded', state.expanded ? '1' : '0');
  renderCal();
}

function shiftCal(dir) {
  // 月视图按月份翻页;周视图按周翻页
  if (state.expanded) {
    const [y, m] = state.date.split('-').map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    state.date = fmtLocalDate(d);
    state.expanded = true;
    renderCal();
    loadMonthDots();
  } else {
    state.date = addDays(state.date, dir * 7);
    renderCal();
    loadMonthDots();
  }
  store.selectedDate = state.date;
  state.els.dateLabel.textContent = dateText();
  updateSubLine();
  loadHotspots();
}

// 当前是否区间选择模式:选中了具体标签(平台/品类)
function rangeMode() {
  return !!(state.platform || state.category) && !state.q;
}

function renderCal() {
  const head = state.els.calHead;
  const body = state.els.calBody;
  head.querySelector('.cal-toggle').textContent = state.expanded ? '收起 ▴' : '展开月份 ▾';

  // 周表头
  const grid = el('div', { class: 'cal-grid' });
  WD.forEach((w) => grid.append(el('div', { class: 'cal-wd', text: w })));

  const dots = state.monthDots || {};
  const today = fmtLocalDate();
  const inRange = rangeMode();

  if (state.expanded) {
    // ---- 月视图:整月网格 ----
    const [y, m] = state.date.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    const lead = (first.getDay() + 6) % 7; // 周一开头的空位数
    head.querySelector('.cal-title').textContent = `${y}年${m}月`;

    for (let i = 0; i < lead; i++) grid.append(el('div', { class: 'cal-cell blank' }));
    for (let d = 1; d <= last.getDate(); d++) {
      const ds = fmtLocalDate(new Date(y, m - 1, d));
      grid.append(calCell(ds, dots[ds], ds === today, false, inRange));
    }
  } else {
    // ---- 周视图:本周 7 天 ----
    const mon = mondayOf(state.date);
    head.querySelector('.cal-title').textContent = `${mon} 起的一周`;
    for (let i = 0; i < 7; i++) {
      const ds = addDays(mon, i);
      const out = ds.slice(0, 7) !== mon.slice(0, 7);
      grid.append(calCell(ds, dots[ds], ds === today, out, inRange));
    }
  }

  body.replaceChildren(grid);
}

function calCell(ds, info, isToday, isOut, inRange) {
  const selected = ds === state.date;
  const has = info && info.count > 0;
  const heat = has ? info.max_heat : 0;
  const r = state.range;
  const rangeCls = inRange
    ? (r.from && r.to && ds >= r.from && ds <= r.to ? ' in-range' : '') + (ds === r.from || ds === r.to ? ' edge' : '')
    : '';
  const cell = el(
    'div',
    {
      class: `cal-cell${selected ? ' selected' : ''}${isToday ? ' today' : ''}${isOut ? ' out' : ''}${rangeCls}`,
      onclick: () => {
        // 搜索状态下点日历 = 先退出搜索
        if (state.q) clearSearch();
        if (rangeMode()) {
          // 区间模式:第一次点=起点,再点=终点;点更早日期=重设起点;重复点起点=取消
          if (!r.from || (r.from && r.to)) {
            state.range = { from: ds, to: '' };
          } else if (ds === r.from) {
            state.range = { from: '', to: '' };
          } else if (ds < r.from) {
            state.range = { from: ds, to: '' };
          } else {
            state.range = { from: r.from, to: ds };
          }
          state.date = ds;
          store.selectedDate = ds;
          renderCal();
          renderRangeBar();
          updateSubLine();
          if (state.range.from && state.range.to) loadHotspots();
          return;
        }
        if (ds === state.date) return;
        state.date = ds;
        store.selectedDate = ds;
        state.els.dateLabel.textContent = dateText();
        renderCal();
        updateSubLine();
        loadHotspots();
      },
    },
    [
      el('div', { class: 'cal-d', text: String(Number(ds.slice(8, 10))) }),
      el('div', { class: 'cal-h' }, [
        has
          ? el('i', { class: `cal-dot${heat >= 70 ? ' hot' : heat >= 40 ? ' warm' : ''}`, style: `height:${Math.max(3, Math.round(heat / 8))}px` })
          : null,
      ]),
      has ? el('div', { class: 'cal-n', text: String(info.count) }) : null,
    ]
  );
  if (has) cell.title = `${ds}:${info.count} 条热点,最高热度 ${info.max_heat}`;
  return cell;
}

// ---------- 区间标签(日历左上方,只显示「时间区间」) ----------

function clearRange() {
  state.range = { from: '', to: '' };
  renderCal();
  renderRangeBar();
  updateSubLine();
  loadHotspots();
}

function renderRangeBar() {
  const tag = state.els.rangeTag;
  tag.replaceChildren();
  if (!rangeMode()) return;
  const r = state.range;
  tag.append(
    el('span', { class: 'range-tag' }, [
      el('span', { text: '📆 时间区间' }),
      r.from && r.to
        ? el('button', { class: 'range-tag-x', text: '✕', title: '清除时间区间', onclick: clearRange })
        : null,
    ])
  );
}

async function loadMonthDots() {
  const month = state.date.slice(0, 7);
  // 圆点随平台/品类过滤联动,缓存键含筛选
  const key = `${month}|${state.platform}|${state.category}`;
  if (state.monthDotsKey === key && state.monthDots) {
    renderCal();
    return;
  }
  try {
    const qs = new URLSearchParams({ month });
    if (state.platform) qs.set('platform', state.platform);
    if (state.category) qs.set('category', state.category);
    const d = await getJSON(`/api/calendar?${qs}`);
    state.monthDots = d.days;
    state.monthDotsKey = key;
    renderCal();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- 筛选 ----------

function renderChips() {
  state.els.platformChipsWrap.innerHTML = '';
  state.els.categoryChipsWrap.innerHTML = '';
  state.els.heatChipsWrap.innerHTML = '';
  state.els.trendChipsWrap.innerHTML = '';
  renderMyToggle();
  state.els.platformChipsWrap.append(
    chips(PLATFORM_OPTIONS, state.platform, (v) => {
      state.platform = v;
      store.platform = v;
      if (!v) state.range = { from: '', to: '' }; // 无具体标签时退出区间模式
      renderChips();
      renderCal();
      renderRangeBar();
      updateSubLine();
      loadMonthDots();
      loadHotspots();
    })
  );
  state.els.categoryChipsWrap.append(
    chips(CATEGORY_OPTIONS, state.myOnly ? '' : state.category, (v) => {
      state.category = v;
      if (v) state.myOnly = false; // 手动选类目时退出「只看我的」
      if (!v) state.range = { from: '', to: '' };
      store.category = v;
      renderChips();
      renderCal();
      renderRangeBar();
      updateSubLine();
      loadMonthDots();
      loadHotspots();
    }, '全部品类')
  );
  state.els.heatChipsWrap.append(
    chips(HEAT_OPTIONS, state.heat, (v) => {
      state.heat = v;
      renderChips();
      loadHotspots();
    }, '全部热度')
  );
  state.els.trendChipsWrap.append(
    chips(TREND_OPTIONS, state.trend, (v) => {
      state.trend = v;
      renderChips();
      loadHotspots();
    }, '全部趋势')
  );
}

// 「只看我的」开关:按设置页配置的主营类目过滤
function renderMyToggle() {
  const wrap = state.els.myWrap;
  wrap.innerHTML = '';
  const has = store.profile.categories.length > 0;
  wrap.append(
    el('button', {
      class: `chip my-toggle${state.myOnly ? ' selected' : ''}`,
      text: state.myOnly ? '🎯 只看我的 · 已开' : '🎯 只看我的',
      title: has ? '只看我的主营类目' : '先在「我的 → 店铺偏好」配置主营类目',
      onclick: () => {
        if (!has) {
          toast('请先在「我的 → 店铺偏好」配置主营类目', 'info');
          return;
        }
        state.myOnly = !state.myOnly;
        renderChips();
        loadHotspots();
      },
    })
  );
}

// ---------- 热点列表 ----------

async function loadHotspots() {
  const list = state.els.list;
  const countEl = state.els.countEl;
  if (state.loading) return;
  state.loading = true;
  const q = state.q;
  const range = state.range;
  list.innerHTML = '';
  list.append(
    el('div', { class: 'sk-line w90 skeleton' }),
    el('div', { class: 'sk-line w70 skeleton' }),
    el('div', { class: 'sk-line w90 skeleton' })
  );
  const qs = new URLSearchParams();
  if (q) {
    qs.set('q', q);
  } else if (range.from && range.to) {
    qs.set('from', range.from);
    qs.set('to', range.to);
  } else {
    qs.set('date', state.date);
  }
  if (state.platform) qs.set('platform', state.platform);
  if (state.myOnly && store.profile.categories.length) {
    qs.set('categories', store.profile.categories.join(','));
  } else if (state.category) {
    qs.set('category', state.category);
  }
  if (state.heat) qs.set('heat', state.heat);
  if (state.trend) qs.set('trend', state.trend);
  try {
    const d = await getJSON(`/api/hotspots?${qs}`);
    // 期间用户改了筛选:以最新请求为准
    if (q !== state.q || (range.from !== state.range.from || range.to !== state.range.to)) return;
    countEl.textContent = String(d.items.length);
    list.innerHTML = '';
    const hasFilter = state.platform || state.category || state.heat || state.trend || state.myOnly || state.q || (state.range.from && state.range.to);
    if (!d.items.length) {
      list.append(
        el('div', { class: 'empty' }, [
          el('span', { class: 'emoji', text: '🛰️' }),
          el('div', { class: 'title', text: q ? `没有找到「${q}」相关话题` : state.range.from ? '该区间暂无热点' : '该日期暂无热点' }),
          el('div', { class: 'desc', text: hasFilter ? '试试切换筛选条件或换个关键词' : '试试切换其他日期,或点击右上角刷新' }),
          hasFilter
            ? el('button', { class: 'go-btn', text: '清除筛选', onclick: () => { clearSearch(); state.platform = ''; state.category = ''; state.heat = ''; state.trend = ''; state.myOnly = false; state.range = { from: '', to: '' }; renderChips(); renderCal(); renderRangeBar(); updateSubLine(); loadHotspots(); } })
            : null,
        ])
      );
      return;
    }
    d.items.forEach((item, i) => {
      item.rank = i + 1;
      list.append(hotspotCard(item));
    });
  } catch (e) {
    list.innerHTML = '';
    list.append(el('div', { class: 'empty' }, [el('span', { class: 'emoji', text: '⚠️' }), el('div', { class: 'desc', text: e.message || '加载失败' })]));
  } finally {
    state.loading = false;
  }
}

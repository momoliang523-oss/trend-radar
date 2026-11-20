// 入口:hash 路由 + 视图生命周期 + 主题/字号 + 鉴权全局回调
import { applyTheme, applyFontSize, refreshFavorites, refreshCart, store } from './store.js';
import calendarView from './views/calendar.js';
import detailView from './views/detail.js';
import favoritesView from './views/favorites.js';
import reportView from './views/report.js';
import meView from './views/me.js';
import cartView from './views/cart.js';
import { initFeedback } from './components/feedback.js';
import { initAppearance } from './components/appearance.js';
import { setApiHandlers } from './api.js';
import { toast } from './components/toast.js';
import { trackEnter, trackLeave } from './lib/tracking.js';

applyTheme();
applyFontSize();
refreshFavorites();
refreshCart();
initFeedback();
initAppearance();

// 全局 401/402 回调:401 提示登录并跳「我的」;402 提示积分不足并引导充值
setApiHandlers({
  unauthorized: () => {
    toast('请先登录后使用完整功能', 'info');
    if (!location.hash.startsWith('#/me')) location.hash = '#/me';
  },
  insufficient: (d) => {
    const left = d?.credits != null ? `(剩余 ${d.credits} 分)` : '';
    toast(`积分不足${left},请到「我的」充值`, 'err');
  },
});

const ROUTES = {
  calendar: calendarView,
  detail: detailView,
  favorites: favoritesView,
  report: reportView,
  cart: cartView,
  me: meView,
};

const viewEl = document.getElementById('view');
let currentView = null;
let currentKey = '';

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'calendar';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  return { name: parts[0] || 'calendar', args: parts.slice(1), params };
}

function setActiveTab(name) {
  document.querySelectorAll('#tabbar a, #sidebar .sb-nav a').forEach((a) => {
    const tab = a.dataset.tab;
    a.classList.toggle('active', tab === name || (name === 'detail' && tab === 'calendar'));
  });
}

async function navigate() {
  const { name, args, params } = parseHash();
  const view = ROUTES[name] || ROUTES.calendar;

  if (currentView && currentKey === name && view.keepAlive) {
    // 同视图仅更新参数(如日历切换日期不重建)
    currentView.update?.(args, params);
    setActiveTab(name);
    return;
  }

  trackEnter(name); // 结算上一视图停留时长,开始新视图计时
  currentView?.destroy?.();
  viewEl.innerHTML = '';
  currentView = view;
  currentKey = name;
  setActiveTab(name);
  window.scrollTo(0, 0);
  try {
    await view.render(viewEl, args, params);
  } catch (e) {
    console.error('[view] 渲染失败:', e);
    viewEl.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'empty';
    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = '⚠️';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '页面渲染出错';
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = `${(e.message || e).slice(0, 200)}\n错误详情见浏览器控制台`;
    desc.style.whiteSpace = 'pre-line';
    banner.append(emoji, title, desc);
    viewEl.append(banner);
  }
}

window.addEventListener('hashchange', navigate);
window.addEventListener('pagehide', () => trackLeave());
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app] 未处理的异常:', e.reason);
});
navigate();

// 系统主题变化跟随(auto 模式)
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (store.theme === 'auto') applyTheme();
});

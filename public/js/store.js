// 全局共享状态
import { fmtLocalDate } from './fmt.js';
import { getJSON } from './api.js';

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('tr_profile') || '{}');
    return { platforms: p.platforms || [], categories: p.categories || [] };
  } catch {
    return { platforms: [], categories: [] };
  }
}

function loadAuth() {
  try {
    const a = JSON.parse(localStorage.getItem('tr_auth') || '{}');
    return { token: a.token || '', user: a.user || null };
  } catch {
    return { token: '', user: null };
  }
}

export const store = {
  selectedDate: fmtLocalDate(),
  platform: '', // '' = 全部
  category: '', // '' = 全部品类
  favorites: new Set(),
  cart: new Set(),
  profile: loadProfile(), // 我的店铺/偏好
  auth: loadAuth(), // {token, user}
  theme: localStorage.getItem('tr_theme') || 'auto',
  fontSize: localStorage.getItem('tr_font') || 'm',
  calendarCache: {}, // month -> {days}
};

export async function refreshFavorites() {
  try {
    const d = await getJSON('/api/favorites');
    store.favorites = new Set(d.items.map((i) => i.id));
  } catch {
    /* 忽略 */
  }
}

export async function refreshCart() {
  try {
    const d = await getJSON('/api/cart');
    store.cart = new Set(d.items.map((i) => i.id));
  } catch {
    /* 忽略 */
  }
}

export function isFav(id) {
  return store.favorites.has(id);
}

export function isInCart(id) {
  return store.cart.has(id);
}

export function toggleFavLocal(id, on) {
  if (on) store.favorites.add(id);
  else store.favorites.delete(id);
}

export function toggleCartLocal(id, on) {
  if (on) store.cart.add(id);
  else store.cart.delete(id);
}

export function saveProfile(p) {
  store.profile = { platforms: p.platforms || [], categories: p.categories || [] };
  localStorage.setItem('tr_profile', JSON.stringify(store.profile));
}

// ---------- 账号 ----------

export function setAuth({ token, user }) {
  store.auth = { token, user };
  localStorage.setItem('tr_auth', JSON.stringify(store.auth));
}

export function clearAuth() {
  store.auth = { token: '', user: null };
  localStorage.removeItem('tr_auth');
}

export function getToken() {
  return store.auth.token || '';
}

export function isLoggedIn() {
  return !!(store.auth.token && store.auth.user);
}

export function updateUser(user) {
  store.auth.user = user;
  localStorage.setItem('tr_auth', JSON.stringify(store.auth));
}

// 余额更新(SSE 事件携带 credits 时调用;负数兜底展示为 0)
export function updateCredits(n) {
  if (n == null || !store.auth.user) return;
  store.auth.user.credits = Math.max(0, Number(n) || 0);
  localStorage.setItem('tr_auth', JSON.stringify(store.auth));
}

// ---------- 外观 ----------

export function saveTheme(t) {
  store.theme = t;
  localStorage.setItem('tr_theme', t);
  applyTheme();
}

export function applyTheme() {
  const t = store.theme;
  let mode = t;
  if (t === 'auto') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = mode;
}

const FONT_SCALES = { s: 0.92, m: 1, l: 1.12 };

export function saveFontSize(f) {
  store.fontSize = f;
  localStorage.setItem('tr_font', f);
  applyFontSize();
}

export function applyFontSize() {
  const scale = FONT_SCALES[store.fontSize] || 1;
  document.body.style.zoom = String(scale);
}

// 停留时长记录:每个视图计时,切页或关闭时 keepalive 上报 /api/track
const KEY = 'tr_sid';
let sessionId = localStorage.getItem(KEY);
if (!sessionId) {
  sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(KEY, sessionId);
}

let currentPage = '';
let enteredAt = 0;

// 进入新视图:先为上一个视图落账,再开始计时
export function trackEnter(page) {
  flush();
  currentPage = page;
  enteredAt = Date.now();
}

// 离开(切页/关闭)时结算当前视图
export function trackLeave() {
  flush();
  currentPage = '';
}

function flush() {
  if (!currentPage || !enteredAt) return;
  const ms = Date.now() - enteredAt;
  enteredAt = 0;
  if (ms < 1000) return; // 少于 1 秒视为误触,不记
  try {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, page: currentPage, ms }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 忽略上报失败 */
  }
}

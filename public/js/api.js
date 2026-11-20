// API 封装:JSON + SSE(fetch + ReadableStream 手解帧);统一携带 Bearer 会话
import { getToken, updateCredits } from './store.js';

// 401/402 全局回调(由 app.js 注册:401 提示并跳「我的」,402 提示积分不足)
let onUnauthorized = null;
let onInsufficient = null;

export function setApiHandlers({ unauthorized, insufficient }) {
  if (unauthorized) onUnauthorized = unauthorized;
  if (insufficient) onInsufficient = insufficient;
}

export class ApiError extends Error {
  constructor(message, { code = '', credits = null } = {}) {
    super(message);
    this.code = code;
    this.credits = credits;
  }
}

function authHeaders(extra) {
  const token = getToken();
  const h = token ? { authorization: `Bearer ${token}` } : {};
  return { ...h, ...(extra || {}) };
}

async function request(method, url, body) {
  const headers = body !== undefined
    ? authHeaders({ 'content-type': 'application/json' })
    : authHeaders();
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(data.error || '请先登录', { code: data.code || 'unauthorized' });
  }
  if (res.status === 402) {
    onInsufficient?.(data);
    throw new ApiError(data.error || '积分不足', { code: data.code || 'insufficient_credits', credits: data.credits });
  }
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

export const getJSON = (u) => request('GET', u);
export const postJSON = (u, b) => request('POST', u, b || {});
export const putJSON = (u, b) => request('PUT', u, b || {});
export const delJSON = (u) => request('DELETE', u);

// SSE:handlers = {onMeta, onSectionStart, onDelta, onSectionDone, onError, onDone, onInsufficient}
// 返回 abort 函数
export function sseStream(url, handlers, signal) {
  let aborted = false;
  const abort = () => {
    aborted = true;
    signal?.abort();
  };

  (async () => {
    try {
      const res = await fetch(url, { signal, headers: authHeaders() });
      if (res.status === 401) {
        onUnauthorized?.();
        handlers.onUnauthorized?.();
        return;
      }
      if (res.status === 402) {
        const d = await res.json().catch(() => ({}));
        onInsufficient?.(d);
        handlers.onInsufficient?.(d);
        handlers.onError?.(new Error(d.error || '积分不足,请到「我的」充值'));
        return;
      }
      if (res.status === 409) {
        handlers.onError?.(new Error('正在生成中,请稍候'));
        return;
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || d.message || `HTTP ${res.status}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) throw new Error('服务端未返回流式响应,请刷新重试');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const dispatch = (frame) => {
        let event = 'message';
        const dataLines = [];
        for (const raw of frame.split('\n')) {
          const line = raw.replace(/\r$/, '');
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return;
        let data = {};
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          return;
        }
        // 余额同步:任何事件携带 credits 都更新本地
        if (data.credits != null) updateCredits(data.credits);
        const map = {
          meta: handlers.onMeta,
          section_start: handlers.onSectionStart,
          delta: handlers.onDelta,
          section_done: handlers.onSectionDone,
          section_error: handlers.onSectionError,
          done: handlers.onDone,
          error: (d) => handlers.onError?.(new Error(d.message || '生成失败')),
        };
        // 先按通用命名(onStats / onNarrative…)匹配,再走固定表
        const cap = event ? event[0].toUpperCase() + event.slice(1) : 'Message';
        (handlers[`on${cap}`] || handlers[event] || map[event])?.(data);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const sepLen = buf[idx] === '\r' ? 4 : 2;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + sepLen);
          if (frame.trim() && !frame.startsWith(':')) dispatch(frame);
        }
      }
      if (buf.trim() && !buf.startsWith(':')) dispatch(buf);
    } catch (e) {
      if (aborted || signal?.aborted) return;
      handlers.onError?.(e);
    }
  })();

  return abort;
}

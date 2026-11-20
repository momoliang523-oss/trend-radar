// LLM 客户端:统一流式(Anthropic 兼容 + OpenAI 兼容两种 SSE 方言)+ 供应商故障切换
import { FORCE_PROVIDER, LLM_MAX_TOKENS, LLM_TIMEOUT_MS, PROVIDERS } from './config.js';
import { sleep } from './util.js';

// 供应商最近状态(供 /api/meta 展示,不含 key 物料)
const providerStatus = new Map(); // id -> {reachable:bool, last_error:string, last_ok_at:string}
export function getProviderStatus() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    base: p.base,
    has_key: !!p.key(),
    models: p.models,
    ...(providerStatus.get(p.id) || { reachable: null, last_error: '', last_ok_at: '' }),
  }));
}
function record(id, reachable, msg) {
  providerStatus.set(id, {
    reachable,
    last_error: reachable ? '' : String(msg || '').slice(0, 200),
    last_ok_at: reachable ? new Date().toISOString() : (providerStatus.get(id)?.last_ok_at || ''),
  });
}

// ---------- Anthropic 兼容流(DeepSeek) ----------

async function* anthropicStream(provider, model, system, user, signal) {
  const res = await fetch(`${provider.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.key(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: LLM_MAX_TOKENS,
      temperature: 0.7,
      system,
      messages: [{ role: 'user', content: user }],
      stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === 'error' || evt.error) {
        const err = new Error(JSON.stringify(evt.error || evt).slice(0, 300));
        throw err;
      }
      if (evt.type === 'message_stop') return;
      const text = evt.delta?.text ?? evt.content_block_delta?.delta?.text ?? '';
      if (text) yield text;
    }
  }
}

// ---------- OpenAI 兼容流(CherryIN) ----------

async function* openaiStream(provider, model, system, user, signal) {
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.key()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: LLM_MAX_TOKENS,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        ended = true;
        return;
      }
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.error) {
        const err = new Error(JSON.stringify(evt.error).slice(0, 300));
        throw err;
      }
      const text = evt.choices?.[0]?.delta?.content ?? '';
      if (text) yield text;
    }
  }
  // 部分代理省略 [DONE],流关闭即视为结束
  if (!ended) return;
}

// ---------- 统一入口:带故障切换的流式生成 ----------

// 产出 {text, provider, model, done?, truncated?}
// - 每个 provider×model 依次尝试
// - 已产出 ≥100 字后中断 → 保留 partial 不再切换(防双倍消费)
// - 全部失败 → throw(调用方走 L3 模板兜底)
export async function* streamChat({ system, user, model = '', signal } = {}) {
  const abort = signal || AbortSignal.timeout(LLM_TIMEOUT_MS);
  const errors = [];
  const tryModel = (m) => !model || model === m; // 显式指定模型时只试该模型
  for (const provider of PROVIDERS) {
    if (FORCE_PROVIDER && provider.id !== FORCE_PROVIDER) continue;
    for (const m of provider.models) {
      if (!tryModel(m)) continue;
      let acc = '';
      try {
        const gen =
          provider.kind === 'anthropic'
            ? anthropicStream(provider, m, system, user, abort)
            : openaiStream(provider, m, system, user, abort);
        for await (const chunk of gen) {
          acc += chunk;
          yield { text: chunk, provider: provider.id, model: m };
        }
        if (!acc) throw new Error('空响应');
        record(provider.id, true, '');
        yield { text: '', provider: provider.id, model: m, done: true };
        return;
      } catch (e) {
        record(provider.id, false, e.message || e);
        errors.push(`${provider.id}/${m}: ${(e.message || e).slice(0, 120)}`);
        if (acc.length >= 100) {
          // partial 可用:停止切换,返回已生成内容
          yield { text: '', provider: provider.id, model: m, done: true, truncated: true };
          return;
        }
        if (e.status === 429) await sleep(1500);
      }
    }
  }
  throw new Error('LLM 全部供应商不可用: ' + errors.join(' | '));
}

// 非流式便捷封装:一次性拿全文
export async function completeChat(opts) {
  let text = '';
  let meta = { provider: '', model: '', truncated: false };
  try {
    for await (const c of streamChat(opts)) {
      if (c.text) text += c.text;
      if (c.done) meta = { provider: c.provider, model: c.model, truncated: !!c.truncated };
    }
    return { ok: true, text, ...meta };
  } catch (e) {
    return { ok: false, text, error: e.message, ...meta };
  }
}

// ---------- CLI 冒烟测试 ----------

if (process.argv.includes('--smoke')) {
  const model = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || '';
  console.log(`[smoke] 目标:${FORCE_PROVIDER || '自动'} 模型:${model || '默认'}\n`);
  (async () => {
    try {
      for await (const c of streamChat({
        system: '你是出海市场调研分析师,用简体中文回答。',
        user: '用三句话介绍一下 TikTok Shop 在东南亚的增长趋势。',
        model,
      })) {
        if (c.text) process.stdout.write(c.text);
        if (c.done) console.log(`\n\n[smoke] 完成 provider=${c.provider} model=${c.model}${c.truncated ? ' (partial)' : ''}`);
      }
    } catch (e) {
      console.error('\n[smoke] 全部供应商失败:', e.message);
      process.exit(1);
    }
  })();
}

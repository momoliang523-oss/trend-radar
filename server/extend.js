// 「一键延伸」管道:上下文装配 → 四分区顺序生成 → 引用提取 → 置信度 → 逐分区落库 → L3 兜底
// 计费:每分区 AI 成功后原子扣分(模板降级/客户端断开不扣);SSE 出口一律脱敏 provider/model
import { db, nowIso } from './db.js';
import { streamChat } from './llm.js';
import { buildContext, SECTION_PROMPTS, SECTION_ORDER, SECTION_TITLES, SYSTEM_PROMPT, templateFallback } from './prompts.js';
import { costForUser, effectiveTier, modelForUser } from './auth.js';
import { chargeSection, currentBalance } from './billing.js';

// in-flight 防重:全量按 hotspotId,单分区按 `${hotspotId}:${section}`
const inflight = new Map();

export function isGenerating(hotspotId) {
  return inflight.has(String(hotspotId));
}

export function isGeneratingSection(hotspotId, section) {
  return inflight.has(`${hotspotId}:${section}`);
}

// ---------- 数据访问 ----------

export function getHotspot(hotspotId) {
  return db.prepare('SELECT * FROM hotspots WHERE id = ?').get(hotspotId) || null;
}

export function getSignalsForHotspot(hotspotId) {
  return db
    .prepare(
      `SELECT s.* FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id
       WHERE hs.hotspot_id = ? ORDER BY hs.is_original DESC, s.engagement DESC`
    )
    .all(hotspotId);
}

export function getCachedExtend(hotspotId) {
  const row = db.prepare('SELECT * FROM extend_results WHERE hotspot_id = ?').get(hotspotId);
  if (!row) return null;
  return {
    hotspotId,
    sections: JSON.parse(row.sections),
    provider: row.provider,
    model: row.model,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function saveSections(hotspotId, sections, provider, model) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO extend_results (hotspot_id, sections, provider, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(hotspot_id) DO UPDATE SET sections = excluded.sections, provider = excluded.provider,
       model = excluded.model, updated_at = excluded.updated_at`
  ).run(hotspotId, JSON.stringify(sections), provider, model, now, now);
}

// ---------- 引用与置信度(确定性,不依赖模型自报) ----------

// 模型只输出 [编号] 占位;真实 URL 一律从信号表映射,杜绝幻觉链接
function extractCitations(markdown, signals) {
  const used = new Set();
  const citations = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(markdown)) && citations.length < 6) {
    const idx = Number(m[1]);
    if (idx >= 1 && idx <= signals.length && !used.has(idx)) {
      used.add(idx);
      const s = signals[idx - 1];
      citations.push({ index: idx, title: s.title.slice(0, 60), url: s.url, platform: s.platform });
    }
  }
  return citations;
}

// 置信度按档位(试用按中档):模板兜底恒为低
const TIER_CONF = { high: 3, mid: 2, free: 2 };

function computeConfidence(tier, citations, status) {
  let level = TIER_CONF[tier] || 2;
  if (!citations.length) level -= 1;
  if (citations.length >= 4) level += 1;
  if (status === 'partial') level = Math.min(level, 2);
  return ['低', '中', '高'][Math.max(0, Math.min(2, level - 1))];
}

// ---------- 单分区生成(流式:每个 chunk 通过 onDelta 即时发出) ----------

async function generateSection(sectionKey, ctx, hotspot, signals, model, signal, onDelta) {
  const prompt = SECTION_PROMPTS[sectionKey](ctx);
  let text = '';
  let meta = { provider: '', model: '', truncated: false };
  try {
    for await (const c of streamChat({
      system: SYSTEM_PROMPT,
      user: prompt,
      model,
      signal,
    })) {
      if (c.text) {
        text += c.text;
        if (onDelta) onDelta(sectionKey, c.text);
      }
      if (c.done) meta = { provider: c.provider, model: c.model, truncated: !!c.truncated };
    }
    if (!text.trim()) throw new Error('空响应');
    return { ok: true, text: text.trim(), ...meta };
  } catch (e) {
    if (text.length >= 100) {
      return { ok: true, text: text.trim(), ...meta, truncated: true };
    }
    return { ok: false, error: e.message };
  }
}

// 分区成功后的落库 + 扣费 + 脱敏事件;返回最新余额
function settleSection({ user, sections, key, hotspotId, sec, onEvent, section, provider, model }) {
  if (sec.provider !== 'template') {
    const ch = chargeSection(user.id, costForUser(user), 'extend', `extend:${hotspotId}:${key}`);
    if (!ch.ok) console.error('[billing] 扣费失败(内容已生成):', user.id, hotspotId, key);
    onEvent({
      event: 'section_done',
      data: {
        section, confidence: sec.confidence, citations: sec.citations, markdown: sec.markdown,
        partial: sec.status === 'partial', degraded: false, credits: ch.balance,
      },
    });
  } else {
    onEvent({
      event: 'section_done',
      data: { section, confidence: sec.confidence, citations: sec.citations, markdown: sec.markdown, degraded: true },
    });
  }
  saveSections(hotspotId, sections, provider, model);
  return currentBalance(user.id);
}

// ---------- 主流程 ----------

// onEvent({event, data}) 由 SSE 层实现;signal 用于客户端断开时中止 LLM
export async function runExtend({ hotspotId, user, force = false, onEvent, signal, targetPlatforms }) {
  const hotspot = getHotspot(hotspotId);
  if (!hotspot) return { error: '热点不存在' };
  const signals = getSignalsForHotspot(hotspotId);
  if (!signals.length) return { error: '该热点暂无信号,无法分析' };

  const model = modelForUser(user);
  let credits = currentBalance(user.id);

  const cached = force ? null : getCachedExtend(hotspotId);
  if (cached) {
    onEvent({ event: 'meta', data: { hotspotId, credits } });
    onEvent({ event: 'done', data: { ok: true, cached: true, credits } });
    return { cached: true };
  }

  if (inflight.has(String(hotspotId))) return { conflict: true };
  inflight.set(String(hotspotId), true);
  try {
    onEvent({ event: 'meta', data: { hotspotId, credits } });

    const ctx = buildContext(hotspot, signals, { targetPlatforms });
    const sections = {};
    let usedProvider = '';
    let usedModel = '';
    const tier = effectiveTier(user);

    // 单分区完整流程(生成 → 引用/置信度 → 落库 → section_done)
    const runOne = async (key) => {
      onEvent({ event: 'section_start', data: { section: key, title: SECTION_TITLES[key] } });
      const r = await generateSection(key, ctx, hotspot, signals, model, signal, (k, chunk) =>
        onEvent({ event: 'delta', data: { section: k, text: chunk } })
      );

      if (r.ok) {
        const citations = extractCitations(r.text, signals);
        const confidence = computeConfidence(tier, citations, r.truncated ? 'partial' : 'ok');
        sections[key] = {
          status: r.truncated ? 'partial' : 'ok',
          markdown: r.text,
          confidence,
          citations,
          provider: r.provider,
          model: r.model,
        };
        usedProvider = r.provider;
        usedModel = r.model;
        credits = settleSection({
          user, sections, key, hotspotId, sec: sections[key], onEvent, section: key, provider: r.provider, model: r.model,
        });
      } else if (signal?.aborted) {
        // 客户端断开:不生成模板、不落库(避免污染缓存)
        return;
      } else {
        // L3 模板兜底:同一 SSE 路径流式输出(不扣分)
        const tpl = templateFallback(hotspot, key, signals);
        sections[key] = {
          status: 'ok',
          markdown: tpl.markdown,
          confidence: tpl.confidence,
          citations: tpl.citations,
          provider: 'template',
          model: 'template',
        };
        for (const chunk of chunkText(tpl.markdown, 24)) {
          onEvent({ event: 'delta', data: { section: key, text: chunk } });
        }
        credits = settleSection({
          user, sections, key, hotspotId, sec: sections[key], onEvent, section: key, provider: 'template', model: 'template',
        });
      }
    };

    // 串行主链:爆火原因解读是后续三个分区的共同依据(PRD 5.2)
    await runOne('why');
    // 并行分支:选品建议 / 短视频 / 内容营销互不阻塞
    await Promise.all(SECTION_ORDER.slice(1).map((key) => runOne(key)));

    onEvent({ event: 'done', data: { ok: true, cached: false, credits } });
    return { ok: true, sections };
  } finally {
    inflight.delete(String(hotspotId));
  }
}

// 单分区流式生成:只跑指定分区并合并进既有结果
export async function runExtendSection({ hotspotId, section, user, force = false, onEvent, signal, targetPlatforms }) {
  const hotspot = getHotspot(hotspotId);
  if (!hotspot) return { error: '热点不存在' };
  const signals = getSignalsForHotspot(hotspotId);
  if (!signals.length) return { error: '该热点暂无信号,无法分析' };

  const key = `${hotspotId}:${section}`;
  if (inflight.has(key)) return { conflict: true };
  inflight.set(key, true);
  try {
    onEvent({ event: 'section_start', data: { section, title: SECTION_TITLES[section] } });

    const model = modelForUser(user);
    const ctx = buildContext(hotspot, signals, { targetPlatforms });
    const r = await generateSection(section, ctx, hotspot, signals, model, signal, (k, chunk) =>
      onEvent({ event: 'delta', data: { section: k, text: chunk } })
    );

    const cached = getCachedExtend(hotspotId) || { sections: {} };
    const sections = { ...cached.sections };
    let credits = currentBalance(user.id);

    if (r.ok) {
      const citations = extractCitations(r.text, signals);
      const confidence = computeConfidence(effectiveTier(user), citations, r.truncated ? 'partial' : 'ok');
      sections[section] = {
        status: r.truncated ? 'partial' : 'ok',
        markdown: r.text,
        confidence,
        citations,
        provider: r.provider,
        model: r.model,
      };
      credits = settleSection({
        user, sections, key: section, hotspotId, sec: sections[section], onEvent, section, provider: r.provider, model: r.model,
      });
    } else if (signal?.aborted) {
      // 客户端断开:不生成模板、不落库
      return { aborted: true };
    } else {
      // L3 模板兜底(同一 SSE 路径流式输出,不扣分)
      const tpl = templateFallback(hotspot, section, signals);
      sections[section] = {
        status: 'ok',
        markdown: tpl.markdown,
        confidence: tpl.confidence,
        citations: tpl.citations,
        provider: 'template',
        model: 'template',
      };
      for (const chunk of chunkText(tpl.markdown, 24)) {
        onEvent({ event: 'delta', data: { section, text: chunk } });
      }
      credits = settleSection({
        user, sections, key: section, hotspotId, sec: sections[section], onEvent, section, provider: 'template', model: 'template',
      });
    }
    onEvent({ event: 'done', data: { ok: true, cached: false, credits } });
    return { ok: true, sections };
  } finally {
    inflight.delete(key);
  }
}

// 单分区重试(非流式):重新生成指定分区并落库(需登录,按 1 分区扣费)
export async function retrySection({ hotspotId, section, user, signal } = {}) {
  const hotspot = getHotspot(hotspotId);
  if (!hotspot) return { error: '热点不存在' };
  const signals = getSignalsForHotspot(hotspotId);
  if (!signals.length) return { error: '无信号' };
  const cached = getCachedExtend(hotspotId) || { sections: {} };
  const ctx = buildContext(hotspot, signals);
  const r = await generateSection(section, ctx, hotspot, signals, modelForUser(user), signal, null);
  if (!r.ok) return { error: r.error || '生成失败' };
  const citations = extractCitations(r.text, signals);
  const confidence = computeConfidence(effectiveTier(user), citations, r.truncated ? 'partial' : 'ok');
  const sec = {
    status: r.truncated ? 'partial' : 'ok',
    markdown: r.text,
    confidence,
    citations,
    provider: r.provider,
    model: r.model,
  };
  const sections = { ...cached.sections, [section]: sec };
  let ch = { balance: currentBalance(user.id) };
  if (sec.provider !== 'template') {
    ch = chargeSection(user.id, costForUser(user), 'extend', `extend:${hotspotId}:${section}`);
  }
  saveSections(hotspotId, sections, sec.provider, sec.model);
  return {
    ok: true,
    section: {
      markdown: sec.markdown,
      confidence: sec.confidence,
      citations: sec.citations,
      partial: sec.status === 'partial',
      degraded: sec.provider === 'template',
    },
    credits: ch.balance,
  };
}

function* chunkText(text, size) {
  let i = 0;
  while (i < text.length) {
    yield text.slice(i, i + size);
    i += size;
  }
}

// 类目 / 产品关键词分析(「假睫毛」→ 模糊匹配美妆类目 → 产品周期信号 + 选品建议)
// SSE 流式、并行分区、引用溯源、缓存(复用 analyze_cache)+ 模板兜底;计费每分区 AI 成功后原子扣分
import { db, nowIso } from './db.js';
import { streamChat } from './llm.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { addDays, charFuzzyScore, sleep, todayStr } from './util.js';
import { costForUser, effectiveTier, modelForUser } from './auth.js';
import { chargeSection, currentBalance } from './billing.js';
import { runCopyStream } from './copy.js';
import { getResearch, researchPromptBlock } from './fxbaogao.js';

export const CATEGORY_SECTIONS = [
  { key: 'map', title: '① 类目定位与关联类目', icon: '🧭' },
  { key: 'cycle', title: '② 产品生命周期信号', icon: '📈' },
  { key: 'pick', title: '③ 选品建议', icon: '📦' },
];

const LOOKBACK_DAYS = 30;

// ---------- 上下文装配:关键词 → 命中热点 + 关联类目 ----------

function safeExtra(x) {
  try {
    return JSON.parse(x || '{}');
  } catch {
    return {};
  }
}

export function buildSearchContext(q, scope = '') {
  const start = addDays(todayStr(), -(LOOKBACK_DAYS - 1));
  const end = todayStr();

  // 模糊匹配:查询词任一字出现在标题/摘要/关键词/信号/类目中即命中(命中字数越多越靠前),
  // 用户不用换关键词——搜「保温杯」,标题有「杯」字就出现。
  const windowRows = db
    .prepare(`SELECT h.* FROM hotspots h WHERE h.date >= ? AND h.date <= ?`)
    .all(start, end);

  // ① 话题命中:标题/摘要/关键词
  const byTopic = windowRows
    .map((h) => ({ h, s: Math.max(charFuzzyScore(q, h.title), charFuzzyScore(q, h.summary), charFuzzyScore(q, h.keywords)) }))
    .filter((x) => x.s > 0);
  // ② 信号命中:平台信号标题/正文
  const sigRows = db
    .prepare(
      `SELECT DISTINCT h.*, s.title AS st, s.text AS sx FROM hotspots h
       JOIN hotspot_signals hs ON hs.hotspot_id = h.id
       JOIN signals s ON s.id = hs.signal_id
       WHERE h.date >= ? AND h.date <= ?`
    )
    .all(start, end);
  const bySignal = sigRows
    .filter((r) => charFuzzyScore(q, r.st) > 0 || charFuzzyScore(q, r.sx) > 0)
    .map(({ st, sx, ...h }) => ({ h, s: Math.max(charFuzzyScore(q, st), charFuzzyScore(q, sx)) }));
  const signalHitCount = bySignal.length;

  // 合并去重,按命中字数、热度排序(命中字数越多越靠前)
  const map = new Map();
  for (const x of [...byTopic, ...bySignal]) {
    const prev = map.get(x.h.id);
    if (!prev || x.s > prev.s) map.set(x.h.id, { h: x.h, s: x.s });
  }
  const hits = [...map.values()].sort((a, b) => b.s - a.s || b.h.heat_score - a.h.heat_score).slice(0, 60).map((x) => x.h);

  // ③ 类目命中:类目名中任一字与查询词重合(如「美妆」类目),把该品类热点并入市场盘
  const catHits = windowRows
    .filter((h) => charFuzzyScore(q, h.category) > 0)
    .sort((a, b) => b.heat_score - a.heat_score)
    .slice(0, 40);

  const relatedCats = new Map();
  for (const h of hits) relatedCats.set(h.category, (relatedCats.get(h.category) || 0) + 1);
  for (const h of catHits) relatedCats.set(h.category, (relatedCats.get(h.category) || 0) + 1);
  const categories = [...relatedCats.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  if (!hits.length && !catHits.length) {
    return { error: `近 ${LOOKBACK_DAYS} 天没有找到与「${q}」字面相关的热点或类目,再短一点的关键词试试` };
  }

  // 市场盘 = 命中热点 + 命中类目热点(供生命周期与选品分析)
  const marketMap = new Map();
  for (const h of [...hits, ...catHits]) marketMap.set(h.id, h);
  let market = [...marketMap.values()].sort((a, b) => b.heat_score - a.heat_score);

  // 用户选定类目/方向:市场盘聚焦该类目(类目名或关键词字面匹配),聚焦不到则退回整体盘
  let focusMiss = false;
  if (scope) {
    const low = String(scope).toLowerCase();
    const scoped = market.filter(
      (h) =>
        String(h.category || '').toLowerCase().includes(low) ||
        low.includes(String(h.category || '').toLowerCase()) ||
        String(`${h.title} ${h.summary || ''} ${h.keywords || ''}`).toLowerCase().includes(low)
    );
    if (scoped.length) market = scoped.sort((a, b) => b.heat_score - a.heat_score);
    else focusMiss = true;
  }

  // 信号:命中热点关联信号按互动量取前 15
  const ids = market.slice(0, 40).map((h) => h.id);
  const signals = ids.length
    ? db
        .prepare(
          `SELECT DISTINCT s.*, hs.hotspot_id AS hid FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id
           WHERE hs.hotspot_id IN (${ids.map(() => '?').join(',')})
           ORDER BY s.engagement DESC LIMIT 15`
        )
        .all(...ids)
    : [];

  const stageCount = { 萌芽: 0, 上升: 0, 峰值: 0, 衰退: 0 };
  for (const h of market) if (stageCount[h.lifecycle] != null) stageCount[h.lifecycle]++;
  const rising = market.filter((h) => h.heat_trend === 'up' || h.heat_trend === 'new');
  const falling = market.filter((h) => h.heat_trend === 'down');
  const prices = signals.map((s) => safeExtra(s.extra).price).filter((p) => p > 0);
  const dates = market.map((h) => h.date).sort();
  const platMap = new Map();
  for (const s of signals) platMap.set(s.platform, (platMap.get(s.platform) || 0) + 1);
  const platforms = [...platMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // 市场盘日均热度走势(折线图用,确定性数据)
  const dayMap = new Map();
  for (const h of market) {
    if (!dayMap.has(h.date)) dayMap.set(h.date, { sum: 0, n: 0 });
    const d = dayMap.get(h.date);
    d.sum += h.heat_score;
    d.n += 1;
  }
  const daily = [...dayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, avg: Math.round(v.sum / v.n), count: v.n }));

  // 市场盘品类分布(饼图用)
  const catDistMap = new Map();
  for (const h of market) catDistMap.set(h.category, (catDistMap.get(h.category) || 0) + 1);
  const cats = [...catDistMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  return {
    q,
    scope: scope || 'search',
    focusMiss: !!focusMiss,
    window: { start, end },
    matched: {
      topicHits: hits.length,
      signalHits: signalHitCount,
      categoryHits: catHits.length,
      categories,
      relatedWords: [...new Set(hits.flatMap((h) => safeJsonWords(h.keywords)).filter((w) => !charFuzzyScore(q, w)))].slice(0, 12),
    },
    stats: {
      total: market.length,
      avgHeat: market.length ? Math.round(market.reduce((a, h) => a + h.heat_score, 0) / market.length) : 0,
      maxHeat: market.length ? Math.max(...market.map((h) => h.heat_score)) : 0,
      rising: rising.length,
      falling: falling.length,
      stageCount,
      dateSpan: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '',
      platforms,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      demoCount: market.filter((h) => h.source_type === 'demo').length,
      topTitles: market.slice(0, 8).map((h) => `${h.title}(热度 ${h.heat_score},${h.lifecycle}期,${h.heat_trend === 'up' || h.heat_trend === 'new' ? '上升' : h.heat_trend === 'down' ? '回落' : '持平'})`),
      daily,
      cats,
    },
    signals: signals.map((s) => ({
      id: s.id,
      platform: s.platform,
      title: s.title,
      text: s.text,
      url: s.url,
      engagement: s.engagement,
      published_at: s.published_at,
      extra: safeExtra(s.extra),
    })),
  };
}

function safeJsonWords(x) {
  try {
    const a = JSON.parse(x || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// ---------- Prompt ----------

function buildPrompt(ctx, targetPlatforms, research = null) {
  const s = ctx.stats;
  const lines = [];
  lines.push(`【分析任务】用户输入产品/类目关键词「${ctx.q}」,请做类目品分析(可做类目模糊扩展:如「假睫毛」可扩展到美妆个护、眼妆工具、美睫配件等)。`);
  lines.push(`【用户选定类目/方向】${ctx.scope !== 'search' ? ctx.scope : '未指定(整体分析)'}${ctx.focusMiss ? '(注:该方向在盘中直接命中较少,已展示整体盘)' : ''}`);
  lines.push(`【数据窗口】近 30 天(${ctx.window.start} ~ ${ctx.window.end})`);
  lines.push(`【匹配情况】话题命中 ${ctx.matched.topicHits} 条、信号命中 ${ctx.matched.signalHits} 条、类目命中 ${ctx.matched.categoryHits} 条`);
  lines.push(`【匹配方式】模糊匹配:查询词任一字出现在话题/信号/类目中即命中(用户搜的词与话题不要求整词一致)`);
  lines.push(`【关联类目】${ctx.matched.categories.map((c) => `${c.name} ${c.count} 条`).join('、') || '无直接关联(请依据关键词做类目推断)'}`);
  if (ctx.matched.relatedWords.length) lines.push(`【关联关键词】${ctx.matched.relatedWords.join('、')}`);
  lines.push(`【市场概况】相关盘共 ${s.total} 条热点(演示 ${s.demoCount} 条),平均热度 ${s.avgHeat},峰值 ${s.maxHeat};上升中 ${s.rising} 条,退潮 ${s.falling} 条`);
  lines.push(`【生命周期分布】萌芽 ${s.stageCount['萌芽']} · 上升 ${s.stageCount['上升']} · 峰值 ${s.stageCount['峰值']} · 衰退 ${s.stageCount['衰退']}(出现时间 ${s.dateSpan})`);
  lines.push(`【平台分布】${s.platforms.map((p) => `${p.name} ${p.count}`).join('、') || '无'}`);
  if (s.priceMin != null) lines.push(`【价格信号】采集信号中价格区间 $${s.priceMin}–$${s.priceMax}(仅供参考,仅演示数据含价格)`);
  lines.push(`【代表话题】${s.topTitles.join(';')}`);
  if (targetPlatforms?.length) {
    lines.push(`【目标平台】${targetPlatforms.join('、')}(卖家主营平台,选品建议需贴合其品类结构、客单价与合规要求)`);
  }
  lines.push(`【信号列表】(按互动量降序,引用用编号 [n])`);
  ctx.signals.forEach((sig, i) => {
    const text = (sig.text || '').replace(/\s+/g, ' ').slice(0, 140);
    const eng = sig.engagement >= 1e4 ? (sig.engagement / 1e4).toFixed(1) + '万' : String(sig.engagement);
    lines.push(`[${i + 1}] (${sig.platform}) ${sig.title}${text ? ` — ${text}` : ''} — 互动量 ${eng} — ${sig.url}`);
  });
  const researchBlock = researchPromptBlock(research);
  if (researchBlock) lines.push(researchBlock);
  lines.push(`说明:价格/销量等数据仅以信号列表为准,不得编造;演示数据已在概况中标注。`);
  lines.push(`【输出风格】结论先行、要点精简:每个小节先给一句结论,再列 3-6 条要点;数据对比一律用 Markdown 表格呈现;只写与数据相关的判断,不写无关内容、不输出分析过程,控制篇幅。`);
  return lines.join('\n');
}

export const SECTION_PROMPTS = {
  map: (ctx, targetPlatforms, research) => `${buildPrompt(ctx, targetPlatforms, research)}

任务:输出该关键词的「类目定位与关联类目」。

输出结构(严格按此顺序):
## 类目定位与关联类目
### 结论(一句话:该关键词最可能归属的主类目 + 当前热度方向)
### 关联类目(Markdown 表格:| 类目 | 关联逻辑 | 热度信号 |,3-6 行)
### 市场热度概览(3-5 条要点,引用信号编号)`,
  cycle: (ctx, targetPlatforms, research) => `${buildPrompt(ctx, targetPlatforms, research)}

任务:输出该关键词相关产品的「产品生命周期信号」。

输出结构(严格按此顺序):
## 产品生命周期信号
### 结论(一句话:整体所处阶段 + 机会或风险)
### 阶段分布(Markdown 表格:| 产品形态 | 所处阶段 | 判断依据 | 建议动作 |,引用信号)
### 机会窗口(3-4 条要点)
### 周期监控指标(3-4 条要点)`,
  pick: (ctx, targetPlatforms, research) => `${buildPrompt(ctx, targetPlatforms, research)}

任务:输出该关键词相关产品的「选品建议」(面向跨境电商卖家,若上下文含【目标平台】需优先贴合)。

输出结构(严格按此顺序):
## 选品建议
### 结论(机会等级 高/中/低 + 一句话理由,引用信号)
### 细分商品方向(Markdown 表格:| 方向 | 功能卖点 | 目标人群 | 差异化空间 |,3-5 行)
### 价格带(Markdown 表格:| 价格带 | 成本结构 | 毛利空间 |)
### 目标市场与切入顺序(3-4 条要点)
### 风险提示(3-4 条要点)`,
  note: '上述建议为方向性参考,不构成销量承诺。',
};

// ---------- 模板兜底 ----------

function templateSection(ctx, key) {
  const s = ctx.stats;
  const head = `> ⚠️ AI 类目分析暂不可用,以下为基于采集数据的自动汇总,置信度较低,可稍后重试。\n\n`;
  const body = {
    map: `### 类目基础信息\n- 关键词:**${ctx.q}**\n- 关联类目:${ctx.matched.categories.map((c) => `${c.name}(${c.count} 条)`).join('、') || '无直接命中'}\n- 话题命中 ${ctx.matched.topicHits} 条 · 信号命中 ${ctx.matched.signalHits} 条\n\n### 依据不足说明\n完整类目定位与关联类目推断需 AI 分析生成。`,
    cycle: `### 生命周期基础数据\n- 相关热点共 ${s.total} 条,平均热度 ${s.avgHeat},峰值 ${s.maxHeat}\n- 阶段分布:萌芽 ${s.stageCount['萌芽']} · 上升 ${s.stageCount['上升']} · 峰值 ${s.stageCount['峰值']} · 衰退 ${s.stageCount['衰退']}\n- 出现时间 ${s.dateSpan},上升中 ${s.rising} 条 / 退潮 ${s.falling} 条\n\n### 依据不足说明\n完整产品生命周期信号需 AI 分析生成。`,
    pick: `### 选品基础数据\n- 代表话题:${s.topTitles.slice(0, 5).join(';')}\n- 平台分布:${s.platforms.map((p) => `${p.name} ${p.count}`).join('、') || '无'}\n\n### 依据不足说明\n完整选品建议(细分方向、价格带、市场切入)需 AI 分析生成。`,
  }[key];
  return head + body;
}

// ---------- 缓存(复用 analyze_cache,cache_key 前缀 catsearch:) ----------

const cacheKeyOf = (q, cat = '') => `catsearch:${q}:${cat}:${todayStr()}`;

export function getCachedCategorySearch(q, cat = '') {
  const row = db.prepare('SELECT * FROM analyze_cache WHERE cache_key = ?').get(cacheKeyOf(q, cat));
  if (!row) return null;
  return { sections: JSON.parse(row.sections), provider: row.provider, model: row.model, created_at: row.created_at };
}

function saveCategorySearch(q, cat, sections, provider, model) {
  db.prepare(
    `INSERT INTO analyze_cache (cache_key, sections, provider, model, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET sections = excluded.sections, provider = excluded.provider,
       model = excluded.model, created_at = excluded.created_at`
  ).run(cacheKeyOf(q, cat), JSON.stringify(sections), provider, model, nowIso());
}

// ---------- 引用与置信度(同 analyze,确定性) ----------

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

const TIER_CONF = { high: 3, mid: 2, free: 2 };

function computeConfidence(tier, citations, partial) {
  let level = TIER_CONF[tier] || 2;
  if (!citations.length) level -= 1;
  if (citations.length >= 4) level += 1;
  if (partial) level = Math.min(level, 2);
  return ['低', '中', '高'][Math.max(0, Math.min(2, level - 1))];
}

// ---------- 主流程 ----------

export async function runCategorySearch({ q, cat = '', force = false, onEvent, signal, targetPlatforms, user }) {
  const ctx = buildSearchContext(q, cat);
  if (ctx.error) {
    onEvent({ event: 'error', data: { message: ctx.error } });
    return { error: ctx.error };
  }

  const model = modelForUser(user);
  const tier = effectiveTier(user);
  let credits = currentBalance(user.id);

  const cached = force ? null : getCachedCategorySearch(q, cat);
  onEvent({ event: 'context', data: ctx });
  if (cached) {
    const stripped = {};
    for (const [k, v] of Object.entries(cached.sections || {})) {
      const { provider, model: m, ...rest } = v;
      stripped[k] = { ...rest, degraded: provider === 'template' };
    }
    onEvent({ event: 'cached', data: { sections: stripped, created_at: cached.created_at, credits } });
    onEvent({ event: 'done', data: { ok: true, cached: true, credits } });
    return { cached: true };
  }

  const sections = {};
  let usedProvider = '';
  let usedModel = '';

  // 行业研报(fxbaogao):6.5 秒预算(实测一次检索约 5 秒)内拿到就注入分析上下文;超时/失败不阻塞主分析(后台继续检索并缓存)
  const research = await Promise.race([getResearch(q, cat), sleep(6500).then(() => null)]);

  const runOne = async (secKey) => {
    const sec = CATEGORY_SECTIONS.find((x) => x.key === secKey);
    onEvent({ event: 'section_start', data: { section: secKey, title: `${sec.icon} ${sec.title}` } });
    const prompt = SECTION_PROMPTS[secKey](ctx, targetPlatforms, research);
    let text = '';
    let meta = { provider: '', model: '', truncated: false };
    try {
      for await (const c of streamChat({ system: SYSTEM_PROMPT, user: prompt, model, signal })) {
        if (c.text) {
          text += c.text;
          onEvent({ event: 'delta', data: { section: secKey, text: c.text } });
        }
        if (c.done) meta = { provider: c.provider, model: c.model, truncated: !!c.truncated };
      }
      if (!text.trim()) throw new Error('空响应');
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return;
      /* 真失败 → 落入模板兜底 */
    }

    if (!text.trim()) {
      // L3 模板兜底(不扣分)
      const tpl = templateSection(ctx, secKey);
      sections[secKey] = { status: 'ok', markdown: tpl, confidence: '低', citations: [], provider: 'template', model: 'template' };
      for (const chunk of chunkText(tpl, 24)) onEvent({ event: 'delta', data: { section: secKey, text: chunk } });
      onEvent({ event: 'section_done', data: { section: secKey, confidence: '低', citations: [], markdown: tpl, degraded: true, credits } });
    } else {
      const citations = extractCitations(text, ctx.signals);
      const confidence = computeConfidence(tier, citations, meta.truncated);
      sections[secKey] = { status: meta.truncated ? 'partial' : 'ok', markdown: text.trim(), confidence, citations, provider: meta.provider, model: meta.model };
      usedProvider = meta.provider;
      usedModel = meta.model;
      const ch = chargeSection(user.id, costForUser(user), 'category', `catsearch:${q}:${cat}:${secKey}`);
      if (!ch.ok) console.error('[billing] 扣费失败(内容已生成):', user.id, secKey);
      credits = ch.balance;
      onEvent({
        event: 'section_done',
        data: { section: secKey, confidence, citations, markdown: text.trim(), partial: !!meta.truncated, degraded: false, credits },
      });
    }
    saveCategorySearch(q, cat, sections, usedProvider, usedModel);
  };

  await Promise.all([runOne('map'), runOne('cycle'), runOne('pick')]);
  onEvent({ event: 'done', data: { ok: true, cached: false, credits } });
  return { ok: true, sections };
}

function* chunkText(text, size) {
  let i = 0;
  while (i < text.length) {
    yield text.slice(i, i + size);
    i += size;
  }
}

// ---------- 文字版自媒体文案(仅管理员,不扣费) ----------

export async function runCategoryCopy({ q, cat = '', onEvent, signal }) {
  const ctx = buildSearchContext(q, cat);
  if (ctx.error) {
    onEvent({ event: 'error', data: { message: ctx.error } });
    return { error: ctx.error };
  }

  // 已有分析结果 → 以其为底稿;没有 → 直接用数据概况生成
  const cached = getCachedCategorySearch(q, cat);
  const sectionsMd = cached
    ? Object.values(cached.sections || {})
        .map((v) => v.markdown)
        .join('\n\n')
    : '';

  const prompt = `【文案素材】以下为「${q}」${cat ? `(聚焦类目/方向:${cat})` : ''}近 30 天海外市场类目分析${sectionsMd ? '结果' : '数据概况'}。

${sectionsMd || buildPrompt(ctx, null)}

任务:把上述分析改写为微信小程序 / 小红书风格的爆款文案(文字版,用于自媒体传播)。
- 面向受众:跨境电商卖家、想做 TikTok 带货的内容创作者
- 有分析结果时以其结论为准;没有时基于数据概况自行归纳(只引用上述数据,不编造)
- 按系统要求的 Markdown 结构输出`;

  return runCopyStream({ prompt, onEvent, signal });
}

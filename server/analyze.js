// 品类 / 单品深度分析:选品建议 + 实施建议 + 风险分析(SSE 流式、并行分区、引用溯源、缓存 + 模板兜底)
// 计费:每分区 AI 成功后原子扣分;SSE 出口脱敏 provider/model
import { db, nowIso } from './db.js';
import { streamChat } from './llm.js';
import { SYSTEM_PROMPT } from './prompts.js';
import { periodRange } from './report.js';
import { costForUser, effectiveTier, modelForUser } from './auth.js';
import { chargeSection, currentBalance } from './billing.js';

export const ANALYZE_SECTIONS = [
  { key: 'suggest', title: '① 全面选品建议', icon: '📦' },
  { key: 'plan', title: '② 实施建议', icon: '🚀' },
  { key: 'risk', title: '③ 风险分析', icon: '⚠️' },
];

// 收藏层级(用于给分析注入用户意向上下文)
export const FAV_LEVELS = ['普通', '高兴趣', '有意向'];

// ---------- 上下文装配 ----------

export function buildAnalyzeContext({ scope, key, id, type = 'month', end }) {
  const { start, end: endStr, label } = periodRange(type, end);

  if (scope === 'hotspot') {
    const hotspot = db.prepare('SELECT * FROM hotspots WHERE id = ?').get(id);
    if (!hotspot) return { error: '热点不存在' };
    const signals = db
      .prepare(
        `SELECT s.* FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id
         WHERE hs.hotspot_id = ? ORDER BY hs.is_original DESC, s.engagement DESC`
      )
      .all(id);
    // 同类目市场盘(同期同品类其他热点)
    const market = db
      .prepare(
        `SELECT h.id, h.title, h.heat_score, h.date FROM hotspots h
         WHERE h.category = ? AND h.date >= ? AND h.date <= ? AND h.id != ?
         ORDER BY h.heat_score DESC LIMIT 10`
      )
      .all(hotspot.category, start, endStr, id);

    return {
      scope,
      target: { id: hotspot.id, label: hotspot.title, category: hotspot.category },
      period: { type, label, start, end: endStr },
      hotspot: {
        id: hotspot.id,
        title: hotspot.title,
        category: hotspot.category,
        heat_score: hotspot.heat_score,
        heat_trend: hotspot.heat_trend,
        lifecycle: hotspot.lifecycle,
        date: hotspot.date,
        summary: hotspot.summary,
        source_type: hotspot.source_type,
      },
      signals: signals.map(mapSignal),
      market: market.map((h) => ({ id: h.id, title: h.title, heat_score: h.heat_score, date: h.date })),
      favoriteLevel: favoriteLevelOf(hotspot.category),
    };
  }

  // scope === 'category'
  const hotspots = db
    .prepare(
      `SELECT * FROM hotspots WHERE category = ? AND date >= ? AND date <= ? ORDER BY heat_score DESC`
    )
    .all(key, start, endStr);
  if (!hotspots.length) return { error: '该周期内此品类暂无热点数据' };

  // 用户高意向收藏的热点(信号优先注入)
  const favIds = new Set(
    db.prepare(`SELECT hotspot_id FROM favorites WHERE level != '普通'`).all().map((r) => r.hotspot_id)
  );
  const favTitles = hotspots.filter((h) => favIds.has(h.id)).map((h) => h.title);

  const ids = hotspots.map((h) => h.id);
  const signals = db
    .prepare(
      `SELECT DISTINCT s.*, hs.hotspot_id AS hid FROM hotspot_signals hs JOIN signals s ON s.id = hs.signal_id
       WHERE hs.hotspot_id IN (${ids.map(() => '?').join(',')})
       ORDER BY (CASE WHEN hs.hotspot_id IN (SELECT hotspot_id FROM favorites WHERE level != '普通') THEN 0 ELSE 1 END), s.engagement DESC LIMIT 15`
    )
    .all(...ids);

  const total = hotspots.length;
  const avgHeat = Math.round(hotspots.reduce((a, h) => a + h.heat_score, 0) / total);
  const rising = hotspots.filter((h) => h.heat_trend === 'up' || h.heat_trend === 'new').length;
  const falling = hotspots.filter((h) => h.heat_trend === 'down').length;
  const platMap = new Map();
  for (const s of signals) platMap.set(s.platform, (platMap.get(s.platform) || 0) + 1);
  const platforms = [...platMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  // 价格信号(demo 数据的 extra.price)
  const prices = signals.map((s) => safeExtra(s.extra).price).filter((p) => p > 0);

  return {
    scope,
    target: { category: key, label: `${key}品类` },
    period: { type, label, start, end: endStr },
    stats: {
      total,
      avgHeat,
      maxHeat: Math.max(...hotspots.map((h) => h.heat_score)),
      rising,
      falling,
      demoCount: hotspots.filter((h) => h.source_type === 'demo').length,
      platforms,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      topTitles: hotspots.slice(0, 8).map((h) => `${h.title}(热度 ${h.heat_score},${h.heat_trend === 'up' || h.heat_trend === 'new' ? '上升' : h.heat_trend === 'down' ? '回落' : '持平'})`),
    },
    signals: signals.map(mapSignal),
    favoriteLevel: favoriteLevelOf(key),
    favoriteTitles: favTitles,
  };
}

function mapSignal(s) {
  return {
    id: s.id,
    platform: s.platform,
    title: s.title,
    text: s.text,
    url: s.url,
    engagement: s.engagement,
    published_at: s.published_at,
    extra: safeExtra(s.extra),
  };
}

function safeExtra(x) {
  try {
    return JSON.parse(x || '{}');
  } catch {
    return {};
  }
}

// 用户对该类目的意向层级(取收藏中最高层级)
function favoriteLevelOf(category) {
  const row = db
    .prepare(
      `SELECT MAX(CASE f.level WHEN '有意向' THEN 3 WHEN '高兴趣' THEN 2 ELSE 1 END) AS lv,
              GROUP_CONCAT(DISTINCT f.level) AS levels
       FROM favorites f JOIN hotspots h ON h.id = f.hotspot_id WHERE h.category = ?`
    )
    .get(category);
  if (!row || !row.lv) return null;
  return { 1: '普通', 2: '高兴趣', 3: '有意向' }[row.lv];
}

// ---------- Prompt ----------

function buildPrompt(ctx) {
  const lines = [];
  lines.push(`【分析对象】${ctx.target.label}(${ctx.scope === 'hotspot' ? '单品' : '品类'}维度)`);
  lines.push(`【数据周期】${ctx.period.label}`);
  if (ctx.targetPlatforms?.length) {
    lines.push(`【目标平台】${ctx.targetPlatforms.join('、')}(卖家主营平台,选品建议需贴合其品类结构、客单价与合规要求)`);
  }
  if (ctx.scope === 'hotspot') {
    const h = ctx.hotspot;
    lines.push(`【热点概况】热度 ${h.heat_score}/100,${h.lifecycle}期,趋势${h.heat_trend},首发 ${h.date}`);
    lines.push(`【同类市场】${ctx.market.map((m) => `${m.title}(热度 ${m.heat_score})`).join(';') || '周期内无其他同类热点'}`);
  } else {
    const s = ctx.stats;
    lines.push(`【市场概况】周期内共 ${s.total} 条热点(演示 ${s.demoCount} 条),平均热度 ${s.avgHeat},峰值 ${s.maxHeat};上升中 ${s.rising} 条,退潮 ${s.falling} 条`);
    lines.push(`【平台分布】${s.platforms.map((p) => `${p.name} ${p.count}`).join('、')}`);
    if (s.priceMin != null) lines.push(`【价格信号】采集信号中价格区间 $${s.priceMin}–$${s.priceMax}(仅供参考,仅演示数据含价格)`);
    lines.push(`【代表热点】${s.topTitles.join(';')}`);
  }
  if (ctx.favoriteLevel) {
    lines.push(`【用户意向】用户已将该类目收藏并标记为「${ctx.favoriteLevel}」层级,请输出更贴近落地执行的详细方案,而非泛泛科普。`);
    if (ctx.favoriteTitles?.length) {
      lines.push(`【用户收藏的热点】${ctx.favoriteTitles.slice(0, 4).join(';')}(信号列表中已优先置顶)`);
    }
  }
  lines.push(`【信号列表】(按互动量降序,引用用编号 [n])`);
  ctx.signals.forEach((s, i) => {
    const text = (s.text || '').replace(/\s+/g, ' ').slice(0, 140);
    const eng = s.engagement >= 1e4 ? (s.engagement / 1e4).toFixed(1) + '万' : String(s.engagement);
    lines.push(`[${i + 1}] (${s.platform}) ${s.title}${text ? ` — ${text}` : ''} — 互动量 ${eng} — ${s.url}`);
  });
  lines.push(`说明:价格/销量等数据仅以信号列表为准,不得编造;演示数据已在概况中标注。`);
  return lines.join('\n');
}

export const SECTION_PROMPTS = {
  suggest: (ctx) => `${buildPrompt(ctx)}

任务:输出该类目/单品的「全面选品建议」(面向跨境电商卖家,若上下文含【目标平台】需优先贴合)。

输出结构(严格按此顺序):
## 全面选品建议
### 机会判断(机会等级 高/中/低 + 理由,引用信号)
### 细分商品方向(3-5 个具体 SKU 形态:功能卖点 / 目标人群 / 差异化空间)
### 价格带与利润结构(客单价区间、参考成本结构、毛利空间)
### 目标市场与切入顺序(先做哪个市场、为什么)
### 竞争与供给判断(现有供给密度、差异化机会、蓝海/红海判断)`,

  plan: (ctx) => `${buildPrompt(ctx)}

任务:输出该类目/单品的「实施建议」(可落地执行的分步方案)。

输出结构(严格按此顺序):
## 实施建议
### 上架节奏与时间窗(结合热点生命周期阶段,给出行动时间表)
### 供应链与备货方案(打样 → 测款 → 小批量 → 放量,各阶段的启动阈值)
### 内容营销配合(短视频脚本方向、红人合作策略、投放节奏)
### Listing 与转化要点(关键词布局、主图/视频、评论运营)
### 测试与复盘指标(CTR / 转化率 / 退货率等红线指标与止损线)`,

  risk: (ctx) => `${buildPrompt(ctx)}

任务:输出该类目/单品的「风险分析」。

输出结构(严格按此顺序):
## 风险分析
每项风险按「**风险等级**(高/中/低)— 触发条件 — 应对措施」格式输出:
### 热度与需求风险(趋势衰退、需求伪真)
### 竞争与仿品风险
### 合规与认证风险(目标市场认证要求,如 FCC / CE / CPC / 平台规则)
### 供应链与物流风险(品控、交期、库存积压)
### 文化与版权风险(文化敏感点、素材与外观专利)
### 综合结论(是否值得投入 + 建议投入规模参考)`,

  note: '上述建议为方向性参考,不构成销量承诺。',
};

// 模板兜底:纯数据陈述
function templateSection(ctx, key) {
  const head = `> ⚠️ AI 深度分析暂不可用,以下为基于采集数据的自动汇总,置信度较低,可稍后重试。\n\n`;
  if (ctx.scope === 'hotspot') {
    const h = ctx.hotspot;
    const body = {
      suggest: `### 基础信息\n- 热点:**${h.title}**\n- 热度:${h.heat_score}/100,处于「${h.lifecycle}」期\n- 同类市场信号:${ctx.market.length ? ctx.market.slice(0, 5).map((m) => m.title).join('、') : '周期内暂无其他同类热点'}\n\n### 依据不足说明\n完整选品建议(细分方向、价格带、竞争判断)需 AI 深度分析生成。`,
      plan: `### 可执行要点(基于现有数据)\n- 该热点处于「${h.lifecycle}」期:${h.lifecycle === '衰退' ? '热度已回落,建议观望为主' : '仍处热度窗口,可结合自身节奏评估'}\n- 参考信号互动量最高的平台优先做内容验证\n\n### 依据不足说明\n完整实施方案需 AI 深度分析生成。`,
      risk: `### 基础风险提示\n- 热度窗口风险:热点生命周期阶段为「${h.lifecycle}」,需关注趋势变化\n- 数据可信度:${h.source_type === 'demo' ? '本热点为演示数据,风险判断仅作演示' : '本热点为真实采集数据'}\n\n### 依据不足说明\n完整风险分析需 AI 深度分析生成。`,
    }[key];
    return head + body;
  }
  const s = ctx.stats;
  const body = {
    suggest: `### 品类基础数据\n- 周期内共 **${s.total}** 条热点,平均热度 ${s.avgHeat},峰值 ${s.maxHeat}\n- 上升中 ${s.rising} 条 / 退潮 ${s.falling} 条\n- 平台分布:${s.platforms.map((p) => `${p.name} ${p.count}`).join('、') || '无'}\n- 代表热点:${s.topTitles.slice(0, 5).join(';')}\n\n### 依据不足说明\n完整选品建议(细分方向、价格带、竞争判断)需 AI 深度分析生成。`,
    plan: `### 可执行要点(基于现有数据)\n- 上升热点占比 ${s.total ? Math.round((s.rising / s.total) * 100) : 0}%,可作为进场节奏参考\n- 优先围绕代表热点做内容与选品验证\n\n### 依据不足说明\n完整实施方案需 AI 深度分析生成。`,
    risk: `### 基础风险提示\n- 热度波动:周期内退潮 ${s.falling} 条,需关注品类生命周期\n- 数据可信度:其中演示数据 ${s.demoCount} 条,判断时注意区分\n\n### 依据不足说明\n完整风险分析需 AI 深度分析生成。`,
  }[key];
  return head + body;
}

// ---------- 缓存 ----------

function cacheKeyOf(scope, key, endStr) {
  return `analyze:${scope}:${key}:${endStr}`;
}

export function getCachedAnalyze(scope, key, endStr) {
  const row = db.prepare('SELECT * FROM analyze_cache WHERE cache_key = ?').get(cacheKeyOf(scope, key, endStr));
  if (!row) return null;
  return { sections: JSON.parse(row.sections), provider: row.provider, model: row.model, created_at: row.created_at };
}

function saveAnalyze(scope, key, endStr, sections, provider, model) {
  db.prepare(
    `INSERT INTO analyze_cache (cache_key, sections, provider, model, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET sections = excluded.sections, provider = excluded.provider,
       model = excluded.model, created_at = excluded.created_at`
  ).run(cacheKeyOf(scope, key, endStr), JSON.stringify(sections), provider, model, nowIso());
}

// ---------- 引用与置信度(同 extend,确定性) ----------

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

function computeConfidence(tier, citations, partial) {
  let level = TIER_CONF[tier] || 2;
  if (!citations.length) level -= 1;
  if (citations.length >= 4) level += 1;
  if (partial) level = Math.min(level, 2);
  return ['低', '中', '高'][Math.max(0, Math.min(2, level - 1))];
}

// 出口脱敏:分区剥离 provider/model,降级信息用 degraded 表达
export function stripSection(sec) {
  if (!sec) return sec;
  const { provider, model, ...rest } = sec;
  return { ...rest, degraded: provider === 'template' };
}

// ---------- 主流程 ----------

// onEvent({event, data});signal 用于断连中止;user 用于档位模型与扣费
export async function runAnalyze({ scope, key, id, type, end, force = false, onEvent, signal, targetPlatforms, user }) {
  const ctx = buildAnalyzeContext({ scope, key, id, type, end });
  if (ctx.error) {
    onEvent({ event: 'error', data: { message: ctx.error } });
    return { error: ctx.error };
  }
  if (targetPlatforms?.length) ctx.targetPlatforms = targetPlatforms;

  const model = modelForUser(user);
  const tier = effectiveTier(user);
  let credits = currentBalance(user.id);

  const cacheKey = scope === 'hotspot' ? String(id) : key;
  const cached = force ? null : getCachedAnalyze(scope, cacheKey, ctx.period.end);
  onEvent({ event: 'context', data: ctx });
  if (cached) {
    const stripped = {};
    for (const [k, v] of Object.entries(cached.sections || {})) stripped[k] = stripSection(v);
    onEvent({ event: 'cached', data: { sections: stripped, created_at: cached.created_at, credits } });
    onEvent({ event: 'done', data: { ok: true, cached: true, credits } });
    return { cached: true };
  }

  const sections = {};
  let usedProvider = '';
  let usedModel = '';

  const runOne = async (secKey) => {
    onEvent({ event: 'section_start', data: { section: secKey, title: `${ANALYZE_SECTIONS.find((s) => s.key === secKey).icon} ${ANALYZE_SECTIONS.find((s) => s.key === secKey).title}` } });
    const prompt = SECTION_PROMPTS[secKey](ctx);
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
      if (signal?.aborted || e?.name === 'AbortError') {
        // 客户端断开:不生成模板、不写缓存(避免污染)
        return;
      }
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
      const ch = chargeSection(user.id, costForUser(user), 'analyze', `analyze:${scope}:${cacheKey}:${secKey}`);
      if (!ch.ok) console.error('[billing] 扣费失败(内容已生成):', user.id, secKey);
      credits = ch.balance;
      onEvent({
        event: 'section_done',
        data: { section: secKey, confidence, citations, markdown: text.trim(), partial: !!meta.truncated, degraded: false, credits },
      });
    }
    saveAnalyze(scope, cacheKey, ctx.period.end, sections, usedProvider, usedModel);
  };

  await Promise.all([runOne('suggest'), runOne('plan'), runOne('risk')]);
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

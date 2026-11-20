// AI 分析师提示词(中文)+ L3 模板兜底
import { fmtLocalDate } from './util.js';

export const SYSTEM_PROMPT = `你是一名面向中国跨境电商出海从业者的海外市场研究分析师,服务对象是做 TikTok 内容 / 亚马逊、TikTok Shop、Shopee 选品的中国卖家与创作者团队。

要求:
1. 全部使用简体中文输出(引用原文时可保留原语言)。
2. 输出 Markdown:用 ## / ### 做层级,重点加 **加粗**。
3. 引用信号一律使用编号 [1][2] 形式,只能引用【信号列表】中真实存在的编号,不得编造。
4. 结论具体、可执行,避免空话套话;依据不足时明确说明不确定性与推断性质,不编造数据。
5. 观点克制保守:不夸大、不制造焦虑、不诱导跟风,不给确定性承诺(如销量、涨粉)。
6. 面向行动:每条结论尽量落到「是否值得跟进、适合谁、怎么做」。`;

// 热点上下文注入(相关性优先,信号带来源标记)
export function buildContext(hotspot, signals, opts = {}) {
  const trendMap = { up: '上升', down: '回落', flat: '持平', new: '新上榜' };
  const lines = [
    `【热点】${hotspot.title}`,
    `【日期】${hotspot.date}　【品类】${hotspot.category}　【热度】${hotspot.heat_score}/100(${trendMap[hotspot.heat_trend] || hotspot.heat_trend},${hotspot.lifecycle}期)`,
  ];
  if (opts.targetPlatforms?.length) {
    lines.push(`【目标平台】${opts.targetPlatforms.join('、')}(卖家主营平台,选品/内容建议需贴合其品类结构、客单价与合规要求)`);
  }
  lines.push(`【信号列表】(共 ${signals.length} 条,按互动量降序)`);
  signals.forEach((s, i) => {
    const text = (s.text || '').replace(/\s+/g, ' ').slice(0, 150);
    const eng = fmtEngagement(s.engagement);
    lines.push(`[${i + 1}] (${s.platform}) ${s.title}${text ? ` — ${text}` : ''} — 互动量 ${eng} — ${s.url}`);
  });
  return lines.join('\n');
}

function fmtEngagement(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// 四分区任务提示
export const SECTION_PROMPTS = {
  why: (ctx) => `${ctx}

任务:分析该热点「为什么在这个时间点、这个市场火起来」。

输出结构(严格按此顺序):
## 爆火原因解读
### 直接原因(1-3 条,每条引用至少一个信号编号)
### 深层原因(2-3 条:文化心理 / 平台机制 / 品类趋势)
### 对中国出海卖家的启示(一段话,3 句以内)

信息不足的维度请如实说明「信号量不足」,不要强行补全。`,

  content: (ctx) => `${ctx}

任务:基于该热点给出可落地的内容营销方向。

输出结构(严格按此顺序):
## 内容营销方向
### 方向一、二、三(每个方向包含:适合品类与目标人群 / 切入角度与内容形式 / 建议平台与发布时间 / 风险提示)
### 总体风险提示(2 条:文化敏感点、平台政策边界)

方向要具体可执行,避免「多做内容」这类空话;不确定处注明推断。`,

  video: (ctx) => `${ctx}

任务:基于该热点给出可直接开拍的短视频创作建议(面向 TikTok / Reels / Shorts)。

输出结构(严格按此顺序):
## 短视频创作建议
### 脚本创意(3-5 个,每个含:前 3 秒钩子台词 / 分镜要点 / BGM 与音效风格 / 3-5 个 #话题标签)
### 15 秒完整示例脚本(镜头 + 台词 + 字幕,可直接拍摄)

贴合热点但不得照搬他人素材,注意版权与平台规则。`,

  product: (ctx) => `${ctx}

任务:基于该热点延伸到选品思路(面向跨境电商卖家,若上下文含【目标平台】需优先贴合)。

输出结构(严格按此顺序):
## 选品思路
### 品类机会(明确品类与商品形态,结合信号论证需求真实度)
### 产品设计建议(功能 / 差异化 / 价格带,给出客单价区间)
### 供应链与合规提示(资质、认证、物流、季节性)
### 警惕点(1-2 条:热度衰退风险 / 仿品与专利 / 定价陷阱)

只输出方向性建议,不构成销量承诺;互动量数据只允许引用信号列表中的数值。`,
};

// L3 模板兜底:所有 LLM 不可用时,基于原始信号生成确定性摘要(不编造归因)
export function templateFallback(hotspot, sectionKey, signals) {
  const sig = signals.slice(0, 6);
  const platformCount = new Map();
  sig.forEach((s) => platformCount.set(s.platform, (platformCount.get(s.platform) || 0) + 1));
  const platforms = [...platformCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topPlatform = platforms[0]?.[0] || '未知平台';
  const total = sig.reduce((a, s) => a + s.engagement, 0);
  const trendMap = { up: '热度持续上升', down: '热度有所回落', flat: '热度趋于平稳', new: '新上榜' };

  const head = `## ${SECTION_TITLES[sectionKey]}\n\n> ⚠️ AI 深度分析暂不可用,以下为基于原始信号的自动摘要,置信度较低,仅供快速参考,可稍后重试完整分析。\n`;

  const why = `### 信号概览
该热点在 **${hotspot.date}** 位于「${hotspot.category}」品类,热度分 **${hotspot.heat_score}/100**,${trendMap[hotspot.heat_trend] || '热度未知'}。

### 传播分布
- 信号主要来自:${platforms.map(([p, c]) => `${p}(${c} 条)`).join('、')}
- 累计互动量约 **${fmtNum(total)}**,其中 ${topPlatform} 信号互动量最高
- 当前处于「${hotspot.lifecycle}」阶段

### 依据不足说明
本次未完成 AI 归因分析,爆火原因需结合完整信号重新解读,以下仅列出高互动信号:

${sig.map((s, i) => `- [${i + 1}] (${s.platform}) ${s.title} — 互动量 ${fmtNum(s.engagement)}`).join('\n')}`;

  const content = `### 方向参考(未完成 AI 深度分析)
基于现有信号,可初步关注的切入角度:
- 围绕「${hotspot.title}」在 **${topPlatform}** 的讨论热点做内容选题
- 优先面向关注该品类的受众,以 ${hotspot.lifecycle} 期节奏决定发布紧迫度

### 总体风险提示
- 文化敏感点与平台政策需人工核实,本摘要不构成完整建议
- 热度窗口变化快,建议结合完整 AI 分析后再排期`;

  const video = `### 初步选题方向
- 以「${hotspot.title}」为话题,结合 ${hotspot.category} 品类做开箱 / 体验 / 对比类短视频
- 前 3 秒建议直接展示结果或抛出问题,吸引同类兴趣人群

### 素材提示
高互动信号可供参考:
${sig.slice(0, 3).map((s, i) => `- [${i + 1}] (${s.platform}) ${s.title}`).join('\n')}

⚠️ 完整脚本创意需 AI 深度分析生成,可稍后重试。`;

  const product = `### 机会初步判断
- 品类方向:**${hotspot.category}**,围绕「${hotspot.title}」做关联商品延伸
- 需求真实度:以 ${topPlatform} 互动信号为主要参考,热度处于「${hotspot.lifecycle}」阶段

### 依据不足说明
⚠️ 本次未完成 AI 选品分析,价格带、竞争与供应链结论缺失;建议稍后重试完整分析后再做选品决策。`;

  const body = { why, content, video, product }[sectionKey] || why;

  return {
    markdown: head + body,
    confidence: '低',
    citations: sig.slice(0, 6).map((s, i) => ({
      index: i + 1,
      title: s.title.slice(0, 60),
      url: s.url,
      platform: s.platform,
    })),
    provider: 'template',
    model: 'template',
  };
}

export const SECTION_TITLES = {
  why: '① 爆火原因解读',
  product: '② 选品建议',
  video: '③ 短视频创作建议',
  content: '④ 内容营销方向',
};

// 生成顺序:爆火原因 → 选品建议 → 短视频 → 内容营销
export const SECTION_ORDER = ['why', 'product', 'video', 'content'];

export function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' 万+';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

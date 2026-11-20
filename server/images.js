// AI 图表生图:经本机 Magpie 网关 /v1/images/generations 调用生图模型(OpenRouter 镜像),
// 按页面真实统计数据生成可下载的图表海报(小红书/公众号分享风格)。
// 注意:OpenRouter 生图模型有区域限制,需本机代理开启(Magpie 走 macOS 系统代理)才能出图。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LLM_TIMEOUT_MS, MAGPIE_API_KEY, MAGPIE_BASE_URL } from './config.js';

// 生图模型(2026-10-24 实测:需代理;gemini-3-pro-image 质量更高、nano-banana-2.1 最便宜)
export const IMAGE_MODEL = process.env.IMAGE_MODEL || 'openrouter/google/gemini-nano-banana-2.1';
// 每张图表海报消耗的积分单位(实际扣分 = 档位单价 × 单位;试用/时长卡 0 分)
export const IMAGE_UNITS = Number(process.env.IMAGE_UNITS || 3);

export const GEN_DIR = path.join(DATA_DIR, 'gen');
mkdirSync(GEN_DIR, { recursive: true });

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const dayLabel = (d) => `${String(d.date || '').slice(5)}日${d.avg}分`;

// 由真实数据拼生图提示词:数字只能来自调用方传入的统计,严禁编造
function buildChartPrompt(type, p) {
  const lines = [];
  if (type === 'category') {
    lines.push(`主题:「${p.q || ''}」出海市场热度分析图表海报${p.cat ? `(聚焦类目:${p.cat})` : ''}`);
    const daily = (Array.isArray(p.daily) ? p.daily : []).slice(-14);
    if (daily.length > 1) lines.push(`热度走势折线(近 ${daily.length} 天):${daily.map(dayLabel).join('、')}`);
    const stages = Object.entries(p.stageCount || {});
    if (stages.length) lines.push(`生命周期阶段分布:${stages.map(([k, v]) => `${k} ${v} 条`).join('、')}`);
    const cats = (Array.isArray(p.cats) ? p.cats : []).slice(0, 6);
    if (cats.length) lines.push(`相关盘品类分布:${cats.map((c) => `${c.name} ${c.count} 条`).join('、')}`);
    const tops = (Array.isArray(p.topTitles) ? p.topTitles : []).slice(0, 5);
    if (tops.length) lines.push(`代表热点:${tops.join(';')}`);
    lines.push(`数据窗口:${p.dateSpan || '近 30 天'}`);
  } else {
    lines.push(`主题:「${p.label || '出海热点周期报告'}」数据图表海报`);
    const daily = (Array.isArray(p.daily) ? p.daily : []).slice(-14);
    if (daily.length > 1) lines.push(`热度走势折线:${daily.map(dayLabel).join('、')}`);
    const top = (Array.isArray(p.top) ? p.top : []).slice(0, 8);
    if (top.length) lines.push(`Top 热点榜:${top.map((t) => `${t.title} ${t.heat_score}分`).join(';')}`);
    const rise = (Array.isArray(p.rising) ? p.rising : []).slice(0, 5);
    if (rise.length) lines.push(`上升热点:${rise.map((t) => t.title).join('、')}`);
    const fall = (Array.isArray(p.falling) ? p.falling : []).slice(0, 5);
    if (fall.length) lines.push(`退潮热点:${fall.map((t) => t.title).join('、')}`);
    const cats = (Array.isArray(p.categories) ? p.categories : []).slice(0, 6);
    if (cats.length) lines.push(`品类分布:${cats.map((c) => `${c.name} ${c.count}条(${pct(c.count, p.total || 0)}%)`).join('、')}`);
    const plats = (Array.isArray(p.platforms) ? p.platforms : []).slice(0, 6);
    if (plats.length) lines.push(`平台分布:${plats.map((c) => `${c.name} ${c.count}条`).join('、')}`);
  }

  return `你是一名数据图表设计师。请根据以下真实统计数据,生成一张中文数据图表海报(小红书/公众号分享风格):
${lines.map((l) => `- ${l}`).join('\n')}
要求:
1. 大标题 + 副标题(注明数据区间),排版美观,浅色渐变背景,现代扁平风格,可加少量装饰元素
2. 折线图:横轴为日期、纵轴为热度分,数据点标注具体数值,趋势用折线表现
3. 占比类数据用环形图或条形图呈现,标注百分比
4. 所有数字必须与上面给定数据完全一致,严禁编造;图表 2-3 个即可,不要过度拥挤
5. 全部简体中文,字体清晰可读;底部加一行小字「数据来源:出海热点雷达」`;
}

// 生成图表海报:内容寻址缓存(相同数据直接复用文件,不重复生图)
// 返回 {file, cached};失败抛错(由 API 层转 502,不扣费)
export async function genChartImage({ type, payload, signal }) {
  const hash = createHash('sha1').update(`${type}|${JSON.stringify(payload)}`).digest('hex').slice(0, 16);
  const base = path.join(GEN_DIR, `chart-${type}-${hash}`);
  for (const ext of ['png', 'jpg']) {
    if (existsSync(`${base}.${ext}`)) return { file: `chart-${type}-${hash}.${ext}`, cached: true };
  }

  const res = await fetch(`${MAGPIE_BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MAGPIE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: buildChartPrompt(type, payload), n: 1, size: '1024x1024' }),
    signal: signal || AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`生图服务返回 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('生图服务未返回图片数据');
  const buf = Buffer.from(b64, 'base64');
  // 依魔数识别格式(生图模型可能返回 JPEG 或 PNG)
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : 'png';
  const file = `chart-${type}-${hash}.${ext}`;
  writeFileSync(path.join(GEN_DIR, file), buf);
  return { file, cached: false };
}

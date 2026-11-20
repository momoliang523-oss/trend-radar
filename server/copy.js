// 自媒体传播文案生成(仅管理员):把报告/选品分析改写为微信小程序 / 小红书爆款文案
// SSE 流式;管理员工具不扣费;模型固定高档(质量优先);失败不发模板(直接报错,文案宁缺毋滥)
import { streamChat } from './llm.js';
import { LLM_MODEL_HIGH } from './config.js';

export const COPY_SYSTEM = `你是一名中国跨境电商自媒体爆款文案写手,擅长微信小程序与小红书风格的出海选品/热点解读内容。

要求:
1. 全部使用简体中文,小红书排版风格:段落短、带 emoji 开头、口语化有网感,不要学术腔。
2. 输出 Markdown 结构:
   ## 标题候选(3-5 个,10-20 字,带 emoji,制造好奇但不夸张、不做虚假承诺)
   ## 正文(300-500 字,分段,每段一个信息点;开头 1-2 句钩子,中间干货,结尾引导互动)
   ## 话题标签(5-8 个,# 开头)
3. 数据只能引用下方提供的分析数据,严禁编造销量、价格、涨粉数等具体数字;原文没有的数据不写。
4. 不夸大、不承诺收益、不制造焦虑;观点克制但表达有吸引力。
5. 文末不写「仅供参考」「投资有风险」等免责话术(这是自媒体文案,不是分析报告)。`;

// 通用文案流:prompt 由调用方组装,流式输出 delta {text} / done {ok, markdown} / error {message}
export async function runCopyStream({ prompt, onEvent, signal }) {
  let text = '';
  let meta = { truncated: false };
  try {
    for await (const c of streamChat({ system: COPY_SYSTEM, user: prompt, model: LLM_MODEL_HIGH, signal })) {
      if (c.text) {
        text += c.text;
        onEvent({ event: 'delta', data: { text: c.text } });
      }
      if (c.done) meta = { truncated: !!c.truncated };
    }
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') return { aborted: true };
  }
  if (signal?.aborted) return { aborted: true };
  if (!text.trim()) {
    onEvent({ event: 'error', data: { message: '文案生成失败,请稍后重试' } });
    return { error: 'empty' };
  }
  onEvent({ event: 'done', data: { ok: true, markdown: text.trim(), partial: meta.truncated } });
  return { ok: true, markdown: text.trim() };
}

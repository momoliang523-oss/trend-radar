// 全局配置:端口、路径、LLM 网关(Magpie)、计费与会员常量
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = '出海热点雷达';
export const APP_VERSION = '0.2.0';

export const PORT = Number(process.env.PORT || 8124);
export const HOST = process.env.HOST || '127.0.0.1';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TREND_RADAR_DATA_DIR || path.join(ROOT, 'data');
export const DB_PATH = process.env.TREND_RADAR_DB || path.join(DATA_DIR, 'trend-radar.db');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// 全局抓取 UA
export const UA = 'trend-radar/0.2 (+research; contact: local)';

// 故意打坏 key 用于演练故障切换:TREND_RADAR_BAD_KEY=1
function breakKey(k) {
  return process.env.TREND_RADAR_BAD_KEY ? k + '__BOGUS__' : k;
}

// ---------- LLM:统一走本机 Magpie 网关(yetone/magpie,Anthropic 兼容) ----------

export const MAGPIE_BASE_URL = process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425';
export const MAGPIE_API_KEY = process.env.MAGPIE_API_KEY || 'magpie';

// 三档会员模型(2026-10-24 实测本机 Magpie 可用;原 minimax:free 已下架、haiku-5.5 区域受限,故替换;可用环境变量覆盖)
export const LLM_MODEL_FREE = process.env.LLM_MODEL_FREE || 'deepseek/deepseek-flash';
export const LLM_MODEL_MID = process.env.LLM_MODEL_MID || 'deepseek/deepseek-v4-pro';
export const LLM_MODEL_HIGH = process.env.LLM_MODEL_HIGH || 'openrouter/mistralai/mistral-large-4-0';

export const TIER_MODELS = { free: LLM_MODEL_FREE, mid: LLM_MODEL_MID, high: LLM_MODEL_HIGH };
// 试用期使用的档位(7 天免费试用内不限次)
export const TRIAL_TIER = process.env.TREND_RADAR_TRIAL_TIER || 'mid';

export const PROVIDERS = [
  {
    id: 'magpie',
    kind: 'anthropic', // /v1/messages
    base: MAGPIE_BASE_URL,
    models: [LLM_MODEL_FREE, LLM_MODEL_MID, LLM_MODEL_HIGH],
    key: () => breakKey(MAGPIE_API_KEY),
  },
];

// 强制指定供应商(调试用):FORCE_PROVIDER=magpie
export const FORCE_PROVIDER = process.env.FORCE_PROVIDER || '';

// 单次 LLM 调用超时
export const LLM_TIMEOUT_MS = Number(process.env.TREND_RADAR_LLM_TIMEOUT || 180000);
// 每分区最长输出 token
export const LLM_MAX_TOKENS = 4000;

// ---------- 账号 / 会员 / 计费 ----------

// 注册赠送积分与试用期
export const REGISTER_GIFT_POINTS = Number(process.env.TREND_RADAR_GIFT_POINTS || 100);
export const TRIAL_DAYS = Number(process.env.TREND_RADAR_TRIAL_DAYS || 7);

// 会话有效期(天)
export const SESSION_TTL_DAYS = 30;

// 每次 AI 分区生成的积分消耗(按档位)
export const POINTS_PER_SECTION = {
  free: Number(process.env.TREND_RADAR_COST_FREE || 1),
  mid: Number(process.env.TREND_RADAR_COST_MID || 3),
  high: Number(process.env.TREND_RADAR_COST_HIGH || 10),
};

// 管理员邮箱(逗号分隔,登录后可见运营数据/订单管理/数据操作)
export const ADMIN_EMAILS = (process.env.TREND_RADAR_ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---------- 支付:支付宝当面付(官方直连) ----------

// 支付宝开放平台应用 ID;留空则自动降级为 mock 支付(本地模拟到账)
export const ALIPAY_APP_ID = process.env.ALIPAY_APP_ID || '';
// 应用私钥:支持 PEM 文本(含换行)或文件路径(内容以 -----BEGIN 开头则视为文本)
export const ALIPAY_PRIVATE_KEY = process.env.ALIPAY_PRIVATE_KEY || '';
// 支付宝公钥(验签异步通知用;沙箱环境用沙箱公钥)
export const ALIPAY_PUBLIC_KEY = process.env.ALIPAY_PUBLIC_KEY || '';
// 沙箱开关:TREND_RADAR_PAY_SANDBOX=1 时走 openapi-sandbox.dl.alipaydev.com
export const PAY_SANDBOX = process.env.TREND_RADAR_PAY_SANDBOX === '1';
// 异步通知回调 URL(需公网可达;留空则纯靠客户端轮询 + 服务端主动查询结算)
export const ALIPAY_NOTIFY_URL = process.env.ALIPAY_NOTIFY_URL || '';

// 自定义充值:1 元 = 多少积分(例 9.9 元 → 99 积分)
export const POINTS_PER_YUAN = Number(process.env.TREND_RADAR_POINTS_PER_YUAN || 10);
export const CUSTOM_MIN_AMOUNT = Number(process.env.TREND_RADAR_CUSTOM_MIN_AMOUNT || 1);
export const CUSTOM_MAX_AMOUNT = Number(process.env.TREND_RADAR_CUSTOM_MAX_AMOUNT || 5000);

// ---------- 采集与数据 ----------

// 每日全量采集目标时刻(本地时间):08:00 前就绪
export const DAILY_FULL_RUN_HOUR = 8;
// 信号留存天数(超期且未被热点引用的信号清理)
export const SIGNAL_RETENTION_DAYS = 30;

// 品类清单(与 PRD 4.2 筛选一致)
export const CATEGORIES = ['美妆个护', '3C数码', '家居', '服饰', '母婴宠物', '食品', '运动户外', '其他'];

// 前端筛选 chip 的平台清单(采集器 display 需落在其中)
export const PLATFORMS = ['TikTok', 'X', 'Instagram', 'Reddit', 'YouTube', 'Amazon', 'TikTok Shop', 'Shopee', 'Temu', 'Hacker News', '新闻'];

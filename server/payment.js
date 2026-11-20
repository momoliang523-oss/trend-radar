// 支付通道:支付宝当面付(官方直连,RSA2-SHA256)+ mock 本地模拟
// 密钥只从环境变量读取,绝不落库/落盘/进日志;无密钥时自动降级 mock
import { createSign, createVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  ALIPAY_APP_ID, ALIPAY_NOTIFY_URL, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY, PAY_SANDBOX,
} from './config.js';

const GATEWAY = PAY_SANDBOX
  ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
  : 'https://openapi.alipay.com/gateway.do';

// PEM 文本或文件路径统一解析;解析失败返回 ''(此时通道降级 mock)
function readPem(value) {
  if (!value) return '';
  const text = value.trim();
  if (text.includes('-----BEGIN')) return text.replace(/\\n/g, '\n');
  if (text.length < 512 && existsSync(text)) return readFileSync(text, 'utf8');
  return '';
}

let _privateKey = null;
let _publicKey = null;
function privateKey() {
  if (_privateKey === null) _privateKey = readPem(ALIPAY_PRIVATE_KEY);
  return _privateKey;
}
function publicKey() {
  if (_publicKey === null) _publicKey = readPem(ALIPAY_PUBLIC_KEY);
  return _publicKey;
}

// 当前支付通道:'alipay'(密钥齐全)| 'offline'(线下转账+人工确认,OFFLINE_PAY_INFO 配置收款信息)| 'mock'(本地模拟,扫码页显示「模拟支付」)
// 优先级:alipay > offline > mock;上线环境必须配置 offline 或 alipay,绝不能把 mock 暴露给公网
let _mockWarned = false;
export function payProvider() {
  const provider = ALIPAY_APP_ID && privateKey() ? 'alipay' : offlinePayInfo() ? 'offline' : 'mock';
  if (provider === 'mock' && !_mockWarned) {
    _mockWarned = true;
    console.warn('[pay] 未配置支付宝密钥/线下收款信息,支付通道降级为本地模拟支付(仅限本地开发)');
  }
  return provider;
}

// 线下转账收款信息(多行文本,原样展示给下单客户;空 = 未启用线下模式)
export function offlinePayInfo() {
  return String(process.env.OFFLINE_PAY_INFO || '').trim();
}

// 参数字典 → 排序拼接(k=v&...)→ RSA2 签名(base64)
function signParams(params, key) {
  const content = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const sign = createSign('RSA-SHA256');
  sign.update(content, 'utf8');
  sign.end();
  return { content, sign: sign.sign(key, 'base64') };
}

function alipayTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function alipayCall(method, bizContent) {
  const common = {
    app_id: ALIPAY_APP_ID,
    method,
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  const { sign } = signParams(common, privateKey());
  const body = new URLSearchParams({ ...common, sign });
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const key = method.replace(/\./g, '_') + '_response';
  const r = data[key] || {};
  if (r.code !== '10000') {
    const err = new Error(`支付宝接口 ${method} 失败: ${r.sub_msg || r.msg || r.code}`);
    err.code = r.code;
    throw err;
  }
  return r;
}

// 预下单(当面付扫码)→ 二维码内容(本身也是可跳转的支付链接)
export async function createAlipayQr(order) {
  if (payProvider() !== 'alipay') return null;
  const subject = order.plan_days > 0
    ? `${order.plan_days} 天中档会员`
    : `出海热点雷达 ${order.points} 积分`;
  const biz = {
    out_trade_no: order.order_no,
    total_amount: Number(order.amount_cny).toFixed(2),
    subject,
  };
  if (ALIPAY_NOTIFY_URL) biz.notify_url = ALIPAY_NOTIFY_URL;
  const r = await alipayCall('alipay.trade.precreate', biz);
  return r.qr_code || '';
}

// 主动查询订单支付状态:返回 trade_status 或 null(订单不存在)
export async function queryAlipayTrade(orderNo) {
  if (payProvider() !== 'alipay') return null;
  try {
    const r = await alipayCall('alipay.trade.query', { out_trade_no: orderNo });
    return r;
  } catch (e) {
    if (e.code === '40004') return null; // 交易不存在(未扫/超时关闭)
    throw e;
  }
}

// 异步通知验签(RSA2 verify 支付宝公钥);返回 {ok, params}
export function verifyAlipayNotify(params) {
  if (!publicKey()) return { ok: false, error: '未配置支付宝公钥' };
  const sign = params.sign;
  const signType = (params.sign_type || 'RSA2').toUpperCase();
  if (!sign) return { ok: false, error: '缺少签名' };
  const copy = { ...params };
  delete copy.sign;
  delete copy.sign_type;
  const content = Object.keys(copy)
    .filter((k) => copy[k] !== undefined && copy[k] !== null && copy[k] !== '')
    .sort()
    .map((k) => `${k}=${copy[k]}`)
    .join('&');
  const verify = createVerify(signType === 'RSA2' ? 'RSA-SHA256' : 'RSA-SHA1');
  verify.update(content, 'utf8');
  verify.end();
  if (!verify.verify(publicKey(), sign, 'base64')) return { ok: false, error: '验签失败' };
  if (copy.app_id && copy.app_id !== ALIPAY_APP_ID) return { ok: false, error: 'app_id 不匹配' };
  return { ok: true, params: copy };
}

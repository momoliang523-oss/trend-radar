// 工具:网络抓取(fetch→curl 代理回退)、日期(一律本地时区)、随机、XML 解析
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UA } from './config.js';

const execFileP = promisify(execFile);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---------- 本地日期(系统时区 CST,禁用 toISOString 取日期) ----------

export function fmtLocalDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr() {
  return fmtLocalDate(new Date());
}

// dateStr: 'YYYY-MM-DD' → n 天后(本地日历运算)
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return fmtLocalDate(dt);
}

// 字符级模糊匹配:查询词中任一字出现在任一文本里即计 1 分(不要求整词/连续出现),
// 命中字数越多分越高。例:「保温杯」→ 标题含「杯」字即命中。
export function charFuzzyScore(q, ...texts) {
  const chars = [...new Set(String(q || '').replace(/[\s\-_·.,!！?？:：;；'"“”‘’()（）]/g, '').toLowerCase())];
  if (!chars.length) return 0;
  let n = 0;
  for (const ch of chars) {
    if (texts.some((t) => String(t || '').toLowerCase().includes(ch))) n++;
  }
  return n;
}

// 所在周(周一为一周起点)的周一日期
export function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = (dt.getDay() + 6) % 7; // 周一=0
  return fmtLocalDate(new Date(y, m - 1, d - wd));
}

export function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

// 相对时间:ISO 时间 → 「6 小时前」
export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (Number.isNaN(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return fmtLocalDate(new Date(t));
}

// ---------- 网络 ----------

// fetch 优先;网络错误且设置了代理环境变量时回退 curl(curl 自动走 https_proxy)
export async function fetchText(url, { headers = {}, timeoutMs = 25000, proxyFallback = true } = {}) {
  const h = { 'user-agent': UA, ...headers };
  try {
    const res = await fetch(url, {
      headers: h,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (e) {
    const hasProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
    if (proxyFallback && hasProxy && !e.status) {
      try {
        const { stdout } = await execFileP(
          'curl',
          ['-sL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', UA, url],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        );
        if (stdout) return stdout;
      } catch {
        /* curl 也失败则抛原错误 */
      }
    }
    throw e;
  }
}

// ---------- 确定性随机(mulberry32) ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- XML / 文本 ----------

const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return '';
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in entityMap ? entityMap[name] : m));
}

// 简单 XML 标签取值(不引入 cheerio,够用即可)
export function tagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
}

// 切分 RSS <item> 块
export function xmlItems(xml, tag = 'item') {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi');
  return (xml.match(re) || []).slice(0, 60);
}

// 生成归一化去重键
export function dedupKey(url, fallback = '') {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    return u.toString();
  } catch {
    return fallback || url;
  }
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

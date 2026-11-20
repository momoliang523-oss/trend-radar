// 账号核心逻辑:scrypt 散列、注册/登录、会话、鉴权解析、管理员/试用判定、档位→模型映射
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, nowIso } from './db.js';
import {
  ADMIN_EMAILS, POINTS_PER_SECTION, REGISTER_GIFT_POINTS, SESSION_TTL_DAYS, TIER_MODELS, TRIAL_DAYS, TRIAL_TIER,
} from './config.js';

const scrypt = promisify(scryptCb);
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;

// ---------- 密码散列(异步,避免阻塞单进程事件循环) ----------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- 会话 ----------

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = nowIso();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400e3).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now); // 懒清理过期会话
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, now, expires);
  return token;
}

export function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { ok: true };
}

// ---------- 注册 / 登录 ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function registerUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!EMAIL_RE.test(email)) return { error: '邮箱格式不正确', status: 400 };
  if (password.length < 6) return { error: '密码至少 6 位', status: 400 };
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return { error: '该邮箱已注册,请直接登录', status: 409 };

  const passHash = await hashPassword(password);
  const now = nowIso();
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400e3).toISOString();
  const r = db
    .prepare('INSERT INTO users (email, pass_hash, tier, credits, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, passHash, 'free', REGISTER_GIFT_POINTS, trialEnds, now);
  const userId = Number(r.lastInsertRowid);

  // 注册赠送流水
  db.prepare('INSERT INTO credit_logs (user_id, delta, balance_after, type, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, REGISTER_GIFT_POINTS, REGISTER_GIFT_POINTS, 'register_gift', `user:${userId}`, now);

  const token = createSession(userId);
  return { ok: true, token, user: publicUser(userById(userId)) };
}

export async function loginUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // 统一错误文案,不泄露「邮箱存在但密码错」
  if (!row || !(await verifyPassword(password, row.pass_hash))) {
    return { error: '邮箱或密码错误', status: 401 };
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  const token = createSession(row.id);
  return { ok: true, token, user: publicUser(row) };
}

// ---------- 查询与判定 ----------

export function userById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase()) || null;
}

// 试用是否生效(每次调用现算,不用登录快照)
export function isTrialActive(user) {
  return !!(user?.trial_ends_at && nowIso() < user.trial_ends_at);
}

// 时长卡是否生效(plan_ends_at 在将来;空串视为无卡)
export function isPlanActive(user) {
  return !!(user?.plan_ends_at && nowIso() < user.plan_ends_at);
}

// 管理员判定:环境变量现算,不落库(变更即时生效)
export function isAdmin(user) {
  return !!(user?.email && ADMIN_EMAILS.includes(String(user.email).toLowerCase()));
}

// 有效档位:试用期内恒为 TRIAL_TIER;时长卡生效期内为卡档位;否则自选档位
export function effectiveTier(user) {
  if (isTrialActive(user)) return TRIAL_TIER;
  if (isPlanActive(user)) return user.plan_tier || 'mid';
  return user?.tier || 'free';
}

export function modelForUser(user) {
  return TIER_MODELS[effectiveTier(user)] || TIER_MODELS.free;
}

// 该用户当前每次分区生成消耗的积分(试用期 / 时长卡期 0)
export function costForUser(user) {
  if (isTrialActive(user) || isPlanActive(user)) return 0;
  return POINTS_PER_SECTION[user?.tier] ?? POINTS_PER_SECTION.free;
}

// 对外用户对象:不含 hash,含现算字段
export function publicUser(user) {
  return {
    email: user.email,
    tier: user.tier,
    credits: user.credits,
    trial_ends_at: user.trial_ends_at || '',
    trial_active: isTrialActive(user),
    trial_tier: TRIAL_TIER,
    plan_ends_at: user.plan_ends_at || '',
    plan_active: isPlanActive(user),
    plan_tier: user.plan_tier || '',
    is_admin: isAdmin(user),
    created_at: user.created_at,
  };
}

// 解析 Authorization: Bearer <token> → {user, token} | null
export function authFromReq(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const row = db
    .prepare(`SELECT u.id, u.email, u.tier, u.credits, u.trial_ends_at, u.plan_ends_at, u.plan_tier, u.created_at, s.expires_at
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
    .get(token);
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const { expires_at, ...user } = row;
  return { user, token };
}

// 修改档位
export function setTier(userId, tier) {
  if (!['free', 'mid', 'high'].includes(tier)) return { error: '未知档位', status: 400 };
  db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
  return { ok: true, tier };
}

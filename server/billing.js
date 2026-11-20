// 计费逻辑:积分包/自定义充值/时长套餐、充值订单(支付自动到账 + 管理员人工兜底)、原子扣分、流水
import { randomBytes } from 'node:crypto';
import { db, nowIso } from './db.js';
import { costForUser, isPlanActive, isTrialActive } from './auth.js';
import { CUSTOM_MAX_AMOUNT, CUSTOM_MIN_AMOUNT, POINTS_PER_YUAN } from './config.js';
import { payProvider } from './payment.js';

// 积分包(固定金额 → 固定积分)
export const POINT_PACKS = [
  { id: 'p100', type: 'points', points: 100, amount_cny: 9.9, label: '100 积分' },
  { id: 'p300', type: 'points', points: 300, amount_cny: 26.9, label: '300 积分' },
  { id: 'p1000', type: 'points', points: 1000, amount_cny: 79.9, label: '1000 积分' },
];

// 时长套餐(固定金额 → N 天会员不限次;档位对客户隐藏)
export const PLAN_PACKS = [
  { id: 'd30', type: 'plan', plan_days: 30, plan_tier: 'mid', amount_cny: 9.9, label: '30 天不限次' },
  { id: 'd90', type: 'plan', plan_days: 90, plan_tier: 'mid', amount_cny: 26.9, label: '90 天不限次' },
  { id: 'd365', type: 'plan', plan_days: 365, plan_tier: 'mid', amount_cny: 79.9, label: '365 天不限次' },
];

export const ALL_PACKS = [...POINT_PACKS, ...PLAN_PACKS];

// 自定义充值规则(前端 /api/packs 展示用)
export function customRechargeRule() {
  return { min_amount: CUSTOM_MIN_AMOUNT, max_amount: CUSTOM_MAX_AMOUNT, points_per_yuan: POINTS_PER_YUAN };
}

export function packLabel(packId, points) {
  const p = ALL_PACKS.find((x) => x.id === packId);
  if (p) return p.label;
  return packId === 'custom' ? `自定义充值 ${points} 积分` : packId;
}

// ---------- 余额与流水 ----------

export function currentBalance(userId) {
  const r = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
  return r ? r.credits : 0;
}

export function creditLogs(userId, limit = 50) {
  return db
    .prepare('SELECT id, delta, balance_after, type, ref, created_at FROM credit_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
}

// 余额预检:试用/时长卡生效期恒通过;否则余额不足返回 402 语义
export function precheckCredits(user, units) {
  if (isTrialActive(user) || isPlanActive(user)) return { ok: true };
  const cost = costForUser(user);
  if (user.credits < cost * units) {
    return { ok: false, code: 'insufficient_credits', error: '积分不足,请到「我的」充值', credits: user.credits };
  }
  return { ok: true, cost, units };
}

// 原子扣分(试用/免费档 0 成本时不写负流水)
export function chargeSection(userId, cost, type, ref) {
  if (cost <= 0) return { ok: true, free: true, balance: currentBalance(userId) };
  const r = db
    .prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
    .run(cost, userId, cost);
  if (Number(r.changes) === 0) return { ok: false, insufficient: true };
  const balance = currentBalance(userId);
  db.prepare('INSERT INTO credit_logs (user_id, delta, balance_after, type, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, -cost, balance, type, ref, nowIso());
  return { ok: true, balance };
}

// ---------- 充值订单(支付自动到账;管理员确认仅作兜底) ----------

function genOrderNo() {
  const d = nowIso().slice(0, 10).replace(/-/g, '');
  return `R${d}-${randomBytes(4).toString('hex')}`;
}

// 下单:{packId} 固定包/时长卡,或 {amountCny} 自定义金额(→ 积分)
export function createOrder(userId, { packId = '', amountCny = null } = {}) {
  let pack = null;
  let points = 0;
  let planDays = 0;
  let planTier = '';
  let amount = 0;
  let id = 'custom';

  if (packId) {
    pack = ALL_PACKS.find((p) => p.id === packId);
    if (!pack) return { error: '未知充值包', status: 400 };
    id = pack.id;
    amount = pack.amount_cny;
    if (pack.type === 'points') points = pack.points;
    else {
      planDays = pack.plan_days;
      planTier = pack.plan_tier;
    }
  } else if (amountCny != null) {
    amount = Number(amountCny);
    // 自定义充值只允许整数金额(产品要求:没有小数点)
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < CUSTOM_MIN_AMOUNT || amount > CUSTOM_MAX_AMOUNT) {
      return { error: `自定义金额需为 ${CUSTOM_MIN_AMOUNT} ~ ${CUSTOM_MAX_AMOUNT} 元的整数`, status: 400 };
    }
    points = Math.floor(amount * POINTS_PER_YUAN);
    if (points < 1) return { error: '金额过小,兑换积分不足 1 分', status: 400 };
  } else {
    return { error: '请选择充值包或输入金额', status: 400 };
  }

  const channel = payProvider(); // alipay | mock
  const order = {
    order_no: genOrderNo(),
    user_id: userId,
    pack_id: id,
    points,
    amount_cny: amount,
    status: 'pending',
    plan_days: planDays,
    plan_tier: planTier,
    channel,
    created_at: nowIso(),
  };
  const insert = () => db.prepare(
    `INSERT INTO orders (order_no, user_id, pack_id, points, amount_cny, status, plan_days, plan_tier, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(order.order_no, order.user_id, order.pack_id, order.points, order.amount_cny, order.status,
    order.plan_days, order.plan_tier, order.channel, order.created_at);
  try {
    insert();
  } catch (e) {
    // order_no 撞车(概率极低):重试一次
    order.order_no = genOrderNo();
    insert();
  }
  const row = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(order.order_no);
  return { ok: true, order: row };
}

export function listUserOrders(userId) {
  return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId);
}

export function listAdminOrders(status = '') {
  const rows = status
    ? db.prepare(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.id DESC LIMIT 100`).all(status)
    : db.prepare(`SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100`).all();
  return rows;
}

export function getOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) || null;
}

// 取消未支付订单(如支付宝预下单失败)
export function cancelOrder(orderId) {
  db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(orderId);
}

export function getOrderByNo(orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo) || null;
}

// 内部结算(幂等事务):pending→paid;积分包加积分,时长卡叠加 plan_ends_at
function settleOrder(row, confirmedBy) {
  const now = nowIso();
  db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, confirmed_by = ? WHERE id = ? AND status = 'pending'`)
    .run(now, confirmedBy, row.id);

  const balance = currentBalance(row.user_id);
  if (row.plan_days > 0) {
    // 时长卡:在「当前生效截止」上顺延(当前无卡则从今天起算)
    const u = db.prepare('SELECT plan_ends_at FROM users WHERE id = ?').get(row.user_id);
    const base = u?.plan_ends_at && nowIso() < u.plan_ends_at
      ? new Date(u.plan_ends_at).getTime()
      : Date.now();
    const newEnds = new Date(base + row.plan_days * 86400e3).toISOString();
    db.prepare('UPDATE users SET plan_ends_at = ?, plan_tier = ? WHERE id = ?')
      .run(newEnds, row.plan_tier || 'mid', row.user_id);
    db.prepare('INSERT INTO credit_logs (user_id, delta, balance_after, type, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.user_id, 0, balance, 'recharge_plan', `order:${row.order_no}`, now);
    return { ok: true, order: { ...row, status: 'paid', paid_at: now, confirmed_by: confirmedBy }, credits: balance, plan_ends_at: newEnds };
  }
  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(row.points, row.user_id);
  const newBalance = currentBalance(row.user_id);
  db.prepare('INSERT INTO credit_logs (user_id, delta, balance_after, type, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.user_id, row.points, newBalance, 'recharge', `order:${row.order_no}`, now);
  return { ok: true, order: { ...row, status: 'paid', paid_at: now, confirmed_by: confirmedBy }, credits: newBalance, plan_ends_at: '' };
}

// 支付到账结算:支付宝回调/轮询查询/模拟支付共用;重复调用幂等(already)
export function settlePaymentOrder(orderId, channel) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!row) {
      db.exec('ROLLBACK');
      return { error: '订单不存在', status: 404 };
    }
    if (row.status === 'paid') {
      db.exec('ROLLBACK');
      return { ok: true, already: true, order: row, credits: currentBalance(row.user_id) };
    }
    if (row.status === 'cancelled') {
      db.exec('ROLLBACK');
      return { error: '订单已取消', status: 400 };
    }
    const r = settleOrder(row, `payment:${channel || row.channel || ''}`);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 管理员人工确认收款(兜底,幂等):pending→paid + 加积分/叠加时长
export function confirmOrder(orderId, adminEmail) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!row) {
      db.exec('ROLLBACK');
      return { error: '订单不存在', status: 404 };
    }
    if (row.status === 'paid') {
      db.exec('ROLLBACK');
      return { ok: true, already: true, order: row, credits: currentBalance(row.user_id) };
    }
    if (row.status === 'cancelled') {
      db.exec('ROLLBACK');
      return { error: '订单已取消,不能确认', status: 400 };
    }
    const r = settleOrder(row, adminEmail || '');
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

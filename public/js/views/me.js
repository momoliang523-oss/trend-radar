// 我的:未登录=邮箱登录/注册;已登录=会员中心(积分/试用/充值/订单/明细)+ 管理员运营区(会员档位对客户隐藏)
import { el, timeAgo } from '../fmt.js';
import { getJSON, postJSON } from '../api.js';
import { store, setAuth, clearAuth, updateUser, saveProfile, isLoggedIn } from '../store.js';
import { toast } from '../components/toast.js';

const TYPE_LABELS = {
  register_gift: '注册赠送',
  recharge: '充值到账',
  recharge_plan: '时长卡到账',
  extend: '延伸分析',
  analyze: '深度分析',
  report: '趋势报告',
  category: '类目分析',
};

const STATUS_LABELS = { pending: '待支付', paid: '已到账', cancelled: '已取消' };

// 支付弹层轮询间隔(毫秒)
const PAY_POLL_MS = 2500;

const SELLER_PLATFORMS = ['SHEIN', 'Temu', 'TikTok Shop', '美客多', 'Amazon', 'Shopee'].map((v) => ({ value: v, label: v }));
const PROFILE_CATEGORIES = ['美妆个护', '3C数码', '家居', '服饰', '母婴宠物', '食品', '运动户外', '其他'].map((v) => ({ value: v, label: v }));

let trialTimer = null;

export default {
  async render(mount) {
    const page = el('div', { class: 'page', style: 'padding-top:12px' });
    const root = el('div', { id: 'me-root' });
    page.append(root);
    mount.append(page);
    renderAll(root);
  },

  destroy() {
    if (trialTimer) {
      clearInterval(trialTimer);
      trialTimer = null;
    }
    closePayModal();
  },
};

function renderAll(root) {
  root.innerHTML = '';
  if (isLoggedIn()) renderMe(root);
  else renderAuth(root);
}

// ---------- 登录 / 注册 ----------

function renderAuth(root) {
  const mode = { v: 'login' }; // login | register
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'set-group auth-card' });
  const tabs = el('div', { class: 'ap-seg' });
  const email = el('input', { class: 'fb-input', type: 'email', placeholder: '邮箱(用于登录与充值通知)' });
  const password = el('input', { class: 'fb-input', type: 'password', placeholder: '密码(至少 6 位)' });
  const submit = el('button', { class: 'go-btn', text: '登 录' });
  const err = el('div', { class: 'auth-error' });

  const rerender = () => {
    tabs.innerHTML = '';
    for (const t of [
      { value: 'login', label: '登录' },
      { value: 'register', label: '注册' },
    ]) {
      tabs.append(
        el('button', {
          class: `ap-seg-btn${mode.v === t.value ? ' on' : ''}`,
          text: t.label,
          onclick: () => {
            mode.v = t.value;
            submit.textContent = mode.v === 'login' ? '登 录' : '注册并领取福利';
            rerender();
          },
        })
      );
    }
  };
  rerender();

  submit.addEventListener('click', async () => {
    const em = email.value.trim();
    const pw = password.value;
    if (!em || !pw) {
      toast('请填写邮箱和密码', 'info');
      return;
    }
    submit.disabled = true;
    try {
      const d = mode.v === 'login'
        ? await postJSON('/api/auth/login', { email: em, password: pw })
        : await postJSON('/api/auth/register', { email: em, password: pw });
      setAuth(d);
      toast(mode.v === 'login' ? '欢迎回来 👋' : '🎉 注册成功:已赠送 100 积分 + 7 天免费试用');
      renderAll(root);
    } catch (e) {
      toast(e.message, 'err');
      submit.disabled = false;
    }
  });

  card.append(
    el('div', { class: 'me-hero' }, [
      el('div', { class: 'me-logo', text: '📡' }),
      el('div', { class: 'me-title', text: '出海热点雷达' }),
      el('div', { class: 'me-sub', text: '登录后即可使用延伸分析 · 深度报告' }),
    ]),
    tabs,
    el('div', { class: 'fb-label', text: '邮箱' }),
    email,
    el('div', { class: 'fb-label', text: '密码' }),
    password,
    err,
    el('div', { class: 'fb-actions' }, [submit]),
    el('div', { class: 'me-gift', text: '🎁 新用户注册即送 100 积分 + 7 天免费试用(不限次数、不扣积分)' }),
  );
  wrap.append(card);
  root.append(wrap);
}

// ---------- 会员中心 ----------

function renderMe(root) {
  const user = store.auth.user;
  root.append(renderAccountCard(user));
  const profileEl = el('div');
  const packsEl = el('div');
  const ordersEl = el('div');
  const logsEl = el('div');
  const opsEl = el('div');
  const adminOrdersEl = el('div');
  const dataEl = el('div');
  root.append(profileEl, packsEl, ordersEl, logsEl, opsEl, adminOrdersEl, dataEl);

  renderProfile(profileEl);
  renderPacks(packsEl, ordersEl);
  renderOrders(ordersEl);
  renderLogs(logsEl);
  if (user.is_admin) {
    renderOps(opsEl);
    renderAdminOrders(adminOrdersEl);
    renderDataButtons(dataEl);
  }

  // 试用 / 时长卡倒计时(每秒刷新;到期自动刷新用户状态)
  if (user.trial_active || user.plan_active) {
    const cd = root.querySelector('.trial-countdown');
    const pcd = root.querySelector('.plan-countdown');
    if (trialTimer) clearInterval(trialTimer);
    trialTimer = setInterval(async () => {
      let expired = false;
      if (cd && user.trial_active) {
        const left = new Date(user.trial_ends_at).getTime() - Date.now();
        cd.textContent = left > 0 ? `试用剩余 ${fmtCountdown(left)}` : '试用已结束';
        if (left <= 0) expired = true;
      }
      if (pcd && user.plan_active) {
        const left = new Date(user.plan_ends_at).getTime() - Date.now();
        pcd.textContent = left > 0 ? `时长卡剩余 ${fmtCountdown(left)}` : '时长卡已到期';
        if (left <= 0) expired = true;
      }
      if (expired) {
        clearInterval(trialTimer);
        trialTimer = null;
        try {
          const d = await getJSON('/api/me');
          updateUser(d.user);
          renderAll(root);
        } catch {
          /* 忽略 */
        }
      }
    }, 1000);
  }
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d} 天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function renderAccountCard(user) {
  const card = el('div', { class: 'set-group me-hero' });
  const trialBadge = user.trial_active
    ? el('span', { class: 'badge conf 高', text: '🎁 试用中 · 不限次' })
    : null;
  const planBadge = user.plan_active
    ? el('span', { class: 'badge tier 高兴趣', text: '👑 时长卡 · 不限次' })
    : null;
  card.append(
    el('div', { class: 'me-row' }, [
      el('div', { class: 'me-logo', text: '👤' }),
      el('div', { class: 'me-info' }, [
        el('div', { class: 'me-title', text: user.email }),
        el('div', { class: 'me-sub', text: `注册于 ${String(user.created_at || '').slice(0, 10)}` }),
      ]),
      el('button', { class: 'fb-cancel', style: 'flex:0;padding:6px 12px;font-size:12.5px', text: '退出登录', onclick: doLogout }),
    ]),
    el('div', { class: 'me-credits' }, [
      el('span', { class: 'me-credits-num', text: String(user.credits) }),
      el('span', { class: 'me-credits-label', text: '积分' }),
    ]),
    el('div', { class: 'me-credits-meta' }, [
      trialBadge,
      planBadge,
      user.trial_active && user.trial_ends_at
        ? el('span', { class: 'trial-countdown', text: '' })
        : null,
      user.plan_active && user.plan_ends_at
        ? el('span', { class: 'plan-countdown', text: '' })
        : null,
      user.is_admin ? el('span', { class: 'badge tier 高兴趣', text: '👑 管理员' }) : null,
    ])
  );
  return card;
}

async function doLogout() {
  try {
    await postJSON('/api/auth/logout');
  } catch {
    /* token 失效也照常清理本地 */
  }
  clearAuth();
  toast('已退出登录');
  const root = document.getElementById('me-root');
  if (root) renderAll(root);
}

// ---------- 充值(积分包 / 自定义金额 / 时长套餐)+ 支付弹层 ----------

function renderPacks(root, ordersEl) {
  const card = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '💎 充值中心' })]);
  const note = el('div', { class: 'me-note', text: '支付宝扫码支付,支付成功后自动到账,无需人工确认。' });
  card.append(note);
  root.append(card);
  getJSON('/api/packs')
    .then((d) => {
      if (d.provider === 'offline') {
        note.text = '支持支付宝/微信转账充值:转账后管理员确认收款,积分立即到账。';
      }
      // ① 积分包
      // ① 积分包
      card.append(el('div', { class: 'set-sub', text: '积分包' }));
      const row = el('div', { class: 'pack-row' });
      for (const p of d.points) {
        row.append(
          el('div', { class: 'pack-card' }, [
            el('div', { class: 'pack-points', text: `${p.points} 分` }),
            el('div', { class: 'pack-price', text: `¥${p.amount_cny}` }),
            buyBtn(p.amount_cny, () => createPayOrder({ pack_id: p.id }, ordersEl)),
          ])
        );
      }
      card.append(row);

      // ② 自定义金额(整数金额 → 按 1 元 = N 积分换算)
      const rule = d.custom || {};
      card.append(el('div', { class: 'set-sub', text: `自定义充值(整数金额 · 1 元 = ${rule.points_per_yuan ?? '—'} 积分)` }));
      const customRow = el('div', { class: 'pack-row custom-row' });
      const input = el('input', {
        class: 'fb-input pay-amount-input',
        type: 'number',
        min: String(rule.min_amount ?? 1),
        max: String(rule.max_amount ?? 5000),
        step: '1',
        placeholder: `输入 ${rule.min_amount ?? 1} ~ ${rule.max_amount ?? 5000} 元整数`,
      });
      const preview = el('div', { class: 'pack-points', text: '= 0 分' });
      input.addEventListener('input', () => {
        const n = Number(input.value);
        preview.textContent = Number.isInteger(n) && n > 0 ? `= ${n * (rule.points_per_yuan || 10)} 分` : '= 0 分';
      });
      customRow.append(
        el('div', { class: 'pack-card pack-card-wide' }, [
          input,
          preview,
          buyBtn(0, () => {
            const n = Number(input.value);
            if (!Number.isInteger(n) || n < (rule.min_amount ?? 1)) {
              toast(`请输入 ${rule.min_amount ?? 1} ~ ${rule.max_amount ?? 5000} 元的整数金额`, 'info');
              return;
            }
            createPayOrder({ amount_cny: n }, ordersEl);
          }, '立即充值'),
        ])
      );
      card.append(customRow);

      // ③ 时长套餐(期限内不限次数、不扣积分)
      card.append(el('div', { class: 'set-sub', text: '时长套餐(期限内不限次数、不扣积分)' }));
      const planRow = el('div', { class: 'pack-row' });
      for (const p of d.plans) {
        planRow.append(
          el('div', { class: 'pack-card' }, [
            el('div', { class: 'pack-points', text: `${p.plan_days} 天` }),
            el('div', { class: 'pack-price', text: `¥${p.amount_cny}` }),
            buyBtn(p.amount_cny, () => createPayOrder({ pack_id: p.id }, ordersEl), '立即开通'),
          ])
        );
      }
      card.append(planRow);
    })
    .catch((e) => {
      card.append(el('div', { class: 'set-row' }, [el('span', { class: 'v na', text: e.message || '加载失败' })]));
    });
}

function buyBtn(amount, onclick, label = '立即购买') {
  const btn = el('button', { class: 'pack-btn', text: label });
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await onclick();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// 下单 → 打开支付弹层(二维码 + 轮询到账)
async function createPayOrder(payload, ordersEl) {
  try {
    const d = await postJSON('/api/me/orders', payload);
    if (ordersEl) renderOrders(ordersEl);
    openPayModal(d);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- 支付弹层 ----------

let payState = null; // {order, qr_code, provider, mask, timer, closed}

function openPayModal(d) {
  closePayModal();
  const order = d.order;
  const planLabel = order.plan_days > 0 ? `${order.plan_days} 天不限次` : `${order.points} 积分`;
  const title = order.plan_days > 0 ? '时长卡支付' : '积分充值';

  const mask = el('div', { class: 'pay-mask' });
  const sheet = el('div', { class: 'pay-sheet' });
  const qrBox = el('div', { class: 'pay-qr-box' });
  const status = el('div', {
    class: 'pay-status',
    text: d.provider === 'mock' ? '本地模拟模式' : d.provider === 'offline' ? '等待转账确认…' : '等待支付…',
  });

  if (d.provider === 'alipay' && d.qr_code) {
    // qrcode-generator(vendor 单文件):typeNumber 0 = 自动;SVG 矢量输出
    const q = globalThis.qrcode(0, 'M');
    q.addData(d.qr_code);
    q.make();
    const qrWrap = el('div', { class: 'pay-qr-img' });
    qrWrap.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    qrBox.append(qrWrap);
  } else if (d.provider === 'offline') {
    // 线下转账:展示收款信息(服务器配置的多行文本),等管理员确认到账
    const info = el('div', { class: 'pay-offline-info' });
    for (const line of String(d.pay_info || '请直接联系客服获取收款账号').split('\n')) {
      const t = line.trim();
      if (t) info.append(el('div', { class: 'pay-offline-line', text: t }));
    }
    qrBox.append(info);
  } else {
    qrBox.append(el('div', { class: 'pay-qr-placeholder', text: '🧾' }));
  }

  const actions = el('div', { class: 'pay-actions' });
  if (d.provider === 'alipay' && d.qr_code) {
    actions.append(
      el('a', { class: 'pay-link', href: d.qr_code, target: '_blank', rel: 'noopener noreferrer', text: '📱 在支付宝 App 中打开支付' })
    );
  } else if (d.provider === 'offline') {
    actions.append(
      el('div', { class: 'pay-offline-hint', text: '转账时请备注订单号 · 到账后管理员确认,积分自动入账' })
    );
  } else {
    actions.append(
      el('button', { class: 'go-btn', text: '💵 模拟支付(点击即到账)', onclick: startMockPay })
    );
  }

  sheet.append(
    el('div', { class: 'pay-title', text: `💰 ${title}` }),
    el('div', { class: 'pay-amount', text: `¥${Number(order.amount_cny).toFixed(2)}` }),
    el('div', { class: 'pay-sub', text: `${planLabel} · 订单号 ${order.order_no}` }),
    qrBox,
    status,
    actions,
    el('button', { class: 'pay-close', text: '关闭', onclick: closePayModal })
  );
  mask.append(sheet);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closePayModal();
  });
  document.body.append(mask);

  payState = { order, provider: d.provider, mask, sheet, timer: null, closed: false };
  // 轮询订单状态(alipay:服务端向支付宝查询并自动结算;offline:等管理员确认收款)
  if (d.provider === 'alipay' || d.provider === 'offline') {
    payState.timer = setInterval(() => pollPayStatus(), PAY_POLL_MS);
  }
}

async function startMockPay() {
  if (!payState) return;
  try {
    const r = await postJSON('/api/pay/mock/pay', { id: payState.order.id });
    onPayPaid(r);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function pollPayStatus() {
  if (!payState || payState.closed) return;
  try {
    const d = await getJSON(`/api/me/orders/${payState.order.id}/status`);
    if (d.status === 'paid') {
      onPayPaid(d);
    }
  } catch {
    /* 网络抖动忽略,下轮再试 */
  }
}

function onPayPaid(d) {
  if (!payState || payState.closed) return;
  const wasPlan = payState.order.plan_days > 0;
  closePayModal();
  if (wasPlan) {
    toast(`✅ 支付成功:时长卡已生效,有效期至 ${String(d.plan_ends_at || '').slice(0, 10)}`);
  } else {
    toast(d.credits != null ? `✅ 支付成功:积分已到账(余额 ${d.credits})` : '✅ 支付成功:积分已到账');
  }
  const root = document.getElementById('me-root');
  if (root) {
    // 刷新用户状态(积分/时长卡)+ 订单列表
    getJSON('/api/me')
      .then((u) => {
        updateUser(u.user);
        renderAll(root);
      })
      .catch(() => renderAll(root));
  }
}

function closePayModal() {
  if (payState) {
    if (payState.timer) clearInterval(payState.timer);
    payState.mask?.remove();
    payState = null;
  }
}

function renderOrders(root) {
  if (!root) return;
  root.innerHTML = '';
  const card = el('div', { class: 'set-group orders-group' }, [el('div', { class: 'set-title', text: '🧾 我的订单' })]);
  card.append(el('div', { class: 'sk-line w90 skeleton' }));
  root.append(card);
  getJSON('/api/me/orders')
    .then((d) => {
      card.innerHTML = '';
      card.append(el('div', { class: 'set-title', text: '🧾 我的订单' }));
      if (!d.items.length) {
        card.append(el('div', { class: 'mini-empty', text: '暂无订单' }));
        return;
      }
      for (const o of d.items) {
        const itemLabel = o.plan_days > 0 ? `${o.plan_days} 天时长卡` : `${o.points} 分`;
        card.append(
          el('div', { class: 'set-row' }, [
            el('span', { class: 'k', text: `${itemLabel} · ${o.order_no}` }),
            el('span', { class: `v ${o.status === 'paid' ? 'ok' : o.status === 'cancelled' ? 'na' : ''}`, text: `${STATUS_LABELS[o.status] || o.status} · ¥${o.amount_cny}` }),
          ])
        );
      }
    })
    .catch((e) => {
      card.innerHTML = '';
      card.append(el('div', { class: 'set-title', text: '🧾 我的订单' }));
      card.append(el('div', { class: 'set-row' }, [el('span', { class: 'v na', text: e.message || '加载失败' })]));
    });
}

function renderLogs(root) {
  root.innerHTML = '';
  const card = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '📒 积分明细' })]);
  card.append(el('div', { class: 'sk-line w90 skeleton' }));
  root.append(card);
  getJSON('/api/me/credits/logs')
    .then((d) => {
      card.innerHTML = '';
      card.append(el('div', { class: 'set-title', text: '📒 积分明细' }));
      if (!d.items.length) {
        card.append(el('div', { class: 'mini-empty', text: '暂无流水' }));
        return;
      }
      for (const l of d.items.slice(0, 20)) {
        card.append(
          el('div', { class: 'set-row' }, [
            el('span', { class: 'k', text: `${TYPE_LABELS[l.type] || l.type} · ${timeAgo(l.created_at)}` }),
            el('span', { class: `v ${l.delta > 0 ? 'ok' : ''}`, text: `${l.delta > 0 ? '+' : ''}${l.delta} 分(余额 ${l.balance_after})` }),
          ])
        );
      }
    })
    .catch((e) => {
      card.innerHTML = '';
      card.append(el('div', { class: 'set-title', text: '📒 积分明细' }));
      card.append(el('div', { class: 'set-row' }, [el('span', { class: 'v na', text: e.message || '加载失败' })]));
    });
}

// ---------- 我的店铺 / 偏好(影响选品建议贴合度) ----------

function multiChips(options, selected, onToggle) {
  const row = el('div', { class: 'chip-row' });
  for (const opt of options) {
    const on = selected.includes(opt.value);
    row.append(
      el('button', {
        class: `chip${on ? ' selected' : ''}`,
        text: opt.label,
        onclick: () => onToggle(opt.value),
      })
    );
  }
  return row;
}

function renderProfile(container) {
  container.innerHTML = '';
  const group = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '我的店铺 / 偏好' })]);
  group.append(el('div', { class: 'set-sub', text: '卖家平台(影响选品建议的贴合度)' }));
  group.append(
    multiChips(SELLER_PLATFORMS, store.profile.platforms, (v) => {
      const arr = store.profile.platforms.includes(v) ? store.profile.platforms.filter((x) => x !== v) : [...store.profile.platforms, v];
      saveProfile({ ...store.profile, platforms: arr });
      renderProfile(container);
    })
  );
  group.append(el('div', { class: 'set-sub', text: '主营类目(用于日历「只看我的」快捷筛选)' }));
  group.append(
    multiChips(PROFILE_CATEGORIES, store.profile.categories, (v) => {
      const arr = store.profile.categories.includes(v) ? store.profile.categories.filter((x) => x !== v) : [...store.profile.categories, v];
      saveProfile({ ...store.profile, categories: arr });
      renderProfile(container);
    })
  );
  container.append(group);
}

// ---------- 管理员区 ----------

function renderOps(container) {
  container.innerHTML = '';
  const group = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '👑 运营数据' })]);
  group.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }));
  container.append(group);
  getJSON('/api/stats')
    .then((s) => {
      group.innerHTML = '';
      group.append(el('div', { class: 'set-title', text: '👑 运营数据' }));
      const o = s.ops || {};
      group.append(
        el('div', { class: 'set-row' }, [
          el('span', { class: 'k', text: '数据量' }),
          el('span', { class: 'v', text: `${o.counts?.signals ?? '—'} 信号 · ${o.counts?.hotspots ?? '—'} 热点 · ${o.counts?.users ?? '—'} 用户 · ${o.counts?.extends ?? '—'} 延伸` }),
        ]),
        el('div', { class: 'set-row' }, [
          el('span', { class: 'k', text: '上次采集' }),
          el('span', { class: 'v', text: o.last_collect ? new Date(o.last_collect).toLocaleString('zh-CN') : '尚未采集' }),
        ]),
        el('div', { class: 'set-row' }, [
          el('span', { class: 'k', text: '平均停留' }),
          el('span', { class: 'v', text: `${s.dwell.avgSeconds} 秒/次 · 共 ${s.dwell.totalVisits} 次` }),
        ]),
        el('div', { class: 'set-row' }, [
          el('span', { class: 'k', text: '客户反馈' }),
          el('span', { class: 'v', text: `${s.feedback.count} 条 · 平均 ${s.feedback.avgRating || '—'}★` }),
        ]),
        el('div', { class: 'set-row' }, [
          el('span', { class: 'k', text: '待确认订单' }),
          el('span', { class: 'v', text: `${o.counts?.orders_pending ?? '—'} 笔` }),
        ])
      );
      const blockedIds = Object.keys(o.errors || {}).filter((k) => o.errors[k]);
      if (blockedIds.length) {
        group.append(
          el('div', { class: 'set-row' }, [
            el('span', { class: 'k', text: '源不可达' }),
            el('span', { class: 'v err', text: blockedIds.join('、') }),
          ])
        );
      }
      if (Array.isArray(o.providers) && o.providers.length) {
        for (const p of o.providers) {
          let v;
          if (p.reachable === true) v = el('span', { class: 'v ok', text: '✅ 可用' });
          else if (p.reachable === false) v = el('span', { class: 'v err', text: `❌ ${p.last_error || '调用失败'}` });
          else v = el('span', { class: 'v na', text: '未使用' });
          group.append(el('div', { class: 'set-row' }, [
            el('span', { class: 'k', text: p.id }),
            v,
          ]));
        }
      }
    })
    .catch((e) => {
      group.innerHTML = '';
      group.append(el('div', { class: 'set-title', text: '👑 运营数据' }));
      group.append(el('div', { class: 'set-row' }, [el('span', { class: 'v na', text: e.message || '加载失败' })]));
    });
}

function renderAdminOrders(container) {
  container.innerHTML = '';
  const group = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '💰 充值订单(确认收款)' })]);
  group.append(el('div', { class: 'sk-line w90 skeleton' }));
  container.append(group);
  getJSON('/api/admin/orders?status=pending')
    .then((d) => {
      group.innerHTML = '';
      group.append(el('div', { class: 'set-title', text: '💰 充值订单(确认收款)' }));
      if (!d.items.length) {
        group.append(el('div', { class: 'mini-empty', text: '暂无待确认订单' }));
        return;
      }
      for (const o of d.items) {
        const itemLabel = o.plan_days > 0 ? `${o.plan_days} 天时长卡` : `${o.points} 分`;
        const btn = el('button', { class: 'action-btn primary', style: 'flex:0;padding:6px 14px;font-size:12.5px', text: '确认收款' });
        btn.addEventListener('click', async () => {
          const what = o.plan_days > 0 ? `开通 ${o.plan_days} 天时长卡` : `充值 ${o.points} 分`;
          if (!confirm(`确认收到 ${o.email} 的 ¥${o.amount_cny},${what}?`)) return;
          btn.disabled = true;
          try {
            const r = await postJSON(`/api/admin/orders/${o.id}/confirm`);
            toast(r.already ? '该订单已确认过(幂等)' : `✅ 已到账(余额 ${r.credits})`);
            renderAdminOrders(container);
          } catch (e) {
            toast(e.message, 'err');
            btn.disabled = false;
          }
        });
        group.append(
          el('div', { class: 'set-row' }, [
            el('span', { class: 'k', text: `${o.email} · ${itemLabel}` }),
            el('span', { class: 'v', text: `¥${o.amount_cny} · ${o.order_no}` }),
            btn,
          ])
        );
      }
    })
    .catch((e) => {
      group.innerHTML = '';
      group.append(el('div', { class: 'set-title', text: '💰 充值订单(确认收款)' }));
      group.append(el('div', { class: 'set-row' }, [el('span', { class: 'v na', text: e.message || '加载失败' })]));
    });
}

function renderDataButtons(container) {
  container.innerHTML = '';
  const group = el('div', { class: 'set-group' }, [el('div', { class: 'set-title', text: '🗄 数据操作' })]);
  group.append(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'action-btn primary',
        text: '🔄 手动刷新数据',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          b.textContent = '采集中…';
          try {
            await postJSON('/api/collect');
            toast('已触发采集,稍后在日历查看');
          } catch (err) {
            toast(err.message, 'err');
          }
          setTimeout(() => {
            b.disabled = false;
            b.textContent = '🔄 手动刷新数据';
          }, 3000);
        },
      }),
      el('button', {
        class: 'action-btn danger',
        text: '♻️ 重新生成演示数据',
        onclick: () => {
          if (!confirm('将清空并重新生成全部演示热点(收藏与已生成分析会一并清除),确定?')) return;
          postJSON('/api/seed/reset')
            .then((r) => toast(`演示数据已重建:${r.seeded} 条热点`))
            .catch((err) => toast(err.message, 'err'));
        },
      }),
    ])
  );
  container.append(group);
}

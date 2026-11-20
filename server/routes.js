// 路由分发:(method, path) → handler,统一 try/catch → JSON 错误;SSE 端点前置鉴权(401/402 在 writeHead 前)
import { existsSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { json, getMeta, getCalendar, getHotspots, getHotspotDetail, getFavorites, addFavorite, removeFavorite, setFavoriteLevel, getCart, addToCart, removeFromCart, triggerCollect, resetSeed } from './api.js';
import { authFromReq, costForUser, isAdmin, loginUser, logout, publicUser, registerUser, setTier } from './auth.js';
import { chargeSection, currentBalance, precheckCredits } from './billing.js';
import { GEN_DIR, IMAGE_UNITS, genChartImage } from './images.js';
import {
  POINT_PACKS, PLAN_PACKS, cancelOrder, confirmOrder, creditLogs, createOrder, customRechargeRule,
  getOrderById, getOrderByNo, listAdminOrders, listUserOrders, settlePaymentOrder,
} from './billing.js';
import { createAlipayQr, offlinePayInfo, payProvider, queryAlipayTrade, verifyAlipayNotify } from './payment.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 表单体解析(支付宝异步通知为 application/x-www-form-urlencoded)
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
import { handleExtendSSE, handleRetry, handleFeedback } from './api-extend.js';
import { handleReports, handleReportStream, handleReportCopy } from './api-report.js';
import { handleAnalyzeStream, handleAnalyzeCached } from './api-analyze.js';
import { handleCategoryStream, handleCategoryCached, handleCategoryContext, handleCategoryCopy, handleCategoryResearch, handleCategoryTrade } from './api-category.js';
import { handleTrack, handleFeedback as handleAppFeedback, getFeedback, getOpsStats } from './api-ops.js';

export async function handle(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;

  try {
    // 统一鉴权解析(需要登录/管理员的端点按需取用)
    const auth = await authFromReq(req);

    // /api/meta(不含任何 LLM 供应商信息)
    if (method === 'GET' && path === '/api/meta') return json(res, 200, await getMeta());

    // /api/calendar
    if (method === 'GET' && path === '/api/calendar') return json(res, 200, getCalendar(url));

    // /api/hotspots
    if (method === 'GET' && path === '/api/hotspots') return json(res, 200, getHotspots(url));

    // /api/hotspot/:id
    let m = path.match(/^\/api\/hotspot\/(\d+)$/);
    if (m && method === 'GET') {
      const r = getHotspotDetail(url, Number(m[1]));
      if (r.error) return json(res, r.status || 500, { error: r.error });
      return json(res, 200, r);
    }

    // /api/extend/:id (SSE,需登录)
    m = path.match(/^\/api\/extend\/(\d+)$/);
    if (m && method === 'GET') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return handleExtendSSE(req, res, Number(m[1]), auth);
    }

    // /api/extend/:id/retry(需登录)
    m = path.match(/^\/api\/extend\/(\d+)\/retry$/);
    if (m && method === 'POST') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return handleRetry(req, res, Number(m[1]), auth);
    }

    // /api/extend/:id/feedback
    m = path.match(/^\/api\/extend\/(\d+)\/feedback$/);
    if (m && method === 'POST') return handleFeedback(req, res, Number(m[1]));

    // /api/favorites
    if (method === 'GET' && path === '/api/favorites') return json(res, 200, getFavorites());
    m = path.match(/^\/api\/favorites\/(\d+)\/level$/);
    if (m && method === 'POST') {
      try {
        const body = await readBody(req);
        const r = setFavoriteLevel(Number(m[1]), String(body.level || ''));
        if (r.error) return json(res, r.status || 400, { error: r.error });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    m = path.match(/^\/api\/favorites\/(\d+)$/);
    if (m && method === 'PUT') {
      let level = '普通';
      try {
        const body = await readBody(req);
        level = String(body.level || '普通');
      } catch {
        /* 无请求体按默认层级 */
      }
      return json(res, 200, addFavorite(Number(m[1]), level));
    }
    if (m && method === 'DELETE') return json(res, 200, removeFavorite(Number(m[1])));

    // /api/reports(周期报告;未登录不返回 AI 洞察)
    if (method === 'GET' && path === '/api/reports') return json(res, 200, handleReports(url, auth));
    if (method === 'GET' && path === '/api/reports/stream') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return handleReportStream(req, res, url, auth);
    }
    if (method === 'GET' && path === '/api/reports/copy') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return handleReportCopy(req, res, url, auth);
    }

    // /api/analyze(品类 / 单品深度分析;流式需登录,缓存预读开放)
    if (method === 'GET' && path === '/api/analyze/stream') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return handleAnalyzeStream(req, res, url, auth);
    }
    if (method === 'GET' && path === '/api/analyze/cached') return json(res, 200, handleAnalyzeCached(url));

    // /api/category(类目/产品关键词分析;流式需登录,缓存预读开放)
    if (method === 'GET' && path === '/api/category/context') return json(res, 200, handleCategoryContext(url));
    if (method === 'GET' && path === '/api/category/research') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return json(res, 200, await handleCategoryResearch(url));
    }
    if (method === 'GET' && path === '/api/category/trade') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return json(res, 200, await handleCategoryTrade(url));
    }
    if (method === 'GET' && path === '/api/category/stream') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return handleCategoryStream(req, res, url, auth);
    }
    if (method === 'GET' && path === '/api/category/cached') return json(res, 200, handleCategoryCached(url));
    if (method === 'GET' && path === '/api/category/copy') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return handleCategoryCopy(req, res, url, auth);
    }

    // /api/images/chart(图表生图海报;需登录,按页面数据经 Magpie 生图模型生成,缓存复用不扣费)
    if (method === 'POST' && path === '/api/images/chart') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const type = body.type === 'category' ? 'category' : 'report';
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null;
      if (!payload || JSON.stringify(payload).length > 12000) return json(res, 400, { error: '图表数据无效' });

      const pre = precheckCredits(auth.user, IMAGE_UNITS);
      if (!pre.ok) return json(res, 402, { error: pre.error, code: pre.code, credits: pre.credits });

      const abort = new AbortController();
      req.on('close', () => abort.abort());
      try {
        const r = await genChartImage({ type, payload, signal: abort.signal });
        if (abort.signal.aborted) return json(res, 499, { error: '已取消' });
        if (!r.cached) {
          const ch = chargeSection(auth.user.id, costForUser(auth.user) * IMAGE_UNITS, 'image', `image:${type}`);
          if (!ch.ok) return json(res, 402, { error: '积分不足,请到「我的」充值', code: 'insufficient_credits', credits: currentBalance(auth.user.id) });
          return json(res, 200, { url: `/api/gen/${r.file}`, credits: ch.balance });
        }
        return json(res, 200, { url: `/api/gen/${r.file}`, cached: true });
      } catch (e) {
        console.error('[image] 生图失败:', String(e.message || e).slice(0, 200));
        if (abort.signal.aborted) return json(res, 499, { error: '已取消' });
        return json(res, 502, { error: '图表生成失败,请稍后重试' });
      }
    }

    // 生成的图表海报(内容寻址文件名,公开可读;仅登录用户能发起生成)
    m = path.match(/^\/api\/gen\/([a-zA-Z0-9-]+\.(png|jpg|jpeg))$/);
    if (m && method === 'GET') {
      const file = nodePath.join(GEN_DIR, m[1]);
      if (!existsSync(file)) return json(res, 404, { error: '图片不存在' });
      const buf = readFileSync(file);
      res.writeHead(200, {
        'content-type': m[2] === 'png' ? 'image/png' : 'image/jpeg',
        'cache-control': 'public, max-age=86400',
        'content-length': buf.length,
      });
      return res.end(buf);
    }

    // /api/collect、/api/seed/reset(仅管理员)
    if (method === 'POST' && path === '/api/collect') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return json(res, 200, triggerCollect());
    }
    if (method === 'POST' && path === '/api/seed/reset') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return json(res, 200, resetSeed());
    }

    // /api/cart(选品购物车)
    if (method === 'GET' && path === '/api/cart') return json(res, 200, getCart());
    m = path.match(/^\/api\/cart\/(\d+)$/);
    if (m && method === 'PUT') return json(res, 200, addToCart(Number(m[1])));
    if (m && method === 'DELETE') return json(res, 200, removeFromCart(Number(m[1])));

    // /api/track(停留时长上报)
    if (method === 'POST' && path === '/api/track') {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = handleTrack(body);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, r);
    }

    // /api/feedback(客户反馈)
    if (method === 'POST' && path === '/api/feedback') {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = handleAppFeedback(body);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, r);
    }
    if (method === 'GET' && path === '/api/feedback') return json(res, 200, getFeedback());

    // /api/stats(运营数据,仅管理员)
    if (method === 'GET' && path === '/api/stats') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return json(res, 200, getOpsStats());
    }

    // ---- 账号 ----
    if (method === 'POST' && path === '/api/auth/register') {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = await registerUser(body.email, body.password);
      if (r.error) return json(res, r.status || 400, { error: r.error });
      return json(res, 200, { token: r.token, user: r.user });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = await loginUser(body.email, body.password);
      if (r.error) return json(res, r.status || 401, { error: r.error });
      return json(res, 200, { token: r.token, user: r.user });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      if (!auth) return json(res, 401, { error: '未登录' });
      return json(res, 200, logout(auth.token));
    }

    // ---- 我的 ----
    if (method === 'GET' && path === '/api/me') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return json(res, 200, { user: publicUser(auth.user) });
    }
    if (method === 'POST' && path === '/api/me/tier') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = setTier(auth.user.id, String(body.tier || ''));
      if (r.error) return json(res, r.status || 400, { error: r.error });
      return json(res, 200, { ok: true, tier: r.tier });
    }
    if (method === 'GET' && path === '/api/me/credits/logs') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return json(res, 200, { items: creditLogs(auth.user.id) });
    }
    if (method === 'GET' && path === '/api/me/orders') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      return json(res, 200, { items: listUserOrders(auth.user.id) });
    }
    if (method === 'POST' && path === '/api/me/orders') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const r = createOrder(auth.user.id, {
        packId: String(body.pack_id || ''),
        amountCny: body.amount_cny != null ? Number(body.amount_cny) : null,
      });
      if (r.error) return json(res, r.status || 400, { error: r.error });
      // 支付宝通道:预下单拿二维码(失败则取消订单,提示重试)
      if (r.order.channel === 'alipay') {
        try {
          const qr = await createAlipayQr(r.order);
          if (!qr) {
            cancelOrder(r.order.id);
            return json(res, 502, { error: '支付宝预下单未返回二维码,请稍后重试' });
          }
          return json(res, 200, { order: r.order, qr_code: qr, provider: 'alipay' });
        } catch (e) {
          console.error('[pay] 支付宝预下单失败:', e.message);
          cancelOrder(r.order.id);
          return json(res, 502, { error: '支付宝预下单失败,请稍后重试' });
        }
      }
      // 线下转账:不下调支付宝,展示收款信息,等管理员确认收款后积分入账
      if (r.order.channel === 'offline') {
        return json(res, 200, { order: r.order, qr_code: '', provider: 'offline', pay_info: offlinePayInfo() });
      }
      return json(res, 200, { order: r.order, qr_code: '', provider: 'mock' });
    }

    // 订单状态轮询(客户端每 ~2.5s;服务端顺带主动向支付宝查询并自动结算到账)
    m = path.match(/^\/api\/me\/orders\/(\d+)\/status$/);
    if (m && method === 'GET') {
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      const order = getOrderById(Number(m[1]));
      if (!order || order.user_id !== auth.user.id) return json(res, 404, { error: '订单不存在' });
      if (order.status === 'pending' && order.channel === 'alipay') {
        try {
          const t = await queryAlipayTrade(order.order_no);
          if (t && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(t.trade_status)) {
            const settled = settlePaymentOrder(order.id, 'alipay');
            if (settled.error) return json(res, settled.status || 400, { error: settled.error });
            return json(res, 200, {
              status: 'paid', credits: settled.credits, plan_ends_at: settled.plan_ends_at || '', order: settled.order,
            });
          }
        } catch (e) {
          console.error('[pay] 支付宝查询失败:', e.message);
        }
      }
      return json(res, 200, {
        status: order.status,
        credits: null,
        plan_ends_at: '',
        order,
      });
    }

    // ---- 充值产品(公开,供充值区展示) ----
    if (method === 'GET' && path === '/api/packs') {
      return json(res, 200, {
        points: POINT_PACKS,
        plans: PLAN_PACKS,
        custom: customRechargeRule(),
        provider: payProvider(),
      });
    }

    // ---- 支付:支付宝异步通知(验签后自动结算;只回应 'success') ----
    if (method === 'POST' && path === '/api/pay/notify/alipay') {
      let params = {};
      try {
        params = await readFormBody(req);
      } catch {
        res.writeHead(400).end('fail');
        return;
      }
      const v = verifyAlipayNotify(params);
      if (!v.ok) {
        console.error('[pay] 支付宝通知验签失败:', v.error);
        res.writeHead(400).end('fail');
        return;
      }
      const p = v.params;
      if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(p.trade_status)) {
        res.writeHead(200).end('success'); // 非成功态不处理,但确认收到
        return;
      }
      const order = getOrderByNo(String(p.out_trade_no || ''));
      if (!order) {
        console.error('[pay] 通知订单不存在:', p.out_trade_no);
        res.writeHead(404).end('fail');
        return;
      }
      if (p.total_amount && Number(p.total_amount) !== Number(order.amount_cny)) {
        console.error('[pay] 通知金额与订单不符:', p.total_amount, '!=', order.amount_cny);
        res.writeHead(400).end('fail');
        return;
      }
      const settled = settlePaymentOrder(order.id, 'alipay');
      if (settled.error) {
        res.writeHead(400).end('fail');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('success');
      return;
    }

    // ---- 支付:mock 模拟支付(仅本地无支付宝密钥时;仅订单本人可触发) ----
    if (method === 'POST' && path === '/api/pay/mock/pay') {
      if (payProvider() !== 'mock') return json(res, 404, { error: '接口不存在: ' + method + ' ' + path });
      if (!auth) return json(res, 401, { error: '请先登录', code: 'unauthorized' });
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const order = getOrderById(Number(body.id));
      if (!order || order.user_id !== auth.user.id) return json(res, 404, { error: '订单不存在' });
      const r = settlePaymentOrder(order.id, 'mock');
      if (r.error) return json(res, r.status || 400, { error: r.error });
      return json(res, 200, { status: 'paid', credits: r.credits, plan_ends_at: r.plan_ends_at || '', order: r.order });
    }

    // ---- 管理员:充值订单管理 ----
    if (method === 'GET' && path === '/api/admin/orders') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      return json(res, 200, { items: listAdminOrders(url.searchParams.get('status') || '') });
    }
    m = path.match(/^\/api\/admin\/orders\/(\d+)\/confirm$/);
    if (m && method === 'POST') {
      if (!auth || !isAdmin(auth.user)) return json(res, 401, { error: '需要管理员权限', code: 'admin_only' });
      const r = confirmOrder(Number(m[1]), auth.user.email);
      if (r.error) return json(res, r.status || 400, { error: r.error });
      return json(res, 200, r);
    }

    return json(res, 404, { error: '接口不存在: ' + method + ' ' + path });
  } catch (e) {
    console.error('[api] 处理失败:', path, e);
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
}

// 详情视图:头部(热度/趋势/生命周期)+ 原始信号 + 关联信号 + 延伸分析(四分区手动逐个生成)
import { el, fmtEngagement, timeAgo, trendLabel, platformEmoji, fmtDateTime } from '../fmt.js';
import { getJSON, postJSON, putJSON, delJSON, sseStream } from '../api.js';
import { mdToDOM } from '../md.js';
import { store, isLoggedIn, toggleFavLocal, isInCart, toggleCartLocal } from '../store.js';
import { toast } from '../components/toast.js';

// 生成顺序固定:①爆火原因 → ②选品建议 → ③短视频 → ④内容营销(均手动点开)
const SECTION_META = {
  why: { title: '① 爆火原因解读', icon: '🧠' },
  product: { title: '② 选品建议', icon: '📦' },
  video: { title: '③ 短视频创作建议', icon: '🎬' },
  content: { title: '④ 内容营销方向', icon: '📣' },
};

let hot = null; // 当前热点 id
let data = null;
let streamAbort = null;
let sectionEls = {}; // key -> {card, body}
let feedbackState = {};

export default {
  async render(mount, args) {
    hot = Number(args[0]);
    streamAbort = null;
    sectionEls = {};
    feedbackState = {};
    mount.append(buildShell());

    try {
      data = await getJSON(`/api/hotspot/${hot}`);
      renderDetail();
    } catch (e) {
      toast(e.message, 'err');
      location.hash = '#/calendar';
    }
  },

  destroy() {
    streamAbort?.();
    streamAbort = null;
  },
};

function buildShell() {
  const page = el('div', { class: 'page' });
  page.append(
    el('div', { class: 'detail-head' }, [
      el('button', { class: 'back-btn', text: '‹', title: '返回', onclick: () => history.back() }),
      el('h1', { text: '热点详情' }),
    ]),
    el('div', { id: 'detail-root' })
  );
  return page;
}

function renderDetail() {
  const root = el('div');
  const h = data.hotspot;

  // 头部卡
  const hero = el('div', { class: 'detail-hero' }, [
    el('h2', { text: h.title }),
    el('div', { class: 'hero-meta' }, [
      el('span', { class: 'badge cat', text: h.category }),
      el('span', { class: `pill ${h.lifecycle}`, text: h.lifecycle }),
      el('span', { class: `trend ${h.heat_trend}`, text: trendLabel(h.heat_trend) }),
      el('span', { class: 'sep', text: `${h.date} · ${h.signal_count} 条信号` }),
      h.source_type === 'demo' ? el('span', { class: 'badge demo', text: '演示数据' }) : el('span', { class: 'badge live', text: '实时' }),
    ]),
    el('div', { class: 'hero-heat' }, [
      el('span', { class: 'num', text: `🔥 ${h.heat_score}` }),
      el('div', { class: 'heat-bar', style: 'flex:1' }, [el('i', { style: `width:${h.heat_score}%` })]),
      el('button', { class: `hero-cart${isInCart(hot) ? ' on' : ''}`, text: '🛒', title: isInCart(hot) ? '移出选品车' : '加入选品车', onclick: toggleCart }),
      el('button', { class: 'fav-star', text: data.is_favorite ? '⭐' : '☆', title: '收藏', onclick: toggleFav }),
    ]),
    h.summary ? el('div', { class: 'hero-summary', text: h.summary }) : null,
  ]);
  root.append(hero);

  // 原始信号区
  root.append(el('div', { class: 'section-head', text: '原始信号' }));
  data.signals.original.forEach((s) => root.append(signalRow(s)));
  if (!data.signals.original.length) {
    root.append(el('div', { class: 'empty' }, [el('div', { class: 'desc', text: '暂无信号' })]));
  }

  // 关联信号区(折叠)
  if (data.signals.related.length) {
    const collapse = el('div', { class: 'collapse-head' });
    const body = el('div', { class: 'collapse-body' });
    collapse.append(el('span', { class: 'arrow', text: '▶' }), `关联信号(${data.signals.related.length}) · 跨平台共振佐证`);
    collapse.addEventListener('click', () => {
      collapse.classList.toggle('open');
      body.classList.toggle('open');
    });
    data.signals.related.forEach((s) => body.append(signalRow(s, true)));
    root.append(collapse, body);
  }

  // 延伸分析区(四分区手动逐个生成)
  const ctaWrap = el('div', { id: 'extend-cta' });
  const secWrap = el('div', { id: 'extend-sections' });
  root.append(ctaWrap, secWrap);

  renderCta(ctaWrap);
  if (data.extend) renderCached(secWrap);

  document.getElementById('detail-root').replaceChildren(root);
}

function renderCta(ctaWrap) {
  ctaWrap.innerHTML = '';
  const cta = el('div', { class: 'extend-cta' });
  const done = data.extend?.sections || {};

  // 分区按钮网格:每个分区单独点开延伸(顺序 why → product → video → content)
  const grid = el('div', { class: 'sec-btns' });
  for (const key of Object.keys(SECTION_META)) {
    const meta = SECTION_META[key];
    const has = !!done[key];
    grid.append(
      el('button', {
        class: `sec-btn${has ? ' done' : ''}`,
        title: has ? '重新生成该分区' : `生成「${meta.title}」`,
        onclick: () => startSection(key),
      }, [
        el('span', { class: 'sec-btn-ico', text: meta.icon }),
        el('span', { class: 'sec-btn-label', text: meta.title.replace(/^[①②③④]\s*/, '') }),
        el('span', { class: 'sec-btn-state', text: has ? '✓' : '+' }),
      ])
    );
  }
  cta.append(grid);

  if (data.extend) {
    cta.append(el('div', { class: 'hint', text: `上次生成 ${timeAgo(data.extend.created_at)}` }));
  } else {
    cta.append(el('div', { class: 'hint', text: '按需点开上方分区:①爆火原因 → ②选品建议 → ③短视频 → ④内容营销(需登录,按档位消耗积分)' }));
  }
  ctaWrap.append(cta);
}

// ---------- 信号行 ----------

function signalRow(s, related = false) {
  return el('div', { class: `sig-row${related ? ' related' : ''}` }, [
    el('div', { class: 'sig-plat', text: platformEmoji(s.platform) }),
    el('div', { class: 'sig-body' }, [
      el('div', { class: 'sig-title' }, [
        s.url && /^https?:/.test(s.url)
          ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title })
          : el('span', { text: s.title }),
      ]),
      s.text ? el('div', { class: 'sig-text', text: s.text }) : null,
      el('div', { class: 'sig-meta' }, [
        el('span', { text: s.platform }),
        el('span', { text: `🔥 ${fmtEngagement(s.engagement)}` }),
        s.published_at ? el('span', { text: fmtDateTime(s.published_at) }) : null,
        s.source_type === 'demo' ? el('span', { text: '演示' }) : null,
      ]),
    ]),
  ]);
}

// ---------- 收藏 ----------

async function toggleFav(e) {
  const btn = e.currentTarget;
  const on = !data.is_favorite;
  try {
    if (on) {
      await putJSON(`/api/favorites/${hot}`);
      toast('已收藏 ⭐');
    } else {
      await delJSON(`/api/favorites/${hot}`);
      toast('已取消收藏');
    }
    data.is_favorite = on;
    toggleFavLocal(hot, on);
    btn.textContent = on ? '⭐' : '☆';
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function toggleCart(e) {
  const btn = e.currentTarget;
  const on = !isInCart(hot);
  try {
    if (on) {
      await putJSON(`/api/cart/${hot}`);
      toast('已加入选品车 🛒');
    } else {
      await delJSON(`/api/cart/${hot}`);
      toast('已移出选品车');
    }
    toggleCartLocal(hot, on);
    btn.classList.toggle('on', on);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------- 延伸分析(单分区 SSE,需登录) ----------

function startSection(key) {
  if (!isLoggedIn()) {
    toast('请先登录后使用完整功能', 'info');
    location.hash = '#/me';
    return;
  }
  if (streamAbort) {
    toast('正在生成中,请稍候', 'info');
    return;
  }
  const secWrap = document.getElementById('extend-sections');
  const old = document.getElementById(`sec-${key}`);
  if (old) old.remove();
  const card = buildSectionCard(key, true);
  insertSectionInOrder(secWrap, key, card);

  const qs = new URLSearchParams({ section: key });
  if (store.profile.platforms.length) qs.set('platforms', store.profile.platforms.join(','));

  const controller = new AbortController();
  streamAbort = controller.abort.bind(controller);
  const current = hot;

  sseStream(
    `/api/extend/${hot}?${qs}`,
    {
      onMeta: () => {},
      onSectionStart: ({ section }) => setSectionProgress(section, true),
      onDelta: ({ section, text }) => appendDelta(section, text),
      onSectionDone: ({ section, confidence, citations, markdown, degraded, partial }) => {
        finalizeSection(section, { markdown, confidence, citations, degraded, partial });
      },
      onSectionError: ({ section, message }) => {
        setSectionProgress(section, false);
        toast(`分区生成失败:${message}`, 'err');
      },
      onDone: () => {
        streamAbort = null;
        if (current === hot) {
          toast('✅ 分区已生成');
          getJSON(`/api/hotspot/${hot}`).then((d) => {
            if (current === hot && d.extend) {
              data.extend = d.extend;
              data.feedback = d.feedback || {};
              renderCta(document.getElementById('extend-cta'));
              renderCached(document.getElementById('extend-sections'));
            }
          }).catch(() => {});
        }
      },
      onError: (e) => {
        streamAbort = null;
        if (current !== hot) return;
        toast(e.message, 'err');
        renderCta(document.getElementById('extend-cta'));
      },
    },
    controller.signal
  );
}

// 按 SECTION_META 顺序插入分区卡,保证阅读顺序稳定
function insertSectionInOrder(secWrap, key, card) {
  const order = Object.keys(SECTION_META);
  const idx = order.indexOf(key);
  let anchor = null;
  for (let i = idx + 1; i < order.length; i++) {
    const next = document.getElementById(`sec-${order[i]}`);
    if (next) {
      anchor = next;
      break;
    }
  }
  if (anchor) secWrap.insertBefore(card, anchor);
  else secWrap.append(card);
}

function buildSectionCard(key, skeleton) {
  const meta = SECTION_META[key];
  const card = el('div', { class: 'sec-card', id: `sec-${key}` });
  const head = el('div', { class: 'sec-head' }, [
    el('span', { class: 'sec-title', text: `${meta.icon} ${meta.title}` }),
    el('span', { class: 'sec-badges' }),
  ]);
  const body = el('div', { class: 'sec-body' });
  const cites = el('div', { class: 'sec-cites' });
  const foot = el('div', { class: 'sec-foot' });
  card.append(head, body, cites, foot);
  if (skeleton) {
    body.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }), el('div', { class: 'sk-line w90 skeleton' }));
    head.querySelector('.sec-badges').append(el('span', { class: 'sec-provider', text: '等待生成…' }));
  }
  sectionEls[key] = { card, head, body, cites, foot, text: '', done: false };
  return card;
}

function setSectionProgress(key, running) {
  const s = sectionEls[key];
  if (!s) return;
  const badges = s.head.querySelector('.sec-badges');
  const old = badges.querySelector('.sec-provider');
  if (old) old.textContent = running ? '生成中…' : old.textContent;
}

function appendDelta(key, text) {
  const s = sectionEls[key];
  if (!s) return;
  s.text += text;
  s.body.replaceChildren(mdToDOM(s.text, { citeClick: (n) => scrollToCite(key, n) }));
  s.body.scrollTop = s.body.scrollHeight;
}

function finalizeSection(key, sec) {
  const s = sectionEls[key];
  if (!s) return;
  s.done = true;
  s.text = sec.markdown || s.text;
  s.body.replaceChildren(mdToDOM(s.text, { citeClick: (n) => scrollToCite(key, n) }));

  // 徽章:置信度 + 降级标志(不暴露任何供应商信息)
  const badges = s.head.querySelector('.sec-badges');
  badges.innerHTML = '';
  badges.append(el('span', { class: `badge conf ${sec.confidence}`, text: `可信度 ${sec.confidence}` }));
  if (sec.degraded || sec.partial) {
    badges.append(el('span', { class: 'sec-provider', text: '降级摘要', style: 'color:var(--warm)' }));
  }

  // 引用 chips
  s.cites.innerHTML = '';
  if ((sec.citations || []).length) {
    s.cites.append(el('div', { class: 'cites-title', text: '📎 引用来源(点击回源)' }));
    for (const c of sec.citations) {
      s.cites.append(
        el('a', { class: 'cite-chip', href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.url }, [
          el('span', { class: 'n', text: String(c.index) }),
          el('span', { class: 't', text: `${c.platform} · ${c.title}` }),
        ])
      );
    }
  }

  // 操作区:复制 + 有用/无用 + 重试(降级时)
  s.foot.innerHTML = '';
  s.foot.append(el('button', { class: 'copy-btn', text: '📋 复制', onclick: () => copySection(key) }));
  const fbGood = el('button', { class: 'fb-btn', text: '👍 有用' });
  const fbBad = el('button', { class: 'fb-btn', text: '👎 没用' });
  const applyFb = (rating) => {
    fbGood.className = `fb-btn${rating === 'useful' ? ' selected-good' : ''}`;
    fbBad.className = `fb-btn${rating === 'useless' ? ' selected-bad' : ''}`;
  };
  applyFb(feedbackState[key]);
  fbGood.addEventListener('click', () => sendFeedback(key, 'useful', applyFb));
  fbBad.addEventListener('click', () => sendFeedback(key, 'useless', applyFb));
  s.foot.append(fbGood, fbBad);
  if (sec.degraded || sec.partial) {
    s.foot.append(el('button', { class: 'retry-btn', text: '↻ 重试本分区', onclick: () => retrySection(key) }));
  }
}

function scrollToCite(key, n) {
  const s = sectionEls[key];
  if (!s) return;
  const chip = [...s.cites.querySelectorAll('.cite-chip')].find((c) => c.querySelector('.n')?.textContent === String(n));
  if (chip) chip.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function copySection(key) {
  const s = sectionEls[key];
  if (!s?.text) return;
  try {
    await navigator.clipboard.writeText(s.text);
    toast('已复制到剪贴板');
  } catch {
    // 兼容旧环境
    const ta = document.createElement('textarea');
    ta.value = s.text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制到剪贴板');
  }
}

async function sendFeedback(key, rating, apply) {
  try {
    await postJSON(`/api/extend/${hot}/feedback`, { section: key, rating });
    feedbackState[key] = rating;
    apply(rating);
    toast(rating === 'useful' ? '感谢反馈 👍' : '感谢反馈,我们会改进');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function retrySection(key) {
  const s = sectionEls[key];
  if (!s) return;
  s.body.replaceChildren(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }));
  setSectionProgress(key, true);
  try {
    const r = await postJSON(`/api/extend/${hot}/retry`, { section: key });
    finalizeSection(key, r.section);
    toast('分区已重新生成');
  } catch (e) {
    setSectionProgress(key, false);
    toast(e.message, 'err');
  }
}

// 缓存直出(无需 SSE)
function renderCached(wrap) {
  if (!data.extend) return;
  wrap.innerHTML = '';
  sectionEls = {};
  feedbackState = { ...(data.feedback || {}) };
  const sections = data.extend.sections;
  for (const key of Object.keys(SECTION_META)) {
    const sec = sections[key];
    if (!sec) continue;
    wrap.append(buildSectionCard(key, false));
    finalizeSection(key, { ...sec, markdown: sec.markdown });
  }
}

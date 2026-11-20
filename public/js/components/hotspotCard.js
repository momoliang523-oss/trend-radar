// 热点卡片(日历 / 收藏共用)
import { el, platformEmoji } from '../fmt.js';
import { isFav, isInCart, toggleCartLocal } from '../store.js';
import { putJSON, delJSON } from '../api.js';
import { toast } from './toast.js';

export function hotspotCard(item, { onFavChange, onCartChange } = {}) {
  const heat = item.heat_score;
  const card = el('div', {
    class: 'card',
    onclick: () => {
      location.hash = `#/detail/${item.id}`;
    },
  });

  const star = el('button', {
    class: `fav-star${isFav(item.id) ? ' on' : ''}`,
    text: isFav(item.id) ? '⭐' : '☆',
    title: isFav(item.id) ? '取消收藏' : '收藏',
    onclick: async (e) => {
      e.stopPropagation();
      const on = !isFav(item.id);
      try {
        if (on) {
          await putJSON(`/api/favorites/${item.id}`);
          star.textContent = '⭐';
          star.classList.add('on');
          toast('已收藏 ⭐');
        } else {
          await delJSON(`/api/favorites/${item.id}`);
          star.textContent = '☆';
          star.classList.remove('on');
          toast('已取消收藏');
        }
        onFavChange?.(item.id, on);
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  });

  const cart = el('button', {
    class: `cart-btn${isInCart(item.id) ? ' on' : ''}`,
    text: '🛒',
    title: isInCart(item.id) ? '移出选品车' : '加入选品车',
    onclick: async (e) => {
      e.stopPropagation();
      const on = !isInCart(item.id);
      try {
        if (on) {
          await putJSON(`/api/cart/${item.id}`);
          cart.classList.add('on');
          toast('已加入选品车 🛒');
        } else {
          await delJSON(`/api/cart/${item.id}`);
          cart.classList.remove('on');
          toast('已移出选品车');
        }
        toggleCartLocal(item.id, on);
        onCartChange?.(item.id, on);
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  });

  const platforms = (item.platforms || []).slice(0, 4);
  card.append(
    el('div', { class: 'card-top' }, [
      el('div', { class: 'card-rank' }, [el('span', { class: 'no', text: item.rank != null ? String(item.rank) : '' })]),
      el('div', { class: 'card-title', text: item.title }),
      star,
    ]),
    el('div', { class: 'card-meta' }, [
      el('span', { class: 'badge cat', text: item.category }),
      el('span', { class: `pill ${item.lifecycle}`, text: item.lifecycle }),
      item.heat_trend !== 'flat' ? el('span', { class: `trend ${item.heat_trend}`, text: ({ up: '↑', down: '↓', new: '✨' }[item.heat_trend] || '') }) : null,
      platforms.length ? el('span', { class: 'badge platform', text: platforms.map((p) => `${platformEmoji(p)} ${p}`).join(' · ') }) : null,
      item.level && item.level !== '普通' ? el('span', { class: `badge tier ${item.level}`, text: `🎯 ${item.level}` }) : null,
      item.source_type === 'demo' ? el('span', { class: 'badge demo', text: '演示数据' }) : el('span', { class: 'badge live', text: '实时' }),
    ]),
    el('div', { class: 'heat-line' }, [
      el('span', { class: 'heat-num', text: `🔥 ${heat}` }),
      el('div', { class: 'heat-bar' }, [el('i', { style: `width:${heat}%` })]),
      el('span', { class: 'sep', text: `${item.signal_count || 0} 条信号` }),
    ]),
    item.summary ? el('div', { class: 'card-summary', text: item.summary }) : null,
    el('div', { class: 'card-actions' }, [
      el('span', { class: 'spacer' }),
      cart,
      el('button', { class: 'extend-btn', text: '延伸分析 →', onclick: (e) => { e.stopPropagation(); location.hash = `#/detail/${item.id}`; } }),
    ])
  );
  return card;
}

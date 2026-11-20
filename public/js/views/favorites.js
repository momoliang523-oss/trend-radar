// 收藏视图:兴趣层级管理(普通 / 高兴趣 / 有意向)+ 同类目升级提示
import { el } from '../fmt.js';
import { getJSON, postJSON } from '../api.js';
import { hotspotCard } from '../components/hotspotCard.js';
import { refreshFavorites, isFav } from '../store.js';
import { toast } from '../components/toast.js';

const LEVELS = ['普通', '高兴趣', '有意向'];

export default {
  async render(mount) {
    const page = el('div', { class: 'page' });
    const topbar = el('div', { class: 'topbar' }, [
      el('div', { class: 'topbar-inner' }, [
        el('div', { class: 'topbar-row' }, [el('div', { class: 'app-title' }, [el('span', { class: 'logo', text: '⭐' }), '我的收藏'])]),
        el('div', { class: 'app-sub', text: '收藏的热点按兴趣层级管理,高层级将进入报告的深度分析' }),
      ]),
    ]);
    const banner = el('div', { id: 'fav-banner' });
    const list = el('div', { class: 'card-list', style: 'margin-top:12px' });
    page.append(banner, list);
    mount.append(topbar, page);

    list.append(el('div', { class: 'sk-line w90 skeleton' }), el('div', { class: 'sk-line w70 skeleton' }));
    try {
      const d = await getJSON('/api/favorites');
      list.innerHTML = '';
      renderBanner(banner, d.suggestion);

      if (!d.items.length) {
        list.append(
          el('div', { class: 'empty' }, [
            el('span', { class: 'emoji', text: '🌱' }),
            el('div', { class: 'title', text: '还没有收藏' }),
            el('div', { class: 'desc', text: '在热点卡片或详情页点亮 ☆,把值得跟进的热点收进来' }),
            el('button', { class: 'go-btn', text: '去日历看热点', onclick: () => (location.hash = '#/calendar') }),
          ])
        );
        return;
      }

      d.items.forEach((item, i) => {
        item.rank = i + 1;
        const card = hotspotCard(item, {
          onFavChange: () => {
            refreshFavorites().then(() => {
              if (!isFav(item.id)) location.reload();
            });
          },
        });
        // 层级控制行
        const tierRow = el('div', { class: 'tier-row' }, [
          el('span', { class: 'tier-label', text: '兴趣层级' }),
          ...LEVELS.map((lv) =>
            el('button', {
              class: `tier-btn${item.level === lv ? ' on' : ''}`,
              text: lv,
              onclick: async (e) => {
                e.stopPropagation();
                try {
                  await postJSON(`/api/favorites/${item.id}/level`, { level: lv });
                  item.level = lv;
                  tierRow.querySelectorAll('.tier-btn').forEach((b) => b.classList.toggle('on', b.textContent === lv));
                  // 同步卡片徽章
                  card.querySelector('.badge.tier')?.remove();
                  if (lv !== '普通') {
                    const badges = card.querySelector('.card-meta');
                    badges.append(el('span', { class: `badge tier ${lv}`, text: `🎯 ${lv}` }));
                  }
                  toast(lv === '普通' ? '已设为普通收藏' : `已设为「${lv}」层级 🎯`);
                  refreshFavorites();
                } catch (err) {
                  toast(err.message, 'err');
                }
              },
            })
          ),
        ]);
        card.append(tierRow);
        list.append(card);
      });
    } catch (e) {
      list.innerHTML = '';
      list.append(el('div', { class: 'empty' }, [el('div', { class: 'desc', text: e.message || '加载失败' })]));
    }
  },

  destroy() {},
};

// 同类目 ≥3 条普通收藏 → 升级提示
function renderBanner(banner, suggestion) {
  banner.innerHTML = '';
  if (!suggestion) return;
  banner.append(
    el('div', { class: 'fav-banner' }, [
      el('span', { class: 'fav-banner-text', text: `「${suggestion.category}」品类已收藏 ${suggestion.count} 条,看起来高度关注 👀` }),
      el('div', { class: 'fav-banner-btns' }, [
        el('button', {
          class: 'action-btn',
          text: '设为高兴趣',
          onclick: () => batchSetLevel(suggestion.category, '高兴趣'),
        }),
        el('button', {
          class: 'action-btn primary',
          text: '设为有意向',
          onclick: () => batchSetLevel(suggestion.category, '有意向'),
        }),
      ]),
    ])
  );
}

async function batchSetLevel(category, level) {
  try {
    const d = await getJSON('/api/favorites');
    const ids = d.items.filter((i) => i.category === category).map((i) => i.id);
    await Promise.all(ids.map((id) => postJSON(`/api/favorites/${id}/level`, { level })));
    toast(`已将该品类 ${ids.length} 条收藏设为「${level}」`);
    location.reload();
  } catch (e) {
    toast(e.message, 'err');
  }
}

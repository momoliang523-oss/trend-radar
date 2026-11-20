// Bing News RSS(国内可达;若返回 HTML 同意页则自禁用)
import { fetchText, tagText, xmlItems, dedupKey } from '../util.js';

export default {
  id: 'bing_news',
  platform: '新闻',
  display: 'Bing News',
  enabled: true,

  async collect() {
    const out = [];
    // 消费热点相关查询,保证信号与「出海选品」相关
    for (const q of ['viral product', 'TikTok trending', 'Amazon best seller']) {
      const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;
      const text = await fetchText(url);
      if (!/^\s*(<\?xml|<rss)/i.test(text)) {
        throw new Error('返回的不是 RSS(可能是同意页),本源自禁用');
      }
      for (const item of xmlItems(text)) {
        const title = tagText(item, 'title');
        if (!title) continue;
        out.push({
          platform: this.platform,
          url: tagText(item, 'link'),
          title,
          text: tagText(item, 'description').slice(0, 300),
          author: '',
          published_at: tagText(item, 'pubDate') ? new Date(tagText(item, 'pubDate')).toISOString() : null,
          engagement: 50 + Math.round(Math.random() * 150),
          extra: { query: q },
          dedup_key: dedupKey(tagText(item, 'link') || `bing:${title}`),
        });
      }
    }
    return out;
  },
};

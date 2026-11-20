// Google News RSS(国内网络不可达,开代理后自动生效)
import { fetchText, tagText, xmlItems, dedupKey } from '../util.js';

export default {
  id: 'google_news',
  platform: '新闻',
  display: 'Google News',
  enabled: true,

  async collect() {
    const out = [];
    for (const q of ['viral product', 'trending consumer tech', 'Amazon bestseller']) {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const text = await fetchText(url);
      if (!/^\s*(<\?xml|<rss)/i.test(text)) throw new Error('返回的不是 RSS');
      for (const item of xmlItems(text)) {
        const title = tagText(item, 'title');
        if (!title) continue;
        out.push({
          platform: this.platform,
          url: tagText(item, 'link'),
          title,
          text: '',
          author: tagText(item, 'source') || '',
          published_at: tagText(item, 'pubDate') ? new Date(tagText(item, 'pubDate')).toISOString() : null,
          engagement: 40 + Math.round(Math.random() * 120),
          extra: { query: q },
          dedup_key: dedupKey(tagText(item, 'link') || `gnews:${title}`),
        });
      }
    }
    return out;
  },
};

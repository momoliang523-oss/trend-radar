// Product Hunt(页面结构多变且不稳定,默认关闭;config 里手动打开)
import { fetchText, tagText, xmlItems, dedupKey } from '../util.js';

export default {
  id: 'producthunt',
  platform: '新闻',
  display: 'Product Hunt',
  enabled: false,

  async collect() {
    const url = 'https://www.producthunt.com/feed';
    const text = await fetchText(url);
    if (!/^\s*(<\?xml|<rss|<feed)/i.test(text)) throw new Error('返回的不是 RSS/Atom');
    const out = [];
    for (const item of xmlItems(text, 'entry')) {
      const title = tagText(item, 'title');
      if (!title) continue;
      out.push({
        platform: this.platform,
        url: tagText(item, 'link'),
        title,
        text: tagText(item, 'summary').slice(0, 300),
        author: '',
        published_at: tagText(item, 'updated') || tagText(item, 'published') || null,
        engagement: 20 + Math.round(Math.random() * 80),
        extra: {},
        dedup_key: dedupKey(tagText(item, 'link') || `ph:${title}`),
      });
    }
    return out;
  },
};

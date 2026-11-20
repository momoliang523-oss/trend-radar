// BBC World News RSS(新闻类背景信号;国内不可达,代理后生效)
import { fetchText, tagText, xmlItems, dedupKey } from '../util.js';

export default {
  id: 'bbc',
  platform: '新闻',
  display: 'BBC News',
  enabled: true,

  async collect() {
    const url = 'https://feeds.bbci.co.uk/news/world/rss.xml';
    const text = await fetchText(url);
    if (!/^\s*(<\?xml|<rss)/i.test(text)) throw new Error('返回的不是 RSS');
    const out = [];
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
        engagement: 30 + Math.round(Math.random() * 90),
        extra: {},
        dedup_key: dedupKey(tagText(item, 'link') || `bbc:${title}`),
      });
    }
    return out;
  },
};

// YouTube 采集:头部创作者频道 RSS(公共 feed,无需 API key;国内不可达,代理后生效)
import { fetchText, tagText, xmlItems, dedupKey } from '../util.js';

// 覆盖科技/生活方式/美食头部频道,信号与消费趋势相关
const CHANNELS = [
  'UCX6OQ3DkcsbYNE6H8uQQuVA', // MrBeast
  'UCBJycsmduvYEL83R_U4JriQ', // MKBHD
  'UCsTcErHg8oDvUnTzoqsYeNw', // Unbox Therapy
  'UCddiUEpeqJcYeBxX1IVBKvQ', // The Verge
  'UCzQUP1qoWDoEbmsQxvdjxgQ', // Linus Tech Tips
];

export default {
  id: 'youtube',
  platform: 'YouTube',
  display: 'YouTube',
  enabled: true,

  async collect() {
    const out = [];
    for (const ch of CHANNELS) {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`;
      const text = await fetchText(url);
      if (!/^\s*(<\?xml|<feed)/i.test(text)) throw new Error('返回的不是 RSS');
      for (const item of xmlItems(text, 'entry')) {
        const title = tagText(item, 'title');
        if (!title) continue;
        const viewsMatch = item.match(/<media:statistics[^>]*views="(\d+)"/);
        const views = viewsMatch ? Number(viewsMatch[1]) : 0;
        out.push({
          platform: this.platform,
          url: tagText(item, 'link'),
          title,
          text: '',
          author: tagText(item, 'name') || '',
          published_at: tagText(item, 'published') || null,
          engagement: Math.round(views / 100), // 归一化
          extra: { views, channel: ch },
          dedup_key: dedupKey(tagText(item, 'link') || `yt:${title}`),
        });
      }
    }
    return out;
  },
};

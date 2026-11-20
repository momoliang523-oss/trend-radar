// Hacker News 采集(Algolia 公开 API,已验证可达;本机唯一稳定的海外源)
import { fetchText, safeJson, dedupKey } from '../util.js';

export default {
  id: 'hn',
  platform: 'Hacker News',
  display: 'Hacker News',
  enabled: true,

  async collect() {
    const out = [];
    for (const tags of ['front_page', 'show_hn']) {
      const url = `https://hn.algolia.com/api/v1/search?tags=${tags}&hitsPerPage=40`;
      const text = await fetchText(url);
      const data = safeJson(text);
      if (!data?.hits) continue;
      for (const h of data.hits) {
        const engagement = (h.points || 0) + (h.num_comments || 0) * 10;
        if (engagement < 50) continue; // 过滤低互动
        out.push({
          platform: this.platform,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title || h.story_title || '',
          text: (h.story_text || '').slice(0, 300),
          author: h.author || '',
          published_at: h.created_at || null,
          engagement,
          extra: { points: h.points || 0, comments: h.num_comments || 0, objectID: h.objectID },
          dedup_key: dedupKey(h.url || `hn:${h.objectID}`),
        });
      }
    }
    return out;
  },
};

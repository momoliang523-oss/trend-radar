// Reddit 采集(公开 JSON,需自定义 UA;国内网络不可达,开代理后自动生效)
import { fetchText, safeJson, dedupKey, xmlItems } from '../util.js';

export default {
  id: 'reddit',
  platform: 'Reddit',
  display: 'Reddit',
  enabled: true,

  async collect() {
    const out = [];
    for (const sub of ['popular', 'all']) {
      const url = `https://www.reddit.com/r/${sub}.json?limit=50`;
      const text = await fetchText(url, {
        headers: { 'user-agent': 'trend-radar/0.1 (research; linux:node)' },
      });
      const data = safeJson(text);
      const children = data?.data?.children || [];
      for (const c of children) {
        const p = c.data || {};
        if (p.stickied || p.over_18) continue;
        const engagement = (p.score || 0) + (p.num_comments || 0) * 10;
        if (engagement < 200) continue;
        out.push({
          platform: this.platform,
          url: 'https://www.reddit.com' + (p.permalink || ''),
          title: p.title || '',
          text: (p.selftext || '').slice(0, 300),
          author: p.author || '',
          published_at: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
          engagement,
          extra: { score: p.score || 0, comments: p.num_comments || 0, subreddit: p.subreddit || '' },
          dedup_key: dedupKey('https://www.reddit.com' + (p.permalink || p.id || '')),
        });
      }
    }
    return out;
  },
};

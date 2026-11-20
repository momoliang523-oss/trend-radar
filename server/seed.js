// 演示数据生成器:14 天 × 多条热点(全球地区主题:日/美/欧/墨西哥/中东/俄罗斯/东南亚/拉美),带生命周期曲线(幂等可重置)
// 背景:本机网络下 TikTok/X/Amazon 等官方接口不可用,演示数据是日历的体验主干;
// 真实采集器(HN 等)混入当日列表。演示条目带 source_type='demo' 标记。
import { db, metaGet, metaSet, nowIso } from './db.js';
import { todayStr, addDays, mulberry32, clamp } from './util.js';

const TODAY = todayStr();
const DAYS = 14;

// ---------- 主题库 ----------
// startOffset: 几天前开始(0=今天);days: 持续天数;peak: 峰值热度
const THEMES = [
  {
    zh: '「情绪奶瓶」便携水杯风潮席卷 TikTok',
    en: 'emotional support water bottle',
    category: '家居', platforms: ['TikTok', 'X', 'Amazon', 'Instagram'],
    startOffset: 0, days: 5, peak: 88, base: 5200, region: '美国', kw: ['美国'],
    summary: '把「情绪价值」做成产品:印着鼓励语的便携水杯在 TikTok 刷屏,评论区大量「必须拥有」,亚马逊同款冲上品类榜。',
  },
  {
    zh: 'AI 宠物翻译项圈演示视频爆火',
    en: 'AI pet translator collar',
    category: '母婴宠物', platforms: ['TikTok', 'YouTube', 'X', 'Amazon'],
    startOffset: 1, days: 6, peak: 92, base: 6400, region: '拉美', kw: ['巴西', '拉美'],
    summary: '「听懂狗说话」的 AI 项圈演示视频全网刷屏,宠物主人疯狂 @ 朋友,评论热问购买链接与是否支持猫。',
  },
  {
    zh: '蘑菇灯:一夜爆红的卧室美学单品',
    en: 'mushroom lamp aesthetic bedroom',
    category: '家居', platforms: ['TikTok', 'Instagram', 'Amazon'],
    startOffset: 11, days: 12, peak: 76, base: 3800, region: '日本', kw: ['日本', '东京'],
    summary: '暖光蘑菇造型小夜灯成为「氛围感卧室」标配,TikTok 改造视频带火,亚马逊多店铺登顶家居新品榜。',
  },
  {
    zh: '宿舍迷你洗衣机走红北美校园',
    en: 'mini portable washing machine dorm',
    category: '家居', platforms: ['TikTok', 'Amazon', 'YouTube'],
    startOffset: 0, days: 5, peak: 81, base: 4500, region: '美国', kw: ['美国', '北美'],
    summary: '开学季刚需:可折叠迷你洗衣机解决「洗衣房排队」痛点,学生党晒单视频密集出现,评论高频词是「链接」。',
  },
  {
    zh: '复古翻盖机回潮,「数字戒断」成新话题',
    en: 'flip phone revival digital detox',
    category: '3C数码', platforms: ['X', 'YouTube', 'Reddit'],
    startOffset: 3, days: 6, peak: 85, base: 5900, region: '日本', kw: ['日本', '东京'],
    summary: 'Z 世代开始逃离算法:翻盖机销量逆势上涨,X 与 Reddit 上「digital detox」讨论爆发,测评视频播放量暴涨。',
  },
  {
    zh: '磁吸假睫毛:手残党的 10 秒上妆神器',
    en: 'magnetic lash clusters hack',
    category: '美妆个护', platforms: ['TikTok', 'Instagram', 'Amazon'],
    startOffset: 1, days: 5, peak: 90, base: 7100, region: '东南亚', kw: ['东南亚', '越南'],
    summary: '「不会贴假睫毛的有救了」:磁吸分段睫毛演示视频病毒式传播,教程 tag 播放破亿,亚马逊类目排名飙升。',
  },
  {
    zh: '防晒粉底二合一:早八人的化妆革命',
    en: 'sunscreen foundation hybrid makeup',
    category: '美妆个护', platforms: ['TikTok', 'Instagram', 'X'],
    startOffset: 4, days: 4, peak: 72, base: 3100, region: '东南亚', kw: ['东南亚', '泰国'],
    summary: '一支搞定防晒+底妆:皮肤科医生背书 + 素人实测视频推动话题升温,「5-minute morning routine」成为流量密码。',
  },
  {
    zh: '可折叠通勤高跟鞋:办公室抽屉里的秘密',
    en: 'foldable commuter heels office',
    category: '服饰', platforms: ['TikTok', 'Instagram', 'Amazon'],
    startOffset: 2, days: 4, peak: 69, base: 2900, region: '日本', kw: ['日本', '东京'],
    summary: '通勤女性人手一双:鞋跟可折叠的轻便鞋款在 TikTok 演示「地铁换鞋」场景,评论区被「where to buy」刷屏。',
  },
  {
    zh: '30 秒充气帐篷成露营圈新宠',
    en: '30 second inflatable camping tent',
    category: '运动户外', platforms: ['YouTube', 'TikTok', 'Amazon'],
    startOffset: 13, days: 14, peak: 83, base: 4700, region: '拉美', kw: ['拉美', '巴西'],
    summary: '露营装备轻量化趋势:电动充气帐篷「一键成型」演示视频爆火,带动便携户外品类搜索量激增。',
  },
  {
    zh: 'AI 婴儿睡眠监控:新手父母的新刚需',
    en: 'AI baby sleep monitor camera',
    category: '母婴宠物', platforms: ['YouTube', 'Reddit', 'Amazon'],
    startOffset: 3, days: 5, peak: 74, base: 3300, region: '欧洲', kw: ['欧洲', '德国'],
    summary: '能识别睡姿、呼吸并预警的 AI 婴儿监控进入新手父母讨论中心,Reddit 育儿版实测帖引发大量咨询。',
  },
  {
    zh: '高蛋白薯片:健身圈的「罪恶感清零」零食',
    en: 'high protein chips guilt free snack',
    category: '食品', platforms: ['TikTok', 'Instagram', 'Amazon'],
    startOffset: 1, days: 5, peak: 78, base: 4100, region: '拉美', kw: ['拉美', '巴西'],
    summary: '蛋白质含量媲美鸡胸肉的薯片成为健身博主新宠,开箱+对比视频密集发布,「macro friendly」话题热度飙升。',
  },
  {
    zh: '速溶抹茶拿铁:复刻咖啡馆的 3 分钟仪式感',
    en: 'instant matcha latte powder viral',
    category: '食品', platforms: ['TikTok', 'X', 'Instagram'],
    startOffset: 12, days: 13, peak: 66, base: 2400, region: '日本', kw: ['日本'],
    summary: '打工人复刻咖啡馆抹茶拿铁的短视频走红,「3 分钟仪式感」带动速溶抹茶粉搜索与带货双涨。',
  },
  {
    zh: '模块化桌面收纳:效率博主的桌面革命',
    en: 'modular desk organizer setup',
    category: '家居', platforms: ['TikTok', 'Amazon', 'YouTube'],
    startOffset: 4, days: 4, peak: 71, base: 3000, region: '俄罗斯', kw: ['俄罗斯', '莫斯科'],
    summary: '「desk setup」改造视频带火模块化收纳:自由拼装的抽屉与支架成为效率博主标配,亚马逊类目排名上升。',
  },
  {
    zh: '磁吸充电宝:iPhone 用户的第二块电池',
    en: 'magsafe power bank battery pack',
    category: '3C数码', platforms: ['TikTok', 'YouTube', 'X', 'Amazon'],
    startOffset: 0, days: 6, peak: 87, base: 6100, region: '中东', kw: ['中东', '迪拜'],
    summary: '轻量磁吸充电宝评测密集上线,「比官方便宜一半但一样好」成为共识,跨境电商卖家争相跟进。',
  },
  {
    zh: '宠物推车:遛狗遛猫新姿势引热议',
    en: 'pet stroller dog cat trend',
    category: '母婴宠物', platforms: ['TikTok', 'Instagram', 'Reddit'],
    startOffset: 12, days: 13, peak: 64, base: 2600, region: '墨西哥', kw: ['墨西哥', '墨西哥城'],
    summary: '推着猫狗逛商场成为新现象,「过度拟人化还是真需求」在 Reddit 吵翻天,搜索量一路上涨。',
  },
  {
    zh: '成人解压捏捏乐:办公室里的情绪出口',
    en: 'adult fidget toy stress relief',
    category: '其他', platforms: ['TikTok', 'X', 'Reddit'],
    startOffset: 2, days: 5, peak: 79, base: 4300, region: '拉美', kw: ['拉美', '巴西'],
    summary: '质感升级的解压玩具打入成年人市场,「工作压力大时捏一下」的共鸣视频爆火,办公场景成为新卖点。',
  },
  // 单日/双日「快闪」事件
  {
    zh: '顶流明星 × 平价彩妆联名系列官宣',
    en: 'celebrity x affordable makeup collab launch',
    category: '美妆个护', platforms: ['X', 'Instagram', 'TikTok'],
    startOffset: 1, days: 2, peak: 68, base: 3600, region: '东南亚', kw: ['东南亚', '泰国'],
    summary: '官宣即售罄:顶流与平价彩妆品牌联名引发抢购潮,「平价大牌平替」话题再度升温。',
  },
  {
    zh: '#20YearChallenge 挑战在 TikTok 刷屏',
    en: '20 year challenge trend tiktok',
    category: '其他', platforms: ['TikTok', 'X'],
    startOffset: 1, days: 2, peak: 73, base: 3900, region: '墨西哥', kw: ['墨西哥'],
    summary: '怀旧滤镜挑战席卷 TikTok,品牌号借势营销,参与量 24 小时破百万。',
  },
  {
    zh: '神秘新硬件发布:极客圈整夜讨论',
    en: 'mystery gadget launch keynote',
    category: '3C数码', platforms: ['X', 'Reddit', 'YouTube'],
    startOffset: 0, days: 1, peak: 62, base: 2800, region: '中东', kw: ['中东', '迪拜'],
    summary: '无预告发布的硬件新品让极客圈沸腾,X 趋势榜霸榜一夜,二手平台加价转卖出现。',
  },
  {
    zh: '社交平台宕机引发全球吐槽热潮',
    en: 'social platform outage global meme',
    category: '其他', platforms: ['X', 'Reddit'],
    startOffset: 0, days: 1, peak: 70, base: 3400, region: '俄罗斯', kw: ['俄罗斯', '莫斯科'],
    summary: '两小时宕机让网友集体涌向其他平台吐槽,meme 图病毒式传播,「数字戒断」话题再次被提起。',
  },
  // ---- 地区扩展:欧洲 / 美国 / 墨西哥 / 中东 / 俄罗斯 / 东南亚 / 拉美 / 日本(全部主题均带 region 与 kw,会写入关键词,便于筛选与搜索) ----
  {
    zh: '英国「少糖运动」:低糖谷物早餐在英区亚马逊冲榜',
    en: 'low sugar cereal breakfast UK',
    category: '食品', platforms: ['Amazon', 'TikTok', '新闻'],
    startOffset: 1, days: 5, peak: 73, base: 3500, region: '欧洲', kw: ['英国', '伦敦', '低糖'],
    summary: '英国「少糖运动」持续升温,低糖谷物早餐在英区亚马逊冲上品类榜,健康零食类目整体受益。',
  },
  {
    zh: '墨西哥亡灵节临近:彩绘骷髅元素服饰在 TikTok 热卖',
    en: 'dia de muertos skull makeup outfit mexico',
    category: '服饰', platforms: ['TikTok', 'TikTok Shop', 'Instagram', 'Temu'],
    startOffset: 4, days: 5, peak: 82, base: 5200, region: '墨西哥', kw: ['墨西哥', '亡灵节', '拉美'],
    summary: '亡灵节(11 月初)前一个月备货潮启动:彩绘骷髅元素的连衣裙、配饰在 TikTok 演示视频密集刷屏。',
  },
  {
    zh: '俄罗斯入冬备货:加绒触屏手套需求激增',
    en: 'winter touchscreen gloves russia',
    category: '服饰', platforms: ['TikTok', 'Temu', 'X'],
    startOffset: 3, days: 5, peak: 79, base: 4600, region: '俄罗斯', kw: ['俄罗斯', '莫斯科', '冬季'],
    summary: '俄罗斯电商平台入冬备货潮:兼顾保暖与手机触控的加绒手套需求激增,跨境卖家密集上架。',
  },
  {
    zh: '东南亚雨季:电动车防水雨披在 Shopee 冲上热销榜',
    en: 'electric bike rain poncho southeast asia',
    category: '运动户外', platforms: ['Shopee', 'TikTok'],
    startOffset: 4, days: 4, peak: 68, base: 3100, region: '东南亚', kw: ['东南亚', '越南', '泰国', '印尼'],
    summary: '东南亚进入雨季,电动车通勤人群催生防水雨披需求,Shopee 多个站点冲上骑行配件热销榜。',
  },
  {
    zh: '沙特女性运动风潮:轻量运动头巾成为新品类',
    en: 'sports hijab saudi arabia activewear',
    category: '服饰', platforms: ['TikTok', 'Instagram', 'Temu'],
    startOffset: 6, days: 7, peak: 75, base: 3900, region: '中东', kw: ['沙特', '中东', '利雅得'],
    summary: '沙特女性运动参与度上升,透气轻量运动头巾成为新品类,「sports hijab」话题在 TikTok 持续升温。',
  },
  {
    zh: '俄罗斯便携电暖手宝:跨境卖家冬季爆款之争',
    en: 'portable hand warmer power bank russia',
    category: '3C数码', platforms: ['Temu', 'TikTok', 'YouTube'],
    startOffset: 5, days: 5, peak: 77, base: 4400, region: '俄罗斯', kw: ['俄罗斯', '冬季', '保暖'],
    summary: '俄罗斯冬季漫长,便携电暖手宝(兼充电宝)成为跨境卖家争抢的爆款,测评视频集中在俄语区上线。',
  },
  {
    zh: '德国自行车通勤热:防水单车包成城市爆款',
    en: 'waterproof bike bag commuter germany',
    category: '运动户外', platforms: ['Amazon', 'YouTube', 'Reddit'],
    startOffset: 6, days: 7, peak: 70, base: 3200, region: '欧洲', kw: ['德国', '柏林', '欧洲'],
    summary: '德国自行车通勤比例攀升,防水单车包(车架包/尾包)在亚马逊德国站走红,通勤装备类目整体升温。',
  },
  {
    zh: '阿联酋斋月礼盒预热:定制椰枣礼盒提前爆单',
    en: 'ramadan date gift box uae custom',
    category: '食品', platforms: ['TikTok', 'TikTok Shop', 'Instagram'],
    startOffset: 7, days: 8, peak: 74, base: 3700, region: '中东', kw: ['阿联酋', '迪拜', '中东', '斋月'],
    summary: '斋月礼盒提前进入备货周期:定制包装椰枣礼盒在阿联酋电商走俏,企业团购订单开始放出。',
  },
  {
    zh: '墨西哥城街头小吃酱料包走红,「辣酱平替」搜索暴涨',
    en: 'mexican street food hot sauce packets',
    category: '食品', platforms: ['TikTok Shop', 'Shopee', 'Temu'],
    startOffset: 8, days: 9, peak: 66, base: 2800, region: '墨西哥', kw: ['墨西哥', '墨西哥城', '拉美'],
    summary: '墨西哥城街头小吃文化被短视频带火,便携酱料包成为「在家复刻」的入门单品,搜索量一路上涨。',
  },
  {
    zh: '法国禁塑令带动可折叠购物袋潮流',
    en: 'foldable shopping bag france plastic ban',
    category: '其他', platforms: ['Instagram', 'TikTok', '新闻'],
    startOffset: 8, days: 9, peak: 63, base: 2500, region: '欧洲', kw: ['法国', '巴黎', '欧洲'],
    summary: '法国禁塑令落地后,设计感可折叠购物袋成为日常配饰,法式简约风品牌账号借势涨粉。',
  },
  {
    zh: '日本梅雨季:除湿+香薰二合一产品在日区热卖',
    en: 'dehumidifier aroma diffuser japan rainy season',
    category: '家居', platforms: ['TikTok', 'Amazon', '新闻'],
    startOffset: 9, days: 10, peak: 69, base: 3000, region: '日本', kw: ['日本', '东京', '梅雨季'],
    summary: '日本梅雨季潮湿难耐,除湿与香薰二合一的小家电在日区电商热卖,「房间不闷」成为核心卖点。',
  },
  {
    zh: '迪拜「沙漠露营」装备热卖,便携冰盒成爆款',
    en: 'desert camping portable ice cooler dubai',
    category: '运动户外', platforms: ['TikTok', 'Instagram', 'Temu'],
    startOffset: 9, days: 10, peak: 72, base: 3400, region: '中东', kw: ['迪拜', '阿联酋', '中东'],
    summary: '沙漠露营在迪拜年轻人中流行,大容量便携冰盒成为必备单品,TikTok 露营收纳视频带火周边装备。',
  },
  {
    zh: '巴西持妆粉底挑战:高温天气下「24 小时不脱妆」',
    en: 'long lasting foundation brazil heat',
    category: '美妆个护', platforms: ['TikTok', 'Instagram', 'Temu'],
    startOffset: 10, days: 11, peak: 76, base: 4000, region: '拉美', kw: ['巴西', '拉美', '圣保罗'],
    summary: '巴西博主发起「高温持妆挑战」,主打防汗持妆的粉底液在拉美市场走红,防晒系底妆搜索联动上涨。',
  },
  {
    zh: '北欧极简风:模块化收纳架在欧洲家居类目升温',
    en: 'modular shelf organizer nordic minimalism',
    category: '家居', platforms: ['Amazon', 'Instagram', 'YouTube'],
    startOffset: 10, days: 11, peak: 65, base: 2700, region: '欧洲', kw: ['北欧', '瑞典', '欧洲'],
    summary: '北欧极简收纳美学在欧洲家居内容里升温,模块化收纳架(自由拼装)带动客厅与书房改造类内容增长。',
  },
  {
    zh: '印尼美妆出海:清真认证口红搜索量翻三倍',
    en: 'halal certified lipstick indonesia makeup',
    category: '美妆个护', platforms: ['TikTok Shop', 'Shopee', 'TikTok'],
    startOffset: 7, days: 8, peak: 71, base: 3300, region: '东南亚', kw: ['印尼', '雅加达', '东南亚', '清真'],
    summary: '印尼美妆消费升级,带清真认证的口红/唇釉搜索量翻三倍,「halal beauty」话题在 Shopee 直播带货中高频出现。',
  },
  {
    zh: '美国后院经济:户外披萨炉成中产新玩具',
    en: 'outdoor pizza oven backyard usa',
    category: '运动户外', platforms: ['TikTok', 'Amazon', 'YouTube', 'Temu'],
    startOffset: 5, days: 5, peak: 78, base: 4300, region: '美国', kw: ['美国', '德州', '后院'],
    summary: '美国「后院经济」持续升温,家用户外披萨炉成为中产家庭新玩具,开箱与对比测评视频密集上线。',
  },
  {
    zh: '美国返校季:透明果冻背包成 TikTok 爆款',
    en: 'clear jelly backpack back to school usa',
    category: '其他', platforms: ['TikTok', 'TikTok Shop', 'Amazon'],
    startOffset: 2, days: 4, peak: 74, base: 3600, region: '美国', kw: ['美国', '返校季'],
    summary: '美国返校季,透明果冻背包因「一眼看见包里有什么」的校园安全检查卖点走红,衍生挂饰搭配内容爆发。',
  },
];

// ---------- 平台信号模板 ----------

function signalTemplates(theme, rng) {
  const t = theme.en;
  return {
    TikTok: [
      { title: `POV: the ${t} trend changed my life 🤯 #viral #musthave`, extra: { views: Math.round(theme.base * 40 * (0.6 + rng())) }, text: 'Comment section is full of "I need this" — the algorithm is pushing this to every feed.' },
      { title: `Trying the viral ${t} so you don't have to #honestreview`, extra: { views: Math.round(theme.base * 25 * (0.6 + rng())) }, text: 'Honest 60-second review with before/after demo and price breakdown.' },
      { title: `${t}: the before/after glow up compilation`, extra: { views: Math.round(theme.base * 18 * (0.6 + rng())) }, text: 'Compilation edit set to trending audio, stitching user submissions.' },
    ],
    X: [
      { title: `the ${t} thing is EVERYWHERE rn and honestly...`, extra: { likes: Math.round(theme.base * 2 * (0.6 + rng())) }, text: 'Thread unpacking why this blew up, quote-tweeted by niche accounts.' },
      { title: `unpopular opinion: ${t} is overrated, fight me`, extra: { likes: Math.round(theme.base * 1.2 * (0.6 + rng())) }, text: 'Hot take with heavy quote-tweet engagement.' },
    ],
    Instagram: [
      { title: `aesthetic ${t} flatlay ✨ saved to my wishlist`, extra: { likes: Math.round(theme.base * 4 * (0.6 + rng())) }, text: 'Flatlay photo with trending audio, tagged with #fyp #aesthetic.' },
      { title: `reel: ${t} unboxing in 15 seconds`, extra: { likes: Math.round(theme.base * 3 * (0.6 + rng())) }, text: 'Fast-cut unboxing reel, top comment: "link please".' },
    ],
    Reddit: [
      { title: `What's the deal with the ${t} trend? (r/AskReddit)`, extra: { score: Math.round(theme.base * 0.8 * (0.6 + rng())), comments: Math.round(theme.base * 0.08) }, text: 'OP asks why this blew up; top answer breaks down the cultural moment.' },
      { title: `r/BuyItForLife: ${t} worth it or hype?`, extra: { score: Math.round(theme.base * 0.6 * (0.6 + rng())), comments: Math.round(theme.base * 0.06) }, text: 'Skeptics vs converts debate quality and longevity.' },
    ],
    YouTube: [
      { title: `I Used the ${t} Every Day for 30 Days — Results`, extra: { views: Math.round(theme.base * 60 * (0.6 + rng())) }, text: 'Long-form test video, chapters and honest verdict.' },
      { title: `${t} Explained: Why It's Suddenly Everywhere`, extra: { views: Math.round(theme.base * 30 * (0.6 + rng())) }, text: 'Trend explainer with timeline and numbers.' },
    ],
    Amazon: [
      { title: `Bestseller: ${t} — jumped to #${3 + Math.floor(rng() * 40)} in its category`, extra: { rank: 3 + Math.floor(rng() * 40), reviews: Math.round(theme.base * 0.3), price: roundPrice(9 + rng() * 60) }, text: 'Sales rank jumped this week; recent reviews mention seeing it on social.' },
    ],
    'TikTok Shop': [
      { title: `${t} — daily GMV breakout, affiliated creators +${20 + Math.floor(rng() * 80)}%`, extra: { gmv: Math.round(theme.base * 10 * (0.6 + rng())), creators: 20 + Math.floor(rng() * 80) }, text: 'Affiliate video volume spiked after a mid-tier creator went viral.' },
    ],
    Shopee: [
      { title: `${t} — trending search +${100 + Math.floor(rng() * 400)}% in SEA markets`, extra: { searchDelta: 100 + Math.floor(rng() * 400), sold: Math.round(theme.base * 0.5 * (0.6 + rng())) }, text: 'Search ranking rising across SEA; multiple stores listing similar SKUs.' },
    ],
    Temu: [
      { title: `${t} — Temu 站内搜索热度 +${100 + Math.floor(rng() * 300)}%,低价链接被疯转`, extra: { gmv: Math.round(theme.base * 8 * (0.6 + rng())) }, text: 'Temu search ranking climbing; multiple low-price listings appearing with strong repurchase signals.' },
    ],
    新闻: [
      { title: `Why the ${t} is this season's surprise consumer hit`, extra: {}, text: 'Industry press piece connecting the trend to broader consumer shifts.' },
    ],
  };
}

function roundPrice(x) {
  return Math.max(4.99, Math.round(x * 2) / 2 - 0.01);
}

// ---------- 生命周期曲线 ----------

function heatCurve(peak, days, i, rng) {
  const start = 18 + Math.floor(rng() * 12);
  const end = 25 + Math.floor(rng() * 18);
  const peakDay = Math.round(days * 0.6);
  let score;
  if (i <= peakDay) {
    score = start + ((peak - start) * i) / Math.max(1, peakDay);
  } else {
    score = peak - ((peak - end) * (i - peakDay)) / Math.max(1, days - 1 - peakDay);
  }
  return clamp(Math.round(score + (rng() - 0.5) * 6), 8, 99);
}

function stageOf(i, peakDay, days) {
  if (i === 0) return '萌芽';
  if (i < peakDay) return '上升';
  if (i === peakDay) return '峰值';
  return '衰退';
}

// ---------- 主流程 ----------

function engagementOf(platform, extra) {
  switch (platform) {
    case 'TikTok':
    case 'YouTube':
      return Math.round((extra.views || 0) / 100);
    case 'X':
      return Math.round(extra.likes || 0);
    case 'Instagram':
      return Math.round(extra.likes || 0);
    case 'Reddit':
      return (extra.score || 0) + (extra.comments || 0) * 10;
    case 'Amazon':
      return Math.max(50, Math.round(1000 - (extra.rank || 500)) * 2 + (extra.reviews || 0) * 3);
    case 'TikTok Shop':
    case 'Temu':
      return Math.round((extra.gmv || 0) / 10);
    case 'Shopee':
      return Math.round((extra.sold || 0) * 2);
    default:
      return 60;
  }
}

export function reseed() {
  // 幂等重置:清掉全部 demo 行(级联清 hotspot_signals),信号独立清理
  const now = nowIso();
  db.prepare(`DELETE FROM hotspots WHERE source_type = 'demo'`).run();
  db.prepare(`DELETE FROM signals WHERE source_type = 'demo'`).run();

  const rng = mulberry32(20260917);
  let hotspotCount = 0;
  let signalCount = 0;

  const insSignal = db.prepare(`INSERT INTO signals
    (source, platform, source_type, url, title, text, author, published_at, collected_at, engagement, extra, dedup_key)
    VALUES (?, ?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insHotspot = db.prepare(`INSERT INTO hotspots
    (date, title, summary, category, keywords, heat_score, heat_trend, lifecycle, heat_series, signal_count, source_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)`);
  const linkSignal = db.prepare(`INSERT OR IGNORE INTO hotspot_signals (hotspot_id, signal_id, is_original) VALUES (?, ?, ?)`);

  for (const theme of THEMES) {
    // 生成该主题的全套信号(发布时刻按主题周期分布)
    const templates = signalTemplates(theme, rng);
    const platforms = theme.platforms.filter((p) => templates[p]);
    const themeSignals = [];
    const startDate = addDays(TODAY, -theme.startOffset);

    for (const p of platforms) {
      const pool = templates[p];
      // 每条模板生成 1 条信号
      pool.forEach((tmpl) => {
        const published = new Date(
          `${startDate}T${String(7 + Math.floor(rng() * 14)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}:00`
        );
        const engagement = engagementOf(p, tmpl.extra);
        const slug = theme.en.replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const r = insSignal.run(
          'demo',
          p,
          `https://example.com/demo/${p.toLowerCase().replace(/\s+/g, '-')}/${slug}-${signalCount + 1}`,
          tmpl.title,
          tmpl.text,
          p === 'X' ? '@demo_user' : p === 'Reddit' ? 'u/demo_user' : '',
          published.toISOString(),
          now,
          engagement,
          JSON.stringify(tmpl.extra),
          `demo:${slug}:${p}:${signalCount + 1}`
        );
        themeSignals.push({ id: Number(r.lastInsertRowid), engagement, platform: p });
        signalCount++;
      });
    }
    themeSignals.sort((a, b) => b.engagement - a.engagement);

    // 主题活跃期内每天生成一张日历卡片
    const peakDay = Math.round(theme.days * 0.6);
    const series = [];
    for (let i = 0; i < theme.days; i++) {
      const day = addDays(startDate, i);
      if (day > TODAY) break; // 不生成未来日期
      const score = heatCurve(theme.peak, theme.days, i, rng);
      series.push([day, score]);
      const trend = i === 0 ? 'new' : series[i - 1][1] < score - 3 ? 'up' : series[i - 1][1] > score + 3 ? 'down' : 'flat';
      const r = insHotspot.run(
        day,
        theme.zh,
        theme.summary,
        theme.category,
        JSON.stringify([
          ...theme.en.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 6),
          ...(theme.region ? [theme.region] : []),
          ...(theme.kw || []),
        ]),
        score,
        trend,
        stageOf(i, peakDay, theme.days),
        JSON.stringify(series),
        themeSignals.length,
        now,
        now
      );
      const hid = Number(r.lastInsertRowid);
      themeSignals.slice(0, 4).forEach((s) => linkSignal.run(hid, s.id, 1));
      themeSignals.slice(4).forEach((s) => linkSignal.run(hid, s.id, 0));
      hotspotCount++;
    }
  }

  metaSet('seeded', '1');
  metaSet('seed_at', now);
  return { hotspots: hotspotCount, signals: signalCount };
}

export function autoSeedIfEmpty() {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM hotspots`).get().n;
  if (n === 0) {
    const r = reseed();
    console.log(`[seed] 库为空,已自动生成演示数据:${r.hotspots} 条热点 / ${r.signals} 条信号`);
    return r;
  }
  return null;
}

// CLI:npm run seed
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const r = reseed();
  console.log(`[seed] 演示数据已重置:${r.hotspots} 条热点 / ${r.signals} 条信号(截至 ${TODAY})`);
}

// 规则关键词 → 品类(中英双语词表,命中即归)
const RULES = [
  {
    category: '美妆个护',
    keys: ['makeup', 'beauty', 'skincare', 'cosmetic', 'lash', 'lipstick', 'sunscreen', 'serum', 'perfume', 'fragrance', 'nail', 'hair', '美妆', '护肤', '口红', '香水', '假睫毛', '防晒', '粉底', '眼影', '美甲'],
  },
  {
    category: '3C数码',
    keys: ['iphone', 'phone', 'smartphone', 'laptop', 'macbook', 'gadget', 'headphone', 'earbud', 'charger', 'power bank', 'keyboard', 'camera', 'drone', 'ai', 'app', 'software', 'robot', 'chip', 'gpu', '手机', '耳机', '充电宝', '键盘', '相机', '无人机', '芯片', '电脑', '数码'],
  },
  {
    category: '家居',
    keys: ['home', 'kitchen', 'organizer', 'storage', 'lamp', 'tumbler', 'bottle', 'candle', 'furniture', 'decor', 'cleaner', 'vacuum', 'laundry', 'washer', 'mug', '家居', '收纳', '灯', '水杯', '香薰', '家具', '清洁', '洗衣'],
  },
  {
    category: '服饰',
    keys: ['fashion', 'clothing', 'dress', 'shoes', 'heels', 'sneaker', 'jacket', 'outfit', 'wear', 'bag', 'accessory', '服饰', '鞋', '高跟鞋', '穿搭', '衣服', '包', '配饰'],
  },
  {
    category: '母婴宠物',
    keys: ['baby', 'kids', 'toddler', 'mom', 'parenting', 'pet', 'dog', 'cat', 'stroller', 'diaper', 'collar', '母婴', '婴儿', '宝宝', '宠物', '猫', '狗', '推车', '尿布', '育儿'],
  },
  {
    category: '食品',
    keys: ['food', 'snack', 'chips', 'drink', 'coffee', 'matcha', 'protein', 'latte', 'candy', 'recipe', 'cooking', '食品', '零食', '咖啡', '抹茶', '饮料', '食谱', '蛋白'],
  },
  {
    category: '运动户外',
    keys: ['fitness', 'gym', 'camping', 'tent', 'hiking', 'running', 'yoga', 'outdoor', 'sport', 'bike', 'fishing', '健身', '露营', '帐篷', '户外', '瑜伽', '跑步', '骑行', '钓鱼'],
  },
];

export function guessCategory(title = '', text = '') {
  const hay = (title + ' ' + text).toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some((k) => hay.includes(k))) return rule.category;
  }
  return '其他';
}

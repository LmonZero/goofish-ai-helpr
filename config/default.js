const path = require('path');

module.exports = {
    // 搜索关键词
    keyword: '',

    // 浏览器用户数据目录名
    dataName: 'demo',

    // 是否无头模式
    headless: true,

    // 浏览器视口
    viewport: { width: 1366, height: 768 },

    // User-Agent（不设置 → 使用 patchright Chromium 原生 UA）
    // 原因：自定义 UA 版本号与实际 Chromium 内核不匹配会被闲鱼检测拦截
    // HeadlessChrome 标识在 BaseScraper.init + anti-detect.js 中自动替换为 Chrome
    // 如需自定义，确保版本号与 Chromium 内核匹配（当前: 147.x）
    userAgent: '',

    // 地区设置
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    geolocation: { longitude: 116.397, latitude: 39.908 },

    // 页面加载超时(ms)
    pageLoadTimeout: 10000,

    // 页面加载后等待时间(ms)
    pageLoadDelay: 5000,

    // 登录二维码等待超时(ms)
    loginTimeout: 60000,

    // AI 分析相关
    intelligent: false,                // 启用深度思考
    prompt: [],                       // 提示词文件路径列表

    // 附加输入信息（传给 AI 的补充上下文）
    inputinfo: '',

    // 数据新鲜度阈値（天）—— 商品/卖家在此期限内已采集则跳过重新爬取
    freshTTLDays: 7,

    // 搜索最大翻页数（0 = 翻到最后一页为止）
    maxPages: 0,
    phtoneDomain: 'https://h5.m.goofish.com',

    // 钉钉通知地址
    ddUrl: '',

    // SQLite 数据库路径
    dbPath: path.join(__dirname, '..', 'DB', 'xianyu.db'),
};

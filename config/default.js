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

    // User-Agent
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',

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
    intelligent: true,                // 启用深度思考
    prompt: [],                       // 提示词文件路径列表

    // 附加输入信息（传给 AI 的补充上下文）
    inputinfo: '',

    // 重复筛查间隔(天)
    againDay: 2,

    // 非捡漏商品忽略间隔(天)
    bargainDay: 7,

    // 手机端域名（用于生成跳转链接）
    phtoneDomain: 'https://h5.m.goofish.com',

    // 钉钉通知地址
    ddUrl: '',

    // SQLite 数据库路径
    dbPath: path.join(__dirname, '..', 'DB', 'xianyu.db'),
};

const path = require('path');
const { chromium } = require('patchright');
const antiDetectScript = require('../lib/anti-detect');

/**
 * 数据采集器抽象基类
 *
 * 设计原则：API 监听优先，Selector 仅用于操作触发
 * - 数据获取：通过 page.on('response') / waitForApiResponse() 拦截 API JSON 响应
 * - 操作触发：用最少的 selector 做点击/滚动，仅触发请求，不提取数据
 * - 兜底方案：极少数场景用 page.evaluate() 取 JS 运行时数据
 *
 * 反检测策略：
 * - 底层：patchright（Playwright 反检测补丁版，消除 CDP 自动化特征）
 * - 注入层：addInitScript 补充指纹伪装（Canvas/WebGL/Audio/Screen 等）
 * - 行为层：随机延迟、模拟人类操作节奏（子类按需使用）
 *
 * 子类需定义：
 *   - static API_PATTERNS      需要监听的 API URL 匹配模式 { name: RegExp }
 *   - static TRIGGER_SELECTORS  仅用于操作触发的选择器 { name: string }
 *
 * 子类必须实现：
 *   - search(keyword)           执行搜索
 *   - scrapeProduct(url)        抓取商品详情
 */
class BaseScraper {

    /**
     * @param {object} options - 配置项（来自 config/default.js 合并用户配置）
     */
    constructor(options = {}) {
        this.options = options;
        this.context = null;
        this.userDataDir = path.join(__dirname, '..', 'UserData', options.dataName || 'demo');

        // API 响应缓存：name -> { url, body, timestamp }
        this._apiResponses = new Map();
    }

    // ======================== 生命周期 ========================

    /**
     * 初始化浏览器持久化上下文 + 注入反检测脚本
     *
     * 反检测分两层：
     *   1. patchright 底层已消除 CDP 自动化特征（navigator.webdriver、Runtime.enable 泄露等）
     *   2. context.addInitScript 补充指纹伪装：Canvas/WebGL/Audio/Screen/Plugins 等
     *      上下文级别注入 → 该上下文中所有页面自动生效
     *
     * @returns {Promise<BrowserContext>}
     */
    async init() {
        const opts = this.options;

        // 修正 User-Agent：确保 HTTP 头和 JS 层都不暴露 HeadlessChrome
        //   1. HTTP 请求头：launchPersistentContext 的 userAgent 参数
        //   2. JS 层 navigator.userAgent：anti-detect.js 中处理
        // 如果未自定义 UA → 使用 Chromium 原生 UA 但把 HeadlessChrome 替换为 Chrome
        let ua = opts.userAgent;
        if (!ua) {
            // 不设自定义 UA → 先用原生启动，但 Chromium 默认 UA 含 HeadlessChrome
            // 直接将 HeadlessChrome 替换为 Chrome 作为 userAgent 参数
            // 格式固定：Mozilla/5.0 (...) HeadlessChrome/XXX Safari/537.36
            ua = undefined;  // 先不设，下面获取后再设
        }

        this.context = await chromium.launchPersistentContext(this.userDataDir, {
            headless: opts.headless,
            userAgent: ua,
            viewport: opts.viewport,
            locale: opts.locale,
            timezoneId: opts.timezoneId,
            geolocation: opts.geolocation,
            permissions: ['geolocation'],
            colorScheme: 'light',
            extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9' },
        });

        // 如果未自定义 UA，获取 Chromium 原生 UA 并修正 HeadlessChrome
        if (!opts.userAgent) {
            const testPage = await this.context.newPage();
            const realUA = await testPage.evaluate(() => navigator.userAgent);
            await testPage.close();
            const fixedUA = realUA.replace('HeadlessChrome/', 'Chrome/');
            // 对上下文中所有现有页面设置 UA override
            for (const page of this.context.pages()) {
                try {
                    const cdpSession = await this.context.newCDPSession(page);
                    await cdpSession.send('Network.setUserAgentOverride', {
                        userAgent: fixedUA,
                    });
                } catch { /* 某些页面可能无法创建 CDP session */ }
            }
            console.log(`[BaseScraper] UA 已修正: ${fixedUA}`);
        }

        // 上下文级别注入反检测脚本 → 所有页面自动生效
        await this.context.addInitScript(antiDetectScript);

        return this.context;
    }

    /**
     * 关闭浏览器上下文
     */
    async close() {
        if (this.context) {
            await this.context.close();
            console.log(`已关闭持久化上下文，浏览器数据保存在 ${this.userDataDir} 目录`);
            this.context = null;
        }
    }

    // ======================== 页面与反检测 ========================

    /**
     * 创建新页面
     *
     * 反检测脚本已在 init() 中通过 context.addInitScript() 注入，
     * 该上下文中的所有页面自动生效，无需再次注入。
     *
     * @returns {Promise<Page>}
     */
    async newPage() {
        return await this.context.newPage();
    }

    // ======================== API 监听基础设施 ========================

    /**
     * 在页面上注册 API 响应监听器
     *
     * 当响应 URL 匹配子类定义的 API_PATTERNS 时，自动缓存解析后的 JSON
     * 典型用法：子类在 page 上调用此方法 → 触发页面操作 → waitForApiResponse() 等待数据
     *
     * @param {Page} page - 目标页面
     * @param {object} [patterns] - URL 匹配规则 { name: RegExp }，默认使用子类 static API_PATTERNS
     */
    listenApiResponses(page, patterns = null) {
        const apiPatterns = patterns || this.constructor.API_PATTERNS || {};

        page.on('response', async (response) => {
            const url = response.url();
            try {
                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('application/json') && !contentType.includes('text/json')) return;

                for (const [name, pattern] of Object.entries(apiPatterns)) {
                    if (pattern.test(url)) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            this._apiResponses.set(name, { url, body, timestamp: Date.now() });
                            console.log(`[API监听] 捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                        break;
                    }
                }
            } catch (_) {
                // 忽略解析错误
            }
        });
    }

    /**
     * 等待特定 API 响应被捕获（阻塞直到命中）
     *
     * @param {string} name - API_PATTERNS 中的 key
     * @param {number} [timeout=15000] - 超时时间(ms)
     * @returns {Promise<{url: string, body: object, timestamp: number}|null>}
     */
    async waitForApiResponse(name, timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this._apiResponses.has(name)) {
                const cached = this._apiResponses.get(name);
                this._apiResponses.delete(name); // 取后即焚
                return cached;
            }
            await this._sleep(300);
        }
        console.log(`[API监听] 等待 ${name} 超时 (${timeout}ms)`);
        return null;
    }

    /**
     * 获取已缓存的 API 响应（非阻塞）
     * @param {string} name
     * @returns {{url: string, body: object, timestamp: number}|null}
     */
    getApiResponse(name) {
        const cached = this._apiResponses.get(name);
        if (cached) this._apiResponses.delete(name);
        return cached || null;
    }

    /**
     * 清空 API 响应缓存
     */
    clearApiCache() {
        this._apiResponses.clear();
    }

    /**
     * 使用 Playwright 原生方式等待特定 URL 的响应（一次性监听，不依赖内部缓存）
     *
     * @param {Page} page
     * @param {RegExp|string} urlPattern - URL 匹配模式
     * @param {number} [timeout=15000]
     * @returns {Promise<object|null>} 解析后的 JSON body
     */
    async waitForResponse(page, urlPattern, timeout = 15000) {
        try {
            const response = await page.waitForResponse(
                (res) => {
                    const url = res.url();
                    if (urlPattern instanceof RegExp) return urlPattern.test(url);
                    return url.includes(urlPattern);
                },
                { timeout }
            );
            return await response.json().catch(() => null);
        } catch (_) {
            console.log(`[API监听] waitForResponse 超时: ${urlPattern}`);
            return null;
        }
    }

    // ======================== 子类需定义 ========================

    /** @type {Object<string, RegExp>} 子类定义需要监听的 API URL 模式 */
    static API_PATTERNS = {};

    /** @type {Object<string, string>} 子类定义仅用于操作触发的选择器 */
    static TRIGGER_SELECTORS = {};

    // ======================== 子类必须实现 ========================

    /**
     * 执行搜索
     * @param {string} keyword
     * @returns {Promise<*>}
     */
    async search(keyword) {
        throw new Error('子类必须实现 search()');
    }

    /**
     * 抓取商品详情
     * @param {string} url
     * @returns {Promise<object|null>}
     */
    async scrapeProduct(url) {
        throw new Error('子类必须实现 scrapeProduct()');
    }

    // ======================== 工具方法 ========================

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BaseScraper;

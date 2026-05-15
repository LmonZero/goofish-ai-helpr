const path = require('path');
const { chromium } = require('patchright');

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
     * 初始化浏览器持久化上下文
     * @returns {Promise<BrowserContext>}
     */
    async init() {
        const opts = this.options;
        this.context = await chromium.launchPersistentContext(this.userDataDir, {
            headless: opts.headless,
            userAgent: opts.userAgent,
            viewport: opts.viewport,
            locale: opts.locale,
            timezoneId: opts.timezoneId,
            geolocation: opts.geolocation,
            permissions: ['geolocation'],
            colorScheme: 'light',
            extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9' },
        });
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
     * 创建新页面并注入反检测脚本
     *
     * 反检测分两层：
     *   1. patchright 底层已消除 CDP 自动化特征（navigator.webdriver、Runtime.enable 泄露等）
     *   2. addInitScript 补充指纹伪装：Canvas/WebGL/Audio/Screen/Plugins 等
     *
     * @returns {Promise<Page>}
     */
    async newPage() {
        const page = await this.context.newPage();

        await page.addInitScript(() => {
            // ===== navigator 属性伪装 =====
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
            Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

            // ===== plugins 伪装（真实 Chrome 插件结构）=====
            const fakePlugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            ];
            const pluginArray = Object.create(PluginArray.prototype);
            for (let i = 0; i < fakePlugins.length; i++) {
                const p = fakePlugins[i];
                const plugin = Object.create(Plugin.prototype);
                Object.defineProperties(plugin, {
                    name: { get: () => p.name, enumerable: true },
                    filename: { get: () => p.filename, enumerable: true },
                    description: { get: () => p.description, enumerable: true },
                    length: { get: () => 0, enumerable: true },
                });
                Object.defineProperty(pluginArray, i, { get: () => plugin, enumerable: true });
            }
            Object.defineProperties(navigator, {
                plugins: { get: () => pluginArray, configurable: true },
                mimeTypes: { get: () => Object.create(MimeTypeArray.prototype), configurable: true },
            });

            // ===== Chrome 运行时伪装 =====
            // 注意：loadTimes/csi 在 Chrome 71+ 已弃用，新浏览器中不存在这些 API
            // 只有在页面本身访问时才注入，避免"不该有的反而有"的检测
            if (!window.chrome) {
                window.chrome = {};
            }
            if (!window.chrome.runtime) {
                window.chrome.runtime = { connect: function () { }, sendMessage: function () { } };
            }
            if (!window.chrome.app) {
                window.chrome.app = { isInstalled: false };
            }

            // ===== Permissions API 伪装 =====
            const originalQuery = window.navigator.permissions?.query;
            if (originalQuery) {
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery.call(window.navigator.permissions, parameters)
                );
            }

            // ===== WebGL 渲染器伪装（避免 Headless 特征）=====
            const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (param) {
                // UNMASKED_VENDOR_WEBGL
                if (param === 37445) return 'Google Inc. (NVIDIA)';
                // UNMASKED_RENDERER_WEBGL
                if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParameterOrig.call(this, param);
            };
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const getParameter2Orig = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function (param) {
                    if (param === 37445) return 'Google Inc. (NVIDIA)';
                    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParameter2Orig.call(this, param);
                };
            }

            // ===== Canvas 指纹加噪（toDataURL + toBlob 保持一致）=====
            const _canvasNoise = (ctx, w, h) => {
                try {
                    const imgData = ctx.getImageData(0, 0, w, h);
                    for (let i = 0; i < imgData.data.length; i += 4 * 37) {
                        imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + (Math.random() > 0.5 ? 1 : -1)));
                    }
                    ctx.putImageData(imgData, 0, 0);
                } catch (_) { }
            };
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function () {
                if (this.width === 0 || this.height === 0) return origToDataURL.apply(this, arguments);
                const ctx = this.getContext('2d');
                if (ctx) _canvasNoise(ctx, this.width, this.height);
                return origToDataURL.apply(this, arguments);
            };
            const origToBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function () {
                if (this.width === 0 || this.height === 0) return origToBlob.apply(this, arguments);
                const ctx = this.getContext('2d');
                if (ctx) _canvasNoise(ctx, this.width, this.height);
                return origToBlob.apply(this, arguments);
            };

            // ===== iframe contentWindow 检测修补 =====
            const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: function () {
                    const result = origContentWindow?.get?.call(this);
                    if (result) {
                        try { result.navigator; } catch (e) { return null; }
                    }
                    return result;
                },
                configurable: true,
            });

            // ===== 屏幕与窗口属性（修复 headless 特征）=====
            if (screen.width === 0 || screen.height === 0) {
                Object.defineProperties(screen, {
                    width: { get: () => 1920, configurable: true },
                    height: { get: () => 1080, configurable: true },
                    availWidth: { get: () => 1920, configurable: true },
                    availHeight: { get: () => 1040, configurable: true },
                    colorDepth: { get: () => 24, configurable: true },
                    pixelDepth: { get: () => 24, configurable: true },
                });
            }

            // ===== 外部窗口尺寸修正 =====
            if (window.outerWidth === 0) {
                Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
            }
            if (window.outerHeight === 0) {
                Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });
            }

            // ===== AudioContext 指纹加噪 =====
            const audioCtx = window.AudioContext || window.webkitAudioContext;
            if (audioCtx) {
                const origGetFloatFreqData = AnalyserNode.prototype.getFloatFrequencyData;
                AnalyserNode.prototype.getFloatFrequencyData = function (array) {
                    origGetFloatFreqData.call(this, array);
                    for (let i = 0; i < array.length; i++) {
                        array[i] = array[i] + (Math.random() - 0.5) * 0.001;
                    }
                };
                const origGetChannelData = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function (channel) {
                    const data = origGetChannelData.call(this, channel);
                    for (let i = 0; i < data.length; i += 100) {
                        data[i] = data[i] + (Math.random() - 0.5) * 0.0001;
                    }
                    return data;
                };
            }

            // ===== navigator.connection 伪装 =====
            if (!navigator.connection) {
                Object.defineProperty(navigator, 'connection', {
                    get: () => ({
                        effectiveType: '4g',
                        rtt: 50,
                        downlink: 10,
                        saveData: false,
                        onchange: null,
                        type: 'wifi',
                    }),
                    configurable: true,
                });
            }

            // ===== navigator.getBattery 伪装（避免 headless 无 battery API 暴露）=====
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 1,
                    addEventListener: function () { },
                    removeEventListener: function () { },
                    dispatchEvent: function () { return true; },
                });
            }

            // ===== 阻止 toString 检测（检查函数是否被修改过）=====
            const _origToString = Function.prototype.toString;
            const _patchedFns = new WeakSet();
            const _markPatched = (fn) => { _patchedFns.add(fn); return fn; };
            Function.prototype.toString = function () {
                return _patchedFns.has(this) ? `function ${this.name || ''}() { [native code] }` : _origToString.call(this);
            };
            // 将所有伪装的函数标记
            _markPatched(WebGLRenderingContext.prototype.getParameter);
            _markPatched(HTMLCanvasElement.prototype.toDataURL);
            _markPatched(HTMLCanvasElement.prototype.toBlob);
            if (window.AudioContext || window.webkitAudioContext) {
                _markPatched(AnalyserNode.prototype.getFloatFrequencyData);
                _markPatched(AudioBuffer.prototype.getChannelData);
            }
            _markPatched(Function.prototype.toString);
        });

        return page;
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

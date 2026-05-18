/**
 * AI 分析器抽象基类
 *
 * 设计原则：API 监听优先
 * - 数据获取：通过拦截 AI 服务的 API/SSE 响应来获取分析结果
 * - 操作触发：用最少的 selector 做点击/输入，仅触发请求，不提取数据
 * - 兜底方案：极少数场景用 selector 取 DOM 文本
 *
 * 子类需定义：
 *   - static API_PATTERNS       需要监听的 AI 响应 URL 匹配模式 { name: RegExp }
 *   - static TRIGGER_SELECTORS  仅用于操作触发的选择器 { name: string }
 *
 * 子类必须实现：
 *   - analyze(question, images)  执行 AI 分析
 */
class BaseAnalyzer {

    /**
     * @param {object} options - 配置项
     * @param {import('playwright').BrowserContext} context - 浏览器上下文（由外部注入）
     */
    constructor(options = {}, context = null) {
        this.options = options;
        this.context = context;

        // API 响应缓存：name -> { url, body, timestamp }
        this._apiResponses = new Map();
    }

    /**
     * 设置浏览器上下文（由外部注入）
     * @param {import('playwright').BrowserContext} context
     */
    setContext(context) {
        this.context = context;
    }

    // ======================== API 监听基础设施 ========================

    /**
     * 在页面上注册 API 响应监听器
     *
     * @param {Page} page
     * @param {object} [patterns] - URL 匹配规则 { name: RegExp }，默认使用子类 static API_PATTERNS
     */
    listenApiResponses(page, patterns = null) {
        const apiPatterns = patterns || this.constructor.API_PATTERNS || {};

        page.on('response', async (response) => {
            const url = response.url();
            try {
                const contentType = response.headers()['content-type'] || '';
                const isJson = contentType.includes('application/json') || contentType.includes('text/json');
                const isSSE = contentType.includes('text/event-stream');
                if (!isJson && !isSSE) return;

                for (const [name, pattern] of Object.entries(apiPatterns)) {
                    if (pattern.test(url)) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            this._apiResponses.set(name, { url, body, timestamp: Date.now() });
                            console.log(`[AI监听] 捕获 ${name}: ${url.substring(0, 120)}...`);
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
     * @param {number} [timeout=60000] - AI 响应可能较慢，默认 60s
     * @returns {Promise<{url: string, body: object, timestamp: number}|null>}
     */
    async waitForApiResponse(name, timeout = 60000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this._apiResponses.has(name)) {
                const cached = this._apiResponses.get(name);
                this._apiResponses.delete(name);
                return cached;
            }
            await this._sleep(500);
        }
        console.log(`[AI监听] 等待 ${name} 超时 (${timeout}ms)`);
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
     * @param {RegExp|string} urlPattern
     * @param {number} [timeout=60000]
     * @returns {Promise<object|null>}
     */
    async waitForResponse(page, urlPattern, timeout = 60000) {
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
            console.log(`[AI监听] waitForResponse 超时: ${urlPattern}`);
            return null;
        }
    }

    // ======================== 子类需定义 ========================

    /** @type {Object<string, RegExp>} 子类定义需要监听的 AI 响应 URL 模式 */
    static API_PATTERNS = {};

    /** @type {Object<string, string>} 子类定义仅用于操作触发的选择器 */
    static TRIGGER_SELECTORS = {};

    // ======================== 子类必须实现 ========================

    /**
     * 执行 AI 分析
     * @param {string} question - 完整的提问文本
     * @param {string[]} [images=[]] - 图片文件路径列表
     * @param {boolean} [isBase64=false] - 图片是否为 base64 格式
     * @returns {Promise<object|null>} AI 返回的结构化结果
     */
    async analyze(question, overrides = {}, images = [], isBase64 = false) {
        throw new Error('子类必须实现 analyze()');
    }

    // ======================== 工具方法 ========================

    /**
     * 修复 Playwright SSE 双重编码问题
     *
     * Playwright/Chromium 将 SSE 响应的原始 UTF-8 字节按 Windows-1252 (cp1252) 解码，
     * 再 UTF-8 编码一次。此方法反向操作：将双重编码字符串的每个 Unicode 码点
     * 按 cp1252 反向映射回原始字节，再用 UTF-8 正确解码。
     *
     * 不能简单用 iconv.encode(str,'win1252')，因为 cp1252 在
     * 0x81,0x8D,0x8F,0x90,0x9D 处未定义，iconv 会输出 '?' 替代。
     *
     * @param {string} doubleEncoded - 双重编码的 SSE 文本
     * @returns {string} 正确解码的 UTF-8 文本
     */
    static fixDoubleEncodedSSE(doubleEncoded) {
        // cp1252 0x80-0x9F 区间的特殊映射
        const cp1252Special = {
            0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
            0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
            0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
            0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
            0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
            0x9E: 0x017E, 0x9F: 0x0178
        };

        // 构建 Unicode 码点 → cp1252 字节值 的反向映射表
        const unicodeToByte = {};
        for (const [byte, cp] of Object.entries(cp1252Special)) {
            unicodeToByte[cp] = parseInt(byte);
        }
        for (let i = 0; i <= 0xFF; i++) {
            if (i >= 0x80 && i <= 0x9F && !cp1252Special[i]) continue;
            const cp = cp1252Special[i] || i;
            if (unicodeToByte[cp] === undefined) unicodeToByte[cp] = i;
        }
        // cp1252 未定义字节也映射回去（C1 控制字符）
        for (let i = 0x80; i <= 0x9F; i++) {
            if (!cp1252Special[i] && unicodeToByte[i] === undefined) {
                unicodeToByte[i] = i;
            }
        }

        const rawBytes = [];
        for (const ch of doubleEncoded) {
            const cp = ch.charCodeAt(0);
            const byte = unicodeToByte[cp];
            if (byte !== undefined) {
                rawBytes.push(byte);
            } else {
                const charBuf = Buffer.from(ch, 'utf-8');
                for (const b of charBuf) rawBytes.push(b);
            }
        }
        return Buffer.from(rawBytes).toString('utf-8');
    }

    /**
     * 从 AI 回复文本中提取 JSON 对象
     * @param {string} text
     * @returns {object}
     */
    extractJSON(text) {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('未匹配到 JSON 对象');
        return JSON.parse(match[0]);
    }

    /**
     * 识别二维码并在终端打印
     *
     * 通用工具方法，适用于所有需要扫码登录的 AI 平台子类。
     * 已提取到 lib/qr-utils.js 共用，此处保留接口兼容。
     *
     * @param {string} imagePath - 二维码图片路径
     * @returns {Promise<boolean>} 是否识别成功
     */
    async decodeAndPrintQR(imagePath) {
        const qrUtils = require('../lib/qr-utils');
        const result = await qrUtils.decodeAndPrintQR(imagePath);
        return result.success;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BaseAnalyzer;

const path = require('path');
const fs = require('fs');
const BaseAnalyzer = require('./BaseAnalyzer');

/**
 * 豆包 AI（doubao.com）分析器
 *
 * 核心流程：
 *   1. 打开豆包页面
 *   2. 在输入框填入提问文本 → 触发对话 API
 *   3. 拦截响应（JSON/SSE）→ 提取 AI 回复
 *
 * TODO: 待调试填入
 *   - API_PATTERNS 中的正则（通过 debug 脚本抓包确认）
 *   - TRIGGER_SELECTORS 中的选择器（通过浏览器 F12 确认）
 *   - SSE 响应结构解析逻辑（快照模式 vs 增量模式）
 */
class DoubaoAnalyzer extends BaseAnalyzer {

    /** 需要监听的 AI 响应 URL 模式 */
    static API_PATTERNS = {
        // TODO: 通过 debug 脚本抓包确认豆包的对话 API 端点
        // 示例猜测（需替换）：
        // chatStream: /doubao\.com\/api\/chat\/stream/,
        chatStream: /doubao\.com/,  // 宽泛匹配，调试后收窄
    };

    /** 仅用于操作触发的选择器 */
    static TRIGGER_SELECTORS = {
        // TODO: 通过浏览器 F12 确认以下选择器
        /** 输入框 */
        inputArea: '',  // TODO: 填入输入框选择器
        /** 发送按钮 */
        sendButton: '',  // TODO: 填入发送按钮选择器
        /** 深度思考/深度推理开关按钮 */
        deepThinkToggle: '',  // TODO: 填入深度思考按钮选择器（如有）
        /** 联网搜索开关按钮 */
        networkToggle: '',  // TODO: 填入联网搜索按钮选择器（如有）

        // ======================== 登录相关 ========================
        /** 弹窗关闭按钮 */
        popupCloseBtn: '',  // TODO: 填入弹窗关闭按钮选择器
        /** 登录按钮 */
        loginBtn: '',  // TODO: 填入登录按钮选择器
        /** 二维码所在 iframe（如二维码在 iframe 中） */
        qrCodeIframe: '',  // TODO: 填入二维码 iframe 选择器（如适用）
        /** 二维码图片或登录面板 */
        qrCodeImg: '',  // TODO: 填入二维码/登录面板选择器
        /** 登录成功后出现的头像或其他标志元素 */
        loginSuccessAvatar: '',  // TODO: 填入登录成功标志选择器
    };

    /**
     * @param {object} options
     * @param {boolean} [options.deepThink=false] - 是否启用深度思考/深度推理
     * @param {boolean} [options.network=false] - 是否启用联网搜索
     * @param {number} [options.loginTimeout=120000] - 登录等待超时(ms)
     * @param {number} [options.streamTimeout=120000] - 响应流超时时间(ms)
     */
    constructor(options = {}) {
        super(options);
        this.deepThink = options.deepThink || false;
        this.network = options.network || false;
        this.loginTimeout = options.loginTimeout || 120000;
        this.streamTimeout = options.streamTimeout || 120000;
        this._page = null;
    }

    // ======================== 生命周期 ========================

    /**
     * 初始化：创建页面 + 注册 SSE 专用监听
     * @returns {Promise<Page>}
     */
    async init() {
        if (!this.context) throw new Error('请先通过 setContext() 注入浏览器上下文');

        const pages = this.context.pages();
        this._page = pages.length > 0 ? pages[0] : await this.context.newPage();

        // 注册 SSE 专用监听（覆盖基类的 json-only 监听）
        this._listenSSEStream(this._page);

        // 导航到豆包首页
        await this._page.goto('https://www.doubao.com/', { waitUntil: 'load', timeout: 30000 });

        // 等待关键元素渲染（页面真正就绪）
        try {
            const selectors = this.constructor.TRIGGER_SELECTORS;
            // 优先等待输入框，如果还没填入则等待 body 就绪
            const waitSelector = selectors.inputArea || 'body';
            await this._page.locator(waitSelector).first().waitFor({ state: 'visible', timeout: 5000 });
            console.log('[DoubaoAnalyzer] 页面关键元素已渲染');
        } catch {
            console.log('[DoubaoAnalyzer] 关键元素未出现，继续执行登录流程');
        }

        // 等待登录完成
        await this._waitForLogin();

        return this._page;
    }

    /**
     * 获取当前页面
     * @returns {Page|null}
     */
    getPage() {
        return this._page;
    }

    // ======================== 核心方法 ========================

    /**
     * 执行 AI 分析
     *
     * @param {string} question - 完整的提问文本
     * @param {object} [overrides={}] - 本次调用的临时覆盖选项
     * @param {boolean} [overrides.deepThink] - 临时覆盖深度思考设置
     * @param {boolean} [overrides.network] - 临时覆盖联网搜索设置
     * @param {string[]} [images=[]] - 图片文件路径列表（暂不支持）
     * @param {boolean} [isBase64=false] - 图片是否为 base64 格式（暂不支持）
     * @returns {Promise<{answer: string, think: string, conversationId: string}|null>}
     */
    async analyze(question, overrides = {}, images = [], isBase64 = false) {
        if (!this._page) throw new Error('请先调用 init()');

        // 清空上次缓存
        this.clearApiCache();

        // 1. 按需切换功能开关状态
        const deepThink = overrides.deepThink !== undefined ? overrides.deepThink : this.deepThink;
        const network = overrides.network !== undefined ? overrides.network : this.network;
        await this._toggleDeepThink(deepThink);
        await this._toggleNetwork(network);

        // 2. 填入提问并触发发送
        await this._sendQuestion(question);

        // 3. 等待响应完成
        const result = await this._waitForStreamComplete(question);
        return result;
    }

    // ======================== 内部方法 ========================

    // ---------- 登录流程 ----------

    /**
     * 等待用户登录
     *
     * 流程：
     *   1. 检查是否已登录（登录标志可见）→ 已登录直接返回
     *   2. 关闭弹窗（如有）
     *   3. 点击登录按钮
     *   4. 保存二维码图片到本地，提示用户扫码
     *   5. 轮询等待登录标志出现（登录成功）
     */
    async _waitForLogin() {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 未配置登录标志选择器，跳过登录流程
        if (!selectors.loginSuccessAvatar) {
            console.log('[DoubaoAnalyzer] 未配置登录标志选择器，跳过登录流程');
            return;
        }

        // 1. 检查是否已登录
        try {
            const avatar = page.locator(selectors.loginSuccessAvatar).first();
            if (await avatar.isVisible({ timeout: 3000 })) {
                console.log('[DoubaoAnalyzer] 已登录，跳过登录流程');
                return;
            }
        } catch { /* 未登录，继续 */ }

        console.log('[DoubaoAnalyzer] 未登录，开始登录流程...');

        // 2. 关闭弹窗
        await this._closePopup();

        // 3. 点击登录按钮
        await this._clickLogin();

        // 4. 保存二维码图片
        await this._saveQRCode();

        // 5. 等待登录成功
        console.log('[DoubaoAnalyzer] 等待扫码登录...');
        try {
            const avatar = page.locator(selectors.loginSuccessAvatar).first();
            await avatar.waitFor({ state: 'visible', timeout: this.loginTimeout });
            console.log('[DoubaoAnalyzer] 登录成功！');
        } catch {
            throw new Error(`[DoubaoAnalyzer] 登录超时（${this.loginTimeout / 1000}s），请重试`);
        }
    }

    /**
     * 关闭首页弹窗
     */
    async _closePopup() {
        const page = this._page;
        const selector = this.constructor.TRIGGER_SELECTORS.popupCloseBtn;
        if (!selector) return;

        try {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 3000 })) {
                await closeBtn.click();
                await this._humanDelay(500, 1000);
                console.log('[DoubaoAnalyzer] 弹窗已关闭');
            }
        } catch {
            console.log('[DoubaoAnalyzer] 无弹窗或已关闭');
        }
    }

    /**
     * 点击登录按钮
     */
    async _clickLogin() {
        const page = this._page;
        const selector = this.constructor.TRIGGER_SELECTORS.loginBtn;
        if (!selector) return;

        try {
            const loginBtn = page.locator(selector).first();
            await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
            await loginBtn.click();
            await this._humanDelay(500, 1000);
            console.log('[DoubaoAnalyzer] 已点击登录按钮');
        } catch (e) {
            console.log(`[DoubaoAnalyzer] 登录按钮点击失败: ${e.message}`);
        }
    }

    /**
     * 保存二维码图片到本地并提示用户
     */
    async _saveQRCode() {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        if (!selectors.qrCodeImg) return;

        const outputPath = path.join('./', 'tmp', `doubao_qrcode_${Date.now()}.png`);

        // 尝试不同的截图策略
        const strategies = [
            // 策略1：iframe 内登录面板截图
            async () => {
                if (!selectors.qrCodeIframe) return null;
                const iframe = page.locator(selectors.qrCodeIframe);
                await iframe.waitFor({ state: 'attached', timeout: 5000 });
                const panel = page.locator(selectors.qrCodeImg).first();
                if (await panel.isVisible({ timeout: 3000 })) {
                    await panel.screenshot({ path: outputPath });
                    return { path: outputPath, msg: '登录面板截图' };
                }
                return null;
            },
            // 策略2：直接截取登录面板（非 iframe）
            async () => {
                const panel = page.locator(selectors.qrCodeImg).first();
                if (await panel.isVisible({ timeout: 3000 })) {
                    await panel.screenshot({ path: outputPath });
                    return { path: outputPath, msg: '登录面板截图' };
                }
                return null;
            },
            // 策略3：页面全局搜索二维码图片
            async () => {
                const qrSelectors = ['img.qrcode', 'img[src*="qrcode"]', 'img[src*="qr"]'];
                for (const sel of qrSelectors) {
                    const el = page.locator(sel).first();
                    if (await el.isVisible({ timeout: 2000 })) {
                        await el.screenshot({ path: outputPath });
                        return { path: outputPath, msg: `页面元素 ${sel} 截图` };
                    }
                }
                return null;
            },
        ];

        for (const strategy of strategies) {
            let result = null;
            try {
                result = await strategy();
                if (result) {
                    console.log(`[DoubaoAnalyzer] 二维码已保存: ${result.path} (${result.msg})`);
                    const flag = await this.decodeAndPrintQR(result.path);
                    if (flag) {
                        console.log('[DoubaoAnalyzer] 请扫描二维码登录');
                        return;
                    }
                }
            } catch {
                // 当前策略失败，继续下一个
            } finally {
                if (result && result.path && fs.existsSync(result.path))
                    fs.unlinkSync(result.path);
            }
        }

        console.log('[DoubaoAnalyzer] 请在浏览器窗口中手动扫码登录');
    }

    // ---------- 功能开关 ----------

    /**
     * 切换深度思考/深度推理模式
     * @param {boolean} enable
     */
    async _toggleDeepThink(enable) {
        const selector = this.constructor.TRIGGER_SELECTORS.deepThinkToggle;
        if (!selector) return;

        const page = this._page;
        try {
            const el = page.locator(selector).first();
            if (!await el.isVisible({ timeout: 2000 })) {
                console.log('[DoubaoAnalyzer] 深度思考按钮不可见，跳过');
                return;
            }

            const classAttr = await el.getAttribute('class').catch(() => null);
            const isCurrentlyOn = classAttr && classAttr.includes('selected');

            if (enable !== isCurrentlyOn) {
                await el.click();
                await this._humanDelay(300, 600);
                console.log(`[DoubaoAnalyzer] 深度思考: ${enable ? '已开启' : '已关闭'}`);
            } else {
                console.log(`[DoubaoAnalyzer] 深度思考: 已是${enable ? '开启' : '关闭'}状态，无需切换`);
            }
        } catch (e) {
            console.log(`[DoubaoAnalyzer] 深度思考切换失败: ${e.message}`);
        }
    }

    /**
     * 切换联网搜索模式
     * @param {boolean} enable
     */
    async _toggleNetwork(enable) {
        const selector = this.constructor.TRIGGER_SELECTORS.networkToggle;
        if (!selector) return;

        const page = this._page;
        try {
            const el = page.locator(selector).first();
            if (!await el.isVisible({ timeout: 2000 })) {
                console.log('[DoubaoAnalyzer] 联网搜索按钮不可见，跳过');
                return;
            }

            const classAttr = await el.getAttribute('class').catch(() => null);
            const isCurrentlyOn = classAttr && classAttr.includes('selected');

            if (enable !== isCurrentlyOn) {
                await el.click();
                await this._humanDelay(300, 600);
                console.log(`[DoubaoAnalyzer] 联网搜索: ${enable ? '已开启' : '已关闭'}`);
            } else {
                console.log(`[DoubaoAnalyzer] 联网搜索: 已是${enable ? '开启' : '关闭'}状态，无需切换`);
            }
        } catch (e) {
            console.log(`[DoubaoAnalyzer] 联网搜索切换失败: ${e.message}`);
        }
    }

    // ---------- 输入与发送 ----------

    /**
     * 发送提问
     * @param {string} question
     */
    async _sendQuestion(question) {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 尝试在输入框中输入文本
        const inputSelectors = [
            selectors.inputArea,
            'div[contenteditable="true"]',
            'textarea',
            '[placeholder*="输入"]',
            '[placeholder*="发送"]',
        ].filter(Boolean);

        let inputFound = false;
        for (const selector of inputSelectors) {
            try {
                const el = page.locator(selector).first();
                if (await el.isVisible({ timeout: 1000 })) {
                    await el.click();
                    await this._humanDelay(200, 500);
                    await el.fill(question);
                    inputFound = true;
                    console.log(`[DoubaoAnalyzer] 输入框定位成功: ${selector}`);
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!inputFound) {
            await page.keyboard.type(question, { delay: 50 + Math.random() * 80 });
            console.log('[DoubaoAnalyzer] 使用键盘输入');
        }

        await this._humanDelay(300, 600);

        // 触发发送
        let sent = false;
        const sendSelectors = [
            selectors.sendButton,
            'button[aria-label*="发送"]',
            'button[aria-label*="send"]',
            'div[class*="send-btn"]',
            'button:has(svg)',
        ].filter(Boolean);

        for (const selector of sendSelectors) {
            try {
                const el = page.locator(selector).first();
                if (await el.isVisible({ timeout: 1000 })) {
                    await el.click();
                    sent = true;
                    console.log(`[DoubaoAnalyzer] 发送按钮定位成功: ${selector}`);
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!sent) {
            await page.keyboard.press('Enter');
            console.log('[DoubaoAnalyzer] 使用 Enter 键发送');
        }
    }

    // ---------- 响应监听与提取 ----------

    /**
     * SSE 专用监听器（覆盖基类的 json-only 逻辑）
     * @param {Page} page
     */
    _listenSSEStream(page) {
        const patterns = this.constructor.API_PATTERNS;

        page.on('response', async (response) => {
            const url = response.url();
            try {
                const contentType = response.headers()['content-type'] || '';

                for (const [name, pattern] of Object.entries(patterns)) {
                    if (!pattern.test(url)) continue;

                    if (contentType.includes('text/event-stream')) {
                        const text = await response.text().catch(() => null);
                        if (text) {
                            this._apiResponses.set(name, { url, body: text, timestamp: Date.now() });
                            console.log(`[DoubaoAnalyzer] SSE流捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    } else if (contentType.includes('application/json') || contentType.includes('text/json')) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            this._apiResponses.set(name, { url, body, timestamp: Date.now() });
                            console.log(`[DoubaoAnalyzer] JSON捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    }
                    break;
                }
            } catch {
                // 忽略
            }
        });
    }

    /**
     * 等待响应完成并提取 AI 回复
     * @param {string} [question]
     * @returns {Promise<{answer: string, think: string, conversationId: string}|null>}
     */
    async _waitForStreamComplete(question) {
        const cached = await this.waitForApiResponse('chatStream', this.streamTimeout);
        if (!cached) {
            console.log('[DoubaoAnalyzer] 未捕获到响应');
            return null;
        }

        // TODO: 根据调试结果实现豆包的响应解析逻辑
        // 可能是 SSE 快照模式（类似智谱清言）或增量模式
        const body = cached.body;

        if (typeof body === 'string') {
            // SSE 文本 — 需要根据豆包的实际格式解析
            return this._extractReplyFromSSE(body);
        } else {
            // JSON 响应 — 直接提取
            return this._extractReplyFromJSON(body);
        }
    }

    /**
     * 从 SSE 全文本中提取 AI 回复内容
     *
     * TODO: 根据调试结果调整解析逻辑
     * 豆包的 SSE 格式待确认，可能是：
     *   - 快照模式（类似智谱清言）：每条 data 包含完整文本，只取最后一条
     *   - 增量模式：每条 data 只包含新增文本，需要拼接
     *
     * @param {string} sseText
     * @returns {{answer: string, think: string, conversationId: string, status: string, dataLineCount: number}}
     */
    _extractReplyFromSSE(sseText) {
        const dataLines = sseText.split('\n').filter(l => l.startsWith('data:'));
        let conversationId = '';
        let lastStatus = '';
        let answer = '';
        let think = '';

        // TODO: 根据豆包实际 SSE 结构调整以下解析逻辑
        for (const line of dataLines) {
            const jsonStr = line.replace(/^data:\s*/, '').trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
                const obj = JSON.parse(jsonStr);

                // 通用字段提取（需要根据豆包实际结构调整）
                if (obj.conversation_id) conversationId = obj.conversation_id;
                if (obj.conversationId) conversationId = obj.conversationId;
                if (obj.status) lastStatus = obj.status;

                // 尝试多种常见的回复字段结构
                // 结构1: { choices: [{ delta: { content: "..." } }] }（OpenAI 兼容格式）
                if (obj.choices && Array.isArray(obj.choices)) {
                    for (const choice of obj.choices) {
                        if (choice.delta?.content) answer += choice.delta.content;
                        if (choice.delta?.reasoning_content) think += choice.delta.reasoning_content;
                    }
                }

                // 结构2: { message: { content: "..." } }
                if (obj.message?.content) answer = obj.message.content;

                // 结构3: { data: { text: "..." } }
                if (obj.data?.text) answer = obj.data.text;

            } catch { /* 忽略非 JSON 行 */ }
        }

        return {
            answer,
            think,
            conversationId,
            status: lastStatus,
            dataLineCount: dataLines.length,
        };
    }

    /**
     * 从 JSON 响应中提取 AI 回复内容
     * @param {object} body
     * @returns {{answer: string, think: string, conversationId: string, status: string}}
     */
    _extractReplyFromJSON(body) {
        // TODO: 根据豆包实际 JSON 结构调整
        return {
            answer: body.data?.text || body.message?.content || body.content || '',
            think: '',
            conversationId: body.conversation_id || body.conversationId || '',
            status: body.status || '',
        };
    }

    // ======================== 工具方法 ========================

    /**
     * 模拟人类操作延迟
     * @param {number} min
     * @param {number} max
     */
    async _humanDelay(min = 200, max = 800) {
        const delay = min + Math.random() * (max - min);
        await this._sleep(delay);
    }
}

module.exports = DoubaoAnalyzer;

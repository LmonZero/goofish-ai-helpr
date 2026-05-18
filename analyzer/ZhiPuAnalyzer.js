const path = require('path');
const BaseAnalyzer = require('./BaseAnalyzer');
const fs = require('fs');
/**
 * 智谱清言（chatglm.cn）AI 分析器
 *
 * 核心流程：
 *   1. 打开智谱清言页面
 *   2. 在输入框填入提问文本 → 触发 POST /assistant/stream
 *   3. 拦截 SSE 响应 → 从最后一条 data 行提取 AI 回复
 *
 * SSE 特点：累积快照模式（非增量），每条 data 包含到当时的全部文本
 */
class ZhiPuAnalyzer extends BaseAnalyzer {

    /** 需要监听的 AI 响应 URL 模式 */
    static API_PATTERNS = {
        chatStream: /chatglm\.cn\/chatglm\/backend-api\/assistant\/stream/,
    };

    /** 仅用于操作触发的选择器 */
    static TRIGGER_SELECTORS = {
        /** 输入框 */
        inputArea: '#search-input-box > div > div.input-box-inner > textarea',
        /** 发送按钮 */
        sendButton: '#search-input-box > div > div.input-box-container.flex.flex-x-between > div:nth-child(2) > div.enter.is-main-chat',  //class="enter is-main-chat m-three-row" 是这个时候才能发送消息
        /** 深度思考开关按钮（点击切换开/关，通过 class 判断当前状态） */
        deepThinkToggle: '#search-input-box > div > div.input-box-container.flex.flex-x-between > div:nth-child(1) > div.session-button-container.flex.flex-y-center.flex-y-center > div:nth-child(1)',  // TODO: 填入深度思考按钮选择器
        /** 联网搜索开关按钮（点击切换开/关，通过 class 判断当前状态） */
        networkToggle: '#search-input-box > div > div.input-box-container.flex.flex-x-between > div:nth-child(1) > div.session-button-container.flex.flex-y-center.flex-y-center > div:nth-child(2)',

        // ======================== 登录相关 ========================
        /** 弹窗关闭按钮（弹窗 ID 是动态的，用 close-btn 定位） */
        popupCloseBtn: '[class*="copy-panel"] button.close-btn',
        /** 登录按钮（包含 "登录" 文字的容器） */
        loginBtn: '#session-container > div.chat-top-section > div.right-box > div.guest-header > div > div',
        /** 二维码所在 iframe 的 name/id */
        qrCodeIframe: '#qrCodeWeChatInject > iframe',
        /** 二维码图片（iframe 内部） */
        qrCodeImg: 'body > div.root-container > div.login-container',
        /** 登录成功后出现的头像 */
        loginSuccessAvatar: '#session-container > div.chat-top-section > div.right-box > div.userInfoBar > div.userInfoBar-header > div > div > img',
    };

    /**
     * @param {object} options
     * @param {string} [options.assistantId] - 智谱助手 ID，默认为通用助手
     * @param {string} [options.chatMode] - 对话模式，默认 'zero'（单轮）
     * @param {boolean} [options.deepThink=false] - 是否启用深度思考
     * @param {boolean} [options.network=false] - 是否启用联网搜索
     * @param {number} [options.loginTimeout=120000] - 登录等待超时(ms)
     * @param {number} [options.streamTimeout=120000] - SSE 流超时时间(ms)
     */
    constructor(options = {}) {
        super(options);
        this.assistantId = options.assistantId || '65940acff94777010aa6b796';
        this.chatMode = options.chatMode || 'zero';
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

        // 始终创建新页面，避免复用其他模块的页面（如 GoofishScraper 的闲鱼页面）
        this._page = await this.context.newPage();

        // 注册 SSE 专用监听（覆盖基类的 json-only 监听）
        this._listenSSEStream(this._page);

        // 导航到智谱清言首页
        await this._page.goto('https://chatglm.cn/', { waitUntil: 'load', timeout: 30000 });

        // 等待关键元素渲染（页面真正就绪）
        try {
            await this._page.locator(this.constructor.TRIGGER_SELECTORS.loginBtn).first().waitFor({ state: 'visible', timeout: 5000 });
            console.log('[ZhiPuAnalyzer] 页面关键元素已渲染');
        } catch {
            console.log('[ZhiPuAnalyzer] 登录按钮未出现，继续执行登录流程');
        }

        // 等待登录完成
        await this._waitForLogin();

        return this._page;
    }

    /**
     * 获取当前页面（外部如需操作页面可使用）
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
     * @param {string[]} [images=[]] - 图片文件路径列表（暂不支持）
     * @param {boolean} [isBase64=false] - 图片是否为 base64 格式（暂不支持）
     * @param {object} [overrides={}] - 本次调用的临时覆盖选项
     * @param {boolean} [overrides.deepThink] - 临时覆盖深度思考设置
     * @param {boolean} [overrides.network] - 临时覆盖联网搜索设置
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

        // 3. 等待 SSE 流完成
        const result = await this._waitForStreamComplete(question);
        return result;
    }

    // ======================== 内部方法 ========================

    // ---------- 登录流程 ----------

    /**
     * 等待用户登录
     *
     * 流程：
     *   1. 检查是否已登录（头像可见）→ 已登录直接返回
     *   2. 关闭弹窗（如有）
     *   3. 点击登录按钮
     *   4. 保存二维码图片到本地，提示用户扫码
     *   5. 轮询等待头像出现（登录成功）
     */
    async _waitForLogin() {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 1. 检查是否已登录
        try {
            const avatar = page.locator(selectors.loginSuccessAvatar).first();
            if (await avatar.isVisible({ timeout: 3000 })) {
                console.log('[ZhiPuAnalyzer] 已登录，跳过登录流程');
                return;
            }
        } catch { /* 未登录，继续 */ }

        console.log('[ZhiPuAnalyzer] 未登录，开始登录流程...');

        // 2. 关闭弹窗
        await this._closePopup();

        // 3. 点击登录按钮
        await this._clickLogin();

        // 4. 保存二维码图片
        await this._saveQRCode();

        // 5. 等待登录成功
        console.log('[ZhiPuAnalyzer] 等待扫码登录...');
        try {
            const avatar = page.locator(selectors.loginSuccessAvatar).first();
            await avatar.waitFor({ state: 'visible', timeout: this.loginTimeout });
            console.log('[ZhiPuAnalyzer] 登录成功！');
        } catch {
            throw new Error(`[ZhiPuAnalyzer] 登录超时（${this.loginTimeout / 1000}s），请重试`);
        }
    }

    /**
     * 关闭首页弹窗
     */
    async _closePopup() {
        const page = this._page;
        const selector = this.constructor.TRIGGER_SELECTORS.popupCloseBtn;

        try {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 3000 })) {
                await closeBtn.click();
                await this._humanDelay(500, 1000);
                console.log('[ZhiPuAnalyzer] 弹窗已关闭');
            }
        } catch {
            console.log('[ZhiPuAnalyzer] 无弹窗或已关闭');
        }
    }

    /**
     * 点击登录按钮
     */
    async _clickLogin() {
        const page = this._page;
        const selector = this.constructor.TRIGGER_SELECTORS.loginBtn;

        try {
            const loginBtn = page.locator(selector).first();
            await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
            await loginBtn.click();
            await this._humanDelay(500, 1000);
            console.log('[ZhiPuAnalyzer] 已点击登录按钮');
        } catch (e) {
            console.log(`[ZhiPuAnalyzer] 登录按钮点击失败: ${e.message}`);
        }
    }

    /**
     * 保存二维码图片到本地并提示用户
     *
     * 二维码在 iframe 内，需要通过 frameLocator 访问
     */
    async _saveQRCode() {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const outputPath = path.join('./', 'tmp', `qrcode_${Date.now()}.png`);

        // 尝试不同的截图策略，第一个成功的就返回
        const strategies = [
            // 策略1：截取登录面板（iframe 内的完整区域）
            async () => {
                const iframe = page.locator(selectors.qrCodeIframe);
                await iframe.waitFor({ state: 'attached', timeout: 5000 });
                const panel = page.locator(selectors.qrCodeImg).first();
                if (await panel.isVisible({ timeout: 3000 })) {
                    await panel.screenshot({ path: outputPath });
                    return { path: outputPath, msg: '登录面板截图' };
                }
                return null;
            },
            // 策略2：iframe 内直接截取二维码图片
            async () => {
                const qrImg = page
                    .frameLocator(selectors.qrCodeIframe)
                    .locator(selectors.qrCodeImg)
                    .first();
                await qrImg.waitFor({ state: 'visible', timeout: 10000 });
                await qrImg.screenshot({ path: outputPath });
                return { path: outputPath, msg: 'iframe 内二维码截图' };
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
            // 策略4：截取登录弹窗区域
            async () => {
                const panel = page.locator('div.panelContent, div.waiting').first();
                if (await panel.isVisible({ timeout: 3000 })) {
                    await panel.screenshot({ path: outputPath });
                    return { path: outputPath, msg: '登录弹窗区域截图' };
                }
                return null;
            },
        ];

        for (const strategy of strategies) {
            let result = null;
            try {
                result = await strategy();
                if (result) {
                    console.log(`[ZhiPuAnalyzer] 二维码已保存: ${result.path} (${result.msg})`);
                    const flag = await this.decodeAndPrintQR(result.path);
                    if (flag) {
                        console.log('[ZhiPuAnalyzer] 请使用【微信】扫描二维码登录');
                        return;
                    }
                }
            } catch (e) {
                // 当前策略失败，继续下一个
            } finally {
                // 确保每次策略执行完毕都进行清理
                if (result && result.path && fs.existsSync(result.path))
                    fs.unlinkSync(result.path);
            }
        }

        console.log('[ZhiPuAnalyzer] 请在浏览器窗口中手动扫码登录');
    }

    // ---------- 功能开关 ----------

    /**
     * 切换联网搜索模式
     *
     * @param {boolean} enable - true 开启联网，false 关闭
     */
    async _toggleNetwork(enable) {
        const selector = this.constructor.TRIGGER_SELECTORS.networkToggle;
        if (!selector) return;  // 未配置选择器则跳过

        const page = this._page;
        try {
            const el = page.locator(selector).first();
            if (!await el.isVisible({ timeout: 2000 })) {
                console.log('[ZhiPuAnalyzer] 联网搜索按钮不可见，跳过');
                return;
            }

            // 通过 class 是否有 selected 判断当前是否已开启
            const classAttr = await el.getAttribute('class').catch(() => null);
            const isCurrentlyOn = classAttr && classAttr.includes('selected');

            // 仅在状态不一致时点击切换
            if (enable !== isCurrentlyOn) {
                await el.click();
                await this._humanDelay(300, 600);
                console.log(`[ZhiPuAnalyzer] 联网搜索: ${enable ? '已开启' : '已关闭'}`);
            } else {
                console.log(`[ZhiPuAnalyzer] 联网搜索: 已是${enable ? '开启' : '关闭'}状态，无需切换`);
            }
        } catch (e) {
            console.log(`[ZhiPuAnalyzer] 联网搜索切换失败: ${e.message}`);
        }
    }

    /**
     * 切换深度思考模式
     *
     * 检查页面上深度思考按钮的当前状态，仅在需要时点击切换。
     * 通过 deepThinkOnClass 判断按钮是否处于开启状态：
     *   - 如果按钮 class 包含 deepThinkOnClass → 当前已开启
     *   - 否则 → 当前已关闭
     *
     * @param {boolean} enable - true 开启深度思考，false 关闭
     */
    async _toggleDeepThink(enable) {
        const selector = this.constructor.TRIGGER_SELECTORS.deepThinkToggle;
        if (!selector) return;  // 未配置选择器则跳过

        const page = this._page;
        try {
            const el = page.locator(selector).first();
            if (!await el.isVisible({ timeout: 2000 })) {
                console.log('[ZhiPuAnalyzer] 深度思考按钮不可见，跳过');
                return;
            }

            // 通过 class 是否有 selected 属性判断当前是否已开启
            const isSelected = await el.getAttribute('class').catch(() => null);
            const isCurrentlyOn = isSelected && isSelected.includes('selected');

            // 仅在状态不一致时点击切换
            if (enable !== isCurrentlyOn) {
                await el.click();
                await this._humanDelay(300, 600);
                console.log(`[ZhiPuAnalyzer] 深度思考: ${enable ? '已开启' : '已关闭'}`);
            } else {
                console.log(`[ZhiPuAnalyzer] 深度思考: 已是${enable ? '开启' : '关闭'}状态，无需切换`);
            }
        } catch (e) {
            console.log(`[ZhiPuAnalyzer] 深度思考切换失败: ${e.message}`);
        }
    }

    /**
     * 发送提问
     * @param {string} question
     */
    async _sendQuestion(question) {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 尝试在输入框中输入文本
        // 智谱清言可能使用 contenteditable 或 textarea，尝试多种选择器
        const inputSelectors = [
            selectors.inputArea,
            'div[contenteditable="true"]',
            'textarea',
            '#chat-input',
            '[placeholder*="输入"]',
        ];

        let inputFound = false;
        for (const selector of inputSelectors) {
            try {
                const el = page.locator(selector).first();
                if (await el.isVisible({ timeout: 1000 })) {
                    await el.click();
                    await this._humanDelay(200, 500);
                    await el.fill(question);
                    inputFound = true;
                    console.log(`[ZhiPuAnalyzer] 输入框定位成功: ${selector}`);
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!inputFound) {
            // 兜底：用键盘直接输入
            await page.keyboard.type(question, { delay: 50 + Math.random() * 80 });
            console.log('[ZhiPuAnalyzer] 使用键盘输入');
        }

        await this._humanDelay(300, 600);

        // 触发发送
        let sent = false;

        // 尝试点击发送按钮
        const sendSelectors = [
            selectors.sendButton,
            'button[aria-label*="发送"]',
            'button[aria-label*="send"]',
            'div[class*="send-btn"]',
            'button:has(svg)', // 带图标的按钮
        ];
        for (const selector of sendSelectors) {
            try {
                const el = page.locator(selector).first();
                if (await el.isVisible({ timeout: 1000 })) {
                    await el.click();
                    sent = true;
                    console.log(`[ZhiPuAnalyzer] 发送按钮定位成功: ${selector}`);
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!sent) {
            // 兜底：按 Enter 发送
            await page.keyboard.press('Enter');
            console.log('[ZhiPuAnalyzer] 使用 Enter 键发送');
        }
    }

    /**
     * SSE 专用监听器（覆盖基类的 json-only 逻辑）
     *
     * 智谱清言的对话响应是 SSE 格式，不能用 response.json() 解析
     * 这里用 response.text() 读取全量文本，存入 _apiResponses
     *
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
                        // SSE 流 — 读取完整文本
                        const text = await response.text().catch(() => null);
                        if (text) {
                            this._apiResponses.set(name, { url, body: text, timestamp: Date.now() });
                            console.log(`[ZhiPuAnalyzer] SSE流捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    } else if (contentType.includes('application/json') || contentType.includes('text/json')) {
                        // JSON 响应
                        const body = await response.json().catch(() => null);
                        if (body) {
                            this._apiResponses.set(name, { url, body, timestamp: Date.now() });
                            console.log(`[ZhiPuAnalyzer] JSON捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    }
                    break;
                }
            } catch (_) {
                // 忽略
            }
        });
    }

    /**
     * 等待 SSE 流完成并提取 AI 回复
     *
     * @param {string} [question] - 用于日志
     * @returns {Promise<{answer: string, think: string, conversationId: string}|null>}
     */
    async _waitForStreamComplete(question) {
        const cached = await this.waitForApiResponse('chatStream', this.streamTimeout);
        if (!cached) {
            console.log('[ZhiPuAnalyzer] 未捕获到 SSE 响应');
            return null;
        }

        const sseText = typeof cached.body === 'string' ? cached.body : JSON.stringify(cached.body);
        const extracted = this._extractReplyFromSSE(sseText);

        console.log(`[ZhiPuAnalyzer] AI 回复完成 (conversation: ${extracted.conversationId}, data行数: ${extracted.dataLineCount})`);
        return extracted;
    }

    /**
     * 从 SSE 全文本中提取 AI 回复内容
     *
     * 智谱清言 SSE 特点：每条 data: 是累积快照，只取最后一条含正文内容的即可
     *
     * @param {string} sseText
     * @returns {{answer: string, think: string, conversationId: string, status: string, dataLineCount: number}}
     */
    _extractReplyFromSSE(sseText) {
        const dataLines = sseText.split('\n').filter(l => l.startsWith('data:'));
        let conversationId = '';
        let lastStatus = '';
        let lastTextObj = null;
        let lastThinkObj = null;

        for (const line of dataLines) {
            const jsonStr = line.replace(/^data:\s*/, '').trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
                const obj = JSON.parse(jsonStr);
                if (obj.conversation_id) conversationId = obj.conversation_id;
                if (obj.status) lastStatus = obj.status;

                if (obj.parts && Array.isArray(obj.parts)) {
                    for (const part of obj.parts) {
                        if (part.content && Array.isArray(part.content)) {
                            for (const item of part.content) {
                                if (item.type === 'text' && item.text) {
                                    lastTextObj = item;
                                } else if (item.type === 'think' && item.think) {
                                    lastThinkObj = item;
                                }
                            }
                        }
                    }
                }
            } catch { /* 忽略非 JSON 行 */ }
        }

        return {
            answer: lastTextObj ? lastTextObj.text : '',
            think: lastThinkObj ? lastThinkObj.think : '',
            conversationId,
            status: lastStatus,
            dataLineCount: dataLines.length,
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

module.exports = ZhiPuAnalyzer;

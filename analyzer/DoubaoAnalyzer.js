const path = require('path');
const fs = require('fs');
const BaseAnalyzer = require('./BaseAnalyzer');

/**
 * 豆包 AI（doubao.com）分析器
 *
 * 核心流程：
 *   1. 打开豆包页面
 *   2. 在输入框填入提问文本 → 触发 POST /chat/completion
 *   3. 拦截 SSE 响应 → 从 CHUNK_DELTA 增量拼接 AI 回复
 *
 * SSE 特点：增量模式（非快照模式），事件类型：
 *   - SSE_HEARTBEAT  心跳，忽略
 *   - SSE_ACK        确认收到，含 conversation_id
 *   - FULL_MSG_NOTIFY 用户消息回显，含 cot_switch 深度思考标志
 *   - STREAM_MSG_NOTIFY AI 回复首帧，含 block_type=10000(正文)/10040(思考)
 *   - CHUNK_DELTA    增量文本 {"text":"好呀"}，需拼接
 *   - STREAM_CHUNK   补丁操作(patch_op)，含文本快照和 TTS
 *   - SSE_REPLY_END  回复结束 end_type=1/2/3
 *
 * 编码注意：Playwright SSE 响应存在双重编码 bug，需用 BaseAnalyzer.fixDoubleEncodedSSE() 修复
 */
class DoubaoAnalyzer extends BaseAnalyzer {

    /** 需要监听的 AI 响应 URL 模式 */
    static API_PATTERNS = {
        chatStream: /doubao\.com\/chat\/completion/,
    };

    /** 仅用于操作触发的选择器 */
    static TRIGGER_SELECTORS = {
        /** 输入框 — 最内层的 textarea，在 #input-engine-container 容器内 */
        inputArea: '#input-engine-container textarea',
        /** 发送按钮 — send-btn-wrapper 是语义化类名，比完整 DOM 路径更稳定 */
        sendButton: '#input-engine-container .send-btn-wrapper',
        /** 深度思考/深度推理开关按钮 — 在输入区域内，包含"快速"或"思考"文本的按钮 */
        deepThinkToggle: 'xpath=//div[@id="input-engine-container"]//button[contains(., "快速") or contains(., "思考")]',
        /** 联网搜索开关按钮 */
        networkToggle: '',  // 这个没有 默认联网

        // ======================== 登录相关 ========================
        /** 弹窗关闭按钮 */
        popupCloseBtn: '',  // 没有弹窗需要关闭
        /** 登录按钮 — XPath 定位，避免 :has-text() 兼容问题 */
        loginBtn: 'xpath=//button[contains(@class, "semi-button-primary") and contains(., "登录")]',
        /** 二维码所在 iframe（如二维码在 iframe 中） */
        qrCodeIframe: '',  // 没有这个
        /** 二维码图片或登录面板 */
        qrCodeImg: '#semi-modal-body',
        /** 登录成功后出现的头像或其他标志元素 — 未登录时登录按钮可见，登录后消失 */
        loginSuccessAvatar: '',  // 登录按钮没了 就是登录成功
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

        // 始终创建新页面，避免复用其他模块的页面（如 GoofishScraper 的闲鱼页面）
        this._page = await this.context.newPage();

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

        // 1. 检查是否已登录（loginBtn 不可见即表示已登录）
        const isLoggedIn = await this._checkLoginStatus();
        if (isLoggedIn) {
            console.log('[DoubaoAnalyzer] 已登录，跳过登录流程');
            return;
        }

        console.log('[DoubaoAnalyzer] 未登录，开始登录流程...');

        // 2. 关闭弹窗
        await this._closePopup();

        // 3. 点击登录按钮
        await this._clickLogin();

        // 4. 保存二维码图片
        await this._saveQRCode();

        // 5. 等待登录成功（loginBtn 消失）
        console.log('[DoubaoAnalyzer] 等待扫码登录...');
        const start = Date.now();
        while (Date.now() - start < this.loginTimeout) {
            if (await this._checkLoginStatus()) {
                console.log('[DoubaoAnalyzer] 登录成功！');
                return;
            }
            await this._sleep(1000);
        }
        throw new Error(`[DoubaoAnalyzer] 登录超时（${this.loginTimeout / 1000}s），请重试`);
    }

    /**
     * 检查当前登录状态
     * @returns {Promise<boolean>}
     */
    async _checkLoginStatus() {
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 优先：配置了 loginSuccessAvatar 且可见
        if (selectors.loginSuccessAvatar) {
            try {
                const el = this._page.locator(selectors.loginSuccessAvatar).first();
                if (await el.isVisible({ timeout: 2000 })) return true;
            } catch { /* 未找到，继续检查 */ }
        }

        // 兜底：loginBtn 存在且可见 → 未登录；存在但不可见或不存在 → 已登录
        if (selectors.loginBtn) {
            try {
                const loginBtn = this._page.locator(selectors.loginBtn).first();
                const count = await loginBtn.count();
                if (count === 0) return true;   // 登录按钮不存在 → 已登录
                return !(await loginBtn.isVisible());  // 存在但不可见 → 已登录
            } catch {
                return false;  // 异常时保守判断为未登录
            }
        }

        return false;
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
     *
     * 豆包的深度思考是一个 Radix UI 下拉菜单（非简单开关）：
     *   - 触发器：button[data-slot="dropdown-menu-trigger"]
     *   - 选项："快速"(data-selected=false) / "思考"(data-selected=true/false)
     *   - 开启深度思考：点击触发器 → 点击 "思考" 菜单项
     *   - 关闭深度思考：点击触发器 → 点击 "快速" 菜单项
     *
     * @param {boolean} enable
     */
    async _toggleDeepThink(enable) {
        const selector = this.constructor.TRIGGER_SELECTORS.deepThinkToggle;
        if (!selector) return;

        const page = this._page;
        try {
            const trigger = page.locator(selector).first();
            if (!await trigger.isVisible({ timeout: 3000 })) {
                console.log('[DoubaoAnalyzer] 深度思考按钮不可见，跳过');
                return;
            }

            // 1. 点击触发器，打开下拉菜单
            await trigger.click();
            await this._humanDelay(400, 700);

            // 2. 找到 "思考" 菜单项，检查当前选中状态
            const thinkItem = page.locator('div[role="menuitem"]').filter({ hasText: '思考' }).first();
            const isSelected = await thinkItem.getAttribute('data-selected').catch(() => 'false');

            if ((enable && isSelected === 'true') || (!enable && isSelected !== 'true')) {
                console.log(`[DoubaoAnalyzer] 深度思考: 已是${enable ? '开启' : '关闭'}状态，无需切换`);
                await page.keyboard.press('Escape');
                await this._humanDelay(200, 400);
                return;
            }

            // 3. 切换到目标模式
            if (enable) {
                await thinkItem.click();
                console.log('[DoubaoAnalyzer] 深度思考: 已开启');
            } else {
                const quickItem = page.locator('div[role="menuitem"]').filter({ hasText: '快速' }).first();
                await quickItem.click();
                console.log('[DoubaoAnalyzer] 深度思考: 已关闭');
            }
            await this._humanDelay(300, 600);
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
     *
     * 豆包 SSE 响应存在双重编码 bug，需用 BaseAnalyzer.fixDoubleEncodedSSE() 修复
     *
     * @param {Page} page
     */
    _listenSSEStream(page) {
        const patterns = this.constructor.API_PATTERNS;

        page.on('response', async (response) => {
            const url = response.url();
            try {
                const contentType = response.headers()['content-type'] || '';
                const isSSE = contentType.includes('text/event-stream');
                const isJson = contentType.includes('application/json') || contentType.includes('text/json');

                // 调试：打印所有 SSE/JSON 响应的 URL（调试用，平时注释掉）
                // if (isSSE || isJson) {
                //     console.log(`[DoubaoAnalyzer] 响应: ${response.status()} ${isSSE ? 'SSE' : 'JSON'} ${url.substring(0, 150)}`);
                // }

                let matched = false;
                for (const [name, pattern] of Object.entries(patterns)) {
                    if (!pattern.test(url)) continue;
                    matched = true;

                    if (isSSE) {
                        // SSE 流 — 读取 Buffer 后修复双重编码
                        const buf = await response.body().catch(() => null);
                        let text = null;
                        if (buf) {
                            const doubleEncoded = buf.toString('utf-8');
                            text = BaseAnalyzer.fixDoubleEncodedSSE(doubleEncoded);
                        }
                        if (!text) {
                            text = await response.text().catch(() => null);
                            if (text) text = BaseAnalyzer.fixDoubleEncodedSSE(text);
                        }
                        if (text) {
                            this._apiResponses.set(name, { url, body: text, timestamp: Date.now() });
                            console.log(`[DoubaoAnalyzer] SSE流捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    } else if (isJson) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            this._apiResponses.set(name, { url, body, timestamp: Date.now() });
                            console.log(`[DoubaoAnalyzer] JSON捕获 ${name}: ${url.substring(0, 120)}...`);
                        }
                    }
                    break;
                }
            } catch (e) {
                console.log(`[DoubaoAnalyzer] 响应处理异常: ${e.message}`);
            }
        });
    }

    /**
     * 等待响应完成并提取 AI 回复
     * @param {string} [question]
     * @returns {Promise<{answer: string, think: string, conversationId: string, hasDeepThink: boolean, endType: string}|null>}
     */
    async _waitForStreamComplete(question) {
        const cached = await this.waitForApiResponse('chatStream', this.streamTimeout);
        if (!cached) {
            console.log('[DoubaoAnalyzer] 未捕获到响应');
            return null;
        }

        const body = cached.body;

        if (typeof body === 'string') {
            const extracted = this._extractReplyFromSSE(body);
            console.log(`[DoubaoAnalyzer] AI 回复完成 (conversation: ${extracted.conversationId}, data行数: ${extracted.dataLineCount})`);
            return extracted;
        } else {
            return this._extractReplyFromJSON(body);
        }
    }

    /**
     * 从 SSE 全文本中提取 AI 回复内容
     *
     * 豆包 SSE 是增量模式（非快照模式）：
     *   - 正文：拼接 CHUNK_DELTA 的 text + STREAM_CHUNK (patch_object=1) 无 parent_id 的 text
     *   - 思考：STREAM_CHUNK (patch_object=1) 中 block_type=10000 + parent_id 指向 thinking_block
     *          + CHUNK_DELTA（思考阶段内）
     *   - conversation_id：从 SSE_ACK 或 STREAM_MSG_NOTIFY 提取
     *   - 深度思考标志：从 FULL_MSG_NOTIFY 的 ext.cot_switch 或 ext.use_deep_think 检测
     *
     * 深度思考数据结构：
     *   - STREAM_MSG_NOTIFY 出现 block_type=10040 (thinking_block)，含 block_id
     *   - 思考文本通过两条通道：
     *     a) STREAM_CHUNK (patch_object=1) 中 block_type=10000 + parent_id → text + summary
     *     b) CHUNK_DELTA（thinkingPhaseActive 时）
     *   - 思考结束：STREAM_CHUNK 中 block_type=10040 的 is_finish=true
     *
     * @param {string} sseText
     * @returns {{answer: string, think: string, thinkSummary: string, conversationId: string, hasDeepThink: boolean, endType: string, dataLineCount: number}}
     */
    _extractReplyFromSSE(sseText) {
        const lines = sseText.split('\n');
        let conversationId = '';
        let answer = '';
        let thinkText = '';
        let thinkSummary = '';
        let hasDeepThink = false;
        let endType = '';
        let messageId = '';
        let dataLineCount = 0;

        // 深度思考状态追踪
        let thinkingBlockId = '';        // block_type=10040 的 block_id
        let thinkingPhaseActive = false; // 思考阶段是否进行中

        // eventType 需跨行保持，因为 event: 和 data: 是分开的两行
        let currentEventType = '';

        for (const line of lines) {
            if (line.startsWith('event:')) {
                currentEventType = line.replace(/^event:\s*/, '').trim();
                continue;
            }
            if (!line.startsWith('data:')) continue;
            dataLineCount++;

            const dataJson = line.replace(/^data:\s*/, '').trim();
            if (!dataJson) continue;
            let obj;
            try { obj = JSON.parse(dataJson); } catch { continue; }

            // ---- SSE_ACK: 提取 conversation_id ----
            if (currentEventType === 'SSE_ACK') {
                const ackMeta = obj.ack_client_meta;
                if (ackMeta?.conversation_id) conversationId = ackMeta.conversation_id;
            }

            // ---- FULL_MSG_NOTIFY: 检测深度思考标志 ----
            if (currentEventType === 'FULL_MSG_NOTIFY') {
                if (obj.message?.ext?.cot_switch === '1' || obj.message?.ext?.use_deep_think === '1') {
                    hasDeepThink = true;
                }
            }

            // ---- STREAM_MSG_NOTIFY: AI 回复首帧 ----
            if (currentEventType === 'STREAM_MSG_NOTIFY') {
                const meta = obj.meta;
                if (meta?.conversation_id) conversationId = meta.conversation_id;
                if (meta?.message_id) messageId = meta.message_id;

                const content = obj.content;
                if (content?.content_block && Array.isArray(content.content_block)) {
                    for (const block of content.content_block) {
                        // block_type=10000 正文首帧（无 parent_id）
                        if (block.block_type === 10000 && !block.parent_id && block.content?.text_block?.text) {
                            answer += block.content.text_block.text;
                        }
                        // block_type=10040 深度思考容器块
                        if (block.block_type === 10040) {
                            hasDeepThink = true;
                            thinkingBlockId = block.block_id || '';
                            thinkingPhaseActive = true;
                        }
                    }
                }
            }

            // ---- CHUNK_DELTA: 增量文本，按阶段路由 ----
            if (currentEventType === 'CHUNK_DELTA') {
                if (obj.text) {
                    if (thinkingPhaseActive) {
                        thinkText += obj.text;
                    } else {
                        answer += obj.text;
                    }
                }
            }

            // ---- STREAM_CHUNK: 补丁操作 ----
            if (currentEventType === 'STREAM_CHUNK') {
                if (obj.patch_op && Array.isArray(obj.patch_op)) {
                    for (const patch of obj.patch_op) {
                        // 只处理 content_block 补丁（patch_object=1）
                        if (patch.patch_object !== 1) continue;
                        if (!patch.patch_value?.content_block) continue;

                        for (const block of patch.patch_value.content_block) {
                            // block_type=10040: 思考容器块生命周期
                            if (block.block_type === 10040) {
                                if (block.is_finish) {
                                    thinkingPhaseActive = false;
                                }
                            }

                            // block_type=10000: 文本块
                            if (block.block_type === 10000 && block.content?.text_block) {
                                const tb = block.content.text_block;
                                const text = tb.text || '';

                                if (block.parent_id && block.parent_id === thinkingBlockId) {
                                    // 思考子块（parent_id 指向 thinking_block）
                                    if (text) thinkText += text;
                                    if (tb.summary) thinkSummary = tb.summary;
                                } else if (!block.parent_id) {
                                    // 回答块（无 parent_id）
                                    if (text) answer += text;
                                }
                            }
                        }
                    }
                }
            }

            // ---- SSE_REPLY_END: 结束标志 ----
            if (currentEventType === 'SSE_REPLY_END') {
                endType = obj.end_type;
            }
        }

        return {
            answer: answer.replace(/\uFFFD/g, ''),
            think: thinkText.replace(/\uFFFD/g, '') || (hasDeepThink ? '(深度思考内容待提取)' : ''),
            thinkSummary,
            conversationId,
            hasDeepThink,
            endType,
            dataLineCount,
        };
    }

    /**
     * 从 JSON 响应中提取 AI 回复内容（非 SSE 场景的兜底）
     * @param {object} body
     * @returns {{answer: string, think: string, conversationId: string, hasDeepThink: boolean, endType: string}}
     */
    _extractReplyFromJSON(body) {
        return {
            answer: body.data?.text || body.message?.content || body.content || '',
            think: '',
            conversationId: body.conversation_id || body.conversationId || '',
            hasDeepThink: false,
            endType: '',
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

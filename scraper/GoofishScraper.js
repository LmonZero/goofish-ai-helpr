/**
 * 闲鱼（goofish.com）数据爬取器
 *
 * 核心流程：
 *   1. 打开闲鱼首页，等待登录
 *   2. 搜索关键词（URL 直接导航 /search?q=） → API 监听捕获搜索结果
 *   3. 应用筛选条件（新发布/个人闲置/包邮）
 *   4. 逐个进入商品详情页 → API 监听捕获商品/卖家/评价数据
 *   5. 截图上传图床 → AI 分析 → SQLite 入库 → 钉钉通知
 *
 * 设计原则（继承 BaseScraper）：
 *   - API 监听优先：通过 page.on('response') 拦截 XHR/Fetch JSON 响应
 *   - Selector 仅用于操作触发：点击筛选、滚动加载等
 *   - 兜底方案：极少数场景用 page.evaluate() 取 JS 运行时数据
 *
 * 反爬虫注意：
 *   - baxia-dialog — 闲鱼反爬虫验证弹窗，出现时需中止
 *   - J_MIDDLEWARE_FRAME_WIDGET — 另一种验证弹窗
 *   - 先访问首页再搜索（反检测措施）
 */

const BaseScraper = require('./BaseScraper');
const imageHosting = require('../lib/image-hosting');
const qrUtils = require('../lib/qr-utils');
const path = require('path');
const axios = require('axios');
const { XianyuDB } = require('./db');

class GoofishScraper extends BaseScraper {

    /**
     * 结构化诊断日志：每步记录期望 vs 实际，一行定位问题
     *
     * @param {string} step - 步骤名（如 'QR标签切换'）
     * @param {string} expect - 期望结果（如 '找到扫码标签并点击'）
     * @param {object} actual - 实际结果详情
     * @param {boolean} ok - 是否成功
     */
    _logStep(step, expect, actual, ok) {
        const status = ok ? '✅' : '❌';
        const detail = typeof actual === 'string' ? actual : JSON.stringify(actual);
        console.log(`${status} [${step}] 期望: ${expect} | 实际: ${detail}`);
    }

    /**
     * 需要监听的闲鱼 API URL 模式
     *
     * 闲鱼 PC 站 API 通过 h5api.m.goofish.com 网关调用 mtop 接口
     * 核心：mtop.taobao.idlemtopsearch.pc.search 返回搜索结果
     */
    static API_PATTERNS = {
        /** 搜索结果列表 — 主搜索 API，data 含 resultList/resultInfo */
        searchList: /mtop\.taobao\.idlemtopsearch\.pc\.search\/1\.0/i,
        /** 商品详情 — 闲鱼详情页 API，data 含 itemDO + sellerDO + picDetailDO */
        productDetail: /taobao\.idle\.pc\.detail/i,
        /** 卖家主页资料 — 头像/昵称/粉丝/关注/签名等 */
        sellerInfo: /mtop\.idle\.web\.user\.page\.head/i,
        /** 卖家商品列表 — 分页，data 含 cardList + nextPage */
        sellerItems: /mtop\.idle\.web\.xyh\.item\.list/i,
        /** 卖家评价列表 — 分页，data 含 cardList + nextPage */
        sellerRatings: /mtop\.idle\.web\.trade\.rate\.list/i,
        /** 商品评价（详情页） */
        reviewList: /mtop\.idle\.web\.trade\.rate(?!\.list)/i,
    };

    /**
     * 仅用于操作触发的选择器
     *
     * 注意：闲鱼使用 CSS Modules（如 search-container--eigqxPi6），
     *       哈希部分会随版本更新变化，尽量用语义化/文本定位
     */
    static TRIGGER_SELECTORS = {
        // ======================== 搜索筛选相关 ========================
        /** 搜索输入框（首页用，搜索页直接URL导航） */
        searchInput: 'input[placeholder*="搜索"]',
        /** 搜索按钮 */
        searchBtn: '',  // 直接URL导航，不需要搜索按钮
        /** "新发布" 筛选标签 */
        filterNewPublish: 'text=新发布',
        /** "个人闲置" 筛选标签 */
        filterPersonal: 'text=个人闲置',
        /** "包邮" 筛选标签 */
        filterFreeShipping: 'text=包邮',
        /** 广告弹窗关闭按钮 */
        adCloseBtn: 'div[class*="closeIconBg"]',

        // ======================== 分页相关 ========================
        /** 页码信息文本（如 "1/50"） */
        pageInfo: 'span[class*="search-page-tiny-page"]',
        /** 分页按钮容器 */
        paginationContainer: 'div[class*="search-page-tiny-container"]',
        /** 下一页按钮（右箭头） */
        nextPageBtn: 'div[class*="search-page-tiny-container"] button:last-child:not([disabled])',

        // ======================== 卖家页面相关 ========================
        /** "信用及评价" tab */
        sellerRatingTab: 'text=信用及评价',

        // ======================== 反爬虫弹窗选择器 ========================
        /** 八匣反爬虫验证弹窗 */
        baxiaDialog: 'div.baxia-dialog-mask',
        /** 中间件验证弹窗 */
        middlewareWidget: 'div.J_MIDDLEWARE_FRAME_WIDGET',

        // ======================== 登录相关（iframe 内扫码登录）========================
        /** 首页"登录"按钮（未登录时 header 右上角显示，文本为"登录"） */
        loginPromptBtn: 'div[class*="user-order-container"] div[class*="nick"]',
        /** 首页"登录后可以更懂你"文字（未登录时弹出的提示文案） */
        loginPromptText: 'text=登录后可以更懂你',
        /** 登录 iframe 选择器（多种入口，逗号分隔，waitForSelector 支持 CSS 逗号） */
        loginIframe: '#alibaba-login-box, #baxia-dialog-content, body > div.J_MIDDLEWARE_FRAME_WIDGET > iframe',
        /** iframe 内：扫码成功标志（class 含 qrcode-success） */
        qrCodeSuccess: '.qrcode-success',
        /** iframe 内："保持登录"确认按钮 */
        keepLoginBtn: 'button.keep-login-confirm-btn',
        /** 已登录标志：nick 文本不为"登录"即为已登录 */
        loggedInIndicator: 'div[class*="user-order-container"] div[class*="nick"]',
    };

    /** 闲鱼 PC 站首页 */
    static HOME_URL = 'https://www.goofish.com/';

    /** 闲鱼搜索页 URL 模板 */
    static SEARCH_URL = 'https://www.goofish.com/search?q={keyword}';

    /** 商品详情页 URL 模板 */
    static PRODUCT_URL = 'https://www.goofish.com/item?id={itemId}';

    /** 卖家主页 URL 模板 */
    static SELLER_URL = 'https://www.goofish.com/personal?userId={userId}';

    /**
     * @param {object} options - 配置项（来自 config/default.js 合并用户配置）
     */
    constructor(options = {}) {
        super(options);
        this._page = null;
        this._searchResults = [];
    }

    // ======================== 生命周期 ========================

    /**
     * 初始化：启动浏览器 → 创建页面 → 导航闲鱼 → 注册 API 监听 → 等待登录
     * @returns {Promise<Page>}
     */
    async init() {
        // 1. 启动浏览器持久化上下文
        const context = await super.init();
        console.log('[GoofishScraper] 浏览器已启动');

        // 2. 创建页面（含反检测脚本注入）
        this._page = await this.newPage();
        console.log('[GoofishScraper] 页面已创建');

        // 3. 注册 API 监听
        this.listenApiResponses(this._page);

        // 4. 先访问首页（反检测措施：模拟真实用户先看首页）
        await this._page.goto(this.constructor.HOME_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        console.log('[GoofishScraper] 已导航到闲鱼首页');

        // 模拟真实用户浏览：随机滚动
        await this._humanDelay(1000, 2000);
        await this._page.evaluate('window.scrollBy(0, Math.random() * 500 + 200)').catch(() => { });
        await this._humanDelay(1000, 2000);

        // 5. 等待页面关键元素渲染
        await this._waitForPageReady();

        // 6. 检查反爬虫弹窗
        await this._checkAntiCrawl();

        // 7. 关闭广告弹窗
        await this._closeAdPopup();

        // 8. 等待登录
        await this._waitForLogin();

        // 9. 登录流程结束后，强制持久化 cookie
        // 即使“保持”按钮没点到，也确保 cookie 不会随浏览器关闭而丢失
        await this._persistLoginCookies();

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
     * 执行搜索（URL 直接导航，避免输入框操作触发反爬）
     *
     * @param {string} keyword - 搜索关键词
     * @param {object} [filters] - 筛选条件
     * @param {boolean} [filters.newPublish] - 是否筛选“新发布”
     * @param {string} [filters.newPublishOption] - 新发布子选项文本（如“1天内”）
     * @param {boolean} [filters.personal] - 是否筛选“个人闲置”
     * @param {boolean} [filters.freeShipping] - 是否筛选“包邮”
     * @param {object} [options] - 其他选项
     * @param {number} [options.maxPages=0] - 最大翻页数，0=翻到最后一页
     * @returns {Promise<Array>} 商品列表
     */
    async search(keyword, filters = {}, options = {}) {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const { maxPages = 0 } = options;
        const unlimited = maxPages <= 0;

        // 清空上次缓存
        this.clearApiCache();
        this._searchResults = [];

        console.log(`[GoofishScraper] 搜索关键词: "${keyword}"`);

        // 1. URL 直接导航到搜索页
        const searchUrl = this.constructor.SEARCH_URL.replace('{keyword}', encodeURIComponent(keyword));

        // 先注册一次性响应监听，避免错过首次请求
        // 匹配闲鱼 mtop 搜索 API（只排除 shade/activate 辅助接口）
        const apiPatterns = this.constructor.API_PATTERNS;
        const mtopRequests = [];  // 记录所有 mtop 请求，便于调试
        page.on('request', req => {
            const url = req.url();
            if (url.includes('mtop.')) {
                mtopRequests.push(url.split('?')[0]);
            }
        });
        const makeSearchResponsePromise = () => page.waitForResponse(
            res => {
                const url = res.url();
                const ct = res.headers()['content-type'] || '';
                // 只匹配 JSON 且为搜索主接口（排除 shade/activate）
                return ct.includes('json')
                    && apiPatterns.searchList.test(url)
                    && !/shade|activate/i.test(url);
            },
            { timeout: 30000 }
        ).catch(() => null);

        let responsePromise = makeSearchResponsePromise();

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(`[GoofishScraper] 已导航到搜索页: ${searchUrl}`);

        // 2. 搜索页登录状态检查
        //    用 nick 文本判断（和首页一样），而不是检查元素是否可见
        let needRelogin = false;
        const loginFrame = await this._detectLoginIframe(3000);
        if (loginFrame) {
            console.log('[GoofishScraper] 搜索页检测到登录 iframe，开始扫码登录...');
            await this._handleQRCodeLogin(this.options.loginTimeout || 120000);
            needRelogin = true;
        } else {
            // 用 page.evaluate 检查 nick 文本
            const searchNick = await page.evaluate(() => {
                const nick = document.querySelector('div[class*="nick"]');
                if (nick) return nick.textContent?.trim() || '';
                const container = document.querySelector('div[class*="user-order-container"]');
                if (container) {
                    const divs = container.querySelectorAll('div, span');
                    for (const d of divs) {
                        const t = d.textContent?.trim();
                        if (t && t.length < 20 && d.children.length === 0) return t;
                    }
                }
                return '';
            }).catch(() => '');
            if (searchNick === '登录') {
                console.log('[GoofishScraper] 搜索页检测到未登录（nick="登录"），开始登录流程...');
                // 点击"登录"触发 QR 码 iframe
                const loginBtn = await page.$(selectors.loginPromptBtn).catch(() => null);
                if (loginBtn) await loginBtn.click().catch(() => { });
                await this._sleep(2000);
                const frame2 = await this._detectLoginIframe(8000);
                if (frame2) {
                    await this._handleQRCodeLogin(this.options.loginTimeout || 120000);
                    needRelogin = true;
                }
            } else if (searchNick) {
                console.log(`[GoofishScraper] 搜索页已登录（nick="${searchNick}"）`);
            }
        }
        if (needRelogin) {
            // 登录完成后重新加载搜索页，重新注册响应监听
            responsePromise = makeSearchResponsePromise();
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }

        // 3. 等待"新发布"元素出现（确认搜索页已加载）
        try {
            await page.locator(selectors.filterNewPublish).first().waitFor({ state: 'visible', timeout: 15000 });
        } catch {
            console.log('[GoofishScraper] "新发布"元素未出现，可能未登录或页面异常');
            // 等待网络空闲，给 API 请求更多时间
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
        }

        // 4. 检查反爬虫弹窗
        await this._checkAntiCrawl();

        // 5. 关闭广告弹窗
        await this._closeAdPopup();

        // 6. 捕获初始搜索结果
        const initialResponse = await responsePromise;
        let initialData = null;
        if (initialResponse) {
            initialData = await initialResponse.json().catch(() => null);
            if (initialData) {
                console.log('[GoofishScraper] 捕获初始搜索响应，数据结构 keys:', Object.keys(initialData));
            } else {
                console.log('[GoofishScraper] 初始搜索响应 JSON 解析失败');
            }
        } else {
            console.log('[GoofishScraper] 未捕获到 JSON 搜索响应');
            if (mtopRequests.length > 0) {
                console.log('[GoofishScraper] 页面 mtop 请求:', [...new Set(mtopRequests)].join(', '));
            } else {
                console.log('[GoofishScraper] 页面无任何 mtop 请求（可能未登录或被反爬拦截）');
            }
        }

        // 7. 应用筛选条件
        let filterData = null;
        if (filters.newPublish) {
            filterData = await this._applyFilterNewPublish(filters.newPublishOption);
        }
        if (filters.personal) {
            const personalData = await this._applyFilterPersonal();
            filterData = filterData || personalData;
        }
        if (filters.freeShipping) {
            const shippingData = await this._applyFilterFreeShipping();
            filterData = filterData || shippingData;
        }

        // 8. 解析搜索结果（优先用筛选后的，其次用初始数据，最后用API缓存）
        const resultBody = filterData || initialData;
        if (resultBody) {
            this._searchResults = this._parseSearchResult(resultBody);
        } else {
            // 兜底：从 API 缓存中取
            const cached = this.getApiResponse('searchList');
            if (cached) {
                this._searchResults = this._parseSearchResult(cached.body);
            }
        }

        // 9. 翻页加载更多（maxPages>0 按配置限制，否则翻到最后一页）
        let currentPage = 1;
        // 先读取总页数（如 "1/50" 中的 50）
        const totalPages = await this._getTotalPages();
        const totalPagesLabel = totalPages > 0 ? `/${totalPages}` : '';
        while (unlimited || currentPage < maxPages) {
            const hasNext = await this._hasNextPage();
            if (!hasNext) {
                console.log(`[GoofishScraper] 第 ${currentPage}${totalPagesLabel} 页已是最后一页，停止翻页`);
                break;
            }

            console.log(`[GoofishScraper] 正在翻至第 ${currentPage + 1}${totalPagesLabel} 页...`);

            // 清空 searchList 缓存，准备接收新的响应
            this._apiResponses.delete('searchList');

            // 点击下一页
            const clicked = await this._clickNextPage();
            if (!clicked) break;

            // 等待新页面加载和 API 响应
            await this._sleep(2500);

            // 尝试从 API 缓存获取新数据
            const nextApi = await this.waitForApiResponse('searchList', 15000);
            if (nextApi && nextApi.body) {
                const nextResults = this._parseSearchResult(nextApi.body);
                if (nextResults.length > 0) {
                    currentPage++;
                    // 翻页后读取实际页码确认
                    const actualPage = await this._getCurrentPage();
                    const pageLabel = actualPage > 0 ? `${actualPage}${totalPagesLabel}` : `${currentPage}${totalPagesLabel}`;
                    console.log(`[GoofishScraper] 已加载第 ${pageLabel} 页，本页 ${nextResults.length} 个商品，共累计 ${this._searchResults.length + nextResults.length} 个`);
                    this._searchResults.push(...nextResults);
                } else {
                    console.log(`[GoofishScraper] 第 ${currentPage + 1}${totalPagesLabel} 页解析结果为空，停止翻页`);
                    break;
                }
            } else {
                // API 未捕获，尝试 DOM 底底（当前页）
                await this._sleep(2000);
                const domResults = await this._parseSearchResultFromDOM();
                if (domResults.length > 0) {
                    currentPage++;
                    const actualPage = await this._getCurrentPage();
                    const pageLabel = actualPage > 0 ? `${actualPage}${totalPagesLabel}` : `${currentPage}${totalPagesLabel}`;
                    console.log(`[GoofishScraper] 第 ${pageLabel} 页 DOM 底底 ${domResults.length} 个商品，共累计 ${this._searchResults.length + domResults.length} 个`);
                    this._searchResults.push(...domResults);
                } else {
                    console.log(`[GoofishScraper] 第 ${currentPage + 1}${totalPagesLabel} 页未获取到数据，停止翻页`);
                    break;
                }
            }
        }

        // 10. 全部翻页完成后，如果仍无结果，尝试 DOM 兜底
        if (this._searchResults.length === 0) {
            console.log('[GoofishScraper] API 未捕获到搜索结果，尝试 DOM 兜底');
            this._searchResults = await this._parseSearchResultFromDOM();
        }

        console.log(`[GoofishScraper] 搜索完成，共 ${this._searchResults.length} 个商品`);
        return this._searchResults;
    }

    /**
     * 抓取商品详情
     *
     * @param {string} itemId - 商品 ID
     * @returns {Promise<object|null>} 商品详情数据
     */
    async scrapeProduct(itemId) {
        // DB 新鲜度检查：已采集且在 freshTTLDays 天内的商品直接返回数据库数据，避免重复访问
        const freshTTLDays = this.options.freshTTLDays;
        const db = new XianyuDB(null, freshTTLDays);
        db.open();
        try {
            const freshCheck = db.checkProductFresh(itemId);
            if (freshCheck.fresh) {
                const cachedProduct = db.getProduct(itemId);
                console.log(`[GoofishScraper] 商品 ${itemId} 数据新鲜（${freshCheck.ageDays}天前更新），直接返回DB数据，跳过网络请求`);
                this._logStep('商品新鲜度检查', 'DB缓存命中', { itemId, ageDays: freshCheck.ageDays }, true);
                return this._dbProductToResult(cachedProduct);
            }
            if (freshCheck.exists) {
                const ageLabel = freshCheck.ageDays === -1 ? '从未完整爬取' : `${freshCheck.ageDays}天前更新`;
                console.log(`[GoofishScraper] 商品 ${itemId} 数据过期（${ageLabel}），重新爬取`);
            } else {
                console.log(`[GoofishScraper] 商品 ${itemId} DB无记录，首次爬取`);
            }
        } finally {
            db.close();
        }

        const page = this._page;
        const url = this.constructor.PRODUCT_URL.replace('{itemId}', itemId);

        console.log(`[GoofishScraper] 抓取商品详情: ${itemId}`);

        // 清空缓存，准备接收新数据
        this.clearApiCache();

        // 1. 导航到商品详情页
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 2. 等待商品详情 API（已包含 itemDO + sellerDO + picDetailDO）
        const detailResult = await this.waitForApiResponse('productDetail', 15000);

        // 3. 截取商品详情页截图（先滚回顶部，确保拍到商品图片区域）
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
        await this._sleep(500);
        // 使用 jpeg 格式 + 60% 质量压缩，避免 PNG 全页截图超过图床 413 限制
        const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 }).catch(() => null);

        // 6. 上传截图到图床
        let screenshotUrl = '';
        if (screenshotBuffer) {
            try {
                screenshotUrl = await imageHosting.upload(screenshotBuffer, 'url', {
                    filename: `goofish_${itemId}.jpg`,
                });
                console.log(`[GoofishScraper] 截图已上传: ${screenshotUrl}`);
            } catch (e) {
                console.log(`[GoofishScraper] 截图上传失败: ${e.message}`);
            }
        }

        // 7. 下载商品图片并上传图床（原始heic格式AI不支持，转jpg后上传）
        const imageInfos = detailResult?.body?.data?.itemDO?.imageInfos || [];
        const uploadedImages = [];
        for (let i = 0; i < imageInfos.length; i++) {
            const info = imageInfos[i];
            const originalUrl = info?.url || info?.picUrl || '';
            if (!originalUrl) continue;
            try {
                // alicdn 内置格式转换：URL后加 _640x640q90.jpg 可获取jpg版本
                const jpgUrl = originalUrl + '_640x640q90.jpg';
                const resp = await axios.get(jpgUrl, {
                    responseType: 'arraybuffer',
                    timeout: 10000,
                    headers: { 'Referer': 'https://www.goofish.com/' },
                });
                const uploaded = await imageHosting.upload(Buffer.from(resp.data), 'url', {
                    filename: `goofish_${itemId}_${i}.jpg`,
                });
                uploadedImages.push({
                    url: originalUrl,
                    uploadedUrl: uploaded,
                    major: info?.major || false,
                    width: info?.widthSize || 0,
                    height: info?.heightSize || 0,
                });
            } catch (e) {
                // 下载或上传失败，保留原始URL
                uploadedImages.push({
                    url: originalUrl,
                    uploadedUrl: '',
                    major: info?.major || false,
                    width: info?.widthSize || 0,
                    height: info?.heightSize || 0,
                });
            }
        }
        this._logStep('商品图片上传', '图片下载转jpg并上传图床', {
            total: imageInfos.length,
            uploaded: uploadedImages.filter(i => i.uploadedUrl).length,
        }, uploadedImages.some(i => i.uploadedUrl));

        // 8. 组装商品详情
        // 详情 API (taobao.idle.pc.detail) 返回 { data: { itemDO, sellerDO, picDetailDO } }
        // sellerDO 已包含在 detailData 中，不需要单独的 sellerInfo API
        this._logStep('详情API', '获取商品详情数据', {
            hasDetail: !!detailResult,
            detailKeys: detailResult?.body?.data ? Object.keys(detailResult.body.data) : [],
        }, !!detailResult);

        const product = this._assembleProductDetail({
            itemId,
            detailData: detailResult?.body?.data,
            screenshotUrl,
        });

        // 注入上传后的图片URL列表
        product.uploadedImages = uploadedImages;

        console.log(`[GoofishScraper] 商品详情抓取完成: ${product.title || itemId}`);
        return product;
    }

    // ======================== 卖家详情 ========================

    /**
     * 抓取卖家主页详情（对齐 Python 版 scrape_user_profile 三阶段采集）
     *
     * 阶段1: 导航 + 捕获卖家资料 API (mtop.idle.web.user.page.head)
     * 阶段2: 滚动加载全部商品 (mtop.idle.web.xyh.item.list, 分页 nextPage)
     * 阶段3: 点击“信用及评价”tab + 滚动加载全部评价 (mtop.idle.web.trade.rate.list)
     *
     * @param {string|number} userId - 卖家用户 ID
     * @param {object} [options]
     * @param {boolean} [options.withItems=true] - 是否抓取卖家在售商品
     * @param {boolean} [options.withRatings=true] - 是否抓取卖家评价
     * @param {boolean} [options.withScreenshot=true] - 是否截取卖家主页
     * @returns {Promise<object>} 卖家详情数据
     */
    async scrapeSeller(userId, options = {}) {
        const { withItems = true, withRatings = true, withScreenshot = true } = options;

        // DB 新鲜度检查：已采集且在 freshTTLDays 天内的卖家直接返回数据库数据，避免重复访问
        const freshTTLDays = this.options.freshTTLDays;
        const db = new XianyuDB(null, freshTTLDays);
        db.open();
        try {
            const freshCheck = db.checkSellerFresh(userId);
            if (freshCheck.fresh) {
                const cachedSeller = db.getSeller(userId);
                console.log(`[GoofishScraper] 卖家 ${userId} 数据新鲜（${freshCheck.ageDays}天前更新），直接返回DB数据，跳过网络请求`);
                this._logStep('卖家新鲜度检查', 'DB缓存命中', { userId, ageDays: freshCheck.ageDays }, true);
                return this._dbSellerToResult(cachedSeller);
            }
            if (freshCheck.exists) {
                const ageLabel = freshCheck.ageDays === -1 ? '从未完整爬取' : `${freshCheck.ageDays}天前更新`;
                console.log(`[GoofishScraper] 卖家 ${userId} 数据过期（${ageLabel}），重新爬取`);
            } else {
                console.log(`[GoofishScraper] 卖家 ${userId} DB无记录，首次爬取`);
            }
        } finally {
            db.close();
        }

        const page = this._page;
        const url = this.constructor.SELLER_URL.replace('{userId}', userId);

        console.log(`[GoofishScraper] 抓取卖家主页: ${userId}`);
        this.clearApiCache();

        // ---- 阶段1: 导航 + 捕获卖家资料 ----
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const sellerResult = await this.waitForApiResponse('sellerInfo', 15000);

        // ---- 阶段2: 滚动加载全部商品 ----
        let allItemCards = [];
        let itemsHasMore = true;
        if (withItems) {
            // 等待第一页商品 API
            await this._sleep(2000);
            const firstItemsResult = await this.waitForApiResponse('sellerItems', 8000).catch(() => null);
            if (firstItemsResult?.body?.data) {
                allItemCards = firstItemsResult.body.data.cardList || [];
                itemsHasMore = firstItemsResult.body.data.nextPage !== false;
            }

            // 滚动加载更多（分页）
            let scrollRound = 0;
            while (itemsHasMore && scrollRound < 10) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
                await this._sleep(1500);
                const moreResult = await this.waitForApiResponse('sellerItems', 8000).catch(() => null);
                if (moreResult?.body?.data) {
                    const newCards = moreResult.body.data.cardList || [];
                    allItemCards.push(...newCards);
                    itemsHasMore = moreResult.body.data.nextPage !== false;
                } else {
                    itemsHasMore = false;
                }
                scrollRound++;
            }
            this._logStep('卖家商品', '滚动加载商品列表', {
                totalCards: allItemCards.length, scrollRound,
            }, allItemCards.length > 0);
        }

        // ---- 阶段3: 点击"信用及评价" + 滚动加载全部评价 ----
        let allRatingCards = [];
        if (withRatings) {
            try {
                // DOM 结构: li > div.item > div.title > div.textReal("信用及评价") + div.textShadow(遮挡层)
                // 直接点 textReal 会被 textShadow 拦截，必须定位到父级 li 元素再点击
                let ratingTabEl = null;

                // 策略1: 定位包含该文本的 li 元素（最稳定）
                const liWithRating = page.locator('li').filter({ hasText: /信用及评价/ });
                if (await liWithRating.count() > 0) {
                    ratingTabEl = liWithRating.first();
                }

                // 策略2: 定位 [class*="item"] 父容器
                if (!ratingTabEl) {
                    const itemWithRating = page.locator('[class*="item"]').filter({ hasText: /信用及评价/ });
                    if (await itemWithRating.count() > 0) ratingTabEl = itemWithRating.first();
                }

                if (ratingTabEl) {
                    // 优先常规点击，被遮挡则改用 dispatchEvent 绕过
                    try {
                        await ratingTabEl.click({ timeout: 5000 });
                    } catch {
                        console.log('[GoofishScraper] 常规点击被遮挡，改用 dispatchEvent 触发');
                        await ratingTabEl.dispatchEvent('click');
                    }
                    await this._sleep(3000);

                    // 等待第一页评价 API
                    const firstRatingResult = await this.waitForApiResponse('sellerRatings', 8000).catch(() => null);
                    if (firstRatingResult?.body?.data) {
                        allRatingCards = firstRatingResult.body.data.cardList || [];
                    }

                    // 滚动加载更多评价
                    let ratingHasMore = true;
                    let ratingScrollRound = 0;
                    while (ratingHasMore && ratingScrollRound < 5) {
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
                        await this._sleep(1500);
                        const moreResult = await this.waitForApiResponse('sellerRatings', 8000).catch(() => null);
                        if (moreResult?.body?.data) {
                            const newCards = moreResult.body.data.cardList || [];
                            allRatingCards.push(...newCards);
                            ratingHasMore = moreResult.body.data.nextPage !== false;
                        } else {
                            ratingHasMore = false;
                        }
                        ratingScrollRound++;
                    }
                    this._logStep('卖家评价', '滚动加载评价列表', {
                        totalCards: allRatingCards.length, ratingScrollRound,
                    }, allRatingCards.length > 0);
                } else {
                    console.log('[GoofishScraper] 未找到"信用及评价"tab，跳过评价采集');
                }

            } catch (e) {
                console.log(`[GoofishScraper] 评价采集失败: ${e.message}`);
            }
        }

        // ---- 截取卖家主页 ----
        let screenshotUrl = '';
        if (withScreenshot) {
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
            await this._sleep(500);
            // 使用 jpeg 格式 + 60% 质量压缩，避免 PNG 全页截图超过图床 413 限制
            const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 }).catch(() => null);
            if (screenshotBuffer) {
                try {
                    screenshotUrl = await imageHosting.upload(screenshotBuffer, 'url', {
                        filename: `goofish_seller_${userId}.jpg`,
                    });
                } catch (e) {
                    console.log(`[GoofishScraper] 卖家主页截图上传失败: ${e.message}`);
                }
            }
        }

        // ---- 组装数据 ----
        const seller = this._assembleSellerDetail({
            userId,
            sellerData: sellerResult?.body?.data,
            itemCards: allItemCards,
            ratingCards: allRatingCards,
            screenshotUrl,
        });

        this._logStep('卖家详情', '抓取卖家主页完整数据', {
            userId,
            hasSellerInfo: !!sellerResult,
            itemCount: seller.items?.length || 0,
            ratingCount: seller.ratings?.length || 0,
        }, !!sellerResult);

        console.log(`[GoofishScraper] 卖家主页抓取完成: ${seller.name || userId}，商品: ${seller.items?.length || 0}，评价: ${seller.ratings?.length || 0}`);
        return seller;
    }

    /**
     * 组装卖家详情数据
     */
    _assembleSellerDetail({ userId, sellerData, itemCards, ratingCards, screenshotUrl }) {
        // sellerInfo API 返回: { baseInfo, module: { shop, social, tabs, base } }
        const data = sellerData || {};
        const mod = data.module || {};
        const base = mod.base || {};
        const shop = mod.shop || {};
        const social = mod.social || {};
        const tabs = mod.tabs || {};

        // 从 cardList 提取卖家商品列表（sellerItems API 格式）
        // card 结构: { cardData: { auctionType, categoryId, detailParams: { itemId, picUrl, title, price, ... } } }
        const items = (itemCards || []).map(card => {
            const dp = card?.cardData?.detailParams || card?.main || card || {};
            const cd = card?.cardData || {};
            return {
                itemId: dp.itemId || dp.id || '',
                title: dp.title || '',
                price: dp.price || dp.soldPrice || '',
                imageUrl: dp.picUrl || dp.picUrlList?.[0] || dp.imageUrl || '',
                wantCnt: dp.wantCnt || 0,
                soldCnt: dp.soldCnt || cd.soldCnt || 0,
                isSold: dp.isSold ? 1 : (dp.status === 'sold' ? 1 : 0),
                area: dp.area || dp.location || '',
                categoryId: dp.categoryId || cd.categoryId || 0,
                status: dp.status || (dp.onShelf !== undefined ? (dp.onShelf ? 'onshelf' : 'offshelf') : ''),
                url: (dp.itemId || dp.id) ? `https://www.goofish.com/item?id=${dp.itemId || dp.id}` : '',
            };
        }).filter(item => item.itemId);

        // 从 cardList 提取评价列表（sellerRatings API 格式）
        // card 结构: { cardData: { feedback, gmtCreate, raterHeadImg, raterUserNick, idleCustomWordContents, rateTagList, rate, ... } }
        const ratings = (ratingCards || []).map(card => {
            const cd = card?.cardData || card || {};
            return {
                content: cd.feedback || '',
                rateTime: cd.gmtCreate || '',
                raterNick: cd.raterUserNick || '',
                raterAvatar: cd.raterHeadImg || '',
                rate: cd.rate || 0,                       // 1=好评 0=中评 -1=差评
                tags: (cd.rateTagList || []).map(t => t.text || ''),
                customWords: (cd.idleCustomWordContents || []).map(w => w.content || ''),
                ipLocation: cd.ipAddress || '',
                sellerReply: cd.sellerReply || '',
                images: Array.isArray(cd.images) ? cd.images.join(',') : '',
                isAnonymous: cd.isAnonymous ? 1 : 0,
            };
        });

        // 信誉统计（对齐 Python 版 calculate_reputation_from_ratings）
        const goodRatings = ratings.filter(r => r.rate === 1).length;
        const neutralRatings = ratings.filter(r => r.rate === 0).length;
        const badRatings = ratings.filter(r => r.rate === -1).length;

        return {
            userId: base.userId || data.baseInfo?.kcUserId || userId,
            name: base.displayName || base.nick || '',
            avatar: base.avatar || base.portraitUrl || '',
            city: base.ipLocation || base.city || '',
            province: base.ipLocation || '',
            signature: base.signature || base.desc || '',
            fansCnt: parseInt(social.followers) || 0,
            followCnt: parseInt(social.following) || 0,
            hasSoldNum: shop.reviewNum || 0,
            itemCount: tabs.item?.number || items.length,
            shopLevel: shop.level || '',
            shopScore: shop.score || 0,
            praiseRatio: shop.praiseRatio || '',
            reviewNum: shop.reviewNum || 0,
            goodRatio: shop.praiseRatio ? shop.praiseRatio + '%' : '',
            creditLevel: data.baseInfo?.tags?.idle_zhima_zheng ? '信用极好' : '',
            identityTags: (base.identityTags || []).map(t => t.text || ''),
            sellerTags: (base.sellerInfoTags || []).map(t => t.text || ''),
            items,
            ratings,
            reputation: {
                totalRatings: ratings.length,
                goodRatings,
                neutralRatings,
                badRatings,
                goodRatio: ratings.length > 0 ? Math.round(goodRatings / ratings.length * 100) + '%' : '',
            },
            screenshotUrl,
            rawSeller: sellerData,
            rawItems: itemCards,
            rawRatings: ratingCards,
        };
    }

    // ======================== 内部方法 ========================

    // ---------- 页面就绪与登录 ----------

    /**
     * 等待页面关键元素渲染
     */
    async _waitForPageReady() {
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const waitSelector = selectors.searchInput || 'body';
        try {
            await this._page.locator(waitSelector).first().waitFor({ state: 'visible', timeout: 10000 });
            console.log('[GoofishScraper] 页面关键元素已渲染');
        } catch {
            console.log('[GoofishScraper] 关键元素未出现，继续执行登录流程');
            // 诊断：截图 + 打印页面标题和关键 HTML
            try {
                const debugDir = qrUtils.ensureTempDir('goofish');
                const debugPath = path.join(debugDir, `debug_pageReady_${Date.now()}.png`);
                await this._page.screenshot({ path: debugPath, fullPage: false });
                const title = await this._page.title();
                const url = this._page.url();
                // 获取 header 区域 HTML
                const headerHtml = await this._page.evaluate(() => {
                    const header = document.querySelector('header') || document.querySelector('div[class*="header"]');
                    return header ? header.innerHTML.slice(0, 2000) : 'NO_HEADER_FOUND';
                }).catch(() => 'EVAL_FAILED');
                console.log(`[GoofishScraper] 页面诊断: title="${title}", url=${url}`);
                console.log(`[GoofishScraper] header HTML: ${headerHtml.slice(0, 500)}`);
                console.log(`[GoofishScraper] 诊断截图: ${debugPath}`);
            } catch { }
        }
    }

    /**
     * 等待用户登录（闲鱼 iframe 扫码登录）
     *
     * 流程：
     *   1. 检测登录 iframe 是否出现（5s 超时）
     *   2. 未出现 → 可能已登录（cookie 确认），跳过
     *   3. 出现 → 全页截图 → 识别二维码 → 终端打印 → 轮询扫码结果
     *   4. 扫码成功后点击"保持登录"按钮
     *   5. 等待 iframe 消失 = 登录完成
     */
    async _waitForLogin() {
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const loginTimeout = this.options.loginTimeout || 120000;

        // 1. 检测 header 右上角 nick 文本
        //    未登录: 文本 = "登录"
        //    已登录: 文本 = 用户昵称（如"张三"）
        //    使用 page.evaluate 直接查 DOM，避免 CSS hash 变化导致选择器失效
        let nickText = '';
        try {
            // 最多等待 10s，每 1s 检查一次
            for (let i = 0; i < 10; i++) {
                nickText = await this._page.evaluate(() => {
                    // 方式1: 精确匹配 nick class
                    const nick = document.querySelector('div[class*="nick"]');
                    if (nick) return nick.textContent?.trim() || '';
                    // 方式2: 在 user-order-container 内找第一个 div 文本
                    const container = document.querySelector('div[class*="user-order-container"]');
                    if (container) {
                        const divs = container.querySelectorAll('div, span');
                        for (const d of divs) {
                            const t = d.textContent?.trim();
                            if (t && t.length < 20 && d.children.length === 0) return t;
                        }
                    }
                    return '';
                }).catch(() => '');
                if (nickText) break;
                await this._sleep(1000);
            }
            console.log(`[GoofishScraper] header nick 文本: "${nickText}"`);
        } catch {
            console.log('[GoofishScraper] header nick 元素未出现，等待页面加载...');
        }

        if (nickText === '登录') {
            console.log('[GoofishScraper] 检测到"登录"按钮，需要登录');
            // 点击"登录"触发 QR 码 iframe
            try {
                const loginBtn = await this._page.$(selectors.loginPromptBtn).catch(() => null);
                if (loginBtn) await loginBtn.click().catch(() => { });
                await this._sleep(2000);
            } catch { }
            // 等待 QR 码 iframe 出现
            const loginFrame = await this._detectLoginIframe(8000);
            if (loginFrame) {
                console.log('[GoofishScraper] QR 码 iframe 已弹出，开始扫码登录...');
                await this._handleQRCodeLogin(loginTimeout);
                return;
            }
            // iframe 没出现可能弹出了别的登录方式，继续等待
            console.log('[GoofishScraper] 点击登录后未检测到 iframe，尝试继续等待...');
            await this._handleQRCodeLogin(loginTimeout);
            return;
        }

        if (nickText && nickText !== '登录') {
            // nick 文本是用户昵称 → 已登录
            console.log(`[GoofishScraper] 已登录（用户: ${nickText}），跳过登录流程`);
            return;
        }

        // 2. nick 元素未出现或文本为空 → 检测是否已有 QR 码 iframe
        const loginFrame = await this._detectLoginIframe(3000);
        if (loginFrame) {
            console.log('[GoofishScraper] 检测到登录 iframe，开始扫码登录...');
            await this._handleQRCodeLogin(loginTimeout);
            return;
        }

        // 3. 仍然无法确定 → 用 _checkLoginStatus 再次确认
        const isLoggedIn = await this._checkLoginStatus();
        if (isLoggedIn) {
            console.log('[GoofishScraper] 已登录，跳过登录流程');
        } else {
            console.log('[GoofishScraper] 未检测到登录标志，需要登录');
            await this._handleQRCodeLogin(loginTimeout);
        }
    }

    /**
     * 检测登录 iframe 是否存在，返回其 contentFrame
     *
     * @param {number} [timeout=5000] - 等待 iframe 出现的超时
     * @returns {Promise<Frame|null>} iframe 的 contentFrame，未检测到返回 null
     */
    async _detectLoginIframe(timeout = 5000) {
        const selectors = this.constructor.TRIGGER_SELECTORS;
        if (!selectors.loginIframe) return null;

        // 方式1：遍历页面所有 iframe DOM 元素，检查 id 属性
        // waitForSelector 对 iframe id 匹配不可靠，$$ 更稳定
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                const iframeElements = await this._page.$$('iframe').catch(() => []);
                for (const iframe of iframeElements) {
                    const id = await iframe.getAttribute('id').catch(() => '');
                    if (id === 'alibaba-login-box') {
                        const visible = await iframe.isVisible().catch(() => false);
                        if (visible) {
                            const frame = await iframe.contentFrame().catch(() => null);
                            if (frame) return frame;
                        }
                    }
                }
                // 也检查 #baxia-dialog-content
                const handle = await this._page.$('#baxia-dialog-content').catch(() => null);
                if (handle) {
                    const visible = await handle.isVisible().catch(() => false);
                    if (visible) {
                        const tagName = await handle.tagName().catch(() => '');
                        if (tagName === 'IFRAME') {
                            const frame = await handle.contentFrame();
                            if (frame) return frame;
                        }
                        const innerIframe = await handle.$('iframe').catch(() => null);
                        if (innerIframe) {
                            const frame = await innerIframe.contentFrame();
                            if (frame) return frame;
                        }
                    }
                }
            } catch { /* 忽略 */ }
            await this._sleep(500);
        }
        return null;
    }

    /**
     * 处理 iframe 内二维码扫码登录
     *
     * @param {number} timeout - 登录超时(ms)
     */
    async _handleQRCodeLogin(timeout) {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const debugDir = qrUtils.ensureTempDir('goofish');

        // 1. 尝试截取二维码 → 识别 → 终端打印
        const screenshotPath = path.join(debugDir, `qrcode_${Date.now()}.png`);

        try {
            // 等待登录弹窗完全渲染
            await this._sleep(5000);

            // 尝试切换到扫码登录标签页
            // 注意：Playwright 的 $() 不支持逗号分隔多个选择器
            // 需要分别尝试每个选择器
            let switchedToQR = false;
            try {
                const iframeElements = await page.$$('iframe').catch(() => []);
                const loginIframe = iframeElements.find(async (iframe) => {
                    return await iframe.getAttribute('id').catch(() => '') === 'alibaba-login-box';
                });
                for (const iframe of iframeElements) {
                    const id = await iframe.getAttribute('id').catch(() => '');
                    if (id !== 'alibaba-login-box') continue;
                    const frame = await iframe.contentFrame().catch(() => null);
                    if (!frame) continue;

                    // 逐个尝试扫码标签选择器
                    const tabSelectors = ['text=手机扫码安全登录', 'text=扫码登录', '[class*="qrcode"]', 'text=QR'];
                    let foundTab = null;
                    let foundSel = '';
                    for (const sel of tabSelectors) {
                        foundTab = await frame.$(sel).catch(() => null);
                        if (foundTab) { foundSel = sel; break; }
                    }

                    if (foundTab) {
                        await foundTab.click().catch(() => { });
                        switchedToQR = true;
                        await this._sleep(2000);
                        this._logStep('QR标签切换', '找到扫码标签并点击', { selector: foundSel }, true);
                    } else {
                        // 打印 frame 内的标签信息，帮助诊断
                        const tabs = await frame.$$('span, a, div[class*="tab"]').catch(() => []);
                        const tabTexts = [];
                        for (const t of tabs.slice(0, 10)) { tabTexts.push(await t.textContent().catch(() => '')); }
                        this._logStep('QR标签切换', '找到扫码标签并点击', { tabCount: tabs.length, texts: tabTexts }, false);
                    }
                    break; // 只处理第一个 alibaba-login-box
                }
            } catch (e) {
                this._logStep('QR标签切换', '找到扫码标签并点击', { error: e.message }, false);
            }

            // 截图用于 QR 识别 — 从小到大逐级截图，识别成功即停
            // 级别1: iframe 内部 QR 码 <img> 元素（最精准）
            // 级别2: iframe 内部 body（QR 码占比大）
            // 级别3: iframe 外壳元素
            // 级别4: 全页截图（兜底）
            let qrResult = { success: false };
            try {
                const iframeElements = await page.$$('iframe').catch(() => []);
                for (const iframe of iframeElements) {
                    const id = await iframe.getAttribute('id').catch(() => '');
                    if (id !== 'alibaba-login-box') continue;
                    const frame = await iframe.contentFrame().catch(() => null);

                    // 级别1: 截 QR 码 <img> 元素
                    if (frame) {
                        const qrImg = await frame.$('img[src*="qrcode"], img[src*="qr"], img[alt*="二维码"], .qrcode-img img, .qrcode img').catch(() => null);
                        if (qrImg) {
                            await qrImg.screenshot({ path: screenshotPath }).catch(() => { });
                            qrResult = await qrUtils.decodeAndPrintQR(screenshotPath, { silent: true });
                            if (qrResult.success) break;
                        }

                        // 级别2: 截 iframe 内部 body
                        const body = await frame.$('body').catch(() => null);
                        if (body) {
                            await body.screenshot({ path: screenshotPath }).catch(() => { });
                            qrResult = await qrUtils.decodeAndPrintQR(screenshotPath, { silent: true });
                            if (qrResult.success) break;
                        }
                    }

                    // 级别3: 截 iframe 外壳元素
                    await iframe.screenshot({ path: screenshotPath }).catch(() => { });
                    qrResult = await qrUtils.decodeAndPrintQR(screenshotPath, { silent: true });
                    if (qrResult.success) break;
                }
            } catch { }

            // 级别4: 全页截图兜底
            if (!qrResult.success) {
                await page.screenshot({ path: screenshotPath, fullPage: false });
                qrResult = await qrUtils.decodeAndPrintQR(screenshotPath);  // 最后一级打印失败日志
            }
            if (qrResult.success) {
                this._logStep('QR码识别', '识别成功并打印到终端', { link: qrResult.result }, true);
                console.log('[GoofishScraper] 请使用【闲鱼 APP】扫描上方二维码登录');
                qrUtils.cleanupTempFile(screenshotPath);
            } else {
                this._logStep('QR码识别', '识别成功并打印到终端', { switchedToQR, screenshot: screenshotPath }, false);
                console.log('[GoofishScraper] 请在浏览器窗口中手动扫码登录');
            }
        } catch (e) {
            this._logStep('QR码截取', '截图并识别', { error: e.message }, false);
        }

        // 2. 轮询等待扫码完成
        // 参考原始代码：扫码成功后 iframe 内出现 qrcode-success，
        // 然后出现"保持登录"按钮，8s 内不点击就自动选"不保持"
        const start = Date.now();
        while (Date.now() - start < timeout) {
            // 获取登录 iframe 的 frame（用 $$ 遍历，更可靠）
            let frame = null;
            try {
                const iframeElements = await page.$$('iframe').catch(() => []);
                for (const iframe of iframeElements) {
                    const id = await iframe.getAttribute('id').catch(() => '');
                    if (id === 'alibaba-login-box') {
                        const visible = await iframe.isVisible().catch(() => false);
                        if (visible) {
                            frame = await iframe.contentFrame().catch(() => null);
                            break;
                        }
                    }
                }
            } catch { }

            if (!frame) {
                // iframe 消失了 → 可能登录成功
                if (await this._checkLoginStatus()) {
                    console.log('[GoofishScraper] 登录成功！');
                    return;
                }
                await this._sleep(1000);
                continue;
            }

            try {
                // 检测 frame 是否已 detached
                if (frame.isDetached && frame.isDetached()) {
                    if (await this._checkLoginStatus()) {
                        console.log('[GoofishScraper] 登录成功！');
                        return;
                    }
                    await this._sleep(1000);
                    continue;
                }

                // 检查扫码成功标志（qrcode-success class）
                const successEl = await frame.$(selectors.qrCodeSuccess).catch(() => null);
                if (successEl) {
                    const className = await successEl.getAttribute('class').catch(() => '');
                    if (className && className.includes('qrcode-success')) {
                        this._logStep('扫码结果', 'qrcode-success', 'qrcode-success', true);
                        // 扫码成功后不立即判定登录 — 继续轮询等待"保持"按钮出现
                        // 因为8s倒计时，按钮可能延迟出现
                    }
                }

                // 尝试点击“保持”按钮（每次轮询都尝试，直到按钮变 visible）
                try {
                    const allKeepBtns = await frame.$$('button:has-text("保持")').catch(() => []);
                    let clicked = false;
                    for (const btn of allKeepBtns) {
                        const isVisible = await btn.isVisible().catch(() => false);
                        if (isVisible) {
                            await btn.click();
                            clicked = true;
                            this._logStep('保持按钮-点击', '点击可见的保持按钮', { btnCount: allKeepBtns.length }, true);
                            break;
                        }
                    }
                    if (!clicked && allKeepBtns.length > 0) {
                        // 按钮存在但不可见 — 用户可能还没扫码，这是正常状态
                        // 只在首次发现时打印日志
                        if (Date.now() - start < 3000) {
                            this._logStep('保持按钮-轮询', '按钮存在但不可见（等待扫码）', { btnCount: allKeepBtns.length }, true);
                        }
                    }
                    if (clicked) {
                        // “保持”按钮已点击，等待登录完成
                        await this._sleep(2000);
                        const loginResult = await this._checkLoginStatus();
                        this._logStep('登录结果', '保持按钮已点击，登录成功', { loggedIn: loginResult }, loginResult);
                        if (loginResult) return;
                    }
                } catch (e) {
                    if (e.message && e.message.includes('detached')) {
                        this._logStep('保持按钮-点击', 'frame detached', { info: '登录可能已完成' }, true);
                        const loginResult = await this._checkLoginStatus();
                        this._logStep('登录结果', 'frame detached后登录成功', { loggedIn: loginResult }, loginResult);
                        if (loginResult) return;
                    }
                }

            } catch (e) {
                if (e.message && e.message.includes('detached')) {
                    this._logStep('iframe操作', 'frame detached', { info: '登录可能已完成' }, true);
                    const loginResult = await this._checkLoginStatus();
                    this._logStep('登录结果', 'frame detached后登录成功', { loggedIn: loginResult }, loginResult);
                    if (loginResult) return;
                }
            }

            await this._sleep(1000);
        }

        this._logStep('登录超时', `${timeout / 1000}s内登录成功`, { timeout }, false);
    }

    /**
     * 处理扫码成功后的"保持登录"确认按钮
     *
     * @param {Frame} frame - 登录 iframe 的 contentFrame（必须为有效未 detached 的 frame）
     */
    async _handleKeepLogin(frame) {
        const selectors = this.constructor.TRIGGER_SELECTORS;
        const page = this._page;

        // 截图保存当前状态，方便调试
        const tmpDir = qrUtils.ensureTempDir('goofish');
        const debugPath = path.join(tmpDir, `keep_login_${Date.now()}.png`);
        try { await page.screenshot({ path: debugPath, fullPage: false }); } catch { }

        // "保持登录状态"弹窗可能在主页面上或 iframe 内
        // 从截图来看，弹窗是 overlay 在主页面上，用 page.waitForSelector 查找
        // 按钮文字是"保持"，黄色按钮
        const btnSelectors = [
            { scope: 'page', sel: 'button:has-text("保持")' },
            { scope: 'page', sel: 'text=保持' },
            { scope: 'frame', sel: selectors.keepLoginBtn },
            { scope: 'frame', sel: 'button:has-text("保持")' },
            { scope: 'frame', sel: 'text=保持' },
        ];

        for (const { scope, sel } of btnSelectors) {
            if (!sel) continue;
            try {
                const target = scope === 'page' ? page : frame;
                if (scope === 'frame' && target.isDetached && target.isDetached()) continue;
                const btn = await target.waitForSelector(sel, { timeout: 1500, state: 'visible' }).catch(() => null);
                if (btn) {
                    // 验证确实是保持登录按钮（排除误匹配）
                    const text = await btn.textContent().catch(() => '');
                    if (text && (text.includes('保持') || text.includes('keep'))) {
                        await btn.click();
                        console.log(`[GoofishScraper] 已点击"保持"按钮（${scope} 级，选择器: ${sel}）`);
                        qrUtils.cleanupTempFile(debugPath);
                        return;
                    }
                }
            } catch (e) {
                if (e.message && e.message.includes('detached')) break;
            }
        }

        console.log(`[GoofishScraper] 未找到"保持"按钮，调试截图: ${debugPath} `);
    }

    /**
     * 检查当前登录状态
     *
     * 检测逻辑（按优先级）：
     *   1. nick 文本 = "登录" → 未登录（最可靠）
     *   2. nick 文本 ≠ "登录" 且非空 → 已登录（正向确认）
     *   3. 登录 iframe 存在 → 未登录
     *   4. 无法确定 → 返回 false
     *
     * @returns {Promise<boolean>}
     */
    async _checkLoginStatus() {
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 方式1: 通过 page.evaluate 直接读取 nick 文本（避免 CSS 选择器 hash 问题）
        try {
            const nickText = await this._page.evaluate(() => {
                const nick = document.querySelector('div[class*="nick"]');
                if (nick) return nick.textContent?.trim() || '';
                const container = document.querySelector('div[class*="user-order-container"]');
                if (container) {
                    const divs = container.querySelectorAll('div, span');
                    for (const d of divs) {
                        const t = d.textContent?.trim();
                        if (t && t.length < 20 && d.children.length === 0) return t;
                    }
                }
                return '';
            }).catch(() => '');
            console.log(`[GoofishScraper] _checkLoginStatus nick: "${nickText}"`);
            if (nickText === '登录') return false;  // 未登录
            if (nickText && nickText !== '登录') return true;  // 已登录（昵称）
        } catch { /* 继续 */ }

        // 方式2：登录 iframe 存在 = 未登录
        const loginFrame = await this._detectLoginIframe(1500);
        if (loginFrame) {
            return false;
        }

        // 无法确定 → 偏向未登录
        return false;
    }

    // ---------- 登录 cookie 持久化 ----------

    /**
     * 登录成功后，强制持久化所有 cookie
     *
     * 问题：如果不点"保持"按钮，服务器设置的 cookie 可能是 session cookie（无 expires），
     * Chromium 关闭时会清除 session cookie，导致下次启动仍需重新登录。
     *
     * 解决：读取所有 cookie，对没有 expires 的 cookie 加上 30 天有效期，重写回去。
     * 这样即使"保持"按钮没点到，cookie 也会被强制持久化。
     */
    async _persistLoginCookies() {
        const context = this.context;
        if (!context) {
            this._logStep('Cookie持久化', '获取browserContext', { error: 'context不存在' }, false);
            return;
        }

        try {
            const cookies = await context.cookies();
            const now = Date.now();
            const thirtyDays = 30 * 24 * 60 * 60 * 1000; // 30天
            let modifiedCount = 0;

            const persistedCookies = cookies.map(cookie => {
                // session cookie: expires = -1 或 expires = 0（无过期时间）
                // 过期 cookie: expires < 当前时间
                const nowSec = Math.floor(now / 1000);
                if (!cookie.expires || cookie.expires <= 0 || cookie.expires < nowSec) {
                    modifiedCount++;
                    return {
                        ...cookie,
                        expires: Math.floor((now + thirtyDays) / 1000), // Unix timestamp（秒）
                    };
                }
                return cookie;
            });

            // 清除旧 cookie，写入新的持久化 cookie
            await context.clearCookies();
            await context.addCookies(persistedCookies);

            this._logStep('Cookie持久化', '强制延长cookie有效期', {
                totalCookies: cookies.length,
                modifiedCount,
                domains: [...new Set(cookies.map(c => c.domain))],
            }, true);  // modifiedCount=0 表示所有cookie已有expires，也是成功
        } catch (e) {
            this._logStep('Cookie持久化', '强制延长cookie有效期', { error: e.message }, false);
        }
    }

    // ---------- 反爬虫与弹窗 ----------

    /**
     * 检查闲鱼反爬虫弹窗，如果出现则抛出异常
     * @throws {Error} 遇到反爬虫弹窗时
     */
    async _checkAntiCrawl() {
        const page = this._page;
        const selectors = this.constructor.TRIGGER_SELECTORS;

        // 检查八匣反爬虫弹窗
        if (selectors.baxiaDialog) {
            try {
                const dialog = page.locator(selectors.baxiaDialog).first();
                if (await dialog.isVisible({ timeout: 2000 })) {
                    console.log('[GoofishScraper] ==================== 反爬虫弹窗检测 ====================');
                    console.log('[GoofishScraper] 检测到 baxia-dialog 反爬虫验证弹窗，无法继续操作');
                    console.log('[GoofishScraper] 建议：停止脚本一段时间再试，或用 headless: false 运行');
                    throw new Error('[GoofishScraper] 反爬虫弹窗 (baxia-dialog)，任务中止');
                }
            } catch (e) {
                if (e.message.includes('反爬虫弹窗')) throw e;
                // 2秒内弹窗未出现，正常继续
            }
        }

        // 检查中间件验证弹窗
        if (selectors.middlewareWidget) {
            try {
                const widget = page.locator(selectors.middlewareWidget).first();
                if (await widget.isVisible({ timeout: 2000 })) {
                    console.log('[GoofishScraper] 检测到 J_MIDDLEWARE_FRAME_WIDGET 反爬虫验证弹窗');
                    throw new Error('[GoofishScraper] 反爬虫弹窗 (J_MIDDLEWARE_FRAME_WIDGET)，任务中止');
                }
            } catch (e) {
                if (e.message.includes('反爬虫弹窗')) throw e;
            }
        }
    }

    /**
     * 关闭广告弹窗
     */
    async _closeAdPopup() {
        const selectors = this.constructor.TRIGGER_SELECTORS;
        if (!selectors.adCloseBtn) return;

        try {
            await this._page.locator(selectors.adCloseBtn).first().click({ timeout: 3000 });
            console.log('[GoofishScraper] 已关闭广告弹窗');
        } catch {
            // 未检测到广告弹窗，正常
        }
    }

    // ---------- 搜索筛选 ----------

    /**
     * 应用“新发布”筛选
     * @param {string} [option] - 子选项文本（如“1天内”）
     * @returns {Promise<object|null>} 筛选后的搜索响应 JSON
     */
    async _applyFilterNewPublish(option) {
        const page = this._page;
        const apiPatterns = this.constructor.API_PATTERNS;
        try {
            await page.locator('text=新发布').first().click();
            await this._humanDelay(1000, 2000);

            if (option) {
                const responsePromise = page.waitForResponse(
                    res => {
                        const ct = res.headers()['content-type'] || '';
                        return ct.includes('json')
                            && apiPatterns.searchList.test(res.url())
                            && !/shade|activate/i.test(res.url());
                    },
                    { timeout: 20000 }
                ).catch(() => null);

                await page.locator(`text = ${option} `).first().click();
                await this._humanDelay(2000, 4000);

                const response = await responsePromise;
                if (response) {
                    console.log(`[GoofishScraper] 已应用筛选: 新发布 > ${option} `);
                    return await response.json().catch(() => null);
                }
            } else {
                console.log('[GoofishScraper] 已应用筛选: 新发布');
            }
        } catch (e) {
            console.log(`[GoofishScraper] 新发布筛选失败: ${e.message} `);
        }
        return null;
    }

    /**
     * 应用“个人闲置”筛选
     * @returns {Promise<object|null>}
     */
    async _applyFilterPersonal() {
        const apiPatterns = this.constructor.API_PATTERNS;
        try {
            const responsePromise = this._page.waitForResponse(
                res => {
                    const ct = res.headers()['content-type'] || '';
                    return ct.includes('json')
                        && apiPatterns.searchList.test(res.url())
                        && !/shade|activate/i.test(res.url());
                },
                { timeout: 20000 }
            ).catch(() => null);

            await this._page.locator('text=个人闲置').first().click();
            await this._humanDelay(2000, 4000);

            const response = await responsePromise;
            if (response) {
                console.log('[GoofishScraper] 已应用筛选: 个人闲置');
                return await response.json().catch(() => null);
            }
        } catch (e) {
            console.log(`[GoofishScraper] 个人闲置筛选失败: ${e.message} `);
        }
        return null;
    }

    /**
     * 应用“包邮”筛选
     * @returns {Promise<object|null>}
     */
    async _applyFilterFreeShipping() {
        const apiPatterns = this.constructor.API_PATTERNS;
        try {
            const responsePromise = this._page.waitForResponse(
                res => {
                    const ct = res.headers()['content-type'] || '';
                    return ct.includes('json')
                        && apiPatterns.searchList.test(res.url())
                        && !/shade|activate/i.test(res.url());
                },
                { timeout: 20000 }
            ).catch(() => null);

            await this._page.locator('text=包邮').first().click();
            await this._humanDelay(2000, 4000);

            const response = await responsePromise;
            if (response) {
                console.log('[GoofishScraper] 已应用筛选: 包邮');
                return await response.json().catch(() => null);
            }
        } catch (e) {
            console.log(`[GoofishScraper] 包邮筛选失败: ${e.message} `);
        }
        return null;
    }

    // ---------- 搜索结果解析 ----------

    /**
     * 解析搜索结果 API 响应
     *
     * 闲鱼搜索 API (mtop.taobao.idlemtopsearch.pc.search/1.0) 响应结构：
     *   body.data.resultList = [{ data: { item: { main: {...} } }, style, type }]
     *   每个 item 的商品信息在 data.item.main 中
     *
     * @param {object} body - API 响应体（已解析的 JSON）
     * @returns {Array<{itemId: string, title: string, price: string, imageUrl: string, url: string, seller: string}>}
     */
    _parseSearchResult(body) {
        try {
            const resultList = body?.data?.resultList || body?.resultList || [];
            if (!Array.isArray(resultList) || resultList.length === 0) {
                console.log('[GoofishScraper] resultList 为空，body keys:', body ? Object.keys(body) : 'null',
                    ', data keys:', body?.data ? Object.keys(body.data).slice(0, 8) : 'null');
                return [];
            }

            const results = [];
            for (const entry of resultList) {
                try {
                    const item = entry?.data?.item;
                    if (!item) continue;

                    const main = item.main || {};
                    const exContent = main.exContent || {};
                    const detailParams = exContent.detailParams || {};

                    // itemId 可能在多个位置：main.itemId / clickParam.args.item_id / detailParams.itemId / targetUrl
                    let itemId = main.itemId || main.item_id || detailParams.itemId || '';
                    if (!itemId && main.clickParam?.args) {
                        itemId = main.clickParam.args.item_id || main.clickParam.args.itemId || '';
                    }
                    if (!itemId && main.targetUrl) {
                        const m = main.targetUrl.match(/[?&]id=([^&]+)/);
                        if (m) itemId = m[1];
                    }
                    if (!itemId && main.targetUrl) {
                        const m = main.targetUrl.match(/item\?id=([^&]+)/);
                        if (m) itemId = m[1];
                    }

                    if (!itemId) continue;

                    // 价格：优先从 price 数组拼接，其次从 clickParam/soldPrice
                    let price = '';
                    if (Array.isArray(main.price)) {
                        price = main.price.map(p => p.text || '').join('');
                    }
                    if (!price && main.clickParam?.args?.price) {
                        price = '¥' + main.clickParam.args.price;
                    }
                    if (!price && detailParams.soldPrice) {
                        price = '¥' + detailParams.soldPrice;
                    }

                    // 标题：优先 main.title，其次 richTitle，其次 detailParams.title
                    let title = main.title || '';
                    if (!title && Array.isArray(main.richTitle)) {
                        title = main.richTitle
                            .filter(n => n.type === 'Text' && n.data?.text)
                            .map(n => n.data.text)
                            .join('');
                    }
                    if (!title) title = detailParams.title || '';

                    // 商品 URL
                    let url = main.targetUrl || '';
                    if (!url || url.startsWith('fleamarket://')) url = '';

                    // 图片：搜索API精简版不含picUrl，imageUrl 在详情API中获取
                    const imageUrl = main.picUrl || main.picUrlList?.[0] || main.imageUrl || main.image || '';

                    // 卖家信息
                    const seller = main.userNickName || detailParams.userNick || exContent.area || '';

                    results.push({
                        itemId,
                        title,
                        price,
                        imageUrl,
                        url: url || `https://www.goofish.com/item?id=${itemId}`,
                        seller,
                    });
                } catch { /* 单个 item 解析失败，跳过 */ }
            }

            if (results.length === 0) {
                console.log(`[GoofishScraper] resultList 有 ${resultList.length} 项但解析全失败`);
            }

            return results;
        } catch {
            console.log('[GoofishScraper] 搜索结果解析失败，响应结构可能与预期不符');
            return [];
        }
    }

    /**
     * DOM 兜底：从页面 DOM 提取搜索结果
     *
     * 选择器说明（基于实际 DOM 探测）：
     *   - 商品容器：div[class*="feeds-list"]（CSS Modules 哈希如 feeds-list-container--UkIMBPNk）
     *   - 商品卡片：<a href="/item?id=xxx" class*="feeds-item-wrap">
     *   - 标题：class*="title" 或 class*="desc"
     *   - 价格：<span class*="sign">¥</span> + <span class*="number">3130</span>
     *   - 图片：<img class*="feeds-image">
     *   - 卖家：<p class*="seller-text">
     *
     * @returns {Promise<Array<{itemId: string, title: string, price: string, imageUrl: string, url: string, seller: string}>>}
     */
    async _parseSearchResultFromDOM() {
        const page = this._page;
        console.log('[GoofishScraper] 开始 DOM 兜底解析...');

        try {
            // 等待商品列表渲染
            await page.locator('div[class*="feeds-list"] a').first().waitFor({ state: 'attached', timeout: 10000 });
        } catch {
            console.log('[GoofishScraper] DOM 中未找到商品列表元素');
            return [];
        }

        try {
            const items = await page.evaluate(() => {
                const results = [];
                // 商品卡片：<a href="/item?id=xxx">
                const cards = document.querySelectorAll('div[class*="feeds-list"] a[href*="/item"]');

                for (const card of cards) {
                    try {
                        const href = card.getAttribute('href') || '';
                        // 提取 itemId：/item?id=123456 或 /item/123456
                        let itemId = '';
                        const idMatch = href.match(/[?&]id=([^&]+)/) || href.match(/\/item\/([^?/]+)/);
                        if (idMatch) itemId = idMatch[1];

                        // 标题：class*="title" 或 class*="desc"
                        const titleEl = card.querySelector('[class*="title"], [class*="desc"]');
                        const title = titleEl?.textContent?.trim() || '';

                        // 价格：<span class*="sign">¥</span> + <span class*="number">3130</span>
                        // 也可直接用 class*="price" 兜底
                        let price = '';
                        const signEl = card.querySelector('span[class*="sign"]');
                        const numberEl = card.querySelector('span[class*="number"]');
                        if (signEl && numberEl) {
                            price = (signEl.textContent || '') + (numberEl.textContent || '');
                        } else {
                            const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                            price = priceEl?.textContent?.trim() || '';
                        }

                        // 卖家：<p class*="seller-text">
                        const sellerEl = card.querySelector('[class*="seller-text"], [class*="seller"]');
                        const seller = sellerEl?.textContent?.trim() || '';

                        // 图片：<img class*="feeds-image">
                        const imgEl = card.querySelector('img[class*="feeds-image"]') || card.querySelector('img');
                        const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                        if (itemId || href) {
                            results.push({ itemId, title, price, imageUrl, url: href, seller });
                        }
                    } catch { /* 单个卡片解析失败，跳过 */ }
                }

                return results;
            });

            console.log(`[GoofishScraper] DOM 解析提取到 ${items.length} 个商品`);
            return items;
        } catch (e) {
            console.log(`[GoofishScraper] DOM 解析失败: ${e.message}`);
            return [];
        }
    }

    // ---------- 分页翻页 ----------

    /**
     * 读取搜索页总页数（如 "1/50" 中的 50）
     * @returns {Promise<number>} 总页数，找不到返回 0
     */
    async _getTotalPages() {
        try {
            const el = await this._page.$('span[class*="search-page-tiny-page"], div[class*="search-page-tiny-container"] span');
            if (!el) return 0;
            const text = await el.textContent();
            const match = text.match(/(\d+)\s*\/\s*(\d+)/);
            return match ? parseInt(match[2], 10) : 0;
        } catch { return 0; }
    }

    /**
     * 读取当前页码（如 "3/50" 中的 3）
     * @returns {Promise<number>} 当前页码，找不到返回 0
     */
    async _getCurrentPage() {
        try {
            const el = await this._page.$('span[class*="search-page-tiny-page"], div[class*="search-page-tiny-container"] span');
            if (!el) return 0;
            const text = await el.textContent();
            const match = text.match(/(\d+)\s*\/\s*(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
        } catch { return 0; }
    }

    /**
     * 检查当前搜索页是否有下一页
     *
     * 闲鱼分页 DOM 结构（实测）：
     *   div[class*="search-page-tiny-container"]
     *     ├── button (上一页，首页时 disabled)
     *     ├── span[class*="search-page-tiny-page"] → "1/50"
     *     └── button (下一页，末页时 disabled)
     *          └── div[class*="search-page-tiny-arrow-right"]
     *
     * @returns {Promise<boolean>}
     */
    async _hasNextPage() {
        const page = this._page;
        try {
            // 策略1：读页码文本（如 "1/50"），判断当前页 < 总页数
            const pageInfoEl = await page.$('span[class*="search-page-tiny-page"], div[class*="search-page-tiny-container"] span');
            if (pageInfoEl) {
                const text = await pageInfoEl.textContent();
                const match = text.match(/(\d+)\s*\/\s*(\d+)/);
                if (match) {
                    const current = parseInt(match[1], 10);
                    const total = parseInt(match[2], 10);
                    return current < total;
                }
            }

            // 策略2：下一页按钮存在且未禁用
            const nextBtn = await page.$('div[class*="search-page-tiny-container"] button:last-child:not([disabled])');
            if (nextBtn) return true;

            return false;
        } catch {
            return false;
        }
    }

    /**
     * 点击"下一页"按钮
     *
     * 闲鱼下一页按钮 = 分页容器内最后一个 button（含右箭头图标）
     * @returns {Promise<boolean>} 是否成功点击
     */
    async _clickNextPage() {
        const page = this._page;

        // 策略1：找到右箭头图标的父级 button（最精准）
        const rightArrow = await page.$('div[class*="search-page-tiny-arrow-right"]');
        if (rightArrow) {
            const btnHandle = await rightArrow.evaluateHandle(el => el.closest('button'));
            const btn = btnHandle.asElement();
            if (btn) {
                const disabled = await btn.getAttribute('disabled');
                if (!disabled) {
                    await btn.click();
                    console.log('[GoofishScraper] 已点击下一页按钮（右箭头）');
                    return true;
                }
            }
        }

        // 策略2：分页容器内最后一个 button（未被 disabled）
        const nextBtn = await page.$('div[class*="search-page-tiny-container"] button:last-child:not([disabled])');
        if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
            await nextBtn.click();
            console.log('[GoofishScraper] 已点击下一页按钮（末尾按钮）');
            return true;
        }

        console.log('[GoofishScraper] 未找到可点击的下一页按钮');
        return false;
    }

    // ---------- 商品详情 ----------

    /**
     * 组装商品详情数据
     */
    _assembleProductDetail({ itemId, detailData, sellerData, screenshotUrl }) {
        // 根据实际 API 响应结构解析
        // 详情 API: taobao.idle.pc.detail/1.0
        // 返回格式: { data: { itemDO, sellerDO, picDetailDO } }
        const itemDO = detailData?.itemDO || detailData || {};
        const sellerDO = detailData?.sellerDO || sellerData || {};

        return {
            itemId: itemDO?.itemId || itemId,
            sellerId: sellerDO?.sellerId || '',
            title: itemDO?.title || '',
            price: itemDO?.soldPrice || '',         // 注意: 字段是 soldPrice 不是 price
            originalPrice: itemDO?.originalPrice || '',
            description: itemDO?.desc || itemDO?.richTextDesc || '',
            images: (itemDO?.imageInfos || []).map(info => ({
                url: info?.url || info?.picUrl || '',
                major: info?.major || false,
                width: info?.widthSize || 0,
                height: info?.heightSize || 0,
            })),
            soldCnt: itemDO?.soldCnt || 0,
            browseCnt: itemDO?.browseCnt || 0,
            quantity: itemDO?.quantity || 0,
            collectCnt: itemDO?.collectCnt || 0,
            wantCnt: itemDO?.wantCnt || 0,
            createdTime: parseInt(itemDO?.gmtCreate) || 0,
            transportFee: itemDO?.transportFee || '',
            categoryId: itemDO?.categoryId || '',
            itemStatus: itemDO?.itemStatusStr || '',
            location: itemDO?.prov || itemDO?.location || '',
            area: itemDO?.city || itemDO?.area || '',
            conditionName: itemDO?.conditionName || '',
            tagList: Array.isArray(itemDO?.tagList) ? itemDO.tagList.map(t => typeof t === 'string' ? t : t?.text || '').filter(Boolean).join(',') : '',
            seller: {
                id: sellerDO?.sellerId || '',
                name: sellerDO?.nick || '',
                avatar: sellerDO?.portraitUrl || '',
                city: sellerDO?.city || '',
                signature: sellerDO?.signature || '',
                hasSoldNum: sellerDO?.hasSoldNumInteger || 0,
                itemCount: sellerDO?.itemCount || 0,
                goodRatio: sellerDO?.newGoodRatioRate || '',
                creditLevel: sellerDO?.zhimaLevelInfo?.levelName || '',
            },
            screenshotUrl,
            rawDetail: detailData,
            rawSeller: sellerData,
        };
    }

    // ======================== DB 缓存转换 ========================

    /**
     * 将 DB 行数据转换为爬虫输出格式（商品）
     * 当 DB 新鲜度命中时，直接返回此格式，与实时爬取结果一致
     */
    _dbProductToResult(dbRow) {
        if (!dbRow) return null;
        const images = (dbRow.images || []).map(img => ({
            url: img.original_url,
            uploadedUrl: img.uploaded_url,
            major: !!img.is_major,
            width: img.width,
            height: img.height,
        }));
        return {
            itemId: dbRow.item_id,
            sellerId: dbRow.seller_id || dbRow.seller?.user_id,
            title: dbRow.title,
            price: dbRow.price,
            originalPrice: dbRow.original_price,
            description: dbRow.description,
            soldCnt: dbRow.sold_cnt,
            browseCnt: dbRow.browse_cnt,
            quantity: dbRow.quantity,
            collectCnt: dbRow.collect_cnt,
            wantCnt: dbRow.want_cnt,
            createdTime: dbRow.created_time,
            transportFee: dbRow.transport_fee,
            categoryId: dbRow.category_id,
            itemStatus: dbRow.item_status,
            location: dbRow.location || '',
            area: dbRow.area || '',
            conditionName: dbRow.condition_name || '',
            tagList: dbRow.tag_list || '',
            screenshotUrl: dbRow.screenshot_url,
            uploadedImages: images,
            seller: dbRow.seller ? {
                id: dbRow.seller.user_id,
                name: dbRow.seller.name,
                avatar: dbRow.seller.avatar,
                city: dbRow.seller.city,
                signature: dbRow.seller.signature,
                hasSoldNum: dbRow.seller.has_sold_num,
                itemCount: dbRow.seller.item_count,
                goodRatio: dbRow.seller.good_ratio,
                creditLevel: dbRow.seller.credit_level,
            } : undefined,
            _fromCache: true,
        };
    }

    /**
     * 将 DB 行数据转换为爬虫输出格式（卖家）
     */
    _dbSellerToResult(dbRow) {
        if (!dbRow) return null;
        const items = (dbRow.items || []).map(item => ({
            itemId: item.item_id,
            title: item.title,
            price: item.price,
            imageUrl: item.image_url,
            wantCnt: item.want_cnt,
            soldCnt: item.sold_cnt || 0,
            isSold: item.is_sold || 0,
            area: item.area || '',
            categoryId: item.category_id || 0,
            status: item.status || '',
        }));
        const ratings = (dbRow.ratings || []).map(r => ({
            content: r.content,
            rateTime: r.rate_time,
            raterNick: r.rater_nick,
            raterAvatar: r.rater_avatar,
            rate: r.rate,
            tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
            customWords: r.custom_words ? r.custom_words.split(',').filter(Boolean) : [],
            ipLocation: r.ip_location,
            sellerReply: r.seller_reply || '',
            images: r.images ? r.images.split(',').filter(Boolean) : [],
            isAnonymous: r.is_anonymous || 0,
        }));
        const totalRatings = ratings.length;
        const goodRatings = ratings.filter(r => r.rate === 1).length;
        const neutralRatings = ratings.filter(r => r.rate === 0).length;
        const badRatings = ratings.filter(r => r.rate === -1).length;
        return {
            userId: dbRow.user_id,
            name: dbRow.name,
            avatar: dbRow.avatar,
            city: dbRow.city,
            province: dbRow.city,
            signature: dbRow.signature,
            fansCnt: dbRow.fans_cnt,
            followCnt: dbRow.follow_cnt,
            hasSoldNum: dbRow.has_sold_num,
            itemCount: dbRow.item_count,
            shopLevel: dbRow.shop_level,
            shopScore: dbRow.shop_score,
            praiseRatio: dbRow.praise_ratio,
            reviewNum: dbRow.review_num,
            goodRatio: dbRow.good_ratio,
            creditLevel: dbRow.credit_level,
            items,
            ratings,
            reputation: {
                totalRatings,
                goodRatings,
                neutralRatings,
                badRatings,
                goodRatio: totalRatings > 0 ? Math.round(goodRatings / totalRatings * 100) + '%' : '',
            },
            screenshotUrl: dbRow.screenshot_url,
            _fromCache: true,
        };
    }

    // ---------- 工具方法 ----------

    /**
     * 模拟人类操作延迟
     */
    async _humanDelay(min = 300, max = 800) {
        const ms = min + Math.random() * (max - min);
        await this._sleep(Math.round(ms));
    }
}

module.exports = GoofishScraper;

/**
 * AIFish AI 分析脚本
 *
 * 流程：DB 读取未分析商品 → 构建 Prompt → AI 分析 → 结果入库 → 钉钉通知
 * 独立于爬取脚本，可单独运行，也可重复分析（更换 prompt 后重跑）
 *
 * 用法：
 *   node script/aifish-analyze.js ./script/json/AIFish-example.json
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const antiDetectScript = require('../lib/anti-detect');
const DoubaoAnalyzer = require('../analyzer/DoubaoAnalyzer');
const ZhiPuAnalyzer = require('../analyzer/ZhiPuAnalyzer');
const { buildPrompt } = require('../scraper/prompt-builder');
const { XianyuDB } = require('../scraper/db');
const DingDingNotifier = require('../notify/DingDingNotifier');

// ======================== 配置加载 ========================

function loadConfig(configPath) {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
        console.error(`配置文件不存在: ${resolved}`);
        process.exit(1);
    }
    const userConfig = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const defaults = require('../config/default');
    return { ...defaults, ...userConfig };
}

// ======================== DB → Prompt 数据转换 ========================

/**
 * 将 DB t_product 行转为 buildPrompt 需要的 product 格式
 * 对齐 GoofishScraper._dbProductToResult
 */
function productFromDB(dbProduct) {
    if (!dbProduct) return null;
    const images = (dbProduct.images || []).map(img => ({
        url: img.original_url,
        uploadedUrl: img.uploaded_url,
        major: !!img.is_major,
        width: img.width,
        height: img.height,
    }));
    return {
        itemId: dbProduct.item_id,
        title: dbProduct.title,
        price: dbProduct.price,
        originalPrice: dbProduct.original_price,
        description: dbProduct.description,
        soldCnt: dbProduct.sold_cnt,
        browseCnt: dbProduct.browse_cnt,
        quantity: dbProduct.quantity,
        collectCnt: dbProduct.collect_cnt,
        wantCnt: dbProduct.want_cnt,
        createdTime: dbProduct.created_time,
        transportFee: dbProduct.transport_fee,
        itemStatus: dbProduct.item_status,
        location: dbProduct.location || '',
        area: dbProduct.area || '',
        conditionName: dbProduct.condition_name || '',
        tagList: dbProduct.tag_list || '',
        keyword: dbProduct.keyword || '',
        screenshotUrl: dbProduct.screenshot_url,
        uploadedImages: images,
        seller: dbProduct.seller ? {
            userId: dbProduct.seller.user_id,
            name: dbProduct.seller.name,
            city: dbProduct.seller.city,
            signature: dbProduct.seller.signature,
            hasSoldNum: dbProduct.seller.has_sold_num,
            itemCount: dbProduct.seller.item_count,
            goodRatio: dbProduct.seller.good_ratio,
            creditLevel: dbProduct.seller.credit_level,
        } : undefined,
    };
}

/**
 * 将 DB t_seller 行转为 buildPrompt 需要的 seller 格式
 * 对齐 GoofishScraper._dbSellerToResult
 */
function sellerFromDB(dbSeller) {
    if (!dbSeller) return null;
    const items = (dbSeller.items || []).map(item => ({
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
    const ratings = (dbSeller.ratings || []).map(r => ({
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
        userId: dbSeller.user_id,
        name: dbSeller.name,
        avatar: dbSeller.avatar || '',
        city: dbSeller.city,
        province: dbSeller.city,
        signature: dbSeller.signature,
        fansCnt: dbSeller.fans_cnt,
        followCnt: dbSeller.follow_cnt,
        hasSoldNum: dbSeller.has_sold_num,
        itemCount: dbSeller.item_count,
        shopLevel: dbSeller.shop_level,
        shopScore: dbSeller.shop_score,
        praiseRatio: dbSeller.praise_ratio,
        reviewNum: dbSeller.review_num,
        goodRatio: dbSeller.good_ratio,
        creditLevel: dbSeller.credit_level,
        items,
        ratings,
        reputation: {
            totalRatings,
            goodRatings,
            neutralRatings,
            badRatings,
            goodRatio: totalRatings > 0 ? Math.round(goodRatings / totalRatings * 100) + '%' : '',
        },
    };
}

// ======================== 主流程 ========================

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        console.log('用法: node script/aifish-analyze.js <配置文件路径>');
        console.log('示例: node script/aifish-analyze.js ./script/json/AIFish-example.json');
        process.exit(1);
    }

    const config = loadConfig(configPath);

    console.log('╔══════════════════════════════════════╗');
    console.log('║       AIFish AI 商品分析             ║');
    console.log('╚══════════════════════════════════════╝');
    const aiPlatform = (config.aiPlatform || 'doubao').toLowerCase();
    const platformLabel = aiPlatform === 'zhipu'
        ? (config.intelligent ? '智谱清言(深度思考)' : '智谱清言(快速)')
        : (config.intelligent ? '豆包(深度思考)' : '豆包(快速)');
    console.log(`AI平台: ${platformLabel}`);
    console.log('');

    // ---- 1. 初始化数据库 ----
    console.log('[1/4] 初始化数据库...');
    const db = new XianyuDB(config.dbPath, config.freshTTLDays);
    db.open();

    // ---- 2. 查询未分析商品 ----
    console.log('[2/4] 查询未分析商品...');
    const unanalyzed = db.getUnanalyzedProducts({
        keyword: config.keyword || '',
        limit: 200,
    });
    console.log(`[2/4] 未分析商品: ${unanalyzed.length} 个\n`);

    if (unanalyzed.length === 0) {
        console.log('没有需要分析的商品，退出');
        db.close();
        return;
    }

    // ---- 3. 启动浏览器 + AI 分析器 ----
    console.log('[3/4] 启动 AI 分析器...');
    const userDataDir = path.join(__dirname, '..', 'UserData', config.dataName || 'demo');
    // UA 修正：不自定义 UA → 使用 Chromium 原生 UA 并将 HeadlessChrome 替换为 Chrome
    let analyzeUA = config.userAgent;
    if (!analyzeUA) analyzeUA = undefined;  // 使用 Chromium 原生 UA
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: config.headless,
        userAgent: analyzeUA,
        viewport: config.viewport,
        locale: config.locale,
        timezoneId: config.timezoneId,
        geolocation: config.geolocation,
        permissions: ['geolocation'],
        colorScheme: 'light',
        extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9' },
    });
    // UA 修正：通过 CDP 将 HeadlessChrome 替换为 Chrome
    if (!config.userAgent) {
        const testPage = await context.newPage();
        const realUA = await testPage.evaluate(() => navigator.userAgent);
        await testPage.close();
        const fixedUA = realUA.replace('HeadlessChrome/', 'Chrome/');
        const cdpSession = await context.newCDPSession(context.pages()[0]);
        await cdpSession.send('Network.setUserAgentOverride', { userAgent: fixedUA });
        console.log(`[aifish-analyze] UA 已修正: ${fixedUA}`);
    }
    await context.addInitScript(antiDetectScript);

    // 根据配置选择 AI 平台（复用上面已声明的 aiPlatform）
    let AnalyzerClass;
    let platformName;
    if (aiPlatform === 'zhipu') {
        AnalyzerClass = ZhiPuAnalyzer;
        platformName = config.intelligent ? '智谱清言(深度思考)' : '智谱清言(快速)';
    } else {
        AnalyzerClass = DoubaoAnalyzer;
        platformName = config.intelligent ? '豆包(深度思考)' : '豆包(快速)';
    }
    const analyzer = new AnalyzerClass({
        deepThink: config.intelligent,
        loginTimeout: config.loginTimeout,
    });
    analyzer.setContext(context);
    await analyzer.init();
    console.log(`[3/4] AI 分析器就绪: ${platformName}\n`);

    const notifier = new DingDingNotifier();
    let analyzed = 0, skipped = 0, recommended = 0;

    // ---- 4. 逐个分析 ----
    for (let i = 0; i < unanalyzed.length; i++) {
        const row = unanalyzed[i];
        const addr = `https://www.goofish.com/item?id=${row.item_id}`;

        console.log(`--- [4/4] ${i + 1}/${unanalyzed.length} ${row.title?.slice(0, 40) || row.item_id} ---`);

        // 4a. 价格去重（同链接同价格已分析过）
        if (db.isDuplicateAnalysis(addr, row.price)) {
            console.log(`  ⏭ 跳过: 同链接同价格已分析`);
            skipped++;
            continue;
        }

        // 4b. 从 DB 获取完整商品 + 卖家数据
        const dbProduct = db.getProduct(row.item_id);
        if (!dbProduct) {
            console.log(`  ⏭ 跳过: DB 无商品详情`);
            skipped++;
            continue;
        }

        const product = productFromDB(dbProduct);
        let seller = {};
        if (dbProduct.seller_id) {
            const dbSeller = db.getSeller(dbProduct.seller_id);
            seller = sellerFromDB(dbSeller) || {};
        }

        // 4c. 构建 AI 提示词
        const isZhipu = aiPlatform === 'zhipu';
        const { text: promptText, images } = buildPrompt(config, product, seller, {
            maxLength: isZhipu ? 20000 : 0,  // 智谱有 20000 字输入上限
        });

        // 4d. AI 分析
        let aiResult;
        try {
            aiResult = await analyzer.analyze(promptText, { deepThink: config.intelligent });
        } catch (e) {
            console.log(`  ❌ AI 分析失败: ${e.message}`);
            continue;
        }

        if (!aiResult || !aiResult.answer) {
            console.log(`  ❌ AI 返回为空`);
            continue;
        }

        // 4e. 解析 AI 返回的 JSON
        let aiReply;
        try {
            aiReply = analyzer.extractJSON(aiResult.answer);
        } catch (e) {
            console.log(`  ⚠ AI 返回非 JSON，原始内容: ${aiResult.answer.slice(0, 100)}...`);
            aiReply = { raw: aiResult.answer };
        }

        // 4f. 保存分析结果
        db.saveAnalysis({
            itemId: row.item_id,
            keyword: row.keyword || product.keyword || config.keyword || '',
            addr,
            price: row.price,
            description: row.title || product.title || '',
            images: (product.uploadedImages || []).filter(img => img.uploadedUrl).map(img => img.uploadedUrl),
            aiReply,
        });

        analyzed++;
        console.log(`  ✅ 分析完成: is_recommended=${aiReply.is_recommended}, reason=${(aiReply.reason || '').slice(0, 60)}`);

        // 4g. 推荐商品 → 钉钉通知
        if (aiReply.is_recommended) {
            recommended++;
            try {
                await notifier.notifyFishBargain(
                    config.ddUrl,
                    {
                        addr,
                        price: row.price,
                        description: row.title || product.title || '',
                        images: (product.uploadedImages || []).filter(img => img.uploadedUrl).map(img => img.uploadedUrl),
                        aiReply,
                    },
                    config.phtoneDomain,
                    row.keyword || product.keyword || config.keyword || '',
                );
                console.log(`  📢 钉钉通知已发送`);
            } catch (e) {
                console.log(`  ⚠ 钉钉通知失败: ${e.message}`);
            }
        }
    }

    // ---- 汇总 ----
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║             分析结果汇总              ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`  待分析:   ${unanalyzed.length}`);
    console.log(`  跳过:    ${skipped}`);
    console.log(`  已分析:  ${analyzed}`);
    console.log(`  推荐:    ${recommended}`);

    await context.close();
    db.close();
}

main().catch(err => {
    console.error('运行失败:', err.message);
    process.exit(1);
});

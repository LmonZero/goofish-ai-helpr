/**
 * AIFish 闲鱼AI筛查脚本
 *
 * 完整流程：配置读取 → 闲鱼爬取 → 去重筛查 → AI 分析 → 结果存储 → 钉钉通知
 *
 * 用法：
 *   node script/aifish-run.js ./script/json/AIFish-example.json
 */

const fs = require('fs');
const path = require('path');
const GoofishScraper = require('../scraper/GoofishScraper');
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

// ======================== 主流程 ========================

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        console.log('用法: node script/aifish-run.js <配置文件路径>');
        console.log('示例: node script/aifish-run.js ./script/json/AIFish-example.json');
        process.exit(1);
    }

    const config = loadConfig(configPath);

    console.log('╔══════════════════════════════════════╗');
    console.log('║          AIFish 闲鱼AI筛查           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`关键词: ${config.keyword}`);
    console.log(`AI平台: ${config.intelligent ? '豆包(深度思考)' : '豆包(快速)'}`);
    console.log(`提示词: ${config.promptBase} + ${config.promptCriteria}`);
    console.log(`去重:   ${config.againDay}天 / 捡漏忽略 ${config.bargainDay}天`);
    console.log(`翻页:   最多 ${config.maxPages || 10} 页`);
    console.log('');

    // ---- 1. 初始化数据库 ----
    console.log('[1/6] 初始化数据库...');
    const db = new XianyuDB(config.dbPath);
    db.open();

    // ---- 2. 启动闲鱼爬虫 ----
    console.log('[2/6] 启动闲鱼爬虫...');
    const scraper = new GoofishScraper({
        dataName: config.dataName,
        headless: config.headless,
        loginTimeout: config.loginTimeout,
    });
    await scraper.init();
    console.log('[2/6] 闲鱼爬虫就绪\n');

    // ---- 3. 搜索商品 ----
    console.log(`[3/6] 搜索 "${config.keyword}"...`);
    const searchResults = await scraper.search(config.keyword, {}, { maxPages: config.maxPages || 10 });
    console.log(`[3/6] 搜索完成，${searchResults.length} 个商品\n`);

    if (searchResults.length === 0) {
        console.log('没有搜索结果，退出');
        await scraper.close();
        db.close();
        return;
    }

    // ---- 4. 初始化 AI 分析器 ----
    console.log('[4/6] 初始化 AI 分析器...');
    const analyzer = new DoubaoAnalyzer({
        deepThink: config.intelligent,
        loginTimeout: config.loginTimeout,
    });
    // 复用爬虫的浏览器上下文（同一个 userData，cookie 域隔离）
    analyzer.setContext(scraper.context);
    await analyzer.init();
    console.log('[4/6] AI 分析器就绪\n');

    const notifier = new DingDingNotifier();
    let analyzed = 0, skipped = 0, recommended = 0;

    // ---- 5. 逐个分析商品 ----
    for (let i = 0; i < searchResults.length; i++) {
        const item = searchResults[i];
        const addr = item.url || `https://www.goofish.com/item?id=${item.itemId}`;
        const price = item.price || '';

        console.log(`--- [5/6] ${i + 1}/${searchResults.length} ${item.title?.slice(0, 40) || item.itemId} ---`);

        // 5a. 去重筛查
        const skip = db.shouldSkipAnalysis(addr, config.againDay, config.bargainDay);
        if (skip.skip) {
            console.log(`  ⏭ 跳过: ${skip.reason}`);
            skipped++;
            continue;
        }

        // 价格精确去重
        if (db.isDuplicateAnalysis(addr, price)) {
            console.log(`  ⏭ 跳过: 同链接同价格已存在`);
            skipped++;
            continue;
        }

        // 5b. 爬取商品详情
        let product;
        try {
            product = await scraper.scrapeProduct(item.itemId);
        } catch (e) {
            console.log(`  ❌ 商品详情爬取失败: ${e.message}`);
            continue;
        }
        if (!product) {
            console.log(`  ❌ 商品详情为空`);
            continue;
        }

        // 5c. 爬取卖家详情
        let seller = null;
        const sellerId = product.sellerId || product.seller?.userId;
        if (sellerId) {
            try {
                seller = await scraper.scrapeSeller(sellerId);
            } catch (e) {
                console.log(`  ⚠ 卖家详情爬取失败: ${e.message}`);
            }
        }

        // 5d. 构建 AI 提示词
        const { text: promptText, images } = buildPrompt(config, product, seller || {});

        // 5e. AI 分析
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

        // 5f. 解析 AI 返回的 JSON
        let aiReply;
        try {
            aiReply = analyzer.extractJSON(aiResult.answer);
        } catch (e) {
            console.log(`  ⚠ AI 返回非 JSON，原始内容: ${aiResult.answer.slice(0, 100)}...`);
            aiReply = { raw: aiResult.answer };
        }

        // 5g. 保存结果
        db.saveAnalysis({
            itemId: item.itemId,
            keyword: config.keyword,
            addr,
            price,
            description: item.title || product.title || '',
            images: (product.uploadedImages || []).map(img => img.uploadedUrl || img.url),
            aiReply,
        });

        analyzed++;
        console.log(`  ✅ 分析完成: is_recommend=${aiReply.is_recommend}, reason=${(aiReply.reason || '').slice(0, 60)}`);

        // 5h. 推荐商品 → 钉钉通知
        if (aiReply.is_recommend) {
            recommended++;
            try {
                await notifier.notifyFishBargain(
                    config.ddUrl,
                    { addr, price, description: item.title || product.title || '', aiReply },
                    config.phtoneDomain,
                    config.keyword,
                );
                console.log(`  📢 钉钉通知已发送`);
            } catch (e) {
                console.log(`  ⚠ 钉钉通知失败: ${e.message}`);
            }
        }
    }

    // ---- 6. 汇总 ----
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║             运行结果汇总              ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`  搜索结果: ${searchResults.length}`);
    console.log(`  跳过(去重): ${skipped}`);
    console.log(`  AI 分析:   ${analyzed}`);
    console.log(`  推荐商品:  ${recommended}`);

    await scraper.close();
    db.close();
}

main().catch(err => {
    console.error('运行失败:', err.message);
    process.exit(1);
});

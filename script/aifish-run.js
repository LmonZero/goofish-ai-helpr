/**
 * AIFish 闲鱼爬取脚本
 *
 * 流程：配置读取 → 闲鱼搜索 → 逐个爬取商品/卖家详情 → 入库
 * 不含 AI 分析，AI 分析由 aifish-analyze.js 独立完成
 *
 * 用法：
 *   node script/aifish-run.js ./script/json/AIFish-example.json
 */

const fs = require('fs');
const path = require('path');
const GoofishScraper = require('../scraper/GoofishScraper');
const { XianyuDB } = require('../scraper/db');

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
    console.log('║       AIFish 闲鱼商品爬取            ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`关键词: ${config.keyword}`);
    console.log(`翻页:   ${config.maxPages > 0 ? `最多 ${config.maxPages} 页` : '全部页'}`);
    console.log('');

    // ---- 1. 初始化数据库 ----
    console.log('[1/4] 初始化数据库...');
    const db = new XianyuDB(config.dbPath, config.freshTTLDays);
    db.open();

    // ---- 2. 启动闲鱼爬虫 ----
    console.log('[2/4] 启动闲鱼爬虫...');
    const scraper = new GoofishScraper({
        dataName: config.dataName,
        headless: config.headless,
        loginTimeout: config.loginTimeout,
        freshTTLDays: config.freshTTLDays,
    });
    await scraper.init();
    console.log('[2/4] 闲鱼爬虫就绪\n');

    // ---- 3. 搜索商品 ----
    console.log(`[3/4] 搜索 "${config.keyword}"...`);
    const searchResults = await scraper.search(config.keyword, {}, { maxPages: config.maxPages || 0 });
    console.log(`[3/4] 搜索完成，${searchResults.length} 个商品\n`);

    if (searchResults.length === 0) {
        console.log('没有搜索结果，退出');
        await scraper.close();
        db.close();
        return;
    }

    // ---- 4. 逐个爬取并入库 ----
    let scraped = 0, skipped = 0, failed = 0;

    for (let i = 0; i < searchResults.length; i++) {
        const item = searchResults[i];
        console.log(`--- [4/4] ${i + 1}/${searchResults.length} ${item.title?.slice(0, 40) || item.itemId} ---`);

        // 4a. 新鲜度去重由 scrapeProduct 内部处理（跳过网络请求，返回DB缓存数据）
        // 这里不再重复检查，因为：
        //   - 商品新鲜 → scrapeProduct 返回 DB 缓存 → saveProduct 也跳过写入
        //   - 商品过期 → scrapeProduct 重新爬取 → saveProduct 覆盖写入

        // 4b. 爬取商品详情
        let product;
        try {
            product = await scraper.scrapeProduct(item.itemId);
        } catch (e) {
            console.log(`  ❌ 商品详情爬取失败: ${e.message}`);
            failed++;
            continue;
        }
        if (!product) {
            console.log(`  ❌ 商品详情为空`);
            failed++;
            continue;
        }

        // 4c. 商品数据入库（saveProduct 内部也做新鲜度检查，已新鲜则跳过写入）
        product.keyword = config.keyword || '';  // 记录搜索关键词，用于分析检索
        const saveResult = db.saveProduct(product);
        if (saveResult.saved) {
            console.log(`  ✅ 商品入库: ${product.title?.slice(0, 40)} (${saveResult.reason})`);
            scraped++;
        } else if (saveResult.reason === 'no_seller') {
            console.log(`  ⏭ 商品跳过: ${product.title?.slice(0, 40)} (卖家ID缺失，等下次重试)`);
            skipped++;
            continue;  // 没有卖家ID，跳过卖家爬取
        } else {
            console.log(`  ⏭ 商品跳过: ${product.title?.slice(0, 40)} (${saveResult.reason})`);
            skipped++;
        }

        // 4d. 爬取卖家详情（sellerId 从 product.sellerId 或 product.seller.id 获取）
        const sellerId = product.sellerId || product.seller?.id;
        if (sellerId) {
            try {
                const seller = await scraper.scrapeSeller(sellerId);
                const sellerResult = db.saveSeller(seller);
                console.log(`  ✅ 卖家入库: userId=${sellerId} (${sellerResult.saved ? sellerResult.reason : '跳过-' + sellerResult.reason})`);
            } catch (e) {
                console.log(`  ⚠ 卖家详情爬取失败: ${e.message}`);
            }
        }
    }

    // ---- 汇总 ----
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║             爬取结果汇总              ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`  搜索结果: ${searchResults.length}`);
    console.log(`  跳过(新鲜): ${skipped}`);
    console.log(`  新增入库:  ${scraped}`);
    console.log(`  失败:      ${failed}`);

    const stats = db.getStats();
    console.log(`  DB 商品总数: ${stats.products}`);

    await scraper.close();
    db.close();
}

main().catch(err => {
    console.error('运行失败:', err.message);
    process.exit(1);
});

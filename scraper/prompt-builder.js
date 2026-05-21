/**
 * Prompt 构建器 — 双模板分离架构
 *
 * base_prompt.txt 含 {{CRITERIA_SECTION}} 占位符
 * xxx_criteria.txt 按商品类别拆分评估标准
 * AIFish 配置 JSON 声明 promptBase + promptCriteria 路径
 *
 * 用法：
 *   const { buildPrompt } = require('./scraper/prompt-builder');
 *   const prompt = buildPrompt({
 *       promptBase: './prompt/base_prompt.txt',
 *       promptCriteria: './prompt/macbook_criteria.txt',
 *   }, productData, sellerData);
 */

const fs = require('fs');
const path = require('path');

/**
 * 构建 AI 分析完整提示词
 *
 * @param {object} config - AIFish 配置项
 * @param {string} config.promptBase - base_prompt.txt 路径
 * @param {string} config.promptCriteria - criteria 文件路径
 * @param {object} product - 商品数据（scrapeProduct 返回值）
 * @param {object} seller - 卖家数据（scrapeSeller 返回值）
 * @param {object} [options]
 * @param {number} [options.maxRatings=50] - 评价最大条数
 * @param {boolean} [options.includeImages=true] - 是否包含图片链接
 * @param {number} [options.maxLength=0] - 最大总长度（0=不限制），超限时从数据部分逐步裁剪
 * @returns {{ text: string, images: string[] }}
 */
function buildPrompt(config, product, seller, options = {}) {
    const { maxRatings = 50, includeImages = true, maxLength = 0 } = options;

    // 1. 加载模板文件
    const basePath = path.resolve(config.promptBase);
    const criteriaPath = path.resolve(config.promptCriteria);

    const baseTemplate = fs.readFileSync(basePath, 'utf8');
    const criteriaContent = fs.readFileSync(criteriaPath, 'utf8');

    // 2. 替换占位符 → 完整 prompt 骨架
    const promptSkeleton = baseTemplate.replace('{{CRITERIA_SECTION}}', criteriaContent);

    // 3. 组装商品数据（精简，去除 raw 字段）
    const itemData = {
        itemId: product.itemId,
        title: product.title,
        price: product.price + '元',
        originalPrice: product.originalPrice ? product.originalPrice + '元' : '未标注',
        description: product.description,
        soldCnt: product.soldCnt,
        browseCnt: product.browseCnt,
        quantity: product.quantity,
        collectCnt: product.collectCnt,
        wantCnt: product.wantCnt,
        transportFee: product.transportFee ? product.transportFee + '元' : '未知',
        itemStatus: product.itemStatus,
        screenshotUrl: product.screenshotUrl,
    };

    // 4. 组装图片链接列表
    const uploadedImages = (product.uploadedImages || []).filter(i => i.uploadedUrl);
    const imageUrls = uploadedImages.map(i => i.uploadedUrl);
    if (includeImages) {
        itemData.uploadedImageUrls = imageUrls;
    }

    // 5. 组装卖家数据（精简，去除 raw 字段）
    const sellerData = {
        userId: seller.userId,
        name: seller.name,
        city: seller.city,
        signature: seller.signature,
        fansCnt: seller.fansCnt,
        followCnt: seller.followCnt,
        hasSoldNum: seller.hasSoldNum,
        itemCount: seller.itemCount,
        shopLevel: seller.shopLevel,
        shopScore: seller.shopScore,
        praiseRatio: seller.praiseRatio,
        reviewNum: seller.reviewNum,
        goodRatio: seller.goodRatio,
        creditLevel: seller.creditLevel,
    };

    // 信誉统计
    if (seller.reputation) {
        sellerData.reputation = seller.reputation;
    }

    // 卖家在售商品（标题+价格，给AI做画像分析）
    if (seller.items?.length) {
        sellerData.sellerItems = seller.items.map(i => ({
            title: i.title,
            price: i.price + '元',
        }));
    }

    // 近期评价（限条数，给AI做画像分析）
    if (seller.ratings?.length) {
        sellerData.recentRatings = seller.ratings.slice(0, maxRatings).map(r => ({
            content: r.content,
            rateTime: r.rateTime,
            raterNick: r.raterNick,
            rate: r.rate === 1 ? '好评' : r.rate === 0 ? '中评' : '差评',
            tags: r.tags,
            customWords: r.customWords,
            ipLocation: r.ipLocation,
        }));
    }

    // 6. 拼装完整提示词
    function assembleText(item, sellerD, imgs) {
        let t = promptSkeleton;
        t += '\n\n---\n\n## 商品数据\n\n```json\n' + JSON.stringify(item, null, 2) + '\n```';
        t += '\n\n---\n\n## 卖家数据\n\n```json\n' + JSON.stringify(sellerD, null, 2) + '\n```';
        if (includeImages && imgs.length > 0) {
            t += '\n\n---\n\n## 商品图片链接（请逐一分析）\n\n';
            t += imgs.map((url, i) => (i + 1) + '. ' + url).join('\n');
        }
        return t;
    }

    let text = assembleText(itemData, sellerData, imageUrls);

    // 7. 长度超限处理：交替减少评价和在售商品，保留至少 1 条
    if (maxLength > 0 && text.length > maxLength) {
        const ratings = seller.ratings || [];
        const items = seller.items || [];

        // 交替裁剪策略：评价 → 商品 → 评价 → 商品 ... 最后裁描述和图片
        const steps = [
            // 第1轮：评价 50→30，商品不变
            () => { if (ratings.length > 30) sellerData.recentRatings = ratings.slice(0, 30).map(fmtRating); },
            // 第2轮：商品 全部→20，评价保持30
            () => { if (items.length > 20) sellerData.sellerItems = items.slice(0, 20).map(i => ({ title: i.title, price: i.price + '元' })); },
            // 第3轮：评价 30→20
            () => { if (ratings.length > 20) sellerData.recentRatings = ratings.slice(0, 20).map(fmtRating); },
            // 第4轮：商品 20→10
            () => { if (items.length > 10) sellerData.sellerItems = items.slice(0, 10).map(i => ({ title: i.title, price: i.price + '元' })); },
            // 第5轮：评价 20→10
            () => { if (ratings.length > 10) sellerData.recentRatings = ratings.slice(0, 10).map(fmtRating); },
            // 第6轮：商品 10→5
            () => { if (items.length > 5) sellerData.sellerItems = items.slice(0, 5).map(i => ({ title: i.title, price: i.price + '元' })); },
            // 第7轮：评价 10→5
            () => { if (ratings.length > 5) sellerData.recentRatings = ratings.slice(0, 5).map(fmtRating); },
            // 第8轮：商品 5→3
            () => { if (items.length > 3) sellerData.sellerItems = items.slice(0, 3).map(i => ({ title: i.title, price: i.price + '元' })); },
            // 第9轮：评价 5→3
            () => { if (ratings.length > 3) sellerData.recentRatings = ratings.slice(0, 3).map(fmtRating); },
            // 第10轮：商品 3→1（至少保留1条）
            () => { if (items.length > 1) sellerData.sellerItems = [{ title: items[0].title, price: items[0].price + '元' }]; },
            // 第11轮：评价 3→1（至少保留1条）
            () => { if (ratings.length > 1) sellerData.recentRatings = [fmtRating(ratings[0])]; },
            // 第12轮：裁剪描述到 500 字
            () => { itemData.description = (itemData.description || '').slice(0, 500); },
            // 第13轮：裁剪描述到 200 字
            () => { itemData.description = (itemData.description || '').slice(0, 200); },
            // 第14轮：移除图片链接列表
            () => { imageUrls.length = 0; },
        ];

        for (const step of steps) {
            step();
            text = assembleText(itemData, sellerData, imageUrls);
            if (text.length <= maxLength) break;
        }

        // 兜底硬截断（保留 JSON 结构完整性）
        if (text.length > maxLength) {
            text = text.slice(0, maxLength - 100);
            text += '\n\n...[内容超出长度限制，已截断]';
        }
    }

    return { text, images: imageUrls };
}

/** 格式化单条评价 */
function fmtRating(r) {
    return {
        content: r.content,
        rateTime: r.rateTime,
        raterNick: r.raterNick,
        rate: r.rate === 1 ? '好评' : r.rate === 0 ? '中评' : '差评',
        tags: r.tags,
        customWords: r.customWords,
        ipLocation: r.ipLocation,
    };
}

module.exports = { buildPrompt };

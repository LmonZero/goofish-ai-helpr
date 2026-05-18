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
 * @param {number} [options.maxRatings=20] - 评价最大条数
 * @param {boolean} [options.includeImages=true] - 是否包含图片链接
 * @returns {{ text: string, images: string[] }}
 */
function buildPrompt(config, product, seller, options = {}) {
    const { maxRatings = 50, includeImages = true } = options;

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
    let text = promptSkeleton;
    text += '\n\n---\n\n## 商品数据\n\n```json\n' + JSON.stringify(itemData, null, 2) + '\n```';
    text += '\n\n---\n\n## 卖家数据\n\n```json\n' + JSON.stringify(sellerData, null, 2) + '\n```';

    if (includeImages && imageUrls.length > 0) {
        text += '\n\n---\n\n## 商品图片链接（请逐一分析）\n\n';
        text += imageUrls.map((url, i) => (i + 1) + '. ' + url).join('\n');
    }

    return { text, images: imageUrls };
}

module.exports = { buildPrompt };

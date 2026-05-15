/**
 * 商品数据仓库 - 闲鱼商品 CRUD
 * 未来新平台可新建对应 Repository（如 ZhuanzhuanRepository）
 */
class ProductRepository {

    /**
     * @param {import('node:sqlite').DatabaseSync} db - 数据库实例（由 Database.init() 返回）
     */
    constructor(db) {
        this.db = db;
    }

    // ======================== 查询 ========================

    /**
     * 按链接查询商品（去重用）
     * @param {string} addr - 商品链接
     * @returns {{createTime: number, is_bargain: number, productId: string}|null}
     */
    findByAddr(addr) {
        return this.db.prepare('SELECT createTime, is_bargain, productId FROM t_dat_xianyu_cache WHERE addr = ?').get(addr);
    }

    /**
     * 按链接+价格查询商品（精确去重）
     * @param {string} addr
     * @param {string} price
     * @returns {{id: number}|null}
     */
    findByAddrAndPrice(addr, price) {
        return this.db.prepare('SELECT id FROM t_dat_xianyu_cache WHERE addr = ? AND price = ?').get(addr, price);
    }

    // ======================== 写入 ========================

    /**
     * 保存商品信息（先删后插，保证同链接同价格只有一条）
     * @param {object} info - 商品完整信息
     * @param {string} info.keyword - 搜索关键词
     * @param {string} info.addr - 商品链接
     * @param {string} info.price - 价格
     * @param {string} info.description - 描述
     * @param {string} info.productId - 商品 ID
     * @param {string[]} info.images - 图片 URL 列表
     * @param {object} info.aiReply - AI 分析结果
     */
    save(info) {
        const ai = info.aiReply || {};

        // 先删除同链接同价格的旧记录
        this.db.prepare('DELETE FROM t_dat_xianyu_cache WHERE addr = ? AND price = ?').run(info.addr, info.price);

        // 插入新记录
        this.db.prepare(
            `INSERT INTO t_dat_xianyu_cache
            (createTime, title, imageurls, productId, addr, price, description, is_bargain, bargain_level, bargain_score, estimated_market_price_range, condition_assessment, identified_brand_model, key_findings, risks, recommendation, is_persion, credit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            Date.now(),
            info.keyword || '',
            JSON.stringify(info.images || []),
            info.productId,
            info.addr,
            info.price,
            info.description,
            ai.is_bargain ? 1 : 0,
            ai.bargain_level || '',
            ai.bargain_score || 0,
            ai.estimated_market_price_range || '',
            ai.condition_assessment || '',
            ai.identified_brand_model || '',
            ai.key_findings || '',
            JSON.stringify(ai.risks || []),
            ai.recommendation || '',
            ai.is_persion ? 1 : 0,
            ai.credit || 0
        );
    }

    // ======================== 判断辅助 ========================

    /**
     * 判断商品是否需要跳过（已被分析过且在忽略期内）
     * @param {string} addr - 商品链接
     * @param {number} againDay - 重复筛查间隔(天)
     * @param {number} bargainDay - 非捡漏商品忽略间隔(天)
     * @returns {{skip: boolean, reason: string}}
     */
    shouldSkip(addr, againDay, bargainDay) {
        const existing = this.findByAddr(addr);
        if (!existing) return { skip: false, reason: '' };

        const elapsed = Date.now() - existing.createTime;

        // 之前不是捡漏，且还在忽略期内
        if (!existing.is_bargain && elapsed < bargainDay * 24 * 3600 * 1000) {
            return { skip: true, reason: '之前判断过不是捡漏，在忽略期内' };
        }

        // 还在重复筛查间隔内
        if (elapsed < againDay * 24 * 3600 * 1000) {
            return { skip: true, reason: '在重复筛查间隔内' };
        }

        return { skip: false, reason: '' };
    }

    /**
     * 判断商品价格是否与已存记录相同（精确去重）
     * @param {string} addr
     * @param {string} price
     * @returns {boolean}
     */
    isDuplicatePrice(addr, price) {
        return !!this.findByAddrAndPrice(addr, price);
    }
}

module.exports = ProductRepository;

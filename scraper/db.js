/**
 * 闲鱼数据存储模块 — SQLite (node:sqlite)
 *
 * 表结构：t_seller / t_product / t_product_image / t_seller_item / t_seller_rating / t_search_log
 *
 * 用法：
 *   const db = require('./scraper/db');
 *   db.open();
 *   db.saveProduct(productData);
 *   db.saveSeller(sellerData);
 *   db.saveSearchLog(keyword, results);
 *   db.close();
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'DB', 'xianyu.db');

class XianyuDB {
    constructor(dbPath) {
        this.dbPath = dbPath || DEFAULT_DB_PATH;
        this.db = null;
    }

    open() {
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec('PRAGMA foreign_keys=ON');
        this._createTables();
        return this;
    }

    close() {
        if (this.db) { this.db.close(); this.db = null; }
    }

    _createTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS t_seller (
                user_id         INTEGER PRIMARY KEY,
                name            TEXT    DEFAULT '',
                avatar          TEXT    DEFAULT '',
                city            TEXT    DEFAULT '',
                signature       TEXT    DEFAULT '',
                fans_cnt        INTEGER DEFAULT 0,
                follow_cnt      INTEGER DEFAULT 0,
                has_sold_num    INTEGER DEFAULT 0,
                item_count      INTEGER DEFAULT 0,
                shop_level      TEXT    DEFAULT '',
                shop_score      INTEGER DEFAULT 0,
                praise_ratio    TEXT    DEFAULT '',
                review_num      INTEGER DEFAULT 0,
                good_ratio      TEXT    DEFAULT '',
                credit_level    TEXT    DEFAULT '',
                reputation_good    INTEGER DEFAULT 0,
                reputation_neutral INTEGER DEFAULT 0,
                reputation_bad     INTEGER DEFAULT 0,
                reputation_good_pct TEXT DEFAULT '',
                screenshot_url  TEXT    DEFAULT '',
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                updated_at      INTEGER DEFAULT (strftime('%s','now'))
            );

            CREATE TABLE IF NOT EXISTS t_product (
                item_id         INTEGER PRIMARY KEY,
                seller_id       INTEGER DEFAULT 0,
                title           TEXT    DEFAULT '',
                price           TEXT    DEFAULT '',
                original_price  TEXT    DEFAULT '',
                description     TEXT    DEFAULT '',
                sold_cnt        INTEGER DEFAULT 0,
                browse_cnt      INTEGER DEFAULT 0,
                quantity        INTEGER DEFAULT 0,
                collect_cnt     INTEGER DEFAULT 0,
                want_cnt        INTEGER DEFAULT 0,
                created_time    INTEGER DEFAULT 0,
                transport_fee   TEXT    DEFAULT '',
                category_id     INTEGER DEFAULT 0,
                item_status     TEXT    DEFAULT '',
                screenshot_url  TEXT    DEFAULT '',
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                updated_at      INTEGER DEFAULT (strftime('%s','now')),
                FOREIGN KEY (seller_id) REFERENCES t_seller(user_id)
            );

            CREATE TABLE IF NOT EXISTS t_product_image (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id         INTEGER NOT NULL,
                original_url    TEXT    DEFAULT '',
                uploaded_url    TEXT    DEFAULT '',
                is_major        INTEGER DEFAULT 0,
                width           INTEGER DEFAULT 0,
                height          INTEGER DEFAULT 0,
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                FOREIGN KEY (item_id) REFERENCES t_product(item_id)
            );

            CREATE TABLE IF NOT EXISTS t_seller_item (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                seller_id       INTEGER NOT NULL,
                item_id         INTEGER NOT NULL,
                title           TEXT    DEFAULT '',
                price           TEXT    DEFAULT '',
                image_url       TEXT    DEFAULT '',
                want_cnt        INTEGER DEFAULT 0,
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                UNIQUE(seller_id, item_id),
                FOREIGN KEY (seller_id) REFERENCES t_seller(user_id)
            );

            CREATE TABLE IF NOT EXISTS t_seller_rating (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                seller_id       INTEGER NOT NULL,
                content         TEXT    DEFAULT '',
                rate_time       TEXT    DEFAULT '',
                rater_nick      TEXT    DEFAULT '',
                rater_avatar    TEXT    DEFAULT '',
                rate            INTEGER DEFAULT 0,
                tags            TEXT    DEFAULT '',
                custom_words    TEXT    DEFAULT '',
                ip_location     TEXT    DEFAULT '',
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                FOREIGN KEY (seller_id) REFERENCES t_seller(user_id)
            );

            CREATE TABLE IF NOT EXISTS t_search_log (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword         TEXT    NOT NULL,
                result_count    INTEGER DEFAULT 0,
                first_item_id   INTEGER DEFAULT 0,
                first_title     TEXT    DEFAULT '',
                first_price     TEXT    DEFAULT '',
                created_at      INTEGER DEFAULT (strftime('%s','now'))
            );

            CREATE TABLE IF NOT EXISTS t_analysis (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id         INTEGER NOT NULL,
                keyword         TEXT    DEFAULT '',
                addr            TEXT    NOT NULL,
                price           TEXT    DEFAULT '',
                description     TEXT    DEFAULT '',
                imageurls       TEXT    DEFAULT '[]',
                is_recommend    INTEGER DEFAULT 0,
                reason          TEXT    DEFAULT '',
                risk_tags       TEXT    DEFAULT '[]',
                criteria_analysis TEXT DEFAULT '{}',
                bargain_score  INTEGER DEFAULT 0,
                is_person      INTEGER DEFAULT 0,
                credit         INTEGER DEFAULT 0,
                raw_reply      TEXT    DEFAULT '',
                created_at      INTEGER DEFAULT (strftime('%s','now')),
                UNIQUE(addr, price),
                FOREIGN KEY (item_id) REFERENCES t_product(item_id)
            );

            CREATE INDEX IF NOT EXISTS idx_analysis_item ON t_analysis(item_id);
            CREATE INDEX IF NOT EXISTS idx_analysis_addr ON t_analysis(addr);

            CREATE INDEX IF NOT EXISTS idx_product_seller ON t_product(seller_id);
            CREATE INDEX IF NOT EXISTS idx_product_image_item ON t_product_image(item_id);
            CREATE INDEX IF NOT EXISTS idx_seller_item_seller ON t_seller_item(seller_id);
            CREATE INDEX IF NOT EXISTS idx_seller_rating_seller ON t_seller_rating(seller_id);
            CREATE INDEX IF NOT EXISTS idx_search_log_keyword ON t_search_log(keyword);
        `);
    }

    // ======================== 新鲜度检查 ========================

    /**
     * 一个月的秒数阈值
     */
    static get FRESH_TTL() { return 30 * 24 * 3600; }  // 30天

    /**
     * 检查商品数据是否新鲜（存在且 updated_at 在30天内）
     * @param {string|number} itemId
     * @returns {{ fresh: boolean, exists: boolean, product: object|null, ageDays: number }}
     */
    checkProductFresh(itemId) {
        const row = this.db.prepare('SELECT * FROM t_product WHERE item_id = ?').get(itemId);
        if (!row) return { fresh: false, exists: false, product: null, ageDays: Infinity };
        const now = Math.floor(Date.now() / 1000);
        const ageSec = now - (row.updated_at || 0);
        const ageDays = Math.floor(ageSec / 86400);
        const fresh = ageSec <= XianyuDB.FRESH_TTL;
        return { fresh, exists: true, product: row, ageDays };
    }

    /**
     * 检查卖家数据是否新鲜（存在且 updated_at 在30天内）
     * @param {string|number} userId
     * @returns {{ fresh: boolean, exists: boolean, seller: object|null, ageDays: number }}
     */
    checkSellerFresh(userId) {
        const row = this.db.prepare('SELECT * FROM t_seller WHERE user_id = ?').get(parseInt(userId) || 0);
        if (!row) return { fresh: false, exists: false, seller: null, ageDays: Infinity };
        const now = Math.floor(Date.now() / 1000);
        const ageSec = now - (row.updated_at || 0);
        const ageDays = Math.floor(ageSec / 86400);
        const fresh = ageSec <= XianyuDB.FRESH_TTL;
        return { fresh, exists: true, seller: row, ageDays };
    }

    // ======================== 写入方法 ========================

    /**
     * 保存商品详情（含图片）
     * - 数据新鲜（<30天）→ 跳过，不重复写入
     * - 数据过期（≥30天）→ 覆盖写入
     * - 数据不存在 → 新增写入
     * @returns {{ saved: boolean, reason: string }}
     */
    saveProduct(product) {
        const itemId = product.itemId;
        const freshCheck = this.checkProductFresh(itemId);
        if (freshCheck.fresh) {
            console.log(`[DB] 商品 ${itemId} 数据新鲜（${freshCheck.ageDays}天前更新），跳过写入`);
            return { saved: false, reason: 'fresh' };
        }
        if (freshCheck.exists) {
            console.log(`[DB] 商品 ${itemId} 数据过期（${freshCheck.ageDays}天前更新），覆盖写入`);
        }

        const now = Math.floor(Date.now() / 1000);
        // 先保存卖家（精简版，来自 sellerDO）
        if (product.seller?.id) {
            this._upsertSeller({
                user_id: product.seller.id,
                name: product.seller.name || '',
                avatar: product.seller.avatar || '',
                city: product.seller.city || '',
                signature: product.seller.signature || '',
                has_sold_num: product.seller.hasSoldNum || 0,
                item_count: product.seller.itemCount || 0,
                good_ratio: product.seller.goodRatio || '',
                credit_level: product.seller.creditLevel || '',
            });
        }

        // 保存商品
        this.db.prepare(`
            INSERT INTO t_product (item_id, seller_id, title, price, original_price, description,
                sold_cnt, browse_cnt, quantity, collect_cnt, want_cnt, created_time,
                transport_fee, category_id, item_status, screenshot_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                title=excluded.title, price=excluded.price, description=excluded.description,
                sold_cnt=excluded.sold_cnt, browse_cnt=excluded.browse_cnt, quantity=excluded.quantity,
                collect_cnt=excluded.collect_cnt, want_cnt=excluded.want_cnt,
                item_status=excluded.item_status, screenshot_url=excluded.screenshot_url,
                updated_at=excluded.updated_at
        `).run(
            product.itemId, product.seller?.id || 0, product.title, product.price,
            product.originalPrice, product.description,
            product.soldCnt || 0, product.browseCnt || 0, product.quantity || 0,
            product.collectCnt || 0, product.wantCnt || 0, product.createdTime || 0,
            product.transportFee, product.categoryId || 0, product.itemStatus,
            product.screenshotUrl, now
        );

        // 保存图片（来自 uploadedImages）
        const images = product.uploadedImages || product.images || [];
        // 先清除旧图片
        this.db.prepare('DELETE FROM t_product_image WHERE item_id = ?').run(product.itemId);
        for (const img of images) {
            const originalUrl = img.url || '';
            const uploadedUrl = img.uploadedUrl || '';
            const isMajor = img.major ? 1 : 0;
            this.db.prepare(`
                INSERT INTO t_product_image (item_id, original_url, uploaded_url, is_major, width, height)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(product.itemId, originalUrl, uploadedUrl, isMajor, img.width || 0, img.height || 0);
        }

        return { saved: true, reason: freshCheck.exists ? 'overwritten' : 'new' };
    }

    /**
     * 保存卖家详情（含商品列表 + 评价）
     * - 数据新鲜（<30天）→ 跳过，不重复写入
     * - 数据过期（≥30天）→ 覆盖写入
     * - 数据不存在 → 新增写入
     * @returns {{ saved: boolean, reason: string }}
     */
    saveSeller(seller) {
        const userId = parseInt(seller.userId) || 0;
        const freshCheck = this.checkSellerFresh(userId);
        if (freshCheck.fresh) {
            console.log(`[DB] 卖家 ${userId} 数据新鲜（${freshCheck.ageDays}天前更新），跳过写入`);
            return { saved: false, reason: 'fresh' };
        }
        if (freshCheck.exists) {
            console.log(`[DB] 卖家 ${userId} 数据过期（${freshCheck.ageDays}天前更新），覆盖写入`);
        }

        const now = Math.floor(Date.now() / 1000);
        const rep = seller.reputation || {};

        this._upsertSeller({
            user_id: seller.userId,
            name: seller.name || '',
            avatar: seller.avatar || '',
            city: seller.city || '',
            signature: seller.signature || '',
            fans_cnt: seller.fansCnt || 0,
            follow_cnt: seller.followCnt || 0,
            has_sold_num: seller.hasSoldNum || 0,
            item_count: seller.itemCount || 0,
            shop_level: seller.shopLevel || '',
            shop_score: seller.shopScore || 0,
            praise_ratio: seller.praiseRatio != null ? String(seller.praiseRatio) : '',
            review_num: seller.reviewNum || 0,
            good_ratio: seller.goodRatio || '',
            credit_level: seller.creditLevel || '',
            reputation_good: rep.goodRatings || 0,
            reputation_neutral: rep.neutralRatings || 0,
            reputation_bad: rep.badRatings || 0,
            reputation_good_pct: rep.goodRatio || '',
            screenshot_url: seller.screenshotUrl || '',
        });

        // 保存卖家在售商品列表
        if (seller.items?.length) {
            // 清除旧数据再写入
            this.db.prepare('DELETE FROM t_seller_item WHERE seller_id = ?').run(seller.userId);
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO t_seller_item (seller_id, item_id, title, price, image_url, want_cnt)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const item of seller.items) {
                stmt.run(seller.userId, item.itemId, item.title, item.price, item.imageUrl, item.wantCnt || 0);
            }
        }

        // 保存评价列表
        if (seller.ratings?.length) {
            this.db.prepare('DELETE FROM t_seller_rating WHERE seller_id = ?').run(seller.userId);
            const stmt = this.db.prepare(`
                INSERT INTO t_seller_rating (seller_id, content, rate_time, rater_nick, rater_avatar, rate, tags, custom_words, ip_location)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const r of seller.ratings) {
                stmt.run(
                    seller.userId,
                    r.content || '',
                    r.rateTime || '',
                    r.raterNick || '',
                    r.raterAvatar || '',
                    r.rate || 0,
                    (r.tags || []).join(','),
                    (r.customWords || []).join(','),
                    r.ipLocation || ''
                );
            }
        }

        return { saved: true, reason: freshCheck.exists ? 'overwritten' : 'new' };
    }

    /**
     * 保存搜索记录
     */
    saveSearchLog(keyword, results) {
        const first = results?.[0] || {};
        this.db.prepare(`
            INSERT INTO t_search_log (keyword, result_count, first_item_id, first_title, first_price)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            keyword,
            results?.length || 0,
            first.itemId || 0,
            first.title || '',
            first.price || ''
        );
    }

    /**
     * 卖家 UPSERT（新增或更新）
     */
    _upsertSeller(s) {
        const now = Math.floor(Date.now() / 1000);
        const userId = parseInt(s.user_id) || 0;
        const params = [
            userId, s.name || '', this._extractString(s.avatar), this._extractString(s.city), this._extractString(s.signature),
            parseInt(s.fans_cnt) || 0, parseInt(s.follow_cnt) || 0, parseInt(s.has_sold_num) || 0, parseInt(s.item_count) || 0,
            String(this._extractString(s.shop_level) || ''), parseInt(s.shop_score) || 0, String(this._extractString(s.praise_ratio) || ''), parseInt(s.review_num) || 0,
            String(this._extractString(s.good_ratio) || ''), String(this._extractString(s.credit_level) || ''),
            parseInt(s.reputation_good) || 0, parseInt(s.reputation_neutral) || 0, parseInt(s.reputation_bad) || 0, this._extractString(s.reputation_good_pct),
            this._extractString(s.screenshot_url), now, now
        ];
        this.db.prepare(`
            INSERT INTO t_seller (user_id, name, avatar, city, signature,
            fans_cnt, follow_cnt, has_sold_num, item_count,
            shop_level, shop_score, praise_ratio, review_num, good_ratio, credit_level,
            reputation_good, reputation_neutral, reputation_bad, reputation_good_pct,
            screenshot_url, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), t_seller.name),
            avatar = COALESCE(NULLIF(excluded.avatar, ''), t_seller.avatar),
            city = COALESCE(NULLIF(excluded.city, ''), t_seller.city),
            signature = COALESCE(NULLIF(excluded.signature, ''), t_seller.signature),
            fans_cnt = CASE WHEN excluded.fans_cnt > 0 THEN excluded.fans_cnt ELSE t_seller.fans_cnt END,
                follow_cnt = CASE WHEN excluded.follow_cnt > 0 THEN excluded.follow_cnt ELSE t_seller.follow_cnt END,
                    has_sold_num = CASE WHEN excluded.has_sold_num > 0 THEN excluded.has_sold_num ELSE t_seller.has_sold_num END,
                        item_count = CASE WHEN excluded.item_count > 0 THEN excluded.item_count ELSE t_seller.item_count END,
                            shop_level = COALESCE(NULLIF(excluded.shop_level, ''), t_seller.shop_level),
                            shop_score = CASE WHEN excluded.shop_score > 0 THEN excluded.shop_score ELSE t_seller.shop_score END,
                                praise_ratio = COALESCE(NULLIF(excluded.praise_ratio, ''), t_seller.praise_ratio),
                                review_num = CASE WHEN excluded.review_num > 0 THEN excluded.review_num ELSE t_seller.review_num END,
                                    good_ratio = COALESCE(NULLIF(excluded.good_ratio, ''), t_seller.good_ratio),
                                    credit_level = COALESCE(NULLIF(excluded.credit_level, ''), t_seller.credit_level),
                                    reputation_good = CASE WHEN excluded.reputation_good > 0 THEN excluded.reputation_good ELSE t_seller.reputation_good END,
                                        reputation_neutral = CASE WHEN excluded.reputation_neutral > 0 THEN excluded.reputation_neutral ELSE t_seller.reputation_neutral END,
                                            reputation_bad = CASE WHEN excluded.reputation_bad > 0 THEN excluded.reputation_bad ELSE t_seller.reputation_bad END,
                                                reputation_good_pct = COALESCE(NULLIF(excluded.reputation_good_pct, ''), t_seller.reputation_good_pct),
                                                screenshot_url = COALESCE(NULLIF(excluded.screenshot_url, ''), t_seller.screenshot_url),
                                                updated_at = excluded.updated_at
                                                    `).run(...params);
    }

    // ======================== 工具方法 ========================

    /**
     * 安全提取字符串值 — 处理 API 返回值可能是对象的情况
     * 例: avatar 可能是 {avatar: "url"} 而非 "url"
     */
    _extractString(val) {
        if (val == null) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'number' || typeof val === 'boolean') return String(val);
        if (typeof val === 'object') {
            // 尝试常见键名: avatar, url, value, text, name, src
            for (const key of ['avatar', 'url', 'value', 'text', 'name', 'src', 'link']) {
                const inner = val[key];
                if (typeof inner === 'string' && inner) return inner;
            }
            // 降级: JSON 序列化
            try { return JSON.stringify(val); } catch { return ''; }
        }
        return String(val);
    }

    // ======================== 分析结果 + 去重 ========================

    /**
     * 查询某链接的分析记录（去重用）
     * @param {string} addr - 商品链接
     * @returns {{created_at: number, is_recommend: number, item_id: number}|null}
     */
    findAnalysisByAddr(addr) {
        return this.db.prepare('SELECT created_at, is_recommend, item_id FROM t_analysis WHERE addr = ? ORDER BY created_at DESC LIMIT 1').get(addr);
    }

    /**
     * 查询某链接+价格的分析记录（精确去重）
     */
    findAnalysisByAddrAndPrice(addr, price) {
        return this.db.prepare('SELECT id FROM t_analysis WHERE addr = ? AND price = ?').get(addr, price);
    }

    /**
     * 判断商品是否需要跳过（已被分析过且在忽略期内）
     * @param {string} addr - 商品链接
     * @param {number} againDay - 重复筛查间隔(天)
     * @param {number} bargainDay - 非捡漏商品忽略间隔(天)
     * @returns {{skip: boolean, reason: string}}
     */
    shouldSkipAnalysis(addr, againDay, bargainDay) {
        const existing = this.findAnalysisByAddr(addr);
        if (!existing) return { skip: false, reason: '' };

        const now = Math.floor(Date.now() / 1000);
        const elapsedSec = now - (existing.created_at || 0);
        const elapsedDays = elapsedSec / 86400;

        // 之前不是推荐，且还在忽略期内
        if (!existing.is_recommend && elapsedDays < bargainDay) {
            return { skip: true, reason: '之前判断过不是推荐，在忽略期内' };
        }

        // 还在重复筛查间隔内
        if (elapsedDays < againDay) {
            return { skip: true, reason: '在重复筛查间隔内' };
        }

        return { skip: false, reason: '' };
    }

    /**
     * 判断商品价格是否与已存分析记录相同（精确去重）
     */
    isDuplicateAnalysis(addr, price) {
        return !!this.findAnalysisByAddrAndPrice(addr, price);
    }

    /**
     * 保存 AI 分析结果（先删后插，保证同链接同价格只有一条）
     * @param {object} info
     * @param {number|string} info.itemId - 商品 ID
     * @param {string} info.keyword - 搜索关键词
     * @param {string} info.addr - 商品链接
     * @param {string} info.price - 价格
     * @param {string} info.description - 描述
     * @param {string[]} info.images - 图片 URL 列表
     * @param {object} info.aiReply - AI 分析结果
     */
    saveAnalysis(info) {
        const ai = info.aiReply || {};
        const criteriaAnalysis = ai.criteria_analysis || {};

        // 先删除同链接同价格的旧记录
        this.db.prepare('DELETE FROM t_analysis WHERE addr = ? AND price = ?').run(info.addr, info.price);

        // 插入新记录
        this.db.prepare(`
            INSERT INTO t_analysis (item_id, keyword, addr, price, description, imageurls,
                is_recommend, reason, risk_tags, criteria_analysis, bargain_score, is_person, credit, raw_reply)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            info.itemId || 0,
            info.keyword || '',
            info.addr,
            info.price,
            (info.description || '').slice(0, 500),
            JSON.stringify(info.images || []),
            ai.is_recommend ? 1 : 0,
            (ai.reason || '').slice(0, 500),
            JSON.stringify(ai.risk_tags || ai.risks || []),
            JSON.stringify(criteriaAnalysis),
            ai.bargain_score || 0,
            ai.is_persion ? 1 : 0,
            ai.credit || 0,
            ai.raw ? JSON.stringify(ai.raw).slice(0, 5000) : ''
        );
    }

    // ======================== 查询方法 ========================

    /** 查询商品详情 */
    getProduct(itemId) {
        const product = this.db.prepare('SELECT * FROM t_product WHERE item_id = ?').get(itemId);
        if (product) {
            product.images = this.db.prepare('SELECT * FROM t_product_image WHERE item_id = ? ORDER BY is_major DESC, id ASC').all(itemId);
            product.seller = this.db.prepare('SELECT * FROM t_seller WHERE user_id = ?').get(product.seller_id);
        }
        return product;
    }

    /** 查询卖家详情 */
    getSeller(userId) {
        const seller = this.db.prepare('SELECT * FROM t_seller WHERE user_id = ?').get(userId);
        if (seller) {
            seller.items = this.db.prepare('SELECT * FROM t_seller_item WHERE seller_id = ? ORDER BY id ASC').all(userId);
            seller.ratings = this.db.prepare('SELECT * FROM t_seller_rating WHERE seller_id = ? ORDER BY id DESC').all(userId);
        }
        return seller;
    }

    /** 查询搜索历史 */
    getSearchLogs(keyword, limit = 20) {
        if (keyword) {
            return this.db.prepare('SELECT * FROM t_search_log WHERE keyword LIKE ? ORDER BY created_at DESC LIMIT ?').all('%' + keyword + '%', limit);
        }
        return this.db.prepare('SELECT * FROM t_search_log ORDER BY created_at DESC LIMIT ?').all(limit);
    }

    /** 统计各表记录数 */
    getStats() {
        const count = (table) => this.db.prepare('SELECT COUNT(*) as cnt FROM ' + table).get().cnt;
        return {
            sellers: count('t_seller'),
            products: count('t_product'),
            productImages: count('t_product_image'),
            sellerItems: count('t_seller_item'),
            sellerRatings: count('t_seller_rating'),
            searchLogs: count('t_search_log'),
            analysis: count('t_analysis'),
        };
    }
}

// 单例
let _instance = null;

function getInstance(dbPath) {
    if (!_instance) {
        _instance = new XianyuDB(dbPath);
    }
    return _instance;
}

module.exports = { XianyuDB, getInstance };

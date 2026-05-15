const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

/**
 * SQLite 数据库连接管理
 * 负责初始化连接、建表、关闭连接
 */
class Database {

    /** 建表 SQL 集合，新平台在此追加 */
    static TABLE_DDL = {
        xianyu: `CREATE TABLE IF NOT EXISTS "t_dat_xianyu_cache" (
            "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            "createTime" INTEGER,
            "title" TEXT,
            "imageurls" TEXT,
            "productId" INTEGER,
            "addr" TEXT,
            "price" TEXT,
            "description" TEXT,
            "is_bargain" INTEGER,
            "bargain_level" TEXT,
            "bargain_score" INTEGER,
            "estimated_market_price_range" TEXT,
            "condition_assessment" TEXT,
            "identified_brand_model" TEXT,
            "key_findings" TEXT,
            "risks" TEXT,
            "recommendation" TEXT,
            "is_persion" INTEGER,
            "credit" TEXT
        )`,

        // 未来新平台的表在此追加，例如：
        // zhuanzhuan: `CREATE TABLE IF NOT EXISTS "t_dat_zhuanzhuan_cache" (...)`,
    };

    /** 索引 SQL 集合 */
    static INDEX_DDL = {
        xianyu: [
            `CREATE INDEX IF NOT EXISTS idx_xianyu_addr_price ON t_dat_xianyu_cache (addr, price)`,
        ],
    };

    /**
     * @param {string} dbPath - 数据库文件路径
     */
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
    }

    /**
     * 初始化数据库连接并建表
     * @param {string[]} [tables] - 要初始化的表名列表，默认全部
     * @returns {DatabaseSync}
     */
    init(tables = null) {
        // 确保目录存在
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new DatabaseSync(this.dbPath);

        const tableNames = tables || Object.keys(Database.TABLE_DDL);
        for (const name of tableNames) {
            const ddl = Database.TABLE_DDL[name];
            if (ddl) {
                this.db.exec(ddl);
            }
            const indexes = Database.INDEX_DDL[name] || [];
            for (const idxDdl of indexes) {
                this.db.exec(idxDdl);
            }
        }

        console.log(`数据库已初始化: ${this.dbPath}`);
        return this.db;
    }

    /**
     * 获取原始数据库实例
     * @returns {DatabaseSync}
     */
    getDb() {
        return this.db;
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            console.log('数据库连接已关闭');
        }
    }
}

module.exports = Database;

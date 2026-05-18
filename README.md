# 初始化

```
    npm i;
    npx patchright install chromium;

```

# 启动

```
node AIFish.js xx.json

```

# node 版本

```
v22.22.2
```

# 说明

patchright 人肉浏览器ai
小黄鱼商品筛查

# git

```
git init
git add README.md
git commit -m "first commit"
git branch -M master
git remote add origin git@github.com:LmonZero/goofish-ai-helpr.git
git push -u origin master

```

# 说明

```
Playwright/
├── analyzer/              # AI 分析器
│   ├── BaseAnalyzer.js
│   └── ZhiPuAnalyzer.js
├── scraper/               # 数据采集器
│   ├── BaseScraper.js
│   ├── GoofishScraper.js  # 闲鱼爬虫（搜索/商品详情/卖家详情）
│   └── db.js              # SQLite 数据存储
├── store/                 # 数据存储
│   ├── Database.js
│   └── ProductRepository.js
├── notify/                # 通知
│   └── DingDingNotifier.js
├── config/                # 配置
│   └── default.js
├── prompt/                # 提示词
├── tests/                 # ★ 整理后的测试/调试
│   ├── debug/             #   抓包调试脚本
│   │   └── debug-zhipu-analyzer.js
│   ├── e2e/               #   端到端测试
│   │   └── test-zhipu.js
│   ├── legacy/            #   早期测试文件
│   │   ├── demo.js
│   │   ├── param_demo.js
│   │   ├── qr_demo.js
│   │   ├── sqllite_demo.js
│   │   └── webtopng_demo.js
│   └── output/            #   运行时输出
│       ├── debug-analyzer-capture.json
│       └── debug-sse-raw.txt
├── main.js                # 项目入口
└── package.json

```

# 数据库表结构

数据库文件: `DB/xianyu.db` (SQLite)

## t_seller — 卖家信息

| 字段                | 类型       | 说明                |
| ------------------- | ---------- | ------------------- |
| user_id             | INTEGER PK | 卖家用户ID          |
| name                | TEXT       | 昵称                |
| avatar              | TEXT       | 头像URL             |
| city                | TEXT       | 所在城市            |
| signature           | TEXT       | 个人签名            |
| fans_cnt            | INTEGER    | 粉丝数              |
| follow_cnt          | INTEGER    | 关注数              |
| has_sold_num        | INTEGER    | 已售数量            |
| item_count          | INTEGER    | 在售商品数          |
| shop_level          | TEXT       | 店铺等级 (L1/L2/L3) |
| shop_score          | INTEGER    | 店铺评分            |
| praise_ratio        | TEXT       | 好评率(API原始值)   |
| review_num          | INTEGER    | 评价数              |
| good_ratio          | TEXT       | 好评率              |
| credit_level        | TEXT       | 芝麻信用等级        |
| reputation_good     | INTEGER    | 信誉-好评数         |
| reputation_neutral  | INTEGER    | 信誉-中评数         |
| reputation_bad      | INTEGER    | 信誉-差评数         |
| reputation_good_pct | TEXT       | 信誉-好评率         |
| screenshot_url      | TEXT       | 卖家主页截图URL     |
| created_at          | INTEGER    | 创建时间(Unix)      |
| updated_at          | INTEGER    | 更新时间(Unix)      |

## t_product — 商品详情

| 字段           | 类型       | 说明                      |
| -------------- | ---------- | ------------------------- |
| item_id        | INTEGER PK | 商品ID                    |
| seller_id      | INTEGER FK | 卖家ID → t_seller.user_id |
| title          | TEXT       | 商品标题                  |
| price          | TEXT       | 售价(元)                  |
| original_price | TEXT       | 原价                      |
| description    | TEXT       | 商品描述                  |
| sold_cnt       | INTEGER    | 已售数量                  |
| browse_cnt     | INTEGER    | 浏览量                    |
| quantity       | INTEGER    | 库存数量                  |
| collect_cnt    | INTEGER    | 收藏数                    |
| want_cnt       | INTEGER    | 想要数                    |
| created_time   | INTEGER    | 发布时间(Unix毫秒)        |
| transport_fee  | TEXT       | 运费                      |
| category_id    | INTEGER    | 品类ID                    |
| item_status    | TEXT       | 商品状态(在线/已售)       |
| screenshot_url | TEXT       | 详情页截图URL             |
| created_at     | INTEGER    | 记录创建时间              |
| updated_at     | INTEGER    | 记录更新时间              |

## t_product_image — 商品图片

| 字段         | 类型       | 说明                       |
| ------------ | ---------- | -------------------------- |
| id           | INTEGER PK | 自增ID                     |
| item_id      | INTEGER FK | 商品ID → t_product.item_id |
| original_url | TEXT       | 原始图片URL(heic/原图)     |
| uploaded_url | TEXT       | 图床URL(jpg, AI可直接分析) |
| is_major     | INTEGER    | 1=首图/封面, 0=详情图      |
| width        | INTEGER    | 图片宽度(px)               |
| height       | INTEGER    | 图片高度(px)               |
| created_at   | INTEGER    | 创建时间                   |

## t_seller_item — 卖家在售商品

| 字段       | 类型       | 说明                           |
| ---------- | ---------- | ------------------------------ |
| id         | INTEGER PK | 自增ID                         |
| seller_id  | INTEGER FK | 卖家ID → t_seller.user_id      |
| item_id    | INTEGER    | 商品ID (UNIQUE with seller_id) |
| title      | TEXT       | 商品标题                       |
| price      | TEXT       | 价格                           |
| image_url  | TEXT       | 商品图片URL                    |
| want_cnt   | INTEGER    | 想要数                         |
| created_at | INTEGER    | 创建时间                       |

## t_seller_rating — 卖家评价

| 字段         | 类型       | 说明                                        |
| ------------ | ---------- | ------------------------------------------- |
| id           | INTEGER PK | 自增ID                                      |
| seller_id    | INTEGER FK | 卖家ID → t_seller.user_id                   |
| content      | TEXT       | 评价内容                                    |
| rate_time    | TEXT       | 评价时间                                    |
| rater_nick   | TEXT       | 评价者昵称                                  |
| rater_avatar | TEXT       | 评价者头像                                  |
| rate         | INTEGER    | 1=好评, 0=中评, -1=差评                     |
| tags         | TEXT       | 标签(逗号分隔, 如"买家,卖家")               |
| custom_words | TEXT       | 系统评价词(逗号分隔, 如"运行流畅,成色很新") |
| ip_location  | TEXT       | 评价者IP地区                                |
| created_at   | INTEGER    | 创建时间                                    |

## t_search_log — 搜索记录

| 字段          | 类型       | 说明         |
| ------------- | ---------- | ------------ |
| id            | INTEGER PK | 自增ID       |
| keyword       | TEXT       | 搜索关键词   |
| result_count  | INTEGER    | 结果数量     |
| first_item_id | INTEGER    | 首条商品ID   |
| first_title   | TEXT       | 首条商品标题 |
| first_price   | TEXT       | 首条商品价格 |
| created_at    | INTEGER    | 搜索时间     |

## 表关系

```
t_search_log ──(first_item_id)──→ t_product
                                  │
                            (seller_id)
                                  │
                                  ▼
              t_seller ←──(user_id)──┘
                │  │  │
      ┌─────────┘  │  └─────────┐
      ▼            ▼             ▼
t_seller_item  t_seller_rating  t_product_image
(seller_id)    (seller_id)      (item_id → t_product)
```

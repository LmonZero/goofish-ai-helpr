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
│   └── BaseScraper.js
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

// Node.js Playwright 入门 demo
// 安装依赖：npm install playwright
// 下载浏览器：npx playwright install
// 运行脚本：node demo.js
const { Jimp } = require('jimp');
const QrCode = require('qrcode-reader');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const dd = require('./lib/notify-dingding-methods');

const agv = process.argv.slice(2)
let configPath = './AIFish.json';
if (agv.length > 0) {
    configPath = agv[0];
}

const config = require(configPath);
// {
//     keyword: '光威龙云三代综合竿 4.5米',
//     intelligent: true, //启用深度思考
//     //输入补充信息
//     inputinfo: '- 参考淘宝价格:224'
// }

const userDataDir = path.join(__dirname, '/UserData', config.dataName || 'demo');

// 数据库配置
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('./DB/xianyu.db');

// {
//   "is_bargain": true,
//   "bargain_level": "超值捡漏/普通优惠/价格正常/偏高",
//   "bargain_score": 85,
//   "estimated_market_price_range": "1500-1800 元",
//   "condition_assessment": "9成新，边框有细微划痕，屏幕完美，箱说全",
//   "identified_brand_model": "Sony WH-1000XM4",
//   "key_findings": "综合图片成色与当前二手均价约1600元判断，该售价仅为1200元且配件齐全，是难得的好价。",
//   "risks": ["描述仅写‘正常使用痕迹’，未明确说明划痕位置", "无原始发票"],
//   "recommendation": "强烈建议立即拍下",
//   "is_persion":true // 是否是个人卖家
// }
db.exec(`CREATE TABLE IF NOT EXISTS "t_dat_xianyu_cache" (
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
            );`);
//创建索引
db.exec(`CREATE INDEX IF NOT EXISTS idx_productId ON t_dat_xianyu_cache (addr,price);`);


(async () => {

    let context;

    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            geolocation: { longitude: 116.397, latitude: 39.908 },
            permissions: ['geolocation'],
            colorScheme: 'light',
            extraHTTPHeaders: {
                'accept-language': 'zh-CN,zh;q=0.9',
            },
        });



        /////////////////////////////////业务开始//////////////////////////////////////
        // const aipage = await getPage(context);
        // await AIQuery(aipage, '说一下图片中的内容', ['example.png']);
        // await aipage.close();

        // 闲鱼界面任务开始
        const xainyupage = await getPage(context);
        try {
            await xainyupage.goto(`https://www.goofish.com/search?q=${config.keyword}`);
            await sleep(5000); // 等待 2 秒，确保页面完全加载
            console.log('闲鱼页面加载完成');


            // 登录框是一个嵌入界面 #baxia-dialog-content  或者 body > div.J_MIDDLEWARE_FRAME_WIDGET > iframe 或者 #alibaba-login-box
            const loginIframeHandle = '#alibaba-login-box, #baxia-dialog-content, body > div.J_MIDDLEWARE_FRAME_WIDGET > iframe'
            const iframeHandle = await xainyupage.waitForSelector(loginIframeHandle, { timeout: 10000 }).catch(() => null);
            if (iframeHandle) {
                const frame = await iframeHandle.contentFrame();
                if (frame) {
                    // 截图并保存
                    await xainyupage.screenshot({ path: 'xianyu.png', fullPage: true });

                    // 识别二维码并生成新的二维码
                    const qrResult = await decodeQrCodeFromImage('xianyu.png');
                    if (qrResult && qrResult.result) {
                        qrResult.result = qrResult.result.replace(/gok&ish/, 'goofish');

                        await generateQrCodeInTerminal(qrResult.result);
                        console.log('请用闲鱼app扫描上面显示的二维码进行登录 30s 否则后将自动关闭');
                        // #login > div.extra-login-content > div > div.login-blocks.block0 > label
                        // #login > div.extra-login-content > div > div.qrcode-success
                        // #login > div.extra-login-content > div > div:nth-child(2)
                        for (let i = 0; i < 20 * 3; i++) {
                            const iframeHandle = await xainyupage.waitForSelector(loginIframeHandle, { timeout: 1000 }).catch(() => null);
                            if (iframeHandle) {
                                const frame = await iframeHandle.contentFrame();
                                if (frame) {
                                    const loginLabel = await frame.$('#login > div.extra-login-content > div > div:nth-child(2)');
                                    if (loginLabel) {
                                        // 获取class 属性
                                        const className = await loginLabel.getAttribute('class');
                                        if (className && className.includes('qrcode-success')) {
                                            console.log('扫码完成.');
                                            //寻找保存登录按钮
                                            //#login > div.extra-login-content > div > div.login-blocks.block4 > div.keep-login-confirm.show > div > div > div.keep-login-confirm-footer > button.fm-button.fm-submit.keep-login-btn.keep-login-confirm-btn.primary
                                            //#login > div.extra-login-content > div > div.login-blocks.block4 > div.keep-login-confirm.show > div > div > div.keep-login-confirm-footer > button.fm-button.fm-submit.keep-login-btn.keep-login-confirm-btn.primary
                                            await sleep(3500); // 等待 1 秒，等待登录完成后保持登录按钮出现
                                            console.log('正在检查保持登录按钮...');
                                            {
                                                const iframeHandle = await xainyupage.waitForSelector(loginIframeHandle, { timeout: 1000 }).catch(() => null);
                                                if (iframeHandle) {
                                                    const frame = await iframeHandle.contentFrame();
                                                    if (frame) {
                                                        await sleep(3000);
                                                        const keepLoginButton = await frame.$('#login > div.extra-login-content > div > div.login-blocks.block4 > div.keep-login-confirm.show > div > div > div.keep-login-confirm-footer > button.fm-button.fm-submit.keep-login-btn.keep-login-confirm-btn.primary');
                                                        if (keepLoginButton) {
                                                            keepLoginButton.click();
                                                            console.log('已点击保持登录按钮');
                                                        } else {
                                                            console.log('未找到保持登录按钮');
                                                        }
                                                    }

                                                }


                                            }
                                            break;
                                        }
                                        console.log('登录界面已出现，请扫描二维码登录...');
                                        await sleep(1000); // 等待 1 秒，继续检查

                                    } else {
                                        console.log('等待登录界面出现...');
                                        await sleep(100);
                                    }
                                }

                            }

                        }
                        console.log('等待结束,如果二维码过期了,请重新运行脚本获取新的二维码');
                        fs.unlinkSync('xianyu.png'); // 删除临时截图文件
                    } else {
                        console.log('iframe 已找到，但无法获取内部 frame');
                    }
                }


                // 检查是否登录完成

            } else {
                console.log('未找到登录 iframe，可能页面结构已变化, 有可能已经登录成功了，继续往下走');
            }

            // 登录完成后，业务
            await sleep(1000); // 等待 5 秒，确保登录状态稳定
            // 浏览页面
            // 列表 #content > div.search-container--eigqxPi6 > div.feeds-list-container--UkIMBPNk > a
            // 下一页按钮 #content > div.search-container--eigqxPi6 > div.search-footer-page-container--e02TuanR > div > div.search-pagination-pageitem-container--adfiUKZP > button:nth-child(14)
            // 当前页码 #content > div.search-container--eigqxPi6 > div.search-footer-page-container--e02TuanR > div > div.search-pagination-pageitem-container--adfiUKZP > div.search-pagination-page-box-active--vsBooIVl
            // 判断是否最后一页 #content > div.search-container--eigqxPi6 > div.search-filter-up-container--IKSFALsr > div.search-filter-distance-page-container--aTsABDJh > div.search-page-tiny-container--GNO3e2D8 > span
            let lastPage = 0
            for (; ;) {

                const products = await xainyupage.$$('#content > div.search-container--eigqxPi6 > div.feeds-list-container--UkIMBPNk > a');
                console.log('当前页面商品数量：', products.length);
                for (const product of products) {
                    const url = await product.getAttribute('href');
                    console.log('商品链接：', url);

                    const info = await watchProduct(context, url);
                    if (info) {
                        await dingdingMsgNotifyFish(info);
                    }

                }
                //检查是否有下一页按钮
                const pageFoot = await xainyupage.$('#content > div.search-container--eigqxPi6 > div.search-filter-up-container--IKSFALsr > div.search-filter-distance-page-container--aTsABDJh > div.search-page-tiny-container--GNO3e2D8 > span');
                // #content > div.search-container--eigqxPi6 > div.search-footer-page-container--e02TuanR > div > div.search-pagination-pageitem-container--adfiUKZP > button:nth-child(4)
                // #content > div.search-container--eigqxPi6 > div.search-footer-page-container--e02TuanR > div > div.search-pagination-pageitem-container--adfiUKZP > button
                const nextPageButtons = await xainyupage.$$('#content > div.search-container--eigqxPi6 > div.search-footer-page-container--e02TuanR > div > div.search-pagination-pageitem-container--adfiUKZP > button');
                let nextPageButton = nextPageButtons[1] ? nextPageButtons[1] : null;

                if (nextPageButton) {
                    const pageFootText = await pageFoot.textContent();
                    console.log('当前页码', pageFootText);
                    const parts = pageFootText.split('/')

                    if (lastPage == parts[0]) {
                        console.log('页码未更新，可能已经到了最后一页');
                        break;
                    }

                    lastPage = parts[0];


                    if (parts[0] == parts[1]) {
                        console.log('已到最后一页');
                        break;
                    } else {
                        console.log('正在点击下一页按钮...');
                        await nextPageButton.click();
                        await sleep(6000); // 等待 6 秒，等待页面加载完成
                    }
                } else {
                    console.log('未找到下一页按钮，可能页面结构已变化，或者已经到了最后一页');
                    await sleep(5000 * 10000);
                    break;
                }
            }

            // await sleep(5000 * 10000); // 等待 5 秒，确保所有操作完成

        } catch (error) {
            console.error('闲鱼界面任务 err：', error.message || error);
        } finally {
            await xainyupage.close();
        }


    } catch (error) {
        console.error('Playwright err：', error.message || error);
    } finally {
        if (context) {
            await context.close();
            console.log(`已关闭持久化上下文，浏览器数据保存在 ${userDataDir} 目录`);
        }
    }
})();


// 购买 锁单

async function dingdingMsgNotifyFish(info) {
    let msg = `【闲鱼捡漏】-${config.keyword}\n`
        + `- [手机跳转](${config.phtoneDomain}${new URL(info.addr).pathname + new URL(info.addr).search})\n`
        + `- 标题：${info.description.slice(0, 100)}...\n`
        + `- 识别结果：${info.aiReply.identified_brand_model}\n`
        + `- 价格：${info.price}\n`
        + `- 是否个人卖家：${info.aiReply.is_persion ? '是' : '否'}\n`
        + `- 信用等级：${info.aiReply.credit}\n`
        + `- 评估：${info.aiReply.bargain_level}\n`
        + `- 评分：${info.aiReply.bargain_score}\n`
        + `- 评估理由：${info.aiReply.key_findings}\n`
        + `- 风险提示：\n${info.aiReply.risks.join('\n')}\n`
        + `- 推荐意见：${info.aiReply.recommendation}\n`
        + `- 链接：<${info.addr}>\n`
        + `- 产品id：${info.productId}\n`

    let imgSrc = '> - 详情图片：\n'
    for (let pic of info.images) {
        if (pic.includes('webp')) {
            imgSrc += '> ' + '<' + pic + '>' + '\n'
        } else {
            imgSrc += `> ![screenshot](${pic})\n`
        }
    }
    msg += imgSrc
    // msg += '<details> \n<summary>点击查看详情图片</summary>\n\n'
    // for (let pic of info.images) {
    //     msg += `![screenshot](${pic})\n`
    // }
    if (info.aiReply.is_bargain) {
        await dd.postToDingdingMarkdown(config.ddUrl, '闲鱼捡漏', msg)
    }

}


async function watchProduct(context, url) {
    let page = null
    let info = {
        price: null,
        description: null,
        images: [],
        addr: url,
    }
    const png = `product-${Math.random().toString(36).substring(2, 15)}.png`;
    try {


        const existingProduct1 = await db.prepare('SELECT createTime,is_bargain,productId FROM t_dat_xianyu_cache WHERE addr = ?').get(url);
        console.log('数据库查询结果：', existingProduct1);
        if (existingProduct1 && !(existingProduct1.is_bargain) && Date.now() - existingProduct1.createTime < config.bargainDay * 24 * 3600 * 1000) {
            console.log('数据库中已存在相同链接的商品，且之前判断过不是捡漏，不再进行AI分析');
            return;
        }

        if (existingProduct1 && Date.now() - existingProduct1.createTime < config.againDay * 24 * 3600 * 1000) { // 如果数据库中存在相同链接和价格的商品，并且记录时间在2天内
            console.log('数据库中已存在相同链接的商品，跳过AI分析');
            return;
        }
        page = await getPage(context);
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
                configurable: true,
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh'],
                configurable: true,
            });
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
                configurable: true,
            });
            Object.defineProperty(navigator, 'vendor', {
                get: () => 'Google Inc.',
                configurable: true,
            });
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
                configurable: true,
            });
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
                configurable: true,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
                configurable: true,
            });
            window.chrome = {
                runtime: {},
                app: { isInstalled: false },
            };
        });

        // 打开页面
        await page.goto(url);
        await sleep(5000); // 等待 5 秒，确保页面完全加载
        console.log('商品页面加载完成');
        // 截图并保存
        await page.screenshot({ path: png, fullPage: true });
        // 价格 #content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-info--ExVwW2NW > div.tips--bJdC_yBS > div:nth-child(1) > div > div.price--OEWLbcxC.windows--oJroL99y
        // 详情描述  #content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-info--ExVwW2NW
        // 详情图片 #content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-window--BgQbsIsU > div.item-main-window-list--od7DK4Fm > div.item-main-window-list-item--gXUlMEkj > img



        info.price = await page.textContent('#content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-info--ExVwW2NW > div.tips--bJdC_yBS > div:nth-child(1) > div > div.price--OEWLbcxC.windows--oJroL99y').catch(() => { console.error('价格选择器可能已失效'); return null; });
        info.description = info.description = await page.$eval('#content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-info--ExVwW2NW', el => {
            return el.innerText;
        });//await page.textContent('#content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-info--ExVwW2NW');
        const imageElements = await page.$$('#content > div.item-container--yLJD5VZj > div.item-main-container--jhpFKlaS > div.item-main-window--BgQbsIsU > div.item-main-window-list--od7DK4Fm > div.item-main-window-list-item--gXUlMEkj > img');
        info.images = [];
        for (const imageElement of imageElements) {
            const src = await imageElement.getAttribute('src');
            info.images.push('https:' + src);
        }
        console.log('商品信息：', info);


        // 查找数据库中数据已经判断过
        const existingProduct = await db.prepare('SELECT id FROM t_dat_xianyu_cache WHERE addr = ? and price=?').get(url, info.price);
        if (existingProduct) {
            console.log('不管日期,价格没变化,数据库中已存在相同链接和价格的商品，跳过AI分析');
        } else {

            const text1 = fs.readFileSync(config.prompt[0], 'utf-8');
            const inputinfo = `
【输入信息】
- 商品价格：${info.price} 元
- 详情图片地址：${JSON.stringify(info.images)}
- 详情描述：${info.description}
- 检索关键词：${config.keyword}
${config.inputinfo}
`
            const text2 = fs.readFileSync(config.prompt[1], 'utf-8');

            console.log('正在询问AI，获取建议...');
            const aipage = await getPage(context);
            const rpl = await AIQuery(aipage, `${text1}${inputinfo}${text2}`, [png]).finally(() => aipage.close());
            if (rpl) {
                info.aiReply = rpl;
            } else {
                console.log('AI未返回结果');
            }

            const id = url.match(/id=(\d+)/);
            const productId = id ? id[1] : null;
            info.productId = productId;
            await db.prepare(`delete from t_dat_xianyu_cache where addr = ? and price = ?`).run(url, info.price);
            await db.prepare(`INSERT INTO t_dat_xianyu_cache (createTime,title, imageurls, productId, addr, price, description, is_bargain, bargain_level, bargain_score, estimated_market_price_range, condition_assessment, identified_brand_model, key_findings, risks, recommendation, is_persion,credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), config.keyword, JSON.stringify(info.images), productId, url, info.price, info.description, info.aiReply?.is_bargain ? 1 : 0, info.aiReply?.bargain_level || '', info.aiReply?.bargain_score || 0, info.aiReply?.estimated_market_price_range || '', info.aiReply?.condition_assessment || '', info.aiReply?.identified_brand_model || '', info.aiReply?.key_findings || '', JSON.stringify(info.aiReply?.risks || []), info.aiReply?.recommendation || '', info.aiReply?.is_persion ? 1 : 0, info.aiReply?.credit || 0);

            if (info.aiReply) {
                return info;
            }
        }



    } catch (error) {
        console.error('watchProduct err：', error.message || error);
    } finally {
        if (page)
            await page.close().catch((e) => { console.error('Error occurred while closing the page:', e); });
        if (fs.existsSync(png))
            await fs.promises.unlink(png).catch((e) => { console.error('Error occurred while deleting screenshot file:', e); }); // 删除临时截图文件

    }

}

async function getPage(context) {
    const page = await context.newPage();
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
        });
        Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh'],
            configurable: true,
        });
        Object.defineProperty(navigator, 'platform', {
            get: () => 'Win32',
            configurable: true,
        });
        Object.defineProperty(navigator, 'vendor', {
            get: () => 'Google Inc.',
            configurable: true,
        });
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => 8,
            configurable: true,
        });
        Object.defineProperty(navigator, 'deviceMemory', {
            get: () => 8,
            configurable: true,
        });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
            configurable: true,
        });
        window.chrome = {
            runtime: {},
            app: { isInstalled: false },
        };
    });
    return page;
}
function extractJSONByRegex(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('未匹配到 JSON 对象');
    console.log('提取到的 JSON 字符串：', match[0]);
    return JSON.parse(match[0]);
}
async function AIQuery(page, question, images = []) {
    // 打开页面
    await page.goto('https://chat.deepseek.com/a/chat');
    // await page.waitForSelector('#tpl_iframe > div.web_qrcode_panel > div.web_qrcode_initial_context.js_status.js_wx_default_tip > div > img', { timeout: 60000 });
    console.log('页面加载完成');
    await sleep(2000); // 等待 2 秒，确保页面完全加载
    // 截图并保存
    await page.screenshot({ path: 'qr.png', fullPage: true });

    // 输出页面标题
    console.log('页面标题：', await page.title());

    // 识别二维码并生成新的二维码
    const qrResult = await decodeQrCodeFromImage('qr.png');
    if (qrResult && qrResult.result) {
        await generateQrCodeInTerminal(qrResult.result);
        console.log('请扫描上面显示的二维码进行登录 30s 否则后将自动关闭');
        await sleep(30000); // 等待 5 秒，查看终端中的二维码
    }

    fs.unlinkSync('qr.png'); // 删除临时截图文件

    //检查是否登录成功 ,查找#root > div > div > div.c3ecdb44 > div.dc04ec1d > div > div._5a8ac7a.a084f19e > span
    const loginSpan = await page.$('#root > div > div > div.c3ecdb44 > div.dc04ec1d > div > div._5a8ac7a.a084f19e > span');
    if (loginSpan) {
        console.log('登录成功');
        const text = await loginSpan.textContent();
        console.log(text);
        loginSpan.click();
        await sleep(2000);

        // 默认这个侧边栏是打开的 
        //#root > div > div > div.c3ecdb44 > div.dc04ec1d.a02af2e6 > div.ca6d4be1._5a20a69 > div.e5bf614e > div:nth-child(2) > div.ds-icon-button__hover-bg
        const sideBarButton = await page.$('#root > div > div > div.c3ecdb44 > div.dc04ec1d.a02af2e6 > div.ca6d4be1._5a20a69 > div.e5bf614e > div:nth-child(2) > div.ds-icon-button__hover-bg');
        if (sideBarButton) {
            sideBarButton.click();
            console.log('已点击侧边栏按钮');
            await sleep(2000); // 等待 2 秒，查看页面反应
        }

        // 检查深度思考 #root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div > div.ec4f5d61 > div:nth-child(1)
        const deepSeekSpan = await page.$('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div > div.ec4f5d61 > div:nth-child(1)');
        if (deepSeekSpan) {
            //查看属性 aria-pressed
            const ariaPressed = await deepSeekSpan.getAttribute('aria-pressed');
            console.log('深度思考 aria-pressed:', ariaPressed);
            if (ariaPressed == 'false' && config.intelligent) {
                console.log('点击进入深度思考');
                deepSeekSpan.click();
            } else if (ariaPressed == 'true' && !config.intelligent) {
                console.log('退出深度思考');
                deepSeekSpan.click();
            }



        } else {
            console.log('未找到深度思考入口');
        }

        // 输入需要AI的问题
        for (const imgPath of images) {
            // 1.图片事件上传
            await simulatePasteImage(page, '#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div > div._24fad49 > textarea', imgPath, 'image/png');
            // await sleep(20 * 1000); // 等待 20 秒，查看页面反应
            for (let i = 0; i < 40; i++) {
                // 检查 #root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div._020ab5b > div.ec4f5d61 > div.bf38813a > div:nth-child(3) > div
                const element = await page.$('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div._020ab5b > div.ec4f5d61 > div.bf38813a > div:nth-child(3) > div')
                //检查属性aria-disabled
                if (element) {
                    const ariaDisabled = await element.getAttribute('aria-disabled');
                    if (ariaDisabled == 'true') {
                        console.log('正在上传图片，请稍候...');

                        // 补丁 再次检查是否是因为无法识别 #root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div.ds-banner.ds-banner--info._0138851 > div > button
                        const errorButton = await page.$('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div.ds-banner.ds-banner--info._0138851 > div > button');
                        if (errorButton) {
                            console.log('图片上传失败，可能是因为图片内容无法识别，已点击确认按钮');
                            errorButton.click();
                        }
                        await sleep(2000); // 等待 5 秒，继续检查

                    } else {
                        console.log('图片上传完成，可以输入文本了');
                        break
                    }
                } else {
                    break;
                }
            }
        }


        // 2.文本输入事件
        await page.fill('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div > div._24fad49 > textarea', question);
        await sleep(1000)
        //点击发送 按钮 #root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div._020ab5b > div.ec4f5d61 > div.bf38813a > div:nth-child(3) > div > div.ds-icon-button__hover-bg
        const sendButton = await page.$('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div > div._9a2f8e4 > div.aaff8b8f > div > div._020ab5b > div.ec4f5d61 > div.bf38813a > div:nth-child(3) > div > div.ds-icon-button__hover-bg');
        if (sendButton) {
            sendButton.click();
            console.log('已点击发送按钮');

            // 等等结果回复
            for (let i = 0; i < 30; i++) {
                //#root > div > div > div.c3ecdb44 > div._7780f2e > div > div.ds-virtual-list.ds-virtual-list--printable._2bd7b35 > div.ds-virtual-list-items._6f2c522 > div > div._4f9bf79.d7dc56a8._43c05b5 > div.ds-message._63c77b1 > div.ds-markdown.ds-assistant-message-main-content

                const replyElement = await page.$('#root > div > div > div.c3ecdb44 > div._7780f2e > div > div.ds-virtual-list.ds-virtual-list--printable._2bd7b35 > div.ds-virtual-list-items._6f2c522 > div > div._4f9bf79.d7dc56a8._43c05b5 > div.ds-message._63c77b1 > div.ds-markdown.ds-assistant-message-main-content');
                if (replyElement) {
                    let replyText = await replyElement.textContent();
                    replyText = extractJSONByRegex(replyText);
                    // console.log('AI回复：', replyText);
                    return replyText
                    break;
                } else {
                    console.log('等待AI回复中...');
                    await sleep(5000); // 等待 5 秒，继续检查
                }

            }

        } else {
            console.log('未找到发送按钮');
        }

    }

    return null;

}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function decodeQrCodeFromImage(imagePath) {
    return new Promise((resolve, reject) => {
        Jimp.read(imagePath)
            .then(image => {
                const qr = new QrCode();
                qr.callback = (err, value) => {
                    if (err) {
                        // reject(err);
                        console.error('二维码识别失败：', err);
                        resolve(null);
                        return;
                    }
                    // console.log('二维码识别结果：', value);
                    resolve(value);
                };
                qr.decode(image.bitmap);
            })
            .catch(reject);
    });
}

function generateQrCodeInTerminal(text) {
    return new Promise((resolve) => {
        console.log('识别结果:', text);
        console.log('下面将在终端中显示生成二维码：');
        qrcodeTerminal.generate(text, { small: true }, (code) => {
            console.log(code);
            resolve(code);
        });
    });
}


/**
 * 模拟将图片粘贴到指定元素
 * @param {Page} page Playwright Page 对象
 * @param {string} selector 目标元素的选择器
 * @param {string} imagePath 本地图片路径
 * @param {string} mimeType 图片 MIME 类型，如 'image/png'
 */
async function simulatePasteImage(page, selector, imagePath, mimeType = 'image/png') {
    // 1. 读取图片并转为 Base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    // 2. 在页面上下文中执行模拟粘贴的脚本
    await page.evaluate(
        ({ sel, base64, mime }) => {
            const target = document.querySelector(sel);
            if (!target) {
                console.error(`Element ${sel} not found`);
                return;
            }

            // 解码 Base64 为二进制数据
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // 创建 Blob 和 File 对象
            const blob = new Blob([bytes], { type: mime });
            const file = new File([blob], 'pasted_image.png', { type: mime });

            // 构造 DataTransfer 并添加文件
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);

            // 创建粘贴事件
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dataTransfer,
            });

            // 派发事件
            target.dispatchEvent(pasteEvent);
        },
        { sel: selector, base64: base64Image, mime: mimeType }
    );
}



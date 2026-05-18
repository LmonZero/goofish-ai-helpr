/**
 * AI Criteria 生成脚本（参考范例模仿模式）
 *
 * 读取 macbook_criteria.txt 作为参考范例，让浏览器 AI 模仿生成新商品品类的评估标准
 * 对齐 Python 版 prompt_utils.py 的 generate_criteria 逻辑
 *
 * 浏览器管理复用 BaseScraper（持久化上下文 + 反检测注入），
 * AI 分析复用 DoubaoAnalyzer/ZhiPuAnalyzer（含登录流程）。
 *
 * 用法：
 *   node script/generate-criteria.js "iPhone 16 Pro" doubao
 *   node script/generate-criteria.js "iPad Air M2" zhipu
 *   node script/generate-criteria.js "索尼WH-1000XM5耳机" doubao
 *
 * 可选参数：
 *   --reference <文件路径>   指定参考范例文件（默认 ./prompt/macbook_criteria.txt）
 *   --deep-think             启用深度思考（默认关闭）
 *   --headless               无头模式（默认有头，方便手动登录）
 */

const BaseScraper = require('../scraper/BaseScraper');
const DoubaoAnalyzer = require('../analyzer/DoubaoAnalyzer');
const ZhiPuAnalyzer = require('../analyzer/ZhiPuAnalyzer');
const fs = require('fs');
const path = require('path');

// ======================== 参数解析 ========================

function parseArgs() {
    const raw = process.argv.slice(2);
    if (raw.length < 2) {
        console.log('用法: node script/generate-criteria.js "<商品名称>" <ai平台> [选项]');
        console.log('  商品名称: 如 "iPhone 16 Pro", "MacBook Air M1", "iPad Air M2"');
        console.log('  ai平台:   doubao | zhipu');
        console.log('  --reference <路径>  参考范例文件（默认 ./prompt/macbook_criteria.txt）');
        console.log('  --deep-think        启用深度思考（默认关闭）');
        console.log('  --headless          无头模式');
        process.exit(1);
    }

    const productName = raw[0];
    const aiPlatform = raw[1].toLowerCase();

    let referenceFile = path.join(__dirname, '..', 'prompt', 'macbook_criteria.txt');
    let deepThink = false;
    let headless = false;

    for (let i = 2; i < raw.length; i++) {
        if (raw[i] === '--reference' && raw[i + 1]) {
            referenceFile = path.resolve(raw[++i]);
        } else if (raw[i] === '--deep-think') {
            deepThink = true;
        } else if (raw[i] === '--headless') {
            headless = true;
        }
    }

    if (!['doubao', 'zhipu'].includes(aiPlatform)) {
        console.error(`不支持的 AI 平台: ${aiPlatform}，请使用 doubao 或 zhipu`);
        process.exit(1);
    }

    return { productName, aiPlatform, referenceFile, deepThink, headless };
}

// ======================== 构建提问（对齐 Python 版 META_PROMPT_TEMPLATE） ========================

function buildMetaPrompt(productName, referenceText) {
    return `你是一位世界级的AI提示词工程大师。你的任务是根据用户提供的【购买需求】，模仿一个【参考范例】，为闲鱼监控机器人的AI分析模块（代号 EagleEye）生成一份全新的【分析标准】文本。

你的输出必须严格遵循【参考范例】的结构、语气和核心原则，但内容要完全针对用户的【购买需求】进行定制。最终生成的文本将作为AI分析模块的思考指南。

---
这是【参考范例】（macbook_criteria.txt）：
\`\`\`text
${referenceText}
\`\`\`
---

这是用户的【购买需求】：
\`\`\`text
${productName}
\`\`\`
---

请现在开始生成全新的【分析标准】文本。请注意：
1.  **只输出新生成的文本内容**，不要包含任何额外的解释、标题或代码块标记。
2.  保留范例中的 \`[V6.3 核心升级]\`、\`[V6.4 逻辑修正]\` 等版本标记，这有助于保持格式一致性。
3.  将范例中所有与 "MacBook" 相关的内容，替换为与用户需求商品相关的内容。
4.  思考并生成针对新商品类型的"一票否决硬性原则"和"危险信号清单"。
5.  特别关注该品类在二手市场的特有风险（如配置锁/MDM锁/网络锁/官换机/翻新机/扩容机等）。
6.  危险信号和豁免条款必须结合该品类的实际市场情况，不能泛泛而谈。`;
}

// ======================== 提取 criteria 内容 ========================

function extractCriteria(rawText) {
    let text = rawText;

    // 1. 去除 markdown 代码块包裹
    const codeBlockMatch = text.match(/```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
        text = codeBlockMatch[1];
    }

    // 2. 去除 AI 前缀废话（"好的，以下是..."）
    const sectionStart = text.indexOf('### **第一部分');
    if (sectionStart > 0) {
        text = text.substring(sectionStart);
    }

    // 3. 清理末尾 AI 附言
    const lines = text.split('\n');
    let cutIndex = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.match(/^7\./) || trimmed.includes('seller_credit') || trimmed.match(/^\*\*7\./)) {
            cutIndex = i + 1;
            break;
        }
    }
    const remaining = lines.slice(cutIndex).join('\n').trim();
    if (remaining && !remaining.startsWith('###') && !remaining.startsWith('*') && !remaining.startsWith('-')) {
        text = lines.slice(0, cutIndex).join('\n');
    }

    return text.trim();
}

// ======================== 主流程 ========================

async function main() {
    const { productName, aiPlatform, referenceFile, deepThink, headless } = parseArgs();

    console.log(`\n=== AI Criteria 生成器 ===`);
    console.log(`商品: ${productName}`);
    console.log(`AI平台: ${aiPlatform}`);
    console.log(`参考范例: ${referenceFile}`);
    console.log(`深度思考: ${deepThink ? '开启' : '关闭'}`);
    console.log(`无头模式: ${headless ? '开启' : '关闭（方便首次登录）'}`);
    console.log(`========================\n`);

    // 1. 读取参考范例
    console.log('[1/5] 读取参考范例...');
    if (!fs.existsSync(referenceFile)) {
        console.error(`参考文件不存在: ${referenceFile}`);
        process.exit(1);
    }
    const referenceText = fs.readFileSync(referenceFile, 'utf8');
    console.log(`  参考范例长度: ${referenceText.length} 字符\n`);

    // 2. 构建提问
    const metaPrompt = buildMetaPrompt(productName, referenceText);
    console.log(`[2/5] 提问构建完成，长度: ${metaPrompt.length} 字符\n`);

    // 3. 启动浏览器（BaseScraper: 持久化上下文 + 反检测注入）
    const dataName = aiPlatform;  // UserData/doubao 或 UserData/zhipu
    console.log(`[3/5] 启动浏览器 (userData: UserData/${dataName})...`);
    const scraper = new BaseScraper({ dataName, headless });
    const context = await scraper.init();
    console.log(`[3/5] 浏览器就绪\n`);

    // 4. 初始化 AI 分析器 + 发送提问
    console.log('[4/5] 初始化 AI 分析器（如未登录会等待扫码）...');
    let analyzer;
    if (aiPlatform === 'doubao') {
        analyzer = new DoubaoAnalyzer({ deepThink });
    } else {
        analyzer = new ZhiPuAnalyzer({ deepThink });
    }
    analyzer.setContext(context);
    await analyzer.init();
    console.log('[4/5] AI 分析器就绪，发送生成请求...\n');

    const result = await analyzer.analyze(metaPrompt, { deepThink });

    if (!result || !result.answer) {
        console.error('AI 返回结果为空，请检查网络和登录状态');
        if (result) {
            console.error('调试信息:', JSON.stringify({
                answerLen: result.answer?.length || 0,
                thinkLen: result.think?.length || 0,
                conversationId: result.conversationId || '',
                dataLineCount: result.dataLineCount || 0,
            }));
        }
        await scraper.close();
        process.exit(1);
    }

    console.log(`  AI 回复完成，正文: ${result.answer.length} 字符\n`);

    // 5. 提取 + 保存
    console.log('[5/5] 提取并保存...');
    const criteriaText = extractCriteria(result.answer);

    const safeName = productName.toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
        .replace(/^_|_$/g, '');
    const outputPath = path.join(__dirname, '..', 'prompt', `${safeName}_criteria.txt`);

    fs.writeFileSync(outputPath, criteriaText + '\n', 'utf8');

    console.log(`\n✅ 生成完成！`);
    console.log(`   文件: ${outputPath}`);
    console.log(`   长度: ${criteriaText.length} 字符`);
    console.log(`\n   在 AIFish 配置中设置:`);
    console.log(`   "promptCriteria": "./prompt/${safeName}_criteria.txt"`);

    await scraper.close();
}

main().catch(err => {
    console.error('生成失败:', err.message);
    process.exit(1);
});
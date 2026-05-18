/**
 * AIFish 脚本管理器
 *
 * 统一入口，调度各类脚本。每个脚本独立完成一个完整流程。
 *
 * 用法：
 *   node main.js run <配置文件>           闲鱼AI筛查主流程
 *   node main.js criteria <商品> <平台>   生成品类评估标准
 *
 * 也可以直接调用脚本：
 *   node script/aifish-run.js <配置文件>
 *   node script/generate-criteria.js <商品> <平台>
 */

const { execSync } = require('child_process');
const path = require('path');

// 脚本注册表
const SCRIPTS = {
    run: {
        file: 'script/aifish-run.js',
        desc: '闲鱼AI筛查主流程',
        usage: 'node main.js run <配置文件>',
        example: 'node main.js run ./script/json/AIFish-example.json',
    },
    criteria: {
        file: 'script/generate-criteria.js',
        desc: '生成品类评估标准提示词',
        usage: 'node main.js criteria <商品名称> <平台> [选项]',
        example: 'node main.js criteria "iPhone 16 Pro" doubao',
    },
};

function printHelp() {
    console.log('AIFish 脚本管理器\n');
    console.log('可用命令：\n');
    for (const [name, script] of Object.entries(SCRIPTS)) {
        console.log(`  ${name.padEnd(12)} ${script.desc}`);
        console.log(`  ${''.padEnd(12)} ${script.usage}`);
        console.log(`  ${''.padEnd(12)} 示例: ${script.example}`);
        console.log('');
    }
    console.log('也可以直接调用脚本：');
    console.log('  node script/aifish-run.js <配置文件>');
    console.log('  node script/generate-criteria.js <商品> <平台>');
}

// ---- 入口 ----

const command = process.argv[2];

if (!command || command === '-h' || command === '--help') {
    printHelp();
    process.exit(0);
}

const script = SCRIPTS[command];
if (!script) {
    console.error(`未知命令: ${command}\n`);
    printHelp();
    process.exit(1);
}

// 转发参数（去掉 main.js 和 command 本身）
const forwardArgs = process.argv.slice(3);
const scriptPath = path.join(__dirname, script.file);

try {
    execSync(`node "${scriptPath}" ${forwardArgs.join(' ')}`, {
        stdio: 'inherit',
        cwd: __dirname,
    });
} catch (e) {
    // execSync 在非零退出码时抛出，stdio: 'inherit' 已输出子进程的错误
    process.exit(e.status || 1);
}

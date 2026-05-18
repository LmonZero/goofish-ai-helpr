/**
 * 二维码识别与终端打印工具
 *
 * 从 BaseAnalyzer.decodeAndPrintQR() 提取而来，
 * 供 BaseAnalyzer（AI 扫码登录）和 GoofishScraper（闲鱼扫码登录）共用。
 *
 * 依赖：jimp、qrcode-reader、qrcode-terminal（已在 package.json 中）
 */

const fs = require('fs');
const path = require('path');

/**
 * 从图片文件识别二维码并在终端打印
 *
 * @param {string} imagePath - 二维码图片路径
 * @returns {Promise<{success: boolean, result?: string}>}
 */
async function decodeAndPrintQR(imagePath) {
    const { Jimp } = require('jimp');
    const QrCode = require('qrcode-reader');
    const qrcodeTerminal = require('qrcode-terminal');

    try {
        const image = await Jimp.read(imagePath);
        const qr = new QrCode();

        return new Promise((resolve) => {
            qr.callback = (err, value) => {
                if (err) {
                    console.log(`[QR] 二维码识别失败: ${err.message}`);
                    resolve({ success: false });
                    return;
                }
                console.log(`[QR] 二维码链接: ${value.result}`);
                qrcodeTerminal.generate(value.result, { small: true }, (code) => {
                    console.log(code);
                });
                resolve({ success: true, result: value.result });
            };
            qr.decode(image.bitmap);
        });
    } catch (e) {
        console.log(`[QR] 二维码读取异常: ${e.message}`);
        return { success: false };
    }
}

/**
 * 安全删除临时文件
 *
 * @param {string} filePath - 要删除的文件路径
 */
function cleanupTempFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* 忽略删除失败 */ }
}

/**
 * 确保临时目录存在，返回临时目录路径
 *
 * @param {string} [subDir=''] - 子目录名（如 'goofish'）
 * @returns {string} 临时目录绝对路径
 */
function ensureTempDir(subDir = '') {
    const tmpDir = path.join(process.cwd(), 'tmp', subDir);
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
}

module.exports = { decodeAndPrintQR, cleanupTempFile, ensureTempDir };

/**
 * 图床上传服务 — image-upload.app
 *
 * 用法：
 *   const imageHosting = require('../lib/image-hosting');
 *
 *   // 上传本地文件（默认返回纯 URL）
 *   const url = await imageHosting.upload('./screenshot.png');
 *
 *   // 上传 Buffer，返回 HTML 格式
 *   const html = await imageHosting.upload(buffer, { filename: 'test.png', format: 'html' });
 *
 *   // 返回 Markdown 格式
 *   const md = await imageHosting.upload('./img.png', { format: 'markdown' });
 *
 * format 选项：
 *   'url'       — 纯 URL（默认）
 *   'html'      — HTML 原图（带链接）
 *   'markdown'  — Markdown 链接
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const UPLOAD_URL = 'https://image-upload.app/api/upload';

class ImageHosting {

    /**
     * 上传图片到图床
     *
     * @param {string|Buffer} input - 本地文件路径 或 Buffer
     * @param {object} [options]
     * @param {string} [options.filename] - 文件名（Buffer 模式必填）
     * @param {string} [options.mode='temporary'] - 上传模式
     * @param {string} [options.type='image'] - 文件类型
     * @param {'url'|'html'|'markdown'} [options.format='url'] - 返回格式
     * @returns {Promise<string>} 按 format 返回对应格式的字符串
     */
    async upload(input, format = 'url', options = {}) {
        const { mode = 'temporary', type = 'image' } = options;

        let buffer;
        let filename;

        if (typeof input === 'string') {
            // 本地文件路径
            if (!fs.existsSync(input)) {
                throw new Error(`[ImageHosting] 文件不存在: ${input}`);
            }
            buffer = fs.readFileSync(input);
            filename = options.filename || path.basename(input);
        } else if (Buffer.isBuffer(input)) {
            // Buffer
            buffer = input;
            filename = options.filename || 'upload.png';
        } else {
            throw new Error('[ImageHosting] input 必须是文件路径(string)或 Buffer');
        }

        // 构建 multipart/form-data
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('file', buffer, { filename });
        form.append('mode', mode);
        form.append('type', type);

        try {
            const response = await axios.post(UPLOAD_URL, form, {
                headers: {
                    ...form.getHeaders(),
                    'Origin': 'https://image-upload.app',
                    'Referer': 'https://image-upload.app/zh',
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });

            const imageUrl = this._extractUrl(response.data);
            const altName = response.data.filename || filename;
            return this._formatOutput(imageUrl, altName, format);
        } catch (e) {
            const msg = e.response ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
            throw new Error(`[ImageHosting] 上传失败: ${msg}`);
        }
    }

    /**
     * 格式化输出
     * @param {string} url - 图片 URL
     * @param {string} altName - 文件名（用作 alt 文本）
     * @param {'url'|'html'|'markdown'} format
     * @returns {string}
     */
    _formatOutput(url, altName, format) {
        switch (format) {
            case 'html':
                return `<a href="${url}"><img src="${url}" alt="${altName}" /></a>`;
            case 'markdown':
                return `![${altName}](${url})`;
            case 'url':
            default:
                return url;
        }
    }

    /**
     * 从 API 响应中提取图片 URL
     * @param {object} data - API 响应体
     * @returns {string}
     */
    _extractUrl(data) {
        // 常见响应结构：{ url: "https://..." } 或 { data: { url: "..." } } 或 { image: "..." }
        if (typeof data === 'string') return data;
        if (data.url) return data.url;
        if (data.data && data.data.url) return data.data.url;
        if (data.data && typeof data.data === 'string') return data.data;
        if (data.image) return data.image;
        if (data.src) return data.src;

        // 扁平搜索第一个看起来像 URL 的值
        const json = JSON.stringify(data);
        const match = json.match(/https?:\/\/[^\s"']+?\.(png|jpg|jpeg|gif|webp|svg|bmp)/i);
        if (match) return match[0];

        throw new Error(`[ImageHosting] 无法从响应中提取图片 URL: ${json.substring(0, 200)}`);
    }
}

module.exports = new ImageHosting();

const axios = require('axios');

/**
 * 钉钉通知器
 * 支持 Markdown 格式消息推送，内置 QPS 限流
 */
class DingDingNotifier {

    constructor() {
        this.QPSQueue = [];
    }

    /**
     * 发送 Markdown 格式消息
     * @param {string} url - 钉钉 webhook 地址
     * @param {string} title - 消息标题
     * @param {string} text - Markdown 正文
     * @param {string[]} [users=[]] - @ 的手机号列表
     */
    async postMarkdown(url, title, text, users = []) {
        if (!url || !text) return;

        const data = {
            msgtype: 'markdown',
            markdown: { title, text },
            at: { atMobiles: users, isAtAll: false },
        };

        const headers = { 'Content-Type': 'application/json' };
        this.QPSQueue.push([url, JSON.stringify(data), { headers }]);

        // 队列中已有任务则等待清队列即可
        if (this.QPSQueue.length > 1) return;

        await this._clearQueue();
    }

    /**
     * 发送闲鱼捡漏通知
     * @param {string} url - 钉钉 webhook 地址
     * @param {object} info - 商品信息
     * @param {string} phoneDomain - 手机端域名
     * @param {string} keyword - 搜索关键词
     */
    async notifyFishBargain(url, info, phoneDomain, keyword) {
        let msg = `【闲鱼捡漏】-${keyword}\n`
            + `- [手机跳转](${phoneDomain}${new URL(info.addr).pathname + new URL(info.addr).search})\n`
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
            + `- 产品id：${info.productId}\n`;

        let imgSrc = '> - 详情图片：\n';
        for (const pic of info.images) {
            if (pic.includes('webp')) {
                imgSrc += '> ' + '<' + pic + '>' + '\n';
            } else {
                imgSrc += `> ![screenshot](${pic})\n`;
            }
        }
        msg += imgSrc;

        if (info.aiReply.is_bargain) {
            await this.postMarkdown(url, '闲鱼捡漏', msg);
        }
    }

    // ======================== 内部限流 ========================

    async _delay(ms = 60) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _clearQueue() {
        while (this.QPSQueue.length) {
            const params = this.QPSQueue.shift();

            // 重试次数限制
            if (params[3] > 10) {
                console.log('钉钉发送失败（重试超限）', params);
                continue;
            }

            let wait = 60;
            try {
                const res = await axios.post(...params);
                console.log('钉钉响应:', res.data);

                if (res.data.errcode === -1 && res.data.errmsg === '系统繁忙') {
                    params[3] = (params[3] || 0) + 1;
                    this.QPSQueue.unshift(params);
                } else if (res.data.errcode === 130101) {
                    // 发送过快，等待 30s 重试
                    wait = 30000;
                    this.QPSQueue.unshift(params);
                } else {
                    console.log('钉钉发送成功');
                }
            } catch (err) {
                console.error('钉钉发送异常:', err.message);
            }

            await this._delay(wait);
        }
    }
}

module.exports = new DingDingNotifier();

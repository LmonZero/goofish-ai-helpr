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
        const reply = info.aiReply || {};
        const analysis = reply.criteria_analysis || {};

        // 手机端跳转链接
        let mobileLink = info.addr;
        try {
            const u = new URL(info.addr);
            mobileLink = phoneDomain + u.pathname + u.search;
        } catch (_) { /* 非标准 URL 则保持原样 */ }

        let msg = `## 🎯 ${keyword} — 推荐商品\n\n`
            + `**[📱 手机查看](${mobileLink})**　　[💻 PC查看](${info.addr})\n\n`
            + `---\n\n`
            + `### 📦 商品信息\n\n`
            + `- **标题：** ${(info.description || '').slice(0, 100)}\n`
            + `- **价格：** ${info.price || '未知'}\n\n`
            + `---\n\n`
            + `### 🧠 AI 分析结论\n\n`
            + `> ${reply.reason || '暂无评价'}\n\n`;

        // 各维度分析
        const dims = [
            { key: 'model_chip', label: '型号/芯片' },
            { key: 'battery_health', label: '电池健康' },
            { key: 'condition', label: '成色状态' },
            { key: 'history', label: '使用历史' },
            { key: 'shipping', label: '发货/售后' },
            { key: 'seller_credit', label: '卖家信用' },
        ];
        for (const dim of dims) {
            const d = analysis[dim.key];
            if (!d) continue;
            msg += `- **${dim.label}**：${d.status || ''}`;
            if (d.comment) msg += ` — ${d.comment}`;
            if (d.evidence) msg += `（${d.evidence}）`;
            msg += '\n';
        }

        // 卖家画像
        const st = analysis.seller_type;
        if (st) {
            msg += '\n**卖家画像**：';
            if (st.persona) msg += `${st.persona}`;
            if (st.comment) msg += ` — ${st.comment}`;
            msg += '\n';
        }

        // 风险标签
        if (reply.risk_tags?.length) {
            msg += `\n**⚠️ 风险标签**：${reply.risk_tags.join('、')}\n`;
        }

        msg += '\n---\n\n';

        // 商品图片（全部来自图床，可直接内嵌展示）
        if (info.images?.length) {
            msg += `### 📷 商品图片\n\n`;
            for (const pic of info.images.slice(0, 6)) {
                msg += `![商品图](${pic})\n`;
            }
            msg += '\n';
        }

        if (reply.is_recommended) {
            await this.postMarkdown(url, `闲鱼【${keyword}】推荐商品`, msg);
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

module.exports = DingDingNotifier;

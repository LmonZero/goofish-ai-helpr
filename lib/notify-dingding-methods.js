// const tools = require('@/shared/utils');
const axios = require('axios')

class NotifyDingDing {
    constructor() {
        this.sendTest = 0; //1：发到测试群，0：正式执行  
        //QPS限制
        this.QPSQuene = []
    }

    async init() { }

    async postToDingdingMarkdown(url = '', title, test, users) {
        let data = {
            msgtype: "markdown",
            markdown: {
                title: title,
                text: test
            },
            at: {
                atMobiles: users,
                // "atUserIds": [
                //     "user123"
                // ],
                isAtAll: false
            }
        }
        let headers = { 'Content-Type': 'application/json' };
        // await axios.post(url, JSON.stringify(data), { headers: headers }).then((val) => {
        //     console.log('send dingding ok\n', data.markdown.text)
        //     console.log('dinding res:', val.data)
        // });
        this.QPSQuene.push([url, JSON.stringify(data), { headers: headers }])

        if (this.QPSQuene.length > 1) {
            return
        }

        this.clearQueue()
    }

    async postToDingding(url, msg, users, updateTime) {
        try {

            let msgSend = '';

            if (msg == '' || url == '') {
                return
            }

            let dingding = []//tools.removeDingDuplicates(users)
            let atall = false
            msgSend = msg + ' \n\n';
            // msgSend = getUpdateTime(msgSend)
            msgSend += updateTime ? '---\n\n' + '- 消息时间：' + updateTime + '\n\n' : '\n\n'

            if (dingding.length) {
                for (let phone of dingding) {
                    msgSend += ` @${phone}`;
                }
            }

            if (users == '所有人') {
                atall = true
            }

            let data = {
                // msgtype: "text",
                // text: {
                //     content: 'HM机器人通知 - ' + msg
                // },

                msgtype: "markdown",
                markdown: {
                    title: "HM机器人通知",
                    text: msgSend
                },

                at: {
                    atMobiles: dingding,
                    isAtAll: atall
                }
            }

            let headers = { 'Content-Type': 'application/json' };

            this.QPSQuene.push([url, JSON.stringify(data), { headers: headers }])

            if (this.QPSQuene.length > 1) {
                return
            }

            this.clearQueue()

        } catch (error) {
            console.error('error happen ---', error);
        }
    }

    async delayTime(timeOut = 60) {
        return new Promise((reslove) => {
            setTimeout(() => {
                reslove()
            }, timeOut)
        })
    }

    async clearQueue() { //qps 有限制 20/s // 但毛用没有  每分钟只能发20条消息
        while (this.QPSQuene.length) { //钉钉标准版 QPS频次限制为20qps，专业版为40qps，专属版为60qps。 这样正常应该不会超
            let params = this.QPSQuene.shift()

            if (params[3] > 10) {
                console.log('dingding send fail', params)
                continue
            }
            let time = 60
            await axios.post(...params).then((val) => {
                console.log('dinding res:', val.data)

                if (val.data.errcode == '-1' && val.data.errmsg == '系统繁忙') {

                    if (!params[3]) {
                        params[3] = 0
                    }
                    params[3]++
                    this.QPSQuene.unshift(params)
                } else if (val.data.errcode == 130101 && val.data.errmsg == 'send too fast, exceed 20 times per minute') {
                    time = 30 * 1000
                    this.QPSQuene.unshift(params)
                } else {
                    console.log('send dingding ok ===>', params[1])
                }
            });

            await this.delayTime(time)
        }
    }

    postToMsg(url, msg, users) {
        try {
            let msgSend = '';
            if (msg == '' || url == '') {
                return
            }

            let dingding = []// tools.removeDingDuplicates(users)

            msgSend = msg + ' \n\n';
            if (dingding) {
                for (let phone of dingding) {
                    msgSend += ` @${phone}`;
                }
            }
            let data = {
                msgtype: "markdown",
                markdown: {
                    title: "HM机器人通知",
                    text: msgSend
                },
                at: {
                    atMobiles: dingding,
                    isAtAll: false
                }
            }
            let headers = { 'Content-Type': 'application/json' };
            axios.post(url, JSON.stringify(data), { headers: headers });
        } catch (error) {
            console.error('error happen ---', error);
        }
    }


}
module.exports = new NotifyDingDing()
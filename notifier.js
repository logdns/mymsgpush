const fetch = require('node-fetch');
const db = require('./db');

function getChannelConfig(channelType) {
    const ch = db.get('SELECT * FROM notify_channels WHERE channel_type = ? AND enabled = 1', [channelType]);
    if (!ch) return null;
    try { return JSON.parse(ch.config); } catch { return null; }
}

function buildMessage(reminder) {
    const displayTime = new Date(reminder.remind_time);
    const cycleText = { 'once': '单次提醒', 'weekly': '每周循环', 'monthly': '每月循环', 'yearly': '每年循环' }[reminder.cycle_type] || '单次提醒';
    const linkText = reminder.link ? `\n\n🔗 链接：${reminder.link}` : '';
    return `🔔 提醒：${reminder.title}\n\n${reminder.content}\n\n⏰ 提醒时间：${displayTime.toLocaleString('zh-CN')}\n\n📅 循环类型：${cycleText}${linkText}`;
}

// 发送到单个渠道（用于测试）
async function sendSingleChannel(channelType, config, reminder) {
    const msgBody = buildMessage(reminder);

    try {
        switch (channelType) {
            case 'telegram': {
                if (!config.bot_token || !config.chat_id) return { success: false, error: '缺少 Bot Token 或 Chat ID' };
                const resp = await fetch(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: config.chat_id, text: msgBody })
                });
                const r = await resp.json();
                return { success: r.ok === true, result: r, error: r.ok ? null : (r.description || '发送失败') };
            }
            case 'wecom': {
                if (!config.webhook_url) return { success: false, error: '缺少 Webhook URL' };
                const resp = await fetch(config.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ msgtype: 'text', text: { content: msgBody } })
                });
                const r = await resp.json();
                return { success: r.errcode === 0, result: r, error: r.errcode === 0 ? null : (r.errmsg || '发送失败') };
            }
            case 'bark': {
                if (!config.key) return { success: false, error: '缺少 Bark Key' };
                const pushUrl = config.push_url || 'https://push.2sb.org';
                const title = `🔔 提醒：${reminder.title}`;
                const body = `${reminder.content}\n⏰ ${new Date(reminder.remind_time).toLocaleString('zh-CN')}`;
                const resp = await fetch(`${pushUrl}/${config.key}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
                const r = await resp.json();
                return { success: resp.ok, result: r, error: resp.ok ? null : '发送失败' };
            }
            case 'feishu': {
                if (!config.webhook_url) return { success: false, error: '缺少 Webhook URL' };
                const resp = await fetch(config.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ msg_type: 'text', content: { text: msgBody } })
                });
                const r = await resp.json();
                return { success: r.code === 0 || resp.ok, result: r, error: (r.code === 0 || resp.ok) ? null : (r.msg || '发送失败') };
            }
            case 'dingtalk': {
                if (!config.webhook_url) return { success: false, error: '缺少 Webhook URL' };
                const resp = await fetch(config.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ msgtype: 'text', text: { content: msgBody } })
                });
                const r = await resp.json();
                return { success: r.errcode === 0, result: r, error: r.errcode === 0 ? null : (r.errmsg || '发送失败') };
            }
            case 'custom_webhook': {
                if (!config.webhook_url) return { success: false, error: '缺少 Webhook URL' };
                const method = (config.method || 'POST').toUpperCase();
                const contentType = config.content_type || 'application/json';
                const bodyTemplate = config.body_template || '{"text": "{{message}}"}';
                const bodyStr = bodyTemplate.replace(/\{\{message\}\}/g, msgBody.replace(/"/g, '\\"').replace(/\n/g, '\\n'));
                const fetchOpts = { method, headers: { 'Content-Type': contentType } };
                if (method !== 'GET') fetchOpts.body = bodyStr;
                const resp = await fetch(config.webhook_url, fetchOpts);
                let r;
                try { r = await resp.json(); } catch { r = { status: resp.status }; }
                return { success: resp.ok, result: r, error: resp.ok ? null : `HTTP ${resp.status}` };
            }
            default:
                return { success: false, error: '未知渠道类型' };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 发送到所有已启用渠道
async function sendNotifications(reminder) {
    const results = [];
    const channels = ['telegram', 'wecom', 'bark', 'feishu', 'dingtalk', 'custom_webhook'];

    for (const channelType of channels) {
        const config = getChannelConfig(channelType);
        if (!config) continue;

        const result = await sendSingleChannel(channelType, config, reminder);
        results.push({ platform: channelType, ...result });
    }

    return results;
}

module.exports = { sendNotifications, sendSingleChannel };

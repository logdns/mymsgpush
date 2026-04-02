const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendNotifications } = require('../notifier');

function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) return res.status(401).json({ error: '未授权' });
    const [username, password] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = db.get('SELECT * FROM admin_users WHERE username = ? AND password = ?', [username, password]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    req.adminUser = user;
    next();
}

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.get('SELECT * FROM admin_users WHERE username = ? AND password = ?', [username, password]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    res.json({ success: true, username: user.username });
});

router.get('/stats', adminAuth, (req, res) => {
    try {
        const total = db.get('SELECT COUNT(*) as count FROM reminders').count;
        const pending = db.get('SELECT COUNT(*) as count FROM reminders WHERE status = 0').count;
        const completed = db.get('SELECT COUNT(*) as count FROM reminders WHERE status = 1').count;
        const todayNotifications = db.get("SELECT COUNT(*) as count FROM notification_logs WHERE date(created_at) = date('now')").count;
        const channelStats = db.all('SELECT platform, COUNT(*) as total, SUM(success) as success FROM notification_logs GROUP BY platform');
        res.json({ reminders: { total, pending, completed }, todayNotifications, channelStats });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/reminders', adminAuth, (req, res) => {
    try {
        const { page = 1, pageSize = 20, status, cycle_type, keyword } = req.query;
        let sql = 'SELECT * FROM reminders WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as count FROM reminders WHERE 1=1';
        const p = [], cp = [];
        if (status !== undefined && status !== '') { sql += ' AND status = ?'; countSql += ' AND status = ?'; p.push(Number(status)); cp.push(Number(status)); }
        if (cycle_type) { sql += ' AND cycle_type = ?'; countSql += ' AND cycle_type = ?'; p.push(cycle_type); cp.push(cycle_type); }
        if (keyword) { sql += ' AND (title LIKE ? OR content LIKE ?)'; countSql += ' AND (title LIKE ? OR content LIKE ?)'; p.push(`%${keyword}%`, `%${keyword}%`); cp.push(`%${keyword}%`, `%${keyword}%`); }
        const total = db.get(countSql, cp).count;
        sql += ' ORDER BY remind_time DESC LIMIT ? OFFSET ?';
        p.push(Number(pageSize), (Number(page) - 1) * Number(pageSize));
        res.json({ reminders: db.all(sql, p), total, page: Number(page), pageSize: Number(pageSize) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/reminders/:id', adminAuth, (req, res) => {
    try {
        const { title, content, remind_time, cycle_type, status, link } = req.body;
        db.run('UPDATE reminders SET title = ?, content = ?, remind_time = ?, cycle_type = ?, status = ?, link = ? WHERE id = ?',
            [title, content, remind_time, cycle_type, status ?? 0, link || '', req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/reminders/:id', adminAuth, (req, res) => {
    try {
        db.run('DELETE FROM reminders WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/reminders/:id/test-notify', adminAuth, async (req, res) => {
    try {
        const reminder = db.get('SELECT * FROM reminders WHERE id = ?', [req.params.id]);
        if (!reminder) return res.status(404).json({ error: '提醒不存在' });
        const results = await sendNotifications(reminder);
        res.json({ success: true, results });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/logs', adminAuth, (req, res) => {
    try {
        const { page = 1, pageSize = 50 } = req.query;
        const total = db.get('SELECT COUNT(*) as count FROM notification_logs').count;
        const logs = db.all(
            'SELECT nl.*, r.title as reminder_title FROM notification_logs nl LEFT JOIN reminders r ON nl.reminder_id = r.id ORDER BY nl.created_at DESC LIMIT ? OFFSET ?',
            [Number(pageSize), (Number(page) - 1) * Number(pageSize)]
        );
        res.json({ logs, total, page: Number(page), pageSize: Number(pageSize) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/change-password', adminAuth, (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: '密码长度至少4位' });
        db.run('UPDATE admin_users SET password = ? WHERE id = ?', [newPassword, req.adminUser.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 前台密码管理 ==========

// GET /admin/frontend-password - 获取前台密码
router.get('/frontend-password', adminAuth, (req, res) => {
    try {
        const setting = db.get("SELECT value FROM settings WHERE key = 'frontend_password'");
        res.json({ password: setting ? setting.value : '' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /admin/frontend-password - 设置前台密码
router.put('/frontend-password', adminAuth, (req, res) => {
    try {
        const { password } = req.body;
        const existing = db.get("SELECT * FROM settings WHERE key = 'frontend_password'");
        if (existing) {
            db.run("UPDATE settings SET value = ? WHERE key = 'frontend_password'", [password || '']);
        } else {
            db.run("INSERT INTO settings (key, value) VALUES ('frontend_password', ?)", [password || '']);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== 通知渠道管理 ==========

// GET /admin/channels - 获取所有通知渠道
router.get('/channels', adminAuth, (req, res) => {
    try {
        const channels = db.all('SELECT * FROM notify_channels ORDER BY id');
        res.json(channels);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /admin/channels/:type - 更新通知渠道配置
router.put('/channels/:type', adminAuth, (req, res) => {
    try {
        const { enabled, config } = req.body;
        db.run(
            'UPDATE notify_channels SET enabled = ?, config = ?, updated_at = datetime(\'now\') WHERE channel_type = ?',
            [enabled ? 1 : 0, JSON.stringify(config), req.params.type]
        );
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /admin/channels/:type/test - 测试通知渠道
router.post('/channels/:type/test', adminAuth, async (req, res) => {
    try {
        const channelType = req.params.type;
        const { enabled, config } = req.body;

        // 先保存配置
        if (config) {
            db.run(
                "UPDATE notify_channels SET enabled = ?, config = ?, updated_at = datetime('now') WHERE channel_type = ?",
                [enabled ? 1 : 0, JSON.stringify(config), channelType]
            );
        }

        // 检查渠道是否启用且配置完整
        const channel = db.get('SELECT * FROM notify_channels WHERE channel_type = ? AND enabled = 1', [channelType]);
        if (!channel) {
            return res.json({ success: false, error: '请先启用该渠道并保存配置' });
        }

        let channelConfig;
        try { channelConfig = JSON.parse(channel.config); } catch { channelConfig = {}; }

        // 检查配置是否有值
        const hasValues = Object.values(channelConfig).some(v => v && v.trim && v.trim().length > 0);
        if (!hasValues) {
            return res.json({ success: false, error: '请先填写渠道配置信息' });
        }

        // 直接调用对应渠道的发送
        const { sendSingleChannel } = require('../notifier');
        const testReminder = {
            title: '🧪 测试通知',
            content: '这是一条测试消息，收到说明通知渠道配置正确！✅',
            remind_time: new Date().toISOString(),
            cycle_type: 'once',
            link: ''
        };
        const result = await sendSingleChannel(channelType, channelConfig, testReminder);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

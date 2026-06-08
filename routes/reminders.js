const express = require('express');
const router = express.Router();
const db = require('../db');
const { hasValidFrontendAuth } = require('./frontendAuth');
const { verifyPassword } = require('../security');

const VALID_CYCLE_TYPES = new Set(['once', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']);

function hasAdminAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    const decodedAuth = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const separatorIndex = decodedAuth.indexOf(':');
    const username = separatorIndex >= 0 ? decodedAuth.slice(0, separatorIndex) : decodedAuth;
    const password = separatorIndex >= 0 ? decodedAuth.slice(separatorIndex + 1) : '';
    const user = db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    return Boolean(user && verifyPassword(password, user.password));
}

function reminderAuth(req, res, next) {
    if (hasAdminAuth(req) || hasValidFrontendAuth(req)) return next();
    return res.status(401).json({ error: '未授权' });
}

function createReminderId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueReminderId(preferredId = '') {
    let id = String(preferredId || '').trim() || createReminderId();
    while (db.get('SELECT id FROM reminders WHERE id = ?', [id])) id = createReminderId();
    return id;
}

function normalizeStatus(value) {
    return Number(value) === 1 ? 1 : 0;
}

router.use(reminderAuth);

// GET /api/reminders - 获取所有提醒
router.get('/', (req, res) => {
    try {
        const reminders = db.all('SELECT * FROM reminders ORDER BY remind_time ASC');
        res.json(reminders);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/reminders - 添加新提醒
router.post('/', (req, res) => {
    try {
        const reminder = req.body;
        const title = String(reminder.title || '').trim();
        const content = String(reminder.content || '').trim();
        const remindTime = String(reminder.remind_time || '').trim();
        const cycleType = String(reminder.cycle_type || '').trim();
        if (!title || !content || !remindTime || !VALID_CYCLE_TYPES.has(cycleType) || Number.isNaN(new Date(remindTime).getTime())) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        db.run(
            'INSERT INTO reminders (id, title, content, remind_time, cycle_type, status, link) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uniqueReminderId(reminder.id), title, content, remindTime, cycleType, normalizeStatus(reminder.status), String(reminder.link || '').trim()]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/reminders/:id - 删除提醒
router.delete('/:id', (req, res) => {
    try {
        db.run('DELETE FROM reminders WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Reminder deleted successfully' });
    } catch (error) {
        console.error('Error during deletion:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/reminders/:id - 更新提醒
router.put('/:id', (req, res) => {
    try {
        const { title, content, remind_time, cycle_type, status, link } = req.body;
        if (!title || !content || !remind_time || !VALID_CYCLE_TYPES.has(cycle_type) || Number.isNaN(new Date(remind_time).getTime())) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        db.run(
            'UPDATE reminders SET title = ?, content = ?, remind_time = ?, cycle_type = ?, status = ?, link = ? WHERE id = ?',
            [String(title).trim(), String(content).trim(), remind_time, cycle_type, normalizeStatus(status), String(link || '').trim(), req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

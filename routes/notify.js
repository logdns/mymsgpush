const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendNotifications } = require('../notifier');

// POST /api/notify/trigger - 手动触发通知检查
router.post('/trigger', async (req, res) => {
    try {
        const now = new Date();
        const reminders = db.all(
            'SELECT * FROM reminders WHERE status = 0 AND datetime(remind_time) <= datetime(?)',
            [now.toISOString()]
        );

        if (!reminders.length) {
            return res.json({ success: true, message: '暂无到期提醒', sent: 0 });
        }

        let sent = 0;
        for (const reminder of reminders) {
            const results = await sendNotifications(reminder);
            for (const result of results) {
                db.run(
                    'INSERT INTO notification_logs (reminder_id, platform, success, message) VALUES (?, ?, ?, ?)',
                    [reminder.id, result.platform, result.success ? 1 : 0, JSON.stringify(result.result || result.error || '')]
                );
            }
            if (reminder.cycle_type === 'once') {
                db.run('UPDATE reminders SET status = 1 WHERE id = ?', [reminder.id]);
            }
            sent++;
        }

        res.json({ success: true, message: `已处理 ${sent} 条提醒`, sent });
    } catch (error) {
        console.error('Notification trigger error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

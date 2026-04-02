const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendNotifications } = require('../notifier');

// GET /api/notify?key=xxx&id=xxx
router.get('/', async (req, res) => {
    const { key, id: reminderId } = req.query;
    if (!reminderId) {
        return res.json({ status: 'ok', message: 'Notification endpoint is working' });
    }
    if (!key || key !== process.env.CRON_SECRET) {
        return res.status(401).send('Unauthorized');
    }
    try {
        const reminder = db.get('SELECT * FROM reminders WHERE id = ? AND status = 0', [reminderId]);
        if (!reminder) {
            return res.status(404).send('Reminder not found or already processed');
        }
        const results = await sendNotifications(reminder);
        for (const result of results) {
            db.run(
                'INSERT INTO notification_logs (reminder_id, platform, success, message) VALUES (?, ?, ?, ?)',
                [reminderId, result.platform, result.success ? 1 : 0, JSON.stringify(result.result || result.error || '')]
            );
        }
        db.run('UPDATE reminders SET status = 1 WHERE id = ?', [reminderId]);
        if (reminder.cycle_type !== 'once') {
            const nextTime = calculateNextTime(reminder.remind_time, reminder.cycle_type);
            if (nextTime) {
                db.run('UPDATE reminders SET status = 0, remind_time = ? WHERE id = ?', [nextTime.toISOString(), reminderId]);
            }
        }
        res.json({ success: true, notifications: results });
    } catch (error) {
        console.error('Notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function calculateNextTime(currentTimeStr, cycleType) {
    const date = new Date(currentTimeStr);
    switch (cycleType) {
        case 'weekly': return new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
        case 'monthly': { const n = new Date(date); n.setMonth(n.getMonth() + 1); if (n.getDate() !== date.getDate()) n.setDate(0); return n; }
        case 'yearly': { const n = new Date(date); n.setFullYear(n.getFullYear() + 1); return n; }
        default: return null;
    }
}

module.exports = router;

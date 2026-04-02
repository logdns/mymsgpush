const express = require('express');
const router = express.Router();
const db = require('../db');

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
        if (!reminder.title || !reminder.content || !reminder.remind_time || !reminder.cycle_type) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        db.run(
            'INSERT INTO reminders (id, title, content, remind_time, cycle_type, status, link) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [reminder.id || Date.now().toString(), reminder.title, reminder.content, reminder.remind_time, reminder.cycle_type, 0, reminder.link || '']
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
        db.run(
            'UPDATE reminders SET title = ?, content = ?, remind_time = ?, cycle_type = ?, status = ?, link = ? WHERE id = ?',
            [title, content, remind_time, cycle_type, status ?? 0, link || '', req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

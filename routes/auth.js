const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/verify-password
router.post('/', (req, res) => {
    try {
        const { password } = req.body;
        const setting = db.get("SELECT value FROM settings WHERE key = 'frontend_password'");
        const correctPassword = setting ? setting.value : '';

        // 如果没设置密码（空字符串），直接通过
        if (!correctPassword) {
            return res.json({ success: true });
        }

        if (password === correctPassword) {
            return res.json({ success: true });
        }

        return res.status(401).json({ success: false });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid request' });
    }
});

module.exports = router;

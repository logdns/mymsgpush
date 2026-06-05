const express = require('express');
const router = express.Router();
const { clearFrontendAuthCookie, getFrontendPassword, hasValidFrontendAuth, setFrontendAuthCookie } = require('./frontendAuth');

// POST /api/verify-password
router.post('/', (req, res) => {
    try {
        const { password } = req.body;
        const correctPassword = getFrontendPassword();

        // 如果没设置密码（空字符串），直接通过
        if (!correctPassword) {
            clearFrontendAuthCookie(res);
            return res.json({ success: true });
        }

        if (password === correctPassword) {
            setFrontendAuthCookie(res, correctPassword);
            return res.json({ success: true });
        }

        clearFrontendAuthCookie(res);
        return res.status(401).json({ success: false });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid request' });
    }
});

router.get('/status', (req, res) => {
    try {
        const protectedEnabled = Boolean(getFrontendPassword());
        res.json({
            protected: protectedEnabled,
            authenticated: !protectedEnabled || hasValidFrontendAuth(req)
        });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid request' });
    }
});

module.exports = router;

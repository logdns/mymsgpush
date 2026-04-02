const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

async function startServer() {
    await initDB();

    const remindersRouter = require('./routes/reminders');
    const notifyRouter = require('./routes/notify');
    const authRouter = require('./routes/auth');
    const adminRouter = require('./routes/admin');
    const scheduler = require('./scheduler');

    const app = express();
    const PORT = process.env.PORT || 3009;

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));

    // API 路由
    app.use('/api/reminders', remindersRouter);
    app.use('/api/notify', notifyRouter);
    app.use('/api/verify-password', authRouter);
    app.use('/admin', adminRouter);

    // 根路径 → 前台（有密码保护）
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.listen(PORT, () => {
        console.log(`\n🚀 懒人备忘提醒推送系统已启动`);
        console.log(`📍 前台: http://localhost:${PORT}`);
        console.log(`📍 后台: http://localhost:${PORT}/admin.html\n`);
        scheduler.start();
    });
}

startServer().catch(err => { console.error('启动失败:', err); process.exit(1); });

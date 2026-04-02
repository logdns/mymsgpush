const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'reminders.db');
let db = null;

function saveToDisk() {
    if (db) {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    }
}

async function initDB() {
    const SQL = await initSqlJs();

    if (fs.existsSync(dbPath)) {
        db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            remind_time TEXT NOT NULL,
            cycle_type TEXT NOT NULL DEFAULT 'once',
            status INTEGER DEFAULT 0,
            link TEXT,
            cron_job_id INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS notification_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reminder_id TEXT,
            platform TEXT,
            success INTEGER,
            message TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // 通知渠道配置表
    db.run(`
        CREATE TABLE IF NOT EXISTS notify_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_type TEXT UNIQUE NOT NULL,
            channel_name TEXT NOT NULL,
            enabled INTEGER DEFAULT 0,
            config TEXT DEFAULT '{}',
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);

    // 初始化默认通知渠道
    const channelCount = get('SELECT COUNT(*) as count FROM notify_channels');
    if (channelCount.count === 0) {
        const defaultChannels = [
            ['telegram', 'Telegram', '{"bot_token":"","chat_id":""}'],
            ['wecom', '企业微信', '{"webhook_url":""}'],
            ['bark', 'Bark推送', '{"push_url":"https://push.2sb.org","key":""}'],
            ['feishu', '飞书', '{"webhook_url":""}'],
            ['dingtalk', '钉钉', '{"webhook_url":""}'],
            ['custom_webhook', '自定义Webhook', '{"webhook_url":"","method":"POST","content_type":"application/json","body_template":"{\\"text\\": \\"{{message}}\\"}"}']
        ];
        for (const [type, name, config] of defaultChannels) {
            db.run('INSERT INTO notify_channels (channel_type, channel_name, enabled, config) VALUES (?, ?, 0, ?)', [type, name, config]);
        }
        console.log('📡 默认通知渠道已初始化');
    }

    // 系统设置表
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // 初始化默认设置
    const frontPwd = get("SELECT * FROM settings WHERE key = 'frontend_password'");
    if (!frontPwd) {
        db.run("INSERT INTO settings (key, value) VALUES ('frontend_password', 'mjj123')");
        console.log('🔑 默认前台密码: mjj123');
    }

    // 插入默认管理员
    const adminCount = get('SELECT COUNT(*) as count FROM admin_users');
    if (adminCount.count === 0) {
        db.run('INSERT INTO admin_users (username, password) VALUES (?, ?)', ['admin', 'admin123']);
        console.log('📌 默认管理员账号: admin / admin123');
    }

    saveToDisk();
    setInterval(saveToDisk, 30000);
    return db;
}

function all(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function get(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    let result = null;
    if (stmt.step()) result = stmt.getAsObject();
    stmt.free();
    return result;
}

function run(sql, params = []) {
    db.run(sql, params);
    saveToDisk();
}

module.exports = { initDB, all, get, run, saveToDisk };

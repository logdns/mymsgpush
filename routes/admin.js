const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const router = express.Router();
const db = require('../db');
const { sendNotifications } = require('../notifier');
const { hashPassword, isHashedPassword, verifyPassword } = require('../security');

const EXPORT_TABLES = {
    reminders: ['id', 'title', 'content', 'remind_time', 'cycle_type', 'status', 'link', 'created_at'],
    admin_users: ['id', 'username', 'password', 'created_at'],
    notification_logs: ['id', 'reminder_id', 'platform', 'success', 'message', 'created_at'],
    notify_channels: ['id', 'channel_type', 'channel_name', 'enabled', 'config', 'updated_at'],
    settings: ['key', 'value']
};

const updateState = {
    running: false,
    checkedAt: null,
    current: null,
    remote: null,
    currentVersion: null,
    remoteVersion: null,
    hasUpdate: false,
    localDirty: false,
    logs: [],
    lastError: null
};

const repoRoot = path.join(__dirname, '..');

function getSetting(key, defaultValue = '') {
    const setting = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return setting ? setting.value : defaultValue;
}

function setSetting(key, value) {
    const existing = db.get('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing) db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
    else db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

function createExportPayload() {
    const payload = {
        version: 1,
        exported_at: new Date().toISOString(),
        app: 'mymsgpush',
        tables: {}
    };

    for (const table of Object.keys(EXPORT_TABLES)) {
        payload.tables[table] = db.all(`SELECT * FROM ${table}`);
    }

    return payload;
}

function importBackupPayload(data, mode = 'merge', fallbackUser = null) {
    const tables = data && data.tables ? data.tables : data;
    if (!tables || typeof tables !== 'object') {
        const error = new Error('备份文件格式不正确');
        error.status = 400;
        throw error;
    }
    if (!['merge', 'replace'].includes(mode)) {
        const error = new Error('导入模式不正确');
        error.status = 400;
        throw error;
    }

    if (mode === 'replace') {
        const deleteOrder = ['notification_logs', 'reminders', 'notify_channels', 'settings', 'admin_users'];
        for (const table of deleteOrder) {
            if (Array.isArray(tables[table])) db.run(`DELETE FROM ${table}`);
        }
    }

    const imported = {};
    for (const table of Object.keys(EXPORT_TABLES)) {
        imported[table] = insertRows(table, Array.isArray(tables[table]) ? tables[table] : []);
    }

    const adminCount = db.get('SELECT COUNT(*) as count FROM admin_users').count;
    if (adminCount === 0 && fallbackUser) {
        db.run('INSERT INTO admin_users (username, password) VALUES (?, ?)', [fallbackUser.username, hashPassword(fallbackUser.password)]);
        imported.admin_users = 1;
    }

    return imported;
}

function pushUpdateLog(message) {
    const line = `[${new Date().toLocaleString('zh-CN')}] ${message}`;
    updateState.logs.push(line);
    if (updateState.logs.length > 300) updateState.logs.shift();
}

function pickAllowed(row, columns) {
    const picked = {};
    for (const column of columns) {
        if (Object.prototype.hasOwnProperty.call(row, column)) picked[column] = row[column];
    }
    return picked;
}

function insertRows(table, rows) {
    const columns = EXPORT_TABLES[table];
    let count = 0;

    for (const row of rows || []) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const data = pickAllowed(row, columns);
        const keys = Object.keys(data);
        if (!keys.length) continue;

        const placeholders = keys.map(() => '?').join(', ');
        db.run(
            `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
            keys.map(key => data[key])
        );
        count++;
    }

    return count;
}

function buildLogFilters(source = {}) {
    const filters = {
        keyword: typeof source.keyword === 'string' ? source.keyword.trim() : '',
        platform: typeof source.platform === 'string' ? source.platform.trim() : '',
        success: source.success === undefined || source.success === null ? '' : String(source.success),
        date_from: typeof source.date_from === 'string' ? source.date_from.trim() : '',
        date_to: typeof source.date_to === 'string' ? source.date_to.trim() : ''
    };
    const where = [];
    const params = [];

    if (filters.keyword) {
        where.push('(r.title LIKE ? OR nl.platform LIKE ? OR nl.message LIKE ?)');
        params.push(`%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`);
    }
    if (filters.platform) {
        where.push('nl.platform = ?');
        params.push(filters.platform);
    }
    if (filters.success !== '') {
        where.push('nl.success = ?');
        params.push(Number(filters.success) ? 1 : 0);
    }
    if (filters.date_from) {
        where.push('datetime(nl.created_at) >= datetime(?)');
        params.push(filters.date_from);
    }
    if (filters.date_to) {
        where.push('datetime(nl.created_at) <= datetime(?)');
        params.push(filters.date_to);
    }

    return { filters, whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

function parseWebdavConfig(rawValue = null) {
    try {
        const parsed = JSON.parse(rawValue || getSetting('webdav_config', '{}') || '{}');
        return {
            enabled: Boolean(parsed.enabled),
            url: parsed.url || '',
            username: parsed.username || '',
            password: parsed.password || '',
            directory: parsed.directory || 'mymsgpush',
            filename: parsed.filename || 'mymsgpush-backup.json'
        };
    } catch {
        return { enabled: false, url: '', username: '', password: '', directory: 'mymsgpush', filename: 'mymsgpush-backup.json' };
    }
}

function maskWebdavConfig(config) {
    return { ...config, password: config.password ? '********' : '' };
}

function normalizeWebdavPath(...parts) {
    return parts
        .filter(Boolean)
        .join('/')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/|\/$/g, '');
}

function buildWebdavUrl(config, relativePath = '') {
    const base = String(config.url || '').replace(/\/+$/g, '');
    const cleanedPath = normalizeWebdavPath(relativePath);
    return cleanedPath ? `${base}/${cleanedPath.split('/').map(encodeURIComponent).join('/')}` : base;
}

function webdavHeaders(config, extra = {}) {
    const headers = { ...extra };
    if (config.username || config.password) {
        headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    }
    return headers;
}

async function ensureWebdavDirectory(config) {
    const parts = normalizeWebdavPath(config.directory).split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
        current = normalizeWebdavPath(current, part);
        const resp = await fetch(buildWebdavUrl(config, current), {
            method: 'MKCOL',
            headers: webdavHeaders(config)
        });
        if (![201, 405, 301, 302].includes(resp.status)) {
            throw new Error(`创建 WebDAV 目录失败：HTTP ${resp.status}`);
        }
    }
}

function getWebdavBackupPath(config) {
    return normalizeWebdavPath(config.directory, config.filename || 'mymsgpush-backup.json');
}

function runCommand(command, args, options = {}) {
    const { logOutput = true } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: repoRoot, shell: false });
        let output = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            if (logOutput) text.split(/\r?\n/).filter(Boolean).forEach(line => pushUpdateLog(line));
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            output += text;
            if (logOutput) text.split(/\r?\n/).filter(Boolean).forEach(line => pushUpdateLog(line));
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(output.trim());
            else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
        });
    });
}

async function getGitCommit(ref) {
    const output = await runCommand('git', ['rev-parse', '--short', ref], { logOutput: false });
    return output.split(/\r?\n/).pop();
}

async function getVersionLabel(ref) {
    try {
        const tag = await runCommand('git', ['describe', '--tags', '--exact-match', ref], { logOutput: false });
        if (tag.trim()) return tag.trim();
    } catch {}

    try {
        const pkg = await runCommand('git', ['show', `${ref}:package.json`], { logOutput: false });
        const parsed = JSON.parse(pkg);
        if (parsed.version) return `v${parsed.version}`;
    } catch {}

    return getGitCommit(ref);
}

async function hasLocalChanges() {
    const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], { logOutput: false });
    return status.trim().length > 0;
}

async function stashLocalChangesIfNeeded() {
    if (!(await hasLocalChanges())) return false;

    const stashName = `mymsgpush-auto-update-backup-${new Date().toISOString()}`;
    pushUpdateLog('检测到本地文件改动，先备份到 Git stash 后继续更新。');
    await runCommand('git', ['stash', 'push', '--include-untracked', '-m', stashName, '--', '.', ':(exclude)data']);
    pushUpdateLog(`本地改动已备份：${stashName}`);
    return true;
}

async function getRemoteRef() {
    try {
        await runCommand('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { logOutput: false });
        return '@{u}';
    } catch {
        const branch = (await runCommand('git', ['branch', '--show-current'], { logOutput: false })).trim() || 'main';
        try {
            await runCommand('git', ['rev-parse', '--verify', `origin/${branch}`], { logOutput: false });
            return `origin/${branch}`;
        } catch {
            return 'origin/main';
        }
    }
}

async function getRemoteSummary() {
    updateState.logs = [];
    pushUpdateLog('开始检查远端版本...');
    await runCommand('git', ['fetch', '--tags', '--prune']);

    const remoteRef = await getRemoteRef();
    const current = await getGitCommit('HEAD');
    const remote = await getGitCommit(remoteRef);
    const currentVersion = await getVersionLabel('HEAD');
    const remoteVersion = await getVersionLabel(remoteRef);
    const localDirty = await hasLocalChanges();
    let changelog = '';
    try {
        changelog = await runCommand('git', ['log', '--oneline', '--decorate', `HEAD..${remoteRef}`]);
    } catch {
        changelog = '';
    }

    updateState.checkedAt = new Date().toISOString();
    updateState.current = current;
    updateState.remote = remote;
    updateState.currentVersion = currentVersion;
    updateState.remoteVersion = remoteVersion;
    updateState.hasUpdate = current !== remote;
    updateState.localDirty = localDirty;
    updateState.lastError = null;
    if (localDirty) pushUpdateLog('检测到本地文件改动，点击更新时会先自动备份到 Git stash。');
    pushUpdateLog(updateState.hasUpdate ? `发现新版本：${currentVersion} (${current}) -> ${remoteVersion} (${remote})` : '当前已经是最新版本');

    return { current, remote, currentVersion, remoteVersion, hasUpdate: updateState.hasUpdate, localDirty, changelog };
}

function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) return res.status(401).json({ error: '未授权' });
    const decodedAuth = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const separatorIndex = decodedAuth.indexOf(':');
    const username = separatorIndex >= 0 ? decodedAuth.slice(0, separatorIndex) : decodedAuth;
    const password = separatorIndex >= 0 ? decodedAuth.slice(separatorIndex + 1) : '';
    const user = db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: '用户名或密码错误' });
    if (!isHashedPassword(user.password)) {
        const migratedPassword = hashPassword(password);
        db.run('UPDATE admin_users SET password = ? WHERE id = ?', [migratedPassword, user.id]);
        user.password = migratedPassword;
    }
    req.adminUser = user;
    req.adminPassword = password;
    next();
}

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: '用户名或密码错误' });
    if (!isHashedPassword(user.password)) {
        db.run('UPDATE admin_users SET password = ? WHERE id = ?', [hashPassword(password), user.id]);
    }
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
        const { whereSql, params } = buildLogFilters(req.query);
        const total = db.get(
            `SELECT COUNT(*) as count FROM notification_logs nl LEFT JOIN reminders r ON nl.reminder_id = r.id${whereSql}`,
            params
        ).count;
        const logs = db.all(
            `SELECT nl.*, r.title as reminder_title FROM notification_logs nl LEFT JOIN reminders r ON nl.reminder_id = r.id${whereSql} ORDER BY nl.created_at DESC LIMIT ? OFFSET ?`,
            [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)]
        );
        res.json({ logs, total, page: Number(page), pageSize: Number(pageSize) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/logs/:id', adminAuth, (req, res) => {
    try {
        db.run('DELETE FROM notification_logs WHERE id = ?', [Number(req.params.id)]);
        res.json({ success: true, deleted: 1 });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/logs/delete', adminAuth, (req, res) => {
    try {
        const { mode, ids = [], filters = {} } = req.body;

        if (mode === 'selected') {
            const selectedIds = ids.map(Number).filter(Number.isFinite);
            if (!selectedIds.length) return res.status(400).json({ error: '请选择要删除的日志' });

            const placeholders = selectedIds.map(() => '?').join(', ');
            db.run(`DELETE FROM notification_logs WHERE id IN (${placeholders})`, selectedIds);
            return res.json({ success: true, deleted: selectedIds.length });
        }

        if (mode === 'filtered') {
            const { whereSql, params } = buildLogFilters(filters);
            if (!whereSql) return res.status(400).json({ error: '请先设置筛选条件，避免误删全部日志' });

            const total = db.get(
                `SELECT COUNT(*) as count FROM notification_logs nl LEFT JOIN reminders r ON nl.reminder_id = r.id${whereSql}`,
                params
            ).count;
            db.run(`DELETE FROM notification_logs WHERE id IN (SELECT nl.id FROM notification_logs nl LEFT JOIN reminders r ON nl.reminder_id = r.id${whereSql})`, params);
            return res.json({ success: true, deleted: total });
        }

        if (mode === 'all') {
            const total = db.get('SELECT COUNT(*) as count FROM notification_logs').count;
            db.run('DELETE FROM notification_logs');
            return res.json({ success: true, deleted: total });
        }

        return res.status(400).json({ error: '删除模式不正确' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/data/export', adminAuth, (req, res) => {
    try {
        const payload = createExportPayload();
        const filename = `mymsgpush-backup-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(payload);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/data/import', adminAuth, (req, res) => {
    try {
        const { mode = 'merge', data } = req.body;
        const imported = importBackupPayload(data, mode, { username: req.adminUser.username, password: req.adminPassword });
        res.json({ success: true, mode, imported });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

router.get('/webdav', adminAuth, (req, res) => {
    try {
        res.json(maskWebdavConfig(parseWebdavConfig()));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/webdav', adminAuth, (req, res) => {
    try {
        const oldConfig = parseWebdavConfig();
        const incoming = req.body || {};
        const config = {
            enabled: Boolean(incoming.enabled),
            url: String(incoming.url || '').trim(),
            username: String(incoming.username || '').trim(),
            password: incoming.password === '********' || incoming.password === undefined ? oldConfig.password : String(incoming.password || ''),
            directory: String(incoming.directory || 'mymsgpush').trim() || 'mymsgpush',
            filename: String(incoming.filename || 'mymsgpush-backup.json').trim() || 'mymsgpush-backup.json'
        };

        if (config.enabled && !config.url) return res.status(400).json({ error: '请填写 WebDAV 地址' });
        setSetting('webdav_config', JSON.stringify(config));
        res.json({ success: true, config: maskWebdavConfig(config) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/webdav/test', adminAuth, async (req, res) => {
    try {
        const config = parseWebdavConfig();
        if (!config.url) return res.status(400).json({ error: '请先保存 WebDAV 地址' });

        await ensureWebdavDirectory(config);
        const resp = await fetch(buildWebdavUrl(config, normalizeWebdavPath(config.directory)), {
            method: 'PROPFIND',
            headers: webdavHeaders(config, { Depth: '0' })
        });
        if (![200, 207].includes(resp.status)) return res.status(400).json({ error: `WebDAV 连接失败：HTTP ${resp.status}` });
        res.json({ success: true, message: 'WebDAV 连接正常' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/webdav/backup', adminAuth, async (req, res) => {
    try {
        const config = parseWebdavConfig();
        if (!config.enabled) return res.status(400).json({ error: '请先启用 WebDAV 备份' });
        if (!config.url) return res.status(400).json({ error: '请先保存 WebDAV 地址' });

        await ensureWebdavDirectory(config);
        const payload = createExportPayload();
        const body = JSON.stringify(payload, null, 2);
        const remotePath = getWebdavBackupPath(config);
        const resp = await fetch(buildWebdavUrl(config, remotePath), {
            method: 'PUT',
            headers: webdavHeaders(config, { 'Content-Type': 'application/json; charset=utf-8' }),
            body
        });

        if (![200, 201, 204].includes(resp.status)) return res.status(400).json({ error: `WebDAV 备份失败：HTTP ${resp.status}` });
        setSetting('webdav_last_backup_at', new Date().toISOString());
        res.json({ success: true, remotePath, bytes: Buffer.byteLength(body) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/webdav/restore', adminAuth, async (req, res) => {
    try {
        const { mode = 'merge' } = req.body || {};
        const config = parseWebdavConfig();
        if (!config.url) return res.status(400).json({ error: '请先保存 WebDAV 地址' });

        const remotePath = getWebdavBackupPath(config);
        const resp = await fetch(buildWebdavUrl(config, remotePath), {
            method: 'GET',
            headers: webdavHeaders(config)
        });
        if (resp.status !== 200) return res.status(400).json({ error: `读取 WebDAV 备份失败：HTTP ${resp.status}` });

        const data = await resp.json();
        const imported = importBackupPayload(data, mode, { username: req.adminUser.username, password: req.adminPassword });
        setSetting('webdav_last_restore_at', new Date().toISOString());
        res.json({ success: true, mode, remotePath, imported });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

router.put('/change-password', adminAuth, (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!verifyPassword(currentPassword || '', req.adminUser.password)) return res.status(400).json({ error: '当前密码错误' });
        if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: '密码长度至少8位' });
        db.run('UPDATE admin_users SET password = ? WHERE id = ?', [hashPassword(newPassword), req.adminUser.id]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/security', adminAuth, (req, res) => {
    try {
        const frontendPassword = db.get("SELECT value FROM settings WHERE key = 'frontend_password'");
        res.json({
            username: req.adminUser.username,
            passwordHashed: isHashedPassword(req.adminUser.password),
            frontendPasswordEnabled: Boolean(frontendPassword && frontendPassword.value),
            defaultsChanged: req.adminUser.username !== 'admin'
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/profile', adminAuth, (req, res) => {
    try {
        const { username, currentPassword } = req.body;
        if (!verifyPassword(currentPassword || '', req.adminUser.password)) return res.status(400).json({ error: '当前密码错误' });
        if (!username || username.length < 3) return res.status(400).json({ error: '用户名至少3位' });

        const existing = db.get('SELECT id FROM admin_users WHERE username = ? AND id <> ?', [username, req.adminUser.id]);
        if (existing) return res.status(409).json({ error: '用户名已存在' });

        db.run('UPDATE admin_users SET username = ? WHERE id = ?', [username, req.adminUser.id]);
        res.json({ success: true, username });
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

router.get('/update/check', adminAuth, async (req, res) => {
    try {
        if (!fs.existsSync(path.join(repoRoot, '.git'))) {
            return res.status(400).json({ error: '当前目录不是 Git 仓库，无法在线更新' });
        }

        const result = await getRemoteSummary();
        res.json({ success: true, ...result, checkedAt: updateState.checkedAt, logs: updateState.logs });
    } catch (error) {
        updateState.lastError = error.message;
        pushUpdateLog(`检查失败：${error.message}`);
        res.status(500).json({ error: error.message, logs: updateState.logs });
    }
});

router.post('/update/start', adminAuth, async (req, res) => {
    if (updateState.running) return res.status(409).json({ error: '已有更新任务正在运行' });
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        return res.status(400).json({ error: '当前目录不是 Git 仓库，无法在线更新' });
    }

    updateState.running = true;
    updateState.lastError = null;
    updateState.logs = [];
    pushUpdateLog('开始更新...');
    res.json({ success: true });

    (async () => {
        try {
            await runCommand('git', ['fetch', '--tags', '--prune']);
            const remoteRef = await getRemoteRef();
            updateState.current = await getGitCommit('HEAD');
            updateState.remote = await getGitCommit(remoteRef);
            updateState.currentVersion = await getVersionLabel('HEAD');
            updateState.remoteVersion = await getVersionLabel(remoteRef);
            updateState.localDirty = await hasLocalChanges();

            if (updateState.current === updateState.remote) {
                updateState.hasUpdate = false;
                pushUpdateLog('当前已经是最新版本，无需更新。');
                return;
            }

            const oldLock = fs.existsSync(path.join(repoRoot, 'package-lock.json'))
                ? fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')
                : '';

            await stashLocalChangesIfNeeded();

            pushUpdateLog(`执行 git pull：${updateState.currentVersion} (${updateState.current}) -> ${updateState.remoteVersion} (${updateState.remote})`);
            if (remoteRef.startsWith('origin/')) {
                await runCommand('git', ['pull', '--ff-only', 'origin', remoteRef.replace('origin/', '')]);
            } else {
                await runCommand('git', ['pull', '--ff-only']);
            }

            const newLock = fs.existsSync(path.join(repoRoot, 'package-lock.json'))
                ? fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')
                : '';

            if (oldLock !== newLock) {
                pushUpdateLog('检测到依赖文件变化，执行 npm install --omit=dev...');
                await runCommand('npm', ['install', '--omit=dev']);
            }

            updateState.current = await getGitCommit('HEAD');
            updateState.currentVersion = await getVersionLabel('HEAD');
            updateState.localDirty = await hasLocalChanges();
            updateState.hasUpdate = false;
            pushUpdateLog('更新完成。若服务端代码已变化，请重启 Node/PM2 进程让新后端代码生效。');
        } catch (error) {
            updateState.lastError = error.message;
            pushUpdateLog(`更新失败：${error.message}`);
        } finally {
            updateState.running = false;
        }
    })();
});

router.get('/update/status', adminAuth, (req, res) => {
    res.json({
        success: true,
        running: updateState.running,
        checkedAt: updateState.checkedAt,
        current: updateState.current,
        remote: updateState.remote,
        currentVersion: updateState.currentVersion,
        remoteVersion: updateState.remoteVersion,
        hasUpdate: updateState.hasUpdate,
        localDirty: updateState.localDirty,
        logs: updateState.logs,
        lastError: updateState.lastError
    });
});

module.exports = router;

const crypto = require('crypto');
const db = require('../db');

const COOKIE_NAME = 'frontend_auth';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SECRET = process.env.FRONTEND_AUTH_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function getFrontendPassword() {
    const setting = db.get("SELECT value FROM settings WHERE key = 'frontend_password'");
    return setting ? setting.value : '';
}

function parseCookies(req) {
    return String(req.headers.cookie || '')
        .split(';')
        .map(cookie => cookie.trim())
        .filter(Boolean)
        .reduce((cookies, cookie) => {
            const separatorIndex = cookie.indexOf('=');
            if (separatorIndex < 0) return cookies;
            const name = decodeURIComponent(cookie.slice(0, separatorIndex));
            const value = decodeURIComponent(cookie.slice(separatorIndex + 1));
            cookies[name] = value;
            return cookies;
        }, {});
}

function signToken(payload) {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function createFrontendToken(password) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const passwordFingerprint = crypto.createHash('sha256').update(String(password || '')).digest('hex');
    const payload = `${issuedAt}.${passwordFingerprint}`;
    return `${payload}.${signToken(payload)}`;
}

function verifyFrontendToken(token, password) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return false;

    const [issuedAtValue, passwordFingerprint, signature] = parts;
    const issuedAt = Number(issuedAtValue);
    if (!Number.isFinite(issuedAt)) return false;
    if (Math.floor(Date.now() / 1000) - issuedAt > MAX_AGE_SECONDS) return false;

    const expectedFingerprint = crypto.createHash('sha256').update(String(password || '')).digest('hex');
    if (passwordFingerprint !== expectedFingerprint) return false;

    const payload = `${issuedAtValue}.${passwordFingerprint}`;
    const expectedSignature = signToken(payload);
    if (signature.length !== expectedSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

function cookieOptions() {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function setFrontendAuthCookie(res, password) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(createFrontendToken(password))}; ${cookieOptions()}`);
}

function clearFrontendAuthCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function hasValidFrontendAuth(req) {
    const password = getFrontendPassword();
    if (!password) return true;
    const cookies = parseCookies(req);
    return verifyFrontendToken(cookies[COOKIE_NAME], password);
}

function frontendAuth(req, res, next) {
    if (hasValidFrontendAuth(req)) return next();
    return res.status(401).json({ error: '前台访问未授权' });
}

module.exports = {
    clearFrontendAuthCookie,
    frontendAuth,
    getFrontendPassword,
    hasValidFrontendAuth,
    setFrontendAuthCookie
};

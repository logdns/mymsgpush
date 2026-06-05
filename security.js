const crypto = require('crypto');

const PBKDF2_PREFIX = 'pbkdf2_sha256';
const ITERATIONS = 120000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
    return `${PBKDF2_PREFIX}$${ITERATIONS}$${salt}$${hash}`;
}

function isHashedPassword(value) {
    return typeof value === 'string' && value.startsWith(`${PBKDF2_PREFIX}$`);
}

function verifyPassword(password, storedPassword) {
    if (!storedPassword) return false;
    const candidate = String(password || '');

    if (!isHashedPassword(storedPassword)) {
        return candidate === storedPassword;
    }

    const parts = storedPassword.split('$');
    if (parts.length !== 4) return false;

    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = Buffer.from(parts[3], 'hex');
    const actual = crypto.pbkdf2Sync(candidate, salt, iterations, expected.length, DIGEST);

    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, isHashedPassword, verifyPassword };

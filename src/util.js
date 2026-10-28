'use strict';
const crypto = require('crypto');
const uid = p => p + '_' + crypto.randomBytes(5).toString('hex');
const now = () => Date.now();
const toPence = x => { if (x === '' || x == null) return null; if (/^\s*-/.test(String(x))) return NaN; const v = parseFloat(String(x).replace(/[^0-9.]/g, '')); return isNaN(v) ? NaN : Math.round(v * 100); };
const gbp = p => (p == null ? '' : '£' + (p % 100 ? (p / 100).toFixed(2) : String(p / 100)));
const PC = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const STREET = /\b\d{1,4}[A-Za-z]?\s+[A-Za-z' -]{2,30}\s(road|rd|street|st|lane|ln|avenue|ave|close|drive|dr|way|court|ct|gardens|crescent|place|terrace|grove|walk|row|park|mews|hill|green|square)\b/i;
const parsePostcode = t => { const m = String(t || '').match(PC); return m ? (m[1] + ' ' + m[2]).toUpperCase() : null; };
const normPostcode = t => { const s = String(t || '').replace(/\s+/g, '').toUpperCase(); return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s) ? s.slice(0, -3) + ' ' + s.slice(-3) : null; };
const normalise = t => String(t || '').toLowerCase().replace(/[^a-z0-9£' ]/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
const STOP = new Set('a an the is it are was i you we to of in on for and or me my your do does did can could would please pls hi hello hey there this that with about what when how any have has be at as so if im its u ur one ones'.split(' '));
const tokens = t => normalise(t).split(' ').filter(w => w && !STOP.has(w));
function lev(a, b) { const m = []; for (let i = 0; i <= a.length; i++) m[i] = [i]; for (let j = 1; j <= b.length; j++) m[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return m[a.length][b.length]; }
const near = (a, b) => a === b || (b.length >= 5 && Math.abs(a.length - b.length) <= 2 && lev(a, b) <= (b.length >= 8 ? 2 : 1));
const stem = w => w.length > 3 ? w.replace(/(es|s)$/, '') : w;
const sameWord = (a, b) => near(a, b) || near(stem(a), stem(b));
const redact = s => String(s || '').replace(/(access_token=)[^&\s"]+/g, '$1[redacted]').replace(/EAA[A-Za-z0-9]{10,}/g, '[redacted]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
const keyFrom = secret => crypto.createHash('sha256').update(String(secret)).digest();
function encrypt(text, secret) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv), e = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); }
function decrypt(s, secret) { const b = Buffer.from(String(s).slice(3), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
module.exports = { uid, now, toPence, gbp, PC, STREET, parsePostcode, normPostcode, normalise, tokens, lev, near, sameWord, stem, redact, encrypt, decrypt, firstName, safeEq, STOP };

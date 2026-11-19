// Passwords, sessions, TOTP and passkeys.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../lib/http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'gnito_sid';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(want, got);
}

// A fixed dummy hash so unknown usernames cost the same time as wrong passwords.
let DUMMY;
export async function dummyVerify(pw) { DUMMY ??= await hashPassword('x'); await verifyPassword(pw, DUMMY); }

export function passwordProblems(pw, username) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 256) return 'Password is too long.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  if (new Set(pw).size < 5) return 'Password is too repetitive.';
  return null;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + (user.session_hours || 12) * 3600_000;
  db.prepare('INSERT INTO sessions (id, user_id, created, expires, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha(token), user.id, now, expires, now, req.clientIp, String(req.headers['user-agent'] || '').slice(0, 200));
  return { token, expires };
}

export function sessionCookie(req, token, expires) {
  const secure = req.isHttps ? '; Secure' : '';
  const maxAge = token ? Math.floor((expires - Date.now()) / 1000) : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha(token));
  if (!s) return null;
  const now = Date.now();
  if (s.expires < now) { db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id); return null; }
  const u = db.prepare(`SELECT u.*, r.key AS role_key, r.name AS role_name, r.rank, r.perms
                        FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`).get(s.user_id);
  if (!u || u.status !== 'active' || u.locked) { db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id); return null; }
  if (now - s.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, s.id);
  u.perms = JSON.parse(u.perms);
  u.sessionId = s.id;
  return u;
}

export function destroySession(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
}

// ---- rate limiting (per IP, in memory) ----
const buckets = new Map();
export function rateLimit(key, perMinute) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > 60_000) { b = { start: now, n: 0 }; buckets.set(key, b); }
  if (++b.n > perMinute) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.start > 60_000) buckets.delete(k); }, 60_000).unref();

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function newTotpSecret() { return base32(crypto.randomBytes(20)); }
export function verifyTotp(secret, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const t = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(hotp(secret, t + d)), Buffer.from(code)));
}

// ---- short-lived challenges (passkeys, pending MFA logins) ----
const challenges = new Map();
export function putChallenge(value, ttlMs = 5 * 60_000) {
  const id = crypto.randomBytes(18).toString('base64url');
  challenges.set(id, { value, exp: Date.now() + ttlMs });
  return id;
}
export function takeChallenge(id) {
  const c = challenges.get(id); challenges.delete(id);
  if (!c || c.exp < Date.now()) return null;
  return c.value;
}
setInterval(() => { const now = Date.now(); for (const [k, c] of challenges) if (c.exp < now) challenges.delete(k); }, 60_000).unref();

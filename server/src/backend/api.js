// REST API routes.
import os from 'node:os';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { HttpError, send, readJson, str, int } from '../lib/http.js';
import { VERSION } from '../lib/config.js';
import { PERMISSIONS, audit, tx } from './db.js';
import {
  hashPassword, verifyPassword, dummyVerify, passwordProblems, createSession, sessionCookie, sessionUser,
  destroySession, rateLimit, newTotpSecret, verifyTotp, putChallenge, takeChallenge,
} from './auth.js';
import { registerFileRoutes, registerMachineFileRoutes } from './files.js';
import { measurable } from './runtime/procstats.js';

const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
const SEARCH_ENGINES = ['duckduckgo', 'startpage', 'brave', 'ecosia', 'bing', 'google'];

export function registerRoutes(router, ctx) {
  const { cfg, db, settings, workspaces, sampler, terminals, browserq, init } = ctx;

  // ---------- helpers ----------
  const needUser = (req) => {
    const u = req.user ?? (req.user = sessionUser(db, req));
    if (!u) throw new HttpError(401, 'Sign in required');
    return u;
  };
  const can = (u, perm) => !!u.is_owner || u.perms.includes(perm);
  const needPerm = (req, perm) => { const u = needUser(req); if (!can(u, perm)) throw new HttpError(403, 'You do not have permission to do that'); return u; };
  const log = (actor, action, target, detail, req) => audit(db, actor, action, target, detail, req?.clientIp);
  const getLimits = (userId) => {
    const r = db.prepare('SELECT * FROM limits WHERE user_id = ?').get(userId);
    return r || settings.get('limits.default', { storage_mb: 1024, ram_mb: 512, cpu_pct: 50, browser_sessions: 1, terminal_sessions: 2 });
  };
  ctx.getLimits = getLimits;
  const getUser = (id) => {
    const u = db.prepare('SELECT u.*, r.key AS role_key, r.name AS role_name, r.rank, r.perms FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(id);
    if (!u) throw new HttpError(404, 'Account not found');
    u.perms = JSON.parse(u.perms); return u;
  };
  const rankOf = (u) => (u.is_owner ? 1000 : u.rank);
  const canManage = (actor, target) => actor.id !== target.id && !target.is_owner && (actor.is_owner || rankOf(actor) > rankOf(target));
  const publicUser = (u) => ({
    id: u.id, username: u.username, role: u.role_key, roleName: u.is_owner ? 'Owner' : u.role_name, rank: rankOf(u),
    isOwner: !!u.is_owner, status: u.status, locked: !!u.locked, lockedReason: u.locked_reason, createdAt: u.created_at,
    lastLogin: u.last_login, totpEnabled: !!u.totp_enabled, sessionHours: u.session_hours, searchEngine: u.search_engine,
    perms: u.is_owner ? Object.keys(PERMISSIONS) : u.perms,
  });
  // Per-user, non-secret salt the browser uses to derive its zero-knowledge history key from the
  // account password. Generated lazily for accounts created before the feature existed.
  const encSaltB64 = (u) => {
    let s = u.enc_salt;
    if (!s) { s = crypto.randomBytes(16); db.prepare('UPDATE users SET enc_salt = ? WHERE id = ?').run(s, u.id); u.enc_salt = s; }
    return Buffer.from(s).toString('base64');
  };
  const allocation = cfg.allocation;
  const kickUser = (uid, reason) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
    terminals.terminateUser(uid, reason);
    browserq.releaseUser(uid);
  };
  // WebAuthn RP IDs must be "localhost" or a real registrable domain — never a bare IP.
  const isIpLiteral = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /:/.test(h);
  const passkeyHost = (host) => { const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); return h === 'localhost' || (!isIpLiteral(h) && h.includes('.')); };
  const rp = (req) => {
    const host = String(req.publicHost || 'localhost');
    const rpID = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!passkeyHost(host)) throw new HttpError(400, `Passkeys need a domain name or localhost — they do not work on a bare IP address (${rpID}). Open Indognito by its hostname, or set up TLS, to use passkeys.`);
    return { rpID, origin: `${req.isHttps ? 'https' : 'http'}://${host}` };
  };

  // ---------- public ----------
  router.get('/api/health', (req, res) => send(res, 200, { ok: true, version: VERSION, uptime: process.uptime() }));

  router.get('/api/setup/status', (req, res) => {
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    send(res, 200, { version: VERSION, hostname: cfg.hostname, initialized: init.done, hasOwner: users > 0, ...init.progress() });
  });
  router.post('/api/setup/init', (req, res) => { init.start(); send(res, 202, init.progress()); });

  router.post('/api/setup/owner', async (req, res) => {
    if (!init.done) throw new HttpError(409, 'Initialization has not finished yet');
    rateLimit('owner:' + req.clientIp, 10);
    const b = await readJson(req);
    const username = str(b.username, 'Username', { min: 3, max: 32, pattern: USERNAME });
    const problem = passwordProblems(b.password, username);
    if (problem) throw new HttpError(400, problem);
    const pw = await hashPassword(b.password);
    const user = tx(db, () => {
      // Only the very first account can be created this way; it becomes the single Owner.
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(409, 'This installation already has an Owner');
      const role = db.prepare("SELECT id FROM roles WHERE key = 'owner'").get();
      const id = db.prepare('INSERT INTO users (username, pw_hash, role_id, is_owner, created_at, last_login) VALUES (?, ?, ?, 1, ?, ?)')
        .run(username, pw, role.id, Date.now(), Date.now()).lastInsertRowid;
      db.prepare('INSERT INTO limits (user_id, storage_mb, ram_mb, cpu_pct, browser_sessions, terminal_sessions) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, allocation.storageMb, allocation.ramMb, allocation.cpuPercent, Math.max(2, browserq.capacity()), 4);
      return getUser(id);
    });
    workspaces.ensure(user);
    const s = createSession(db, user, req);
    log(user, 'setup.owner_created', `user:${user.id}`, null, req);
    send(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(req, s.token, s.expires) });
  });

  // ---------- authentication ----------
  const finishLogin = (req, res, user, method) => {
    db.prepare('UPDATE users SET failed_logins = 0, lock_until = NULL, last_login = ? WHERE id = ?').run(Date.now(), user.id);
    const s = createSession(db, user, req);
    log(user, 'auth.login', `user:${user.id}`, { method }, req);
    send(res, 200, { user: publicUser(getUser(user.id)) }, { 'set-cookie': sessionCookie(req, s.token, s.expires) });
  };
  const loginBlock = (u) => {
    if (u.status !== 'active') return 'This account has been disabled. Contact an administrator.';
    if (u.locked) return `This account is locked${u.locked_reason ? `: ${u.locked_reason}` : '.'}`;
    if (u.lock_until && u.lock_until > Date.now()) return `Too many failed sign-ins. Try again in ${Math.ceil((u.lock_until - Date.now()) / 60000)} minute(s).`;
    return null;
  };

  router.post('/api/auth/login', async (req, res) => {
    const b = await readJson(req);
    rateLimit('login:' + req.clientIp, 20);
    const username = str(b.username, 'Username', { max: 64 });
    const u = db.prepare('SELECT u.*, r.key AS role_key, r.name AS role_name, r.rank, r.perms FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ?').get(username);
    if (!u) { await dummyVerify(String(b.password || '')); throw new HttpError(401, 'Wrong username or password'); }
    const blocked = loginBlock(u);
    if (blocked) throw new HttpError(403, blocked);
    if (!(await verifyPassword(String(b.password || ''), u.pw_hash))) {
      const n = u.failed_logins + 1;
      db.prepare('UPDATE users SET failed_logins = ?, lock_until = ? WHERE id = ?').run(n, n >= 5 ? Date.now() + 15 * 60_000 : null, u.id);
      log(null, 'auth.failed', `user:${u.id}`, { attempts: n }, req);
      throw new HttpError(401, 'Wrong username or password');
    }
    u.perms = JSON.parse(u.perms);
    if (u.totp_enabled) return send(res, 200, { mfa: 'totp', challenge: putChallenge({ userId: u.id }) });
    finishLogin(req, res, u, 'password');
  });

  router.post('/api/auth/totp', async (req, res) => {
    const b = await readJson(req);
    rateLimit('totp:' + req.clientIp, 10);
    const c = takeChallenge(String(b.challenge || ''));
    if (!c) throw new HttpError(401, 'Sign-in expired. Start again.');
    const u = getUser(c.userId);
    if (!verifyTotp(u.totp_secret, b.code)) {
      log(null, 'auth.totp_failed', `user:${u.id}`, null, req);
      throw new HttpError(401, 'That code is not right. Start sign-in again.');
    }
    const blocked = loginBlock(u); if (blocked) throw new HttpError(403, blocked);
    finishLogin(req, res, u, 'password+totp');
  });

  router.post('/api/auth/logout', (req, res) => {
    const u = sessionUser(db, req);
    destroySession(db, req);
    if (u) log(u, 'auth.logout', `user:${u.id}`, null, req);
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  });

  router.get('/api/auth/me', (req, res) => {
    const u = needUser(req);
    send(res, 200, { user: publicUser(u), limits: getLimits(u.id), version: VERSION, encSalt: encSaltB64(u), wrappedKey: u.wrapped_key || null });
  });
  // Store the browser-wrapped history master key (opaque base64; the server cannot unwrap it).
  router.put('/api/me/keybundle', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    const wrapped = b.wrapped === null ? null : str(b.wrapped, 'wrapped key', { max: 1024 });
    db.prepare('UPDATE users SET wrapped_key = ? WHERE id = ?').run(wrapped, u.id);
    send(res, 200, { ok: true });
  });

  router.post('/api/auth/password', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.current || ''), u.pw_hash))) throw new HttpError(401, 'Current password is wrong');
    const problem = passwordProblems(b.password, u.username); if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(u.id, u.sessionId);
    log(u, 'auth.password_changed', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });

  // ---------- passkeys ----------
  router.post('/api/security/passkey/register-options', async (req, res) => {
    const u = needUser(req);
    const { rpID } = rp(req);
    const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(u.id);
    const opts = await generateRegistrationOptions({
      rpName: 'Indognito', rpID, userName: u.username, userID: new TextEncoder().encode(`gnito-${u.id}`),
      attestationType: 'none', excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    send(res, 200, { options: opts, challenge: putChallenge({ userId: u.id, challenge: opts.challenge }) });
  });
  router.post('/api/security/passkey/register', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req, 64 << 10);
    const c = takeChallenge(String(b.challenge || ''));
    if (!c || c.userId !== u.id) throw new HttpError(400, 'Passkey setup expired. Try again.');
    const { rpID, origin } = rp(req);
    let v;
    try { v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID }); }
    catch (e) { throw new HttpError(400, `Passkey was not accepted: ${e.message}`); }
    if (!v.verified) throw new HttpError(400, 'Passkey could not be verified');
    const cred = v.registrationInfo.credential;
    db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cred.id, u.id, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []), String(b.name || 'Passkey').slice(0, 40), Date.now());
    log(u, 'security.passkey_added', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });
  router.get('/api/security/passkeys', (req, res) => {
    const u = needUser(req);
    send(res, 200, { passkeys: db.prepare('SELECT id, name, created, last_used FROM passkeys WHERE user_id = ?').all(u.id) });
  });
  router.delete('/api/security/passkeys/:id', (req, res, { params }) => {
    const u = needUser(req);
    db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(params.id, u.id);
    log(u, 'security.passkey_removed', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });
  router.post('/api/auth/passkey-options', async (req, res) => {
    rateLimit('pk:' + req.clientIp, 30);
    const { rpID } = rp(req);
    const opts = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    send(res, 200, { options: opts, challenge: putChallenge({ challenge: opts.challenge }) });
  });
  router.post('/api/auth/passkey', async (req, res) => {
    rateLimit('pk:' + req.clientIp, 30);
    const b = await readJson(req, 64 << 10);
    const c = takeChallenge(String(b.challenge || ''));
    if (!c) throw new HttpError(400, 'Sign-in expired. Try again.');
    const pk = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(b.response?.id || ''));
    if (!pk) throw new HttpError(401, 'This passkey is not registered here');
    const { rpID, origin } = rp(req);
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: JSON.parse(pk.transports || '[]') } });
    } catch (e) { throw new HttpError(401, `Passkey was not accepted: ${e.message}`); }
    if (!v.verified) throw new HttpError(401, 'Passkey could not be verified');
    db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, Date.now(), pk.id);
    const u = getUser(pk.user_id);
    const blocked = loginBlock(u); if (blocked) throw new HttpError(403, blocked);
    finishLogin(req, res, u, 'passkey');
  });

  // ---------- TOTP + session settings ----------
  router.post('/api/security/totp/setup', (req, res) => {
    const u = needUser(req);
    const secret = newTotpSecret();
    const label = encodeURIComponent(`Indognito:${u.username}`);
    send(res, 200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Indognito&digits=6&period=30`, challenge: putChallenge({ userId: u.id, secret }, 10 * 60_000) });
  });
  router.post('/api/security/totp/enable', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    const c = takeChallenge(String(b.challenge || ''));
    if (!c || c.userId !== u.id) throw new HttpError(400, 'Setup expired. Start again.');
    if (!verifyTotp(c.secret, b.code)) throw new HttpError(400, 'That code is not right. Start again and check your device clock.');
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(c.secret, u.id);
    log(u, 'security.totp_enabled', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });
  router.post('/api/security/totp/disable', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.password || ''), u.pw_hash))) throw new HttpError(401, 'Password is wrong');
    db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(u.id);
    log(u, 'security.totp_disabled', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });
  router.put('/api/me/preferences', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    if (b.sessionHours !== undefined) db.prepare('UPDATE users SET session_hours = ? WHERE id = ?').run(int(b.sessionHours, 'Session length', { min: 1, max: 720 }), u.id);
    if (b.searchEngine !== undefined) {
      if (!SEARCH_ENGINES.includes(b.searchEngine)) throw new HttpError(400, 'Unknown search engine');
      db.prepare('UPDATE users SET search_engine = ? WHERE id = ?').run(b.searchEngine, u.id);
    }
    if (b.saveHistory !== undefined) settings.set(`user.${u.id}.saveHistory`, !!b.saveHistory);
    send(res, 200, { user: publicUser(getUser(u.id)), saveHistory: settings.get(`user.${u.id}.saveHistory`, false) });
  });
  router.get('/api/me/preferences', (req, res) => {
    const u = needUser(req);
    send(res, 200, { searchEngine: u.search_engine, sessionHours: u.session_hours, saveHistory: settings.get(`user.${u.id}.saveHistory`, false), engines: SEARCH_ENGINES });
  });
  router.get('/api/me/sessions', (req, res) => {
    const u = needUser(req);
    const rows = db.prepare('SELECT id, created, last_seen, expires, ip, ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(u.id);
    send(res, 200, { sessions: rows.map((r) => ({ ...r, id: r.id.slice(0, 10), current: r.id === u.sessionId })) });
  });
  router.post('/api/me/sessions/revoke-others', (req, res) => {
    const u = needUser(req);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(u.id, u.sessionId);
    log(u, 'auth.revoked_other_sessions', `user:${u.id}`, null, req);
    send(res, 200, { ok: true });
  });

  // ---------- workspace dashboard ----------
  const usageFor = async (uid) => {
    const lim = getLimits(uid);
    const t = sampler.treeUsage(terminals.pidsFor(uid));
    return {
      storage: { used: await workspaces.usage(uid), max: lim.storage_mb * 1048576 },
      ram: { used: t.rss, max: lim.ram_mb * 1048576, measured: measurable },
      cpu: { percent: Math.round(t.cpu * 10) / 10, max: lim.cpu_pct, measured: measurable },
      terminals: { open: terminals.list(uid).filter((s) => s.status !== 'exited').length, max: lim.terminal_sessions },
      browser: { open: browserq.userActive(uid), max: lim.browser_sessions },
    };
  };
  router.get('/api/workspace/stats', async (req, res) => {
    const u = needUser(req);
    const p = terminals.probe();
    send(res, 200, { ...(await usageFor(u.id)), runtime: { driver: p.selected, limits: p.limits, sandbox: p.sandbox } });
  });

  // ---------- terminal ----------
  router.get('/api/terminal/sessions', (req, res) => {
    const u = needUser(req);
    send(res, 200, { sessions: terminals.list(u.id), allowed: terminals.allowedFor(u), runtime: terminals.probe().selected });
  });
  router.post('/api/terminal/sessions', async (req, res) => {
    const u = needUser(req);
    const b = await readJson(req);
    try { send(res, 201, { session: terminals.create(u, getLimits(u.id), { cols: b.cols | 0 || 100, rows: b.rows | 0 || 30 }) }); }
    catch (e) { throw new HttpError(e.status || 500, e.message); }
  });
  router.delete('/api/terminal/sessions/:id', (req, res, { params }) => {
    const u = needUser(req);
    const s = terminals.get(params.id);
    if (!s || s.userId !== u.id) throw new HttpError(404, 'No such session');
    terminals.terminate(s.id);
    send(res, 200, { ok: true });
  });

  // ---------- browser ----------
  router.post('/api/browser/sessions', (req, res) => {
    const u = needUser(req);
    try { send(res, 200, browserq.request(u, getLimits(u.id))); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  });
  router.get('/api/browser/sessions/:id', (req, res, { params }) => send(res, 200, browserq.status(params.id, needUser(req).id)));
  router.post('/api/browser/sessions/:id/heartbeat', (req, res, { params }) => {
    const ok = browserq.heartbeat(params.id, needUser(req).id);
    send(res, ok ? 200 : 410, { ok });
  });
  router.delete('/api/browser/sessions/:id', (req, res, { params }) => {
    const u = needUser(req);
    const s = browserq.slots.get(params.id);
    if (s && s.userId === u.id) browserq.release(params.id); else browserq.leave(params.id, u.id);
    send(res, 200, { ok: true });
  });
  router.get('/api/browser/history', (req, res) => {
    const u = needUser(req);
    send(res, 200, { history: db.prepare('SELECT id, enc, url, title, iv, ct, ts FROM history WHERE user_id = ? ORDER BY ts DESC LIMIT 300').all(u.id) });
  });
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  router.post('/api/browser/history', async (req, res) => {
    const u = needUser(req);
    if (!settings.get(`user.${u.id}.saveHistory`, false)) return send(res, 200, { saved: false });
    const b = await readJson(req);
    // Zero-knowledge path: the client sends only an IV and ciphertext (AES-GCM of {url,title});
    // the server stores them opaquely and never learns the destination.
    if (b.ct !== undefined || b.iv !== undefined) {
      const iv = str(b.iv, 'iv', { max: 32 }); const ct = str(b.ct, 'ct', { max: 4096 });
      if (!b64.test(iv) || !b64.test(ct)) throw new HttpError(400, 'Encrypted history must be base64');
      db.prepare('INSERT INTO history (user_id, url, enc, iv, ct, ts) VALUES (?, ?, 1, ?, ?, ?)').run(u.id, '', iv, ct, Date.now());
    } else {
      const url = str(b.url, 'URL', { max: 2048 });
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'Only web addresses are recorded');
      db.prepare('INSERT INTO history (user_id, url, title, enc, ts) VALUES (?, ?, ?, 0, ?)').run(u.id, url, String(b.title || '').slice(0, 200), Date.now());
    }
    db.prepare('DELETE FROM history WHERE user_id = ? AND id NOT IN (SELECT id FROM history WHERE user_id = ? ORDER BY ts DESC LIMIT 1000)').run(u.id, u.id);
    send(res, 200, { saved: true });
  });
  router.delete('/api/browser/history', (req, res) => {
    const u = needUser(req);
    db.prepare('DELETE FROM history WHERE user_id = ?').run(u.id);
    send(res, 200, { ok: true });
  });
  router.delete('/api/browser/history/:id', (req, res, { params }) => {
    const u = needUser(req);
    db.prepare('DELETE FROM history WHERE user_id = ? AND id = ?').run(u.id, Number(params.id));
    send(res, 200, { ok: true });
  });
  router.get('/api/apps', (req, res) => {
    needUser(req);
    send(res, 200, { apps: db.prepare('SELECT * FROM apps WHERE enabled = 1 ORDER BY sort, name').all() });
  });

  // Real site icons for catalog apps. The server (not the user's browser) fetches the favicon and
  // serves it from this origin, so tiles show a site's true icon without the client ever contacting
  // the site directly or a third-party favicon service — and it stays within the page's CSP. Only
  // admin-curated catalog URLs are fetched (no arbitrary host → no SSRF); results are cached.
  const favCache = new Map(); // appId -> { buf, type, exp }
  const isPrivateHost = (host) => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|\[?fc|\[?fd)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  async function fetchFavicon(appUrl) {
    const u0 = new URL(appUrl);
    if (u0.protocol !== 'https:' && u0.protocol !== 'http:') return null;
    if (isPrivateHost(u0.hostname)) return null;
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 5000);
    const get = (url) => fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Indognito-favicon/1.0', accept: '*/*' } });
    try {
      let iconUrl = u0.origin + '/favicon.ico';
      try {
        const r = await get(appUrl);
        if (r.ok && /text\/html/i.test(r.headers.get('content-type') || '')) {
          const html = (await r.text()).slice(0, 200_000);
          const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel=["'][^"']*\bicon\b/i.test(t));
          // Prefer an explicit size (apple-touch / sized icons tend to be crisp), else the first.
          const pick = links.find((t) => /apple-touch-icon|sizes=["'](?:\d{2,})/i.test(t)) || links[0];
          const href = pick?.match(/href=["']([^"']+)["']/i)?.[1];
          if (href) iconUrl = new URL(href, r.url || appUrl).href;
        }
      } catch { /* fall back to /favicon.ico */ }
      if (isPrivateHost(new URL(iconUrl).hostname)) return null;
      const fr = await get(iconUrl);
      if (!fr.ok) return null;
      const type = (fr.headers.get('content-type') || 'image/x-icon').split(';')[0].trim();
      if (!/^image\//i.test(type) && type !== 'image/x-icon') return null;
      const buf = Buffer.from(await fr.arrayBuffer());
      if (buf.length < 70 || buf.length > 512 * 1024) return null; // skip empty/placeholder 1x1s and oversized
      return { buf, type: type || 'image/x-icon' };
    } catch { return null; } finally { clearTimeout(to); }
  }
  router.get('/api/favicon', async (req, res, { query }) => {
    needUser(req);
    const id = query.get('id');
    const app = id && db.prepare('SELECT url FROM apps WHERE id = ? AND enabled = 1').get(id);
    if (!app) return send(res, 404, { error: 'Unknown app' });
    let c = favCache.get(id);
    if (!c || c.exp < Date.now()) {
      const fav = await fetchFavicon(app.url);
      c = { buf: fav?.buf || null, type: fav?.type || null, exp: Date.now() + (fav ? 7 * 864e5 : 36e5) };
      favCache.set(id, c);
    }
    if (!c.buf) return send(res, 204, '');
    send(res, 200, c.buf, { 'content-type': c.type, 'cache-control': 'public, max-age=86400' });
  });

  // On the isolated-microVM runtime the File Explorer operates on the user's VM (same machine as
  // the terminal); otherwise on the host workspace folder.
  if (ctx.machines?.enabled && terminals.probe().selected === 'microvm') registerMachineFileRoutes(router, { machines: ctx.machines, needUser });
  else registerFileRoutes(router, { workspaces, needUser, getLimits, auditFn: log });

  // ---------- administration ----------
  router.get('/api/admin/users', async (req, res) => {
    needPerm(req, 'users.view');
    const rows = db.prepare('SELECT u.*, r.key AS role_key, r.name AS role_name, r.rank, r.perms FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.is_owner DESC, r.rank DESC, u.username').all();
    const users = [];
    for (const r of rows) { r.perms = JSON.parse(r.perms); users.push({ ...publicUser(r), limits: getLimits(r.id), usage: await usageFor(r.id) }); }
    send(res, 200, { users });
  });

  const validateLimits = (b) => {
    const out = {};
    if (b.storage_mb !== undefined) out.storage_mb = int(b.storage_mb, 'Storage (MB)', { min: 64, max: allocation.storageMb });
    if (b.ram_mb !== undefined) out.ram_mb = int(b.ram_mb, 'RAM (MB)', { min: 64, max: allocation.ramMb });
    if (b.cpu_pct !== undefined) out.cpu_pct = int(b.cpu_pct, 'CPU (%)', { min: 5, max: allocation.cpuPercent });
    if (b.browser_sessions !== undefined) out.browser_sessions = int(b.browser_sessions, 'Browser sessions', { min: 0, max: 50 });
    if (b.terminal_sessions !== undefined) out.terminal_sessions = int(b.terminal_sessions, 'Terminal sessions', { min: 0, max: 20 });
    return out;
  };
  const roleFor = (actor, key) => {
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(String(key || 'user'));
    if (!role) throw new HttpError(400, 'Unknown role');
    if (role.key === 'owner') throw new HttpError(403, 'There is exactly one Owner. Use "Transfer ownership" instead.');
    if (!actor.is_owner && role.rank >= rankOf(actor)) throw new HttpError(403, 'You can only give roles below your own');
    return role;
  };

  router.post('/api/admin/users', async (req, res) => {
    const actor = needPerm(req, 'users.create');
    const b = await readJson(req);
    const username = str(b.username, 'Username', { min: 3, max: 32, pattern: USERNAME });
    const problem = passwordProblems(b.password, username); if (problem) throw new HttpError(400, problem);
    const role = roleFor(actor, b.role);
    const lim = { ...settings.get('limits.default'), ...(can(actor, 'limits.manage') ? validateLimits(b.limits || {}) : {}) };
    const pw = await hashPassword(b.password);
    let id;
    try {
      id = tx(db, () => {
        const id2 = db.prepare('INSERT INTO users (username, pw_hash, role_id, created_at) VALUES (?, ?, ?, ?)').run(username, pw, role.id, Date.now()).lastInsertRowid;
        db.prepare('INSERT INTO limits (user_id, storage_mb, ram_mb, cpu_pct, browser_sessions, terminal_sessions) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id2, lim.storage_mb, lim.ram_mb, lim.cpu_pct, lim.browser_sessions, lim.terminal_sessions);
        return id2;
      });
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That username is taken'); throw e; }
    const u = getUser(id);
    workspaces.ensure(u);
    log(actor, 'admin.user_created', `user:${id}`, { username, role: role.key }, req);
    send(res, 201, { user: publicUser(u) });
  });

  router.patch('/api/admin/users/:id', async (req, res, { params }) => {
    const actor = needUser(req);
    const target = getUser(Number(params.id));
    const b = await readJson(req);
    if (!canManage(actor, target)) {
      throw new HttpError(403, actor.id === target.id ? 'You cannot change your own role, status or limits here' : 'You can only manage accounts ranked below you');
    }
    const changes = {};
    if (b.role !== undefined) {
      needPerm(req, 'users.manage');
      const role = roleFor(actor, b.role);
      db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role.id, target.id);
      changes.role = role.key;
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // re-sign-in with new permissions
    }
    if (b.status !== undefined) {
      needPerm(req, 'users.manage');
      if (!['active', 'disabled'].includes(b.status)) throw new HttpError(400, 'Status must be active or disabled');
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(b.status, target.id);
      if (b.status === 'disabled') kickUser(target.id, 'Your account was disabled by an administrator.');
      changes.status = b.status;
    }
    if (b.locked !== undefined) {
      needPerm(req, 'users.lock');
      const reason = b.locked ? String(b.reason || '').slice(0, 200) || null : null;
      db.prepare('UPDATE users SET locked = ?, locked_reason = ?, failed_logins = 0, lock_until = NULL WHERE id = ?').run(b.locked ? 1 : 0, reason, target.id);
      if (b.locked) kickUser(target.id, 'Your account was locked by an administrator.');
      changes.locked = !!b.locked; if (reason) changes.reason = reason;
    }
    if (b.limits !== undefined) {
      needPerm(req, 'limits.manage');
      const lim = { ...getLimits(target.id), ...validateLimits(b.limits) };
      db.prepare(`INSERT INTO limits (user_id, storage_mb, ram_mb, cpu_pct, browser_sessions, terminal_sessions) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET storage_mb=excluded.storage_mb, ram_mb=excluded.ram_mb, cpu_pct=excluded.cpu_pct,
                  browser_sessions=excluded.browser_sessions, terminal_sessions=excluded.terminal_sessions`)
        .run(target.id, lim.storage_mb, lim.ram_mb, lim.cpu_pct, lim.browser_sessions, lim.terminal_sessions);
      changes.limits = lim;
    }
    if (b.password !== undefined) {
      needPerm(req, 'users.manage');
      const problem = passwordProblems(b.password, target.username); if (problem) throw new HttpError(400, problem);
      // Clear the wrapped history key: an admin reset gives a new password, but nobody holds the
      // old one, so the user's encrypted history can no longer be unwrapped (zero-knowledge by
      // design). The client mints a fresh master key on next sign-in.
      db.prepare('UPDATE users SET pw_hash = ?, wrapped_key = NULL, failed_logins = 0, lock_until = NULL WHERE id = ?').run(await hashPassword(b.password), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      changes.password = 'reset';
    }
    log(actor, 'admin.user_updated', `user:${target.id}`, { username: target.username, ...changes }, req);
    send(res, 200, { user: publicUser(getUser(target.id)) });
  });

  router.delete('/api/admin/users/:id', async (req, res, { params }) => {
    const actor = needPerm(req, 'users.manage');
    const target = getUser(Number(params.id));
    if (!canManage(actor, target)) throw new HttpError(403, 'You can only delete accounts ranked below you');
    kickUser(target.id, 'Account deleted.');
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    await workspaces.remove(target.id);
    if (ctx.machines?.enabled) await ctx.machines.destroy(target.id).catch(() => {}); // tear down their isolated VM
    log(actor, 'admin.user_deleted', `user:${target.id}`, { username: target.username }, req);
    send(res, 200, { ok: true });
  });

  router.post('/api/admin/transfer-ownership', async (req, res) => {
    const actor = needUser(req);
    if (!actor.is_owner) throw new HttpError(403, 'Only the Owner can transfer ownership');
    const b = await readJson(req);
    if (!(await verifyPassword(String(b.password || ''), actor.pw_hash))) throw new HttpError(401, 'Password is wrong');
    const target = getUser(int(b.userId, 'Account'));
    if (target.id === actor.id || target.status !== 'active' || target.locked) throw new HttpError(400, 'Choose another active, unlocked account');
    tx(db, () => {
      const owner = db.prepare("SELECT id FROM roles WHERE key = 'owner'").get().id;
      const admin = db.prepare("SELECT id FROM roles WHERE key = 'admin'").get().id;
      db.prepare('UPDATE users SET is_owner = NULL, role_id = ? WHERE id = ?').run(admin, actor.id);
      db.prepare('UPDATE users SET is_owner = 1, role_id = ? WHERE id = ?').run(owner, target.id);
    });
    log(actor, 'admin.ownership_transferred', `user:${target.id}`, { from: actor.username, to: target.username }, req);
    send(res, 200, { ok: true });
  });

  router.get('/api/admin/roles', (req, res) => {
    needPerm(req, 'users.view');
    const roles = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS members FROM roles r ORDER BY rank DESC').all()
      .map((r) => ({ ...r, perms: JSON.parse(r.perms), builtin: !!r.builtin }));
    send(res, 200, { roles, permissions: PERMISSIONS });
  });
  const roleBody = (actor, b) => {
    const rank = int(b.rank, 'Rank', { min: 1, max: 79 });
    const perms = Array.isArray(b.perms) ? b.perms.filter((p) => p in PERMISSIONS) : [];
    for (const p of perms) if (!can(actor, p)) throw new HttpError(403, `You cannot grant "${p}" because you do not have it`);
    return { name: str(b.name, 'Role name', { min: 2, max: 32 }), rank, perms };
  };
  router.post('/api/admin/roles', async (req, res) => {
    const actor = needPerm(req, 'roles.manage');
    const r = roleBody(actor, await readJson(req));
    const key = 'custom-' + r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try { db.prepare('INSERT INTO roles (key, name, rank, perms) VALUES (?, ?, ?, ?)').run(key, r.name, r.rank, JSON.stringify(r.perms)); }
    catch { throw new HttpError(409, 'A role with that name exists'); }
    log(actor, 'admin.role_created', `role:${key}`, r, req);
    send(res, 201, { ok: true, key });
  });
  router.patch('/api/admin/roles/:key', async (req, res, { params }) => {
    const actor = needPerm(req, 'roles.manage');
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(params.key);
    if (!role) throw new HttpError(404, 'No such role');
    if (role.builtin && role.key !== 'moderator') throw new HttpError(403, 'Built-in Owner, Administrator and User roles cannot be edited');
    const r = roleBody(actor, await readJson(req));
    db.prepare('UPDATE roles SET name = ?, rank = ?, perms = ? WHERE id = ?').run(r.name, r.rank, JSON.stringify(r.perms), role.id);
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role_id = ?)').run(role.id);
    log(actor, 'admin.role_updated', `role:${role.key}`, r, req);
    send(res, 200, { ok: true });
  });
  router.delete('/api/admin/roles/:key', (req, res, { params }) => {
    const actor = needPerm(req, 'roles.manage');
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(params.key);
    if (!role) throw new HttpError(404, 'No such role');
    if (role.builtin) throw new HttpError(403, 'Built-in roles cannot be deleted');
    const userRole = db.prepare("SELECT id FROM roles WHERE key = 'user'").get().id;
    db.prepare('UPDATE users SET role_id = ? WHERE role_id = ?').run(userRole, role.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    log(actor, 'admin.role_deleted', `role:${role.key}`, null, req);
    send(res, 200, { ok: true });
  });

  router.get('/api/admin/audit', (req, res, { query }) => {
    needPerm(req, 'audit.view');
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100').all(before);
    send(res, 200, { entries: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
  });

  router.get('/api/admin/status', (req, res) => {
    needPerm(req, 'system.view');
    const p = terminals.probe();
    send(res, 200, {
      version: VERSION, hostname: cfg.hostname, platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      ports: cfg.ports, permissionMode: cfg.permissionMode, allocation, tls: cfg.tls.mode,
      runtime: p, allowUnsandboxed: settings.get('runtime.allowUnsandboxed', false), terminalNetwork: settings.get('runtime.terminalNetwork', true),
      host: ctx.host || null,
      browser: { capacity: browserq.capacity(), active: browserq.slots.size, queued: browserq.queue.length, averageSessionMinutes: browserq.averageHoldMin() },
      terminals: terminals.list().map((s) => ({ ...s, username: db.prepare('SELECT username FROM users WHERE id = ?').get(s.userId)?.username })),
      dns: settings.get('network.dns'),
    });
  });

  router.put('/api/admin/runtime', async (req, res) => {
    const actor = needPerm(req, 'policy.manage');
    const b = await readJson(req);
    if (b.allowUnsandboxed !== undefined) {
      if (!actor.is_owner) throw new HttpError(403, 'Only the Owner can allow unsandboxed terminals');
      settings.set('runtime.allowUnsandboxed', !!b.allowUnsandboxed);
    }
    if (b.terminalNetwork !== undefined) settings.set('runtime.terminalNetwork', !!b.terminalNetwork);
    log(actor, 'admin.runtime_updated', 'runtime', b, req);
    send(res, 200, { ok: true });
  });

  router.get('/api/admin/policy', (req, res) => {
    needPerm(req, 'policy.manage');
    send(res, 200, { policy: browserq.policy(), capacity: browserq.capacity(), transport: browserq.transport() });
  });
  router.put('/api/admin/policy', async (req, res) => {
    const actor = needPerm(req, 'policy.manage');
    const b = await readJson(req, 256 << 10);
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      .map((s) => { if (!/^(\*\.)?[a-z0-9*-]+(\.[a-z0-9*-]+)*$/.test(s)) throw new HttpError(400, `"${s}" is not a valid domain pattern`); return s; });
    const policy = {
      mode: b.mode === 'allowlist' ? 'allowlist' : 'blocklist',
      block: list(b.block), allow: list(b.allow),
      ports: b.ports === 'any' ? 'any' : 'web', allowUdp: !!b.allowUdp,
    };
    settings.set('network.policy', policy);
    if (b.capacity !== undefined) settings.set('browser.capacity', int(b.capacity, 'Browser capacity', { min: 1, max: 500 }));
    if (b.transport !== undefined) settings.set('browser.transport', b.transport === 'libcurl' ? 'libcurl' : 'epoxy');
    browserq.applyPolicy(); browserq.promote();
    log(actor, 'admin.policy_updated', 'network', { ...policy, capacity: browserq.capacity(), transport: browserq.transport() }, req);
    send(res, 200, { policy, capacity: browserq.capacity(), transport: browserq.transport() });
  });

  router.get('/api/admin/apps', (req, res) => { needPerm(req, 'policy.manage'); send(res, 200, { apps: db.prepare('SELECT * FROM apps ORDER BY sort, name').all() }); });
  router.put('/api/admin/apps/:id', async (req, res, { params }) => {
    const actor = needPerm(req, 'policy.manage');
    const b = await readJson(req);
    const id = str(params.id, 'App id', { min: 2, max: 40, pattern: /^[a-z0-9-]+$/ });
    const url = str(b.url, 'URL', { max: 500 });
    if (!/^https:\/\//.test(url)) throw new HttpError(400, 'App URLs must start with https://');
    db.prepare(`INSERT INTO apps (id, name, url, category, description, icon, enabled, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, category=excluded.category,
                description=excluded.description, icon=excluded.icon, enabled=excluded.enabled, sort=excluded.sort`)
      .run(id, str(b.name, 'Name', { min: 1, max: 40 }), url, str(b.category || 'Apps', 'Category', { max: 30 }),
        String(b.description || '').slice(0, 120), String(b.icon || 'globe').slice(0, 20), b.enabled === false ? 0 : 1, Number(b.sort) || 0);
    log(actor, 'admin.app_saved', `app:${id}`, { url }, req);
    send(res, 200, { ok: true });
  });
  router.delete('/api/admin/apps/:id', (req, res, { params }) => {
    const actor = needPerm(req, 'policy.manage');
    db.prepare('DELETE FROM apps WHERE id = ?').run(params.id);
    log(actor, 'admin.app_deleted', `app:${params.id}`, null, req);
    send(res, 200, { ok: true });
  });
}

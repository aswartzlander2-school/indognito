// Browser runtime slots + fair queue. A "slot" is the right to relay web traffic through this
// server's Wisp endpoint. When all slots are busy, requests wait in a queue.
import crypto from 'node:crypto';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';

// Privacy: by default the relay does NOT log the sites users visit. Wisp's INFO/DEBUG levels print
// every destination host and resolved IP; keep it at ERROR so browsing stays private. An admin can
// raise it with GNITO_WISP_LOG for troubleshooting.
logging.set_level(logging[(process.env.GNITO_WISP_LOG || 'ERROR').toUpperCase()] ?? logging.ERROR);

const IDLE_MS = 90_000;        // slot released if no open relay socket and no heartbeat for this long
const QUEUE_POLL_MS = 60_000;  // queued entries dropped if the client stops polling
const DEFAULT_HOLD_MIN = 10;   // assumed session length until real data exists

export class BrowserQueue {
  constructor({ db, settings, cfg }) {
    Object.assign(this, { db, settings, cfg });
    this.slots = new Map();   // ticket -> { ticket, userId, started, lastActive, sockets:Set, runId, bytes }
    this.queue = [];          // { id, userId, enqueued, lastPoll }
    this.applyPolicy();
    setInterval(() => this.tick(), 5_000).unref();
  }

  capacity() {
    const def = Math.max(2, Math.floor((this.cfg.allocation?.ramMb || 3072) / 512));
    return this.settings.get('browser.capacity', def);
  }

  // Mean length of the last 50 finished sessions (minutes), from real history.
  averageHoldMin() {
    const rows = this.db.prepare('SELECT ended - started AS d FROM browser_runs WHERE ended IS NOT NULL ORDER BY id DESC LIMIT 50').all();
    if (rows.length < 3) return DEFAULT_HOLD_MIN;
    const mean = rows.reduce((a, r) => a + r.d, 0) / rows.length / 60_000;
    return Math.min(120, Math.max(0.5, mean));
  }

  // Estimate when queue position `pos` (1-based) gets a slot: simulate slot hand-offs using
  // each active slot's elapsed time and the observed average hold time.
  estimateMinutes(pos) {
    const hold = this.averageHoldMin() * 60_000, now = Date.now();
    const free = Math.max(0, this.capacity() - this.slots.size);
    if (pos <= free) return 0;
    const finish = [...this.slots.values()].map((s) => s.started + Math.max(hold, now - s.started + hold * 0.1));
    while (finish.length < this.capacity()) finish.push(now);
    finish.sort((a, b) => a - b);
    let t = now;
    for (let i = 0; i < pos - free; i++) {
      t = finish.shift();
      finish.push(t + hold); finish.sort((a, b) => a - b);
    }
    return Math.max(1, Math.ceil((t - now) / 60_000));
  }

  // Which client-side transport the browser engine should use to reach this server's Wisp relay.
  // "epoxy": Rust/WASM TLS (default). "libcurl": libcurl.js/WASM. Both do TLS to each site *inside*
  // the page, so the relay only sees encrypted bytes for https; the choice is about compatibility
  // and performance, not disguising traffic. Admin-selectable.
  transport(userId) {
    // A user may pick their own transport in Settings; otherwise the server-wide default applies.
    const perUser = userId != null ? this.settings.get(`user.${userId}.transport`, '') : '';
    const t = perUser || this.settings.get('browser.transport', 'epoxy');
    return t === 'libcurl' ? 'libcurl' : 'epoxy';
  }

  userActive(userId) { return [...this.slots.values()].filter((s) => s.userId === userId).length; }

  request(user, limits) {
    // A user's own slots with no open relay connection (e.g. a closed tab) are reclaimed first.
    if (this.userActive(user.id) >= limits.browser_sessions) {
      const stale = [...this.slots.values()].filter((s) => s.userId === user.id && s.sockets.size === 0).sort((a, b) => a.lastActive - b.lastActive);
      while (stale.length && this.userActive(user.id) >= limits.browser_sessions) this.release(stale.shift().ticket);
    }
    if (this.userActive(user.id) >= limits.browser_sessions) {
      const e = new Error(`You already have ${this.userActive(user.id)} browser session(s) (limit ${limits.browser_sessions}). Close one first.`);
      e.status = 429; throw e;
    }
    const existing = this.queue.find((q) => q.userId === user.id);
    if (existing) { existing.lastPoll = Date.now(); return this.status(existing.id, user.id); }
    if (this.slots.size < this.capacity() && this.queue.length === 0) return this.grant(user.id);
    const q = { id: crypto.randomBytes(9).toString('base64url'), userId: user.id, enqueued: Date.now(), lastPoll: Date.now(), limit: limits.browser_sessions };
    this.queue.push(q);
    return this.status(q.id, user.id);
  }

  grant(userId, queueId) {
    const ticket = crypto.randomBytes(18).toString('base64url');
    const runId = this.db.prepare('INSERT INTO browser_runs (user_id, started) VALUES (?, ?)').run(userId, Date.now()).lastInsertRowid;
    this.slots.set(ticket, { ticket, userId, started: Date.now(), lastActive: Date.now(), sockets: new Set(), runId, bytes: 0, queueId });
    return { status: 'active', ticket, id: queueId || ticket, transport: this.transport(userId) };
  }

  status(id, userId) {
    for (const s of this.slots.values()) if ((s.queueId === id || s.ticket === id) && s.userId === userId) return { status: 'active', ticket: s.ticket, id, transport: this.transport(userId) };
    const i = this.queue.findIndex((q) => q.id === id && q.userId === userId);
    if (i < 0) return { status: 'expired', id };
    this.queue[i].lastPoll = Date.now();
    const position = i + 1;
    return { status: 'queued', id, position, ahead: i, capacity: this.capacity(), active: this.slots.size,
      etaMinutes: this.estimateMinutes(position), averageSessionMinutes: Math.round(this.averageHoldMin() * 10) / 10 };
  }

  heartbeat(ticket, userId) {
    const s = this.slots.get(ticket);
    if (!s || s.userId !== userId) return false;
    s.lastActive = Date.now(); return true;
  }

  release(ticket) {
    const s = this.slots.get(ticket); if (!s) return;
    this.slots.delete(ticket);
    for (const sock of s.sockets) sock.destroy();
    this.db.prepare('UPDATE browser_runs SET ended = ? WHERE id = ?').run(Date.now(), s.runId);
    this.promote();
  }
  releaseUser(userId) { for (const s of [...this.slots.values()]) if (s.userId === userId) this.release(s.ticket); this.queue = this.queue.filter((q) => q.userId !== userId); }
  leave(id, userId) { this.queue = this.queue.filter((q) => !(q.id === id && q.userId === userId)); }

  // Fair scheduling: among waiting users, prefer the one holding the fewest slots; ties go to the earliest.
  promote() {
    while (this.slots.size < this.capacity() && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.userActive(this.queue[i].userId), b = this.userActive(this.queue[best].userId);
        if (a < b) best = i;
      }
      const [q] = this.queue.splice(best, 1);
      if (this.userActive(q.userId) >= q.limit) continue;
      this.grant(q.userId, q.id);
    }
  }

  tick() {
    const now = Date.now();
    for (const s of [...this.slots.values()]) if (s.sockets.size === 0 && now - s.lastActive > IDLE_MS) this.release(s.ticket);
    this.queue = this.queue.filter((q) => now - q.lastPoll < QUEUE_POLL_MS);
    this.promote();
  }

  // Wisp websocket upgrade: /wisp/<ticket>/
  handleUpgrade(req, socket, head, user, ticket) {
    const s = this.slots.get(ticket);
    if (!s || !user || s.userId !== user.id) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (s.sockets.size >= 8) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    s.sockets.add(socket); s.lastActive = Date.now();
    socket.on('data', (d) => { s.lastActive = Date.now(); s.bytes += d.length; });
    socket.on('close', () => { s.sockets.delete(socket); s.lastActive = Date.now(); });
    req.url = '/'; // wisp-js routes by trailing slash
    wisp.routeRequest(req, socket, head);
  }

  // Network policy -> wisp-js options. Private and loopback destinations are always refused (SSRF protection).
  applyPolicy() {
    const p = this.policy();
    const toRe = (pat) => new RegExp('^(?:.*\\.)?' + pat.replace(/^\*\./, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + '\\.?$', 'i');
    wisp.options.allow_private_ips = false;
    wisp.options.allow_loopback_ips = false;
    wisp.options.allow_udp_streams = !!p.allowUdp;
    wisp.options.hostname_whitelist = p.mode === 'allowlist' ? p.allow.map(toRe) : null;
    wisp.options.hostname_blacklist = p.mode === 'allowlist' ? null : p.block.map(toRe);
    wisp.options.port_whitelist = p.ports === 'web' ? [80, 443, 8080, 8443] : null;
    wisp.options.stream_limit_total = 256;
    wisp.options.parse_real_ip = false;
    wisp.options.wisp_motd = 'Indognito';
  }

  policy() {
    return this.settings.get('network.policy', { mode: 'blocklist', block: [], allow: [], ports: 'web', allowUdp: false });
  }
}

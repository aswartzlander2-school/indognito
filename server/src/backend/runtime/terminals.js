// Terminal sessions: allocation, attach/replay, resize, termination and limit enforcement.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { detectDrivers, spawnLocal, frame } from './drivers.js';

const SCROLLBACK = 256 * 1024;

export class Terminals extends EventEmitter {
  constructor({ cfg, workspaces, settings, sampler, machines }) {
    super();
    Object.assign(this, { cfg, workspaces, settings, sampler, machines });
    this.sessions = new Map();
  }
  probe() { return detectDrivers(this.cfg); }
  list(userId) { return [...this.sessions.values()].filter((s) => userId == null || s.userId === userId).map(view); }
  get(id) { return this.sessions.get(id); }
  pidsFor(userId) { return [...this.sessions.values()].filter((s) => s.userId === userId && s.status === 'running').flatMap((s) => s.pids()); }

  allowedFor(user) {
    const p = this.probe();
    const allowUnsandboxed = this.settings.get('runtime.allowUnsandboxed', false);
    if (p.selected === 'microvm') {
      if (!this.machines?.enabled) return { ok: false, reason: 'Terminals run in an isolated Linux microVM. The Owner needs to connect a MicroVM-Playground server first (set runtime.microvm.url in the server config).' };
      return { ok: true };
    }
    if (!p.pty) return { ok: false, reason: 'The PTY helper is missing from this installation.' };
    if (p.selected === 'sandbox') {
      // Isolated when bubblewrap works. Otherwise the terminal would be unsandboxed, which is only
      // allowed if the Owner explicitly turned it on — never silently.
      if (p.sandbox) return { ok: true };
      if (allowUnsandboxed) return { ok: true };
      return { ok: false, reason: `Terminals must be isolated, but neither a microVM nor a bubblewrap sandbox is available on this host${p.sandboxReason ? ` (${p.sandboxReason})` : ''}. Connect a MicroVM-Playground server (runtime.microvm.url), or explicitly allow unsandboxed terminals in Admin → System.` };
    }
    // Explicit 'process' driver — unsandboxed; Owner-gated.
    if (!user.is_owner && !allowUnsandboxed) {
      return { ok: false, reason: 'Unsandboxed terminals are disabled. The Owner can connect a MicroVM-Playground server, or allow unsandboxed terminals in Admin → System.' };
    }
    return { ok: true };
  }

  create(user, limits, { cols = 100, rows = 30 } = {}) {
    const mine = this.list(user.id).filter((s) => s.status !== 'exited');
    if (mine.length >= limits.terminal_sessions) {
      const e = new Error(`You already have ${mine.length} terminal session(s) open (your limit is ${limits.terminal_sessions}).`); e.status = 429; throw e;
    }
    const allowed = this.allowedFor(user);
    if (!allowed.ok) { const e = new Error(allowed.reason); e.status = 403; throw e; }
    const id = crypto.randomBytes(9).toString('base64url');
    const s = {
      id, userId: user.id, username: user.username, status: 'allocating', phase: 'Allocating runtime…', driver: this.probe().selected,
      created: Date.now(), cols, rows, buf: [], bufLen: 0, clients: new Set(), rt: null, exitReason: null,
      title: `Session ${mine.length + 1}`,
      pids: () => s.rt?.pids || [],
    };
    this.sessions.set(id, s);
    this.allocate(s, user, limits).catch((err) => this.finish(s, `Allocation failed: ${err.message}`));
    return view(s);
  }

  async allocate(s, user, limits) {
    const ws = this.workspaces.ensure(user);
    const p = this.probe();
    const network = this.settings.get('runtime.terminalNetwork', true);
    if (s.driver === 'microvm') {
      // Attach to the user's persistent, isolated Linux microVM (same VM backs the File Explorer
      // and Browser). The VM has its own disk and never mounts host/user files. Report progress so
      // the terminal can show "Allocating runtime…" then "Connecting…" while it comes up.
      this.setPhase(s, 'Allocating runtime…');
      await this.machines.ensure(user, limits);
      this.setPhase(s, 'Connecting…');
      s.rt = await this.machines.console(user, limits, { cols: s.cols, rows: s.rows });
    } else {
      const child = spawnLocal(s.driver, { ws, cols: s.cols, rows: s.rows, limits, network, probe: p });
      const ev = new EventEmitter();
      child.stdout.on('data', (d) => ev.emit('data', d));
      child.stderr.on('data', (d) => ev.emit('data', Buffer.from(d.toString().replace(/\n/g, '\r\n'))));
      child.on('exit', (code) => ev.emit('exit', code));
      child.on('error', (err) => { ev.emit('data', Buffer.from(`\r\n${err.message}\r\n`)); ev.emit('exit', -1); });
      child.stdin.on('error', () => {});
      s.rt = {
        pids: [child.pid],
        on: (e, f) => ev.on(e, f),
        write: (d) => child.stdin.writable && child.stdin.write(frame('d', d)),
        resize: (c, r) => child.stdin.writable && child.stdin.write(frame('r', `${c},${r}`)),
        kill: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref(); },
      };
    }
    if (s.status === 'exited') { s.rt.kill(); return; }
    s.rt.on('data', (d) => this.output(s, d));
    s.rt.on('exit', (code) => this.finish(s, s.exitReason || `Process exited (code ${code}).`));
    s.status = 'running';
    s.startedAt = Date.now();
    this.broadcast(s, { type: 'status', session: view(s) });
  }

  output(s, d) {
    s.buf.push(d); s.bufLen += d.length;
    while (s.bufLen > SCROLLBACK && s.buf.length > 1) s.bufLen -= s.buf.shift().length;
    for (const c of s.clients) if (c.readyState === 1) c.send(d, { binary: true });
  }

  broadcast(s, msg) { const t = JSON.stringify(msg); for (const c of s.clients) if (c.readyState === 1) c.send(t); }

  setPhase(s, phase) { if (s.status !== 'allocating') return; s.phase = phase; this.broadcast(s, { type: 'status', session: view(s) }); }

  attach(s, ws) {
    s.clients.add(ws);
    ws.send(JSON.stringify({ type: 'status', session: view(s) }));
    if (s.buf.length) ws.send(Buffer.concat(s.buf), { binary: true });
    ws.on('message', (data, isBinary) => {
      if (s.status !== 'running') return;
      if (isBinary) { s.rt.write(data); return; }
      try {
        const m = JSON.parse(String(data));
        if (m.type === 'resize') {
          s.cols = Math.max(10, Math.min(500, m.cols | 0)); s.rows = Math.max(4, Math.min(200, m.rows | 0));
          s.rt.resize(s.cols, s.rows);
        } else if (m.type === 'input' && typeof m.data === 'string') s.rt.write(Buffer.from(m.data));
      } catch { /* ignore */ }
    });
    ws.on('close', () => s.clients.delete(ws));
  }

  terminate(id, reason = 'Session ended by user.') {
    const s = this.sessions.get(id); if (!s) return;
    s.exitReason = reason;
    if (s.rt) s.rt.kill(); else this.finish(s, reason);
  }

  finish(s, reason) {
    if (s.status === 'exited') return;
    s.status = 'exited'; s.exitReason = reason; s.ended = Date.now();
    this.broadcast(s, { type: 'status', session: view(s) });
    this.workspaces.invalidate(s.userId);
    setTimeout(() => { for (const c of s.clients) c.close(); this.sessions.delete(s.id); }, 30_000).unref();
  }

  terminateUser(userId, reason) { for (const s of this.sessions.values()) if (s.userId === userId) this.terminate(s.id, reason); }
}

function view(s) {
  return { id: s.id, userId: s.userId, title: s.title, status: s.status, phase: s.phase, driver: s.driver, created: s.created,
    startedAt: s.startedAt, ended: s.ended, exitReason: s.exitReason, cols: s.cols, rows: s.rows };
}

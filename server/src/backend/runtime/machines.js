// Per-user isolated machines backed by a MicroVM-Playground server
// (github.com/aswartzlander2-sys/MicroVM-Playground).
//
// Each user gets ONE persistent microVM that backs their terminal, their File Explorer and their
// Browser downloads. The VM has its own kernel and disk and never mounts the host's or the user's
// workspace files, so it is fully isolated — "the terminal cannot access user files". The terminal
// (console), the File Explorer (SFTP file ops) and the Browser (download → write) all point at the
// SAME VM, which is how they stay linked.
//
// Requires a running MicroVM-Playground server with a QEMU backend and SSH enabled in the guest
// image. Configure it in data/config.json under runtime.microvm:
//   { "url": "https://microvm.example", "password": "...",
//     "guestUser": "gnito", "guestPassword": "...", "image": "default",
//     "memMib": 1024, "vcpus": 1, "diskGb": 8, "ttl": "never" }
//
// NOTE: this path is only exercised when runtime.microvm.url is set; without it the terminal falls
// back to the bubblewrap sandbox. It has not been run end-to-end inside this repo's dev environment
// (which has no virtualization) — test it against your MicroVM-Playground deployment.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class Machines {
  constructor(cfg) {
    this.cfg = cfg.runtime?.microvm || {};
    this.base = (this.cfg.url || '').replace(/\/+$/, '');
    this.byUser = new Map(); // userId -> { id, promise, lastUsed }
    this.cookie = '';
    this.loginAt = 0;
  }

  get enabled() { return !!this.base; }

  async headers() {
    const h = { 'content-type': 'application/json' };
    if (this.cfg.password) {
      // MicroVM-Playground uses a single shared password + a session cookie.
      if (!this.cookie || Date.now() - this.loginAt > 50 * 60_000) {
        const r = await fetch(this.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: this.cfg.password }) });
        if (!r.ok) throw new Error(`MicroVM server login failed (${r.status})`);
        this.cookie = (r.headers.get('set-cookie') || '').split(';')[0];
        this.loginAt = Date.now();
      }
      if (this.cookie) h.cookie = this.cookie;
    }
    return h;
  }

  // Ensures the user's VM exists and is running; returns its id. One VM per user, reused.
  async ensure(user, limits) {
    if (!this.enabled) throw new Error('No MicroVM-Playground server is configured (runtime.microvm.url).');
    const existing = this.byUser.get(user.id);
    if (existing?.promise) { existing.lastUsed = Date.now(); return existing.promise; }
    const entry = { lastUsed: Date.now() };
    entry.promise = this._create(user, limits).catch((e) => { this.byUser.delete(user.id); throw e; });
    this.byUser.set(user.id, entry);
    return entry.promise;
  }

  async _create(user, limits) {
    const headers = await this.headers();
    // Reuse an already-running VM named for this user if the server still has it.
    const name = `gnito-u${user.id}`.toLowerCase();
    const list = await this._vms(headers);
    const found = list.find((v) => v.name === name);
    let id = found?.id;
    if (!id) {
      const body = {
        name, image: this.cfg.image || 'default', ttl: this.cfg.ttl || 'never',
        vcpus: this.cfg.vcpus || Math.max(1, Math.round((limits?.cpu_pct || 100) / 100)),
        mem_mib: this.cfg.memMib || Math.max(256, limits?.ram_mb || 1024),
        disk_gb: this.cfg.diskGb || Math.max(2, Math.min(40, Math.floor((limits?.storage_mb || 8192) / 1024))),
      };
      const r = await fetch(this.base + '/api/vms', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`MicroVM create failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
      id = (await r.json()).id;
    } else if (found.state !== 'running') {
      await fetch(`${this.base}/api/vms/${id}/start`, { method: 'POST', headers }).catch(() => {});
    }
    await this._waitRunning(id, headers);
    return id;
  }

  async _vms(headers) {
    const r = await fetch(`${this.base}/api/vms`, { headers });
    if (!r.ok) return [];
    const s = await r.json();
    return Array.isArray(s) ? s : s.vms || [];
  }

  async _waitRunning(id, headers, tries = 120) {
    for (let i = 0; i < tries; i++) {
      const me = (await this._vms(headers)).find((v) => v.id === id);
      if (me?.state === 'running') return;
      if (me?.state === 'error') throw new Error('MicroVM failed to start');
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('MicroVM did not become ready in time');
  }

  // ---- terminal console transport (same shape the Terminals manager expects) ----
  async console(user, limits, { cols, rows }) {
    const id = await this.ensure(user, limits);
    const headers = await this.headers();
    const ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}/api/vms/${id}/console?replay=1`, { headers: { cookie: headers.cookie || '' } });
    const ev = new EventEmitter();
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (data, isBinary) => ev.emit('data', isBinary ? data : Buffer.from(String(data))));
    ws.on('close', () => ev.emit('exit', 0));
    ws.on('error', () => ev.emit('exit', -1));
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    return {
      pids: [], vmId: id,
      on: (e, f) => ev.on(e, f),
      write: (d) => ws.readyState === 1 && ws.send(d),
      resize: (c, r) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r })),
      kill: () => { try { ws.close(); } catch { /* */ } }, // closing the console does NOT destroy the VM
    };
  }

  // ---- file operations inside the user's VM (over the server's SFTP bridge) ----
  async file(user, action, path, content) {
    const id = await this.ensure(user);
    const headers = await this.headers();
    const body = { action, path, username: this.cfg.guestUser || 'gnito', password: this.cfg.guestPassword || '' };
    if (content !== undefined) body.content = content;
    const r = await fetch(`${this.base}/api/vms/${id}/files`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (action === 'download') {
      if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `download failed (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `file ${action} failed (${r.status})`);
    return data;
  }

  list(user, path) { return this.file(user, 'list', path || '/'); }
  read(user, path) { return this.file(user, 'read', path); }
  write(user, path, content) { return this.file(user, 'write', path, content); }
  download(user, path) { return this.file(user, 'download', path); }

  // Destroy the user's VM (e.g. on account deletion).
  async destroy(userId) {
    const e = this.byUser.get(userId);
    this.byUser.delete(userId);
    if (!e?.promise) return;
    try {
      const id = await e.promise;
      const headers = await this.headers();
      await fetch(`${this.base}/api/vms/${id}`, { method: 'DELETE', headers }).catch(() => {});
    } catch { /* already gone */ }
  }
}

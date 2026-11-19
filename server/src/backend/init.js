// First-run initialization. Every task does real work; the web UI's 25×25 grid animation
// reflects this progress and never runs ahead of it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { seedRoles, seedApps } from './db.js';
import { detectDrivers } from './runtime/drivers.js';
import { hostStats } from './runtime/procstats.js';
import { APP_ROOT } from '../lib/config.js';

export function initTasks(ctx) {
  const { cfg, db, settings, browserq } = ctx;
  return [
    ['Checking data directory permissions', async () => {
      const f = path.join(cfg.dataDir, '.write-test');
      fs.writeFileSync(f, 'ok'); fs.rmSync(f);
    }],
    ['Verifying database integrity', async () => {
      const r = db.prepare('PRAGMA integrity_check').get();
      if (Object.values(r)[0] !== 'ok') throw new Error('Database integrity check failed');
    }],
    ['Creating roles and permissions', async () => seedRoles(db)],
    ['Installing the application catalog', async () => seedApps(db)],
    ['Preparing workspace storage', async () => fs.mkdirSync(path.join(cfg.dataDir, 'workspaces'), { recursive: true, mode: 0o700 })],
    ['Detecting runtime drivers', async () => settings.set('runtime.probe', detectDrivers(cfg))],
    ['Verifying browser engine files', async () => {
      const files = [
        'node_modules/@mercuryworkshop/scramjet/dist/scramjet.all.js',
        'node_modules/@mercuryworkshop/scramjet/dist/scramjet.wasm.wasm',
        'node_modules/@mercuryworkshop/scramjet/dist/scramjet.sync.js',
        'node_modules/@mercuryworkshop/bare-mux/dist/index.js',
        'node_modules/@mercuryworkshop/bare-mux/dist/worker.js',
        'node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs',
      ];
      const sums = {};
      for (const f of files) {
        const p = path.join(APP_ROOT, 'server', f);
        sums[f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      }
      settings.set('engine.files', sums);
    }],
    ['Measuring host resources', async () => {
      hostStats(); await new Promise((r) => setTimeout(r, 400));
      settings.set('host.measured', { ...hostStats(), at: Date.now() });
    }],
    ['Configuring network policy', async () => { if (!settings.get('network.policy')) settings.set('network.policy', browserq.policy()); browserq.applyPolicy(); }],
    ['Checking outbound DNS', async () => {
      try { await dns.lookup('duckduckgo.com'); settings.set('network.dns', { ok: true, at: Date.now() }); }
      catch (e) { settings.set('network.dns', { ok: false, error: e.code, at: Date.now() }); }
    }],
    ['Setting default resource limits', async () => {
      if (settings.get('limits.default')) return;
      const a = cfg.allocation;
      settings.set('limits.default', {
        storage_mb: Math.min(2048, a.storageMb), ram_mb: Math.min(512, a.ramMb),
        cpu_pct: Math.min(50, a.cpuPercent), browser_sessions: 1, terminal_sessions: 2,
      });
    }],
    ['Finishing initialization', async () => settings.set('init.completedAt', Date.now())],
  ];
}

export class Initializer {
  constructor(ctx) { this.ctx = ctx; this.tasks = initTasks(ctx).map(([name, run]) => ({ name, run, state: 'scheduled' })); this.running = null; }
  get done() { return !!this.ctx.settings.get('init.completedAt'); }
  start() {
    if (this.done || this.running) return;
    this.running = (async () => {
      for (const t of this.tasks) {
        t.state = 'processing'; t.started = Date.now();
        try { await t.run(); t.state = 'done'; } catch (e) { t.state = 'error'; t.error = e.message; this.error = `${t.name}: ${e.message}`; break; }
        t.ended = Date.now();
      }
      this.running = null;
    })();
  }
  progress() {
    const done = this.done;
    return { initialized: done, error: this.error || null,
      tasks: this.tasks.map((t) => ({ name: t.name, state: done ? 'done' : t.state, error: t.error })) };
  }
}

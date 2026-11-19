// Real process measurements. Linux: /proc. macOS: ps. Windows: not yet measured (reported as unavailable).
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const PAGE = 4096;
const HZ = 100;
const isLinux = os.platform() === 'linux';

function readProcTable() {
  // pid -> { ppid, rss, ticks }
  const table = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // rest[0]=state, rest[1]=ppid, rest[11]=utime, rest[12]=stime, rest[21]=rss(pages)
      table.set(Number(name), { ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]), rss: Number(rest[21]) * PAGE });
    } catch { /* exited */ }
  }
  return table;
}

function psTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { timeout: 4000 }, (err, out) => {
      const table = new Map();
      if (!err) for (const line of out.split('\n')) {
        const m = line.trim().split(/\s+/); if (m.length < 4) continue;
        const t = m[3].split(/[:.-]/).map(Number); let secs = 0; for (const x of t.slice(0, 3)) secs = secs * 60 + (x || 0);
        table.set(Number(m[0]), { ppid: Number(m[1]), rss: Number(m[2]) * 1024, ticks: secs * HZ });
      }
      resolve(table);
    });
  });
}

export const measurable = isLinux || os.platform() === 'darwin';

export class ProcSampler {
  constructor() { this.prev = new Map(); this.prevAt = 0; this.last = { table: new Map(), at: 0 }; }
  async sample() {
    if (!measurable) return null;
    const table = isLinux ? readProcTable() : await psTable();
    const at = Date.now();
    this.prevTicks = this.curTicks; this.prevAt = this.last.at;
    this.curTicks = new Map([...table].map(([pid, p]) => [pid, p.ticks]));
    this.last = { table, at };
    return this.last;
  }
  // Sum RSS and CPU% of the process trees rooted at `pids`.
  treeUsage(pids) {
    const { table, at } = this.last;
    if (!table.size) return { rss: 0, cpu: 0, pids: [] };
    const children = new Map();
    for (const [pid, p] of table) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(pid); }
    const seen = new Set(); const stack = pids.filter((p) => table.has(p));
    while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); for (const c of children.get(p) || []) stack.push(c); }
    let rss = 0, dTicks = 0;
    for (const p of seen) {
      rss += table.get(p).rss;
      const before = this.prevTicks?.get(p);
      if (before !== undefined) dTicks += Math.max(0, table.get(p).ticks - before);
    }
    const dt = (at - this.prevAt) / 1000;
    const cpu = dt > 0 && this.prevTicks ? (dTicks / HZ / dt) * 100 : 0; // 100 = one full core
    return { rss, cpu, pids: [...seen] };
  }
}

// Host-wide numbers, cgroup-aware on Linux (so containers report their real limit).
let prevCpu = os.cpus().map((c) => c.times);
export function hostStats() {
  let total = os.totalmem(), free = os.freemem();
  if (isLinux) {
    try {
      const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      if (max !== 'max' && Number(max) < total) {
        const cur = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
        total = Number(max); free = Math.max(0, total - cur);
      }
    } catch { /* not cgroup v2 */ }
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const avail = /MemAvailable:\s+(\d+)/.exec(mi);
      if (avail && Number(avail[1]) * 1024 < free) free = Number(avail[1]) * 1024;
      else if (avail && total === os.totalmem()) free = Number(avail[1]) * 1024;
    } catch { /* ignore */ }
  }
  const cur = os.cpus().map((c) => c.times);
  let busy = 0, all = 0;
  cur.forEach((t, i) => {
    const p = prevCpu[i] || t;
    const d = (k) => t[k] - p[k];
    const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    busy += tot - d('idle'); all += tot;
  });
  prevCpu = cur;
  return { memTotal: total, memAvailable: free, cpuCount: cur.length, cpuPercent: all ? (busy / all) * 100 : 0, load: os.loadavg() };
}

// Experimental driver: runs a terminal inside a VM from a MicroVM-Playground server
// (github.com/aswartzlander2-sys/MicroVM-Playground) through its HTTP + websocket API.
// The VM has its own disk, so files there are NOT the workspace folder (see docs/EVALUATION.md).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export async function startMicroVm({ url, password, name, limits, cols, rows }) {
  const base = url.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (password) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password }) });
    if (!r.ok) throw new Error(`MicroVM login failed (${r.status})`);
    const c = r.headers.get('set-cookie') || '';
    headers.cookie = c.split(';')[0];
  }
  const body = {
    name, ttl: '1h',
    vcpus: Math.max(1, Math.round(limits.cpu_pct / 100)),
    mem_mib: Math.max(256, limits.ram_mb),
    disk_gb: Math.max(2, Math.min(20, Math.floor(limits.storage_mb / 1024))),
  };
  const r = await fetch(base + '/api/vms', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`MicroVM create failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const vm = await r.json();
  const id = vm.id;
  for (let i = 0; i < 120; i++) {
    const s = await (await fetch(`${base}/api/vms`, { headers })).json();
    const me = (Array.isArray(s) ? s : s.vms || []).find((v) => v.id === id);
    if (me?.state === 'running') break;
    if (me?.state === 'error') throw new Error('MicroVM failed to start');
    await new Promise((res) => setTimeout(res, 1000));
  }
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/vms/${id}/console`, { headers: { cookie: headers.cookie || '' } });
  const ev = new EventEmitter();
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (data, isBinary) => ev.emit('data', isBinary ? data : Buffer.from(String(data))));
  ws.on('close', () => ev.emit('exit', 0));
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  return {
    pids: [], vmId: id,
    on: (e, f) => ev.on(e, f),
    write: (d) => ws.readyState === 1 && ws.send(d),
    resize: (c, r2) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r2 })),
    kill: async () => { try { ws.close(); } catch { /* */ } await fetch(`${base}/api/vms/${id}`, { method: 'DELETE', headers }).catch(() => {}); },
  };
}

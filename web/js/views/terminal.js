// Terminal: xterm.js connected over a websocket to a real shell in the user's workspace.
import { api, h, icon, BASE, toast, fmtBytes, confirmBox, loadScript, loadStyle } from '../core.js';
import { appHeader } from './shell.js';

// xterm and its fit addon (~480 KB) load only when the Terminal view is opened.
const termLibs = () => Promise.all([
  loadStyle('vendor/xterm/css/xterm.css'),
  loadScript('vendor/xterm/lib/xterm.js').then(() => loadScript('vendor/xterm-fit/lib/addon-fit.js')),
]);

const sessions = new Map(); // id -> { term, fit, ws, el, info } — kept while the page is open so tabs survive navigation

export async function showTerminal(mount, arg) {
  const tabsEl = h('div', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminal sessions' });
  const body = h('div', { class: 'term-body' });
  const status = h('div', { class: 'term-status' });
  const view = h('div', { class: 'shell' }, appHeader('Terminal', 'terminal'), h('div', { class: 'term-wrap', style: { flex: 1, minHeight: 0 } }, tabsEl, body, status));
  let active = null, timer;
  const ro = new ResizeObserver(() => fitActive());
  mount(view, () => { clearInterval(timer); ro.disconnect(); for (const s of sessions.values()) s.el.remove(); });
  ro.observe(body);

  function fitActive() {
    const s = sessions.get(active); if (!s || !s.term) return;
    try { s.fit.fit(); } catch { /* hidden */ }
    if (s.ws?.readyState === 1) s.ws.send(JSON.stringify({ type: 'resize', cols: s.term.cols, rows: s.term.rows }));
  }

  function allocating(el, text = 'Allocating runtime…') {
    el.querySelector('.alloc')?.remove();
    el.append(h('div', { class: 'alloc', role: 'status' }, h('div', { style: { textAlign: 'center' } }, h('div', { class: 'dots' }, h('i'), h('i'), h('i')), h('h1', {}, text))));
  }

  function attach(info) {
    let s = sessions.get(info.id);
    if (!s) {
      const el = h('div', { style: { position: 'absolute', inset: '10px 6px 6px 12px' } });
      const term = new Terminal({
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace", fontSize: 14, cursorBlink: true, scrollback: 5000,
        theme: { background: '#0c0807', foreground: '#f6ede8', cursor: '#ff8a2a', selectionBackground: '#ff6a2b55', red: '#ff5a4e', yellow: '#ffc93c', green: '#3ccf6e', blue: '#3d8bff' },
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      s = { term, fit, el, info, ws: null };
      sessions.set(info.id, s);
      allocating(el);
      term.open(el);
      term.onData((d) => { if (s.ws?.readyState === 1) s.ws.send(new TextEncoder().encode(d)); });
    }
    body.append(s.el);
    if (!s.ws || s.ws.readyState > 1) connect(s);
    return s;
  }

  function connect(s) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}ws/terminal/${s.info.id}`);
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.type === 'status') {
          s.info = m.session;
          if (m.session.status === 'allocating') allocating(s.el, m.session.phase || 'Allocating runtime…'); // update the centered status text
          if (m.session.status === 'running') { s.el.querySelector('.alloc')?.remove(); if (active === s.info.id) { fitActive(); s.term.focus(); } }
          if (m.session.status === 'exited') s.term.write(`\r\n\x1b[2m── ${m.session.exitReason || 'Session ended.'} ──\x1b[0m\r\n`);
          renderTabs(); renderStatus();
        }
      } else s.term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => { if (s.info.status === 'running') { s.info.status = 'disconnected'; renderTabs(); } };
  }

  function select(id) {
    active = id;
    for (const [sid, s] of sessions) s.el.style.display = sid === id ? '' : 'none';
    renderTabs(); renderStatus();
    setTimeout(() => { fitActive(); sessions.get(id)?.term.focus(); }, 30);
  }

  async function create() {
    try {
      const { session } = await api('api/terminal/sessions', { method: 'POST', body: { cols: 100, rows: 30 } });
      attach(session); select(session.id);
    } catch (e) { toast(e.message, true); if (!sessions.size) empty(e.message); }
  }

  async function end(id) {
    if (!(await confirmBox('End this session?', 'The shell and any programs running in it will be stopped. Files you saved stay in your workspace.', 'End session'))) return;
    await api(`api/terminal/sessions/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
    const s = sessions.get(id);
    setTimeout(() => { s?.ws?.close(); s?.term.dispose(); s?.el.remove(); sessions.delete(id); const next = [...sessions.keys()][0]; if (next) select(next); else empty(); }, 400);
  }

  function renderTabs() {
    tabsEl.replaceChildren(...[...sessions.values()].map((s) => h('div', {
      class: 'term-tab' + (s.info.id === active ? ' on' : ''), role: 'tab', tabindex: 0, 'aria-selected': s.info.id === active,
      onclick: () => select(s.info.id), onkeydown: (e) => { if (e.key === 'Enter') select(s.info.id); },
    }, h('span', { class: 'dot ' + s.info.status }), s.info.title,
    h('button', { class: 'btn sm icon ghost', 'aria-label': `End ${s.info.title}`, onclick: (e) => { e.stopPropagation(); end(s.info.id); } }, icon('x')))),
    h('button', { class: 'btn sm', onclick: create }, icon('plus'), 'New session'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm ghost', title: 'Open the File Explorer', onclick: () => { location.hash = '#/files'; } }, icon('folder'), 'Files'));
  }

  let stats = null;
  function renderStatus() {
    const s = sessions.get(active);
    const drv = { sandbox: 'Sandboxed (bubblewrap)', process: 'Unsandboxed process', microvm: 'Isolated Linux microVM' };
    status.replaceChildren(
      h('span', {}, h('b', {}, 'Runtime: '), s ? `${drv[s.info.driver] || s.info.driver} · ${s.info.status}` : '—'),
      h('span', {}, h('b', {}, 'Working folder: '), h('span', { class: 'mono' }, s?.info.driver === 'sandbox' ? '/home/gnito' : '~ (your workspace)')),
      stats ? h('span', {}, h('b', {}, 'RAM: '), `${fmtBytes(stats.ram.used)} / ${fmtBytes(stats.ram.max)}`) : null,
      stats ? h('span', {}, h('b', {}, 'CPU: '), `${stats.cpu.percent}% (limit ${stats.cpu.max}%)`) : null,
      stats ? h('span', {}, h('b', {}, 'Storage: '), `${fmtBytes(stats.storage.used)} / ${fmtBytes(stats.storage.max)}`) : null);
  }

  function empty(msg) {
    body.querySelector('.alloc')?.remove();
    body.append(h('div', { class: 'alloc' }, h('div', { style: { textAlign: 'center', maxWidth: '560px', padding: '20px' } },
      h('p', { class: 'muted' }, msg || 'No terminal sessions are open.'),
      msg ? null : h('button', { class: 'btn primary', onclick: () => { body.querySelector('.alloc')?.remove(); create(); } }, icon('plus'), 'New session'))));
  }

  timer = setInterval(async () => { try { stats = await api('api/workspace/stats'); renderStatus(); } catch { /* ignore */ } }, 3000);

  // Re-attach to existing sessions (they keep running on the server), or start one. Load the
  // terminal engine and the session list together so neither blocks the other.
  const [list] = await Promise.all([api('api/terminal/sessions'), termLibs()]);
  for (const s of list.sessions.filter((x) => x.status !== 'exited')) attach(s);
  if (!list.allowed.ok) { renderTabs(); return empty(list.allowed.reason); }
  if (sessions.size) select(arg && sessions.has(arg) ? arg : [...sessions.keys()][0]); else await create();
  const cd = sessionStorage.getItem('gnito.cd');
  if (cd) {
    sessionStorage.removeItem('gnito.cd');
    const s = sessions.get(active);
    const send = () => s?.ws?.readyState === 1 && s.info.status === 'running' ? s.ws.send(new TextEncoder().encode(`cd ${shellQuote(cd)}\r`)) : setTimeout(send, 300);
    send();
  }
}

function shellQuote(p) { return `"$HOME"${p === '/' ? '' : "'" + p.replace(/'/g, "'\\''") + "'"}`; }

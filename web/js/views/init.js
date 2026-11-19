// First-visit initialization: a 25×25 SVG grid fills the background and represents real startup
// work (backend init tasks + warming the UI/engine assets), with a centered glass card on top.
//
// Cell colors:
//   grey/black       = not started (default)
//   flashing yellow  = about to start (scheduled)
//   solid yellow     = started (processing)
//   green            = finished
//   blue             = active (all at the end), then auto-refresh after 5 seconds
import { api, h } from '../core.js';

// Small cells (same size as the login background squares), as a responsive grid that fills the
// viewport so every cell is visible.
const CELL_PX = 46;

export function showInit(mount, status) {
  const ns = 'http://www.w3.org/2000/svg';
  const cols = Math.max(14, Math.round(window.innerWidth / CELL_PX));
  const rows = Math.max(10, Math.round(window.innerHeight / CELL_PX));
  const CELLS = cols * rows;
  const PROC_BAND = Math.round(CELLS * 0.11);   // "started" (solid yellow) wave width
  const SCHED_BAND = Math.round(CELLS * 0.15);  // "about to start" (flashing yellow) wave width
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'init-grid');
  svg.setAttribute('aria-hidden', 'true');
  const rects = [];
  for (let i = 0; i < CELLS; i++) {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', (i % cols) + 0.08); r.setAttribute('y', Math.floor(i / cols) + 0.08);
    r.setAttribute('width', 0.84); r.setAttribute('height', 0.84);
    r.style.animationDelay = `${(Math.random() * 1.1).toFixed(2)}s`;
    svg.append(r); rects.push(r);                 // no class = grey/black default
  }
  const errLine = h('p', { class: 'err hidden' });
  const glass = h('div', { class: 'glass-card', role: 'status' },
    h('h1', {}, 'Setting up Indognito.'), h('p', {}, 'This will take a minute.'), errLine);
  const live = h('div', { class: 'sr', 'aria-live': 'polite' }); // screen-reader progress only
  mount(h('div', { class: 'screen init-screen' }, svg, glass, live));

  // Shuffle the cells; each cell's position in this order is when it lights up.
  const order = [...Array(CELLS).keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const posOf = new Array(CELLS);
  order.forEach((cell, pos) => { posOf[cell] = pos; });
  const shown = new Array(CELLS).fill('');

  let tasks = status.tasks;
  let failed = false, finished = false, assetsDone = false;

  api('api/setup/init', { method: 'POST', body: {} }).catch(() => {});

  // While the backend initializes, warm the heavy frontend assets so the whole app — browser
  // engine, terminal, fonts and view modules — is cached before we refresh into setup.
  warmAssets().then(() => { assetsDone = true; });

  const poll = async () => {
    if (failed || finished) return;
    try {
      const st = await api('api/setup/status');
      tasks = st.tasks;
      if (st.error) { failed = true; errLine.textContent = st.error; errLine.classList.remove('hidden'); live.textContent = 'Initialization stopped: ' + st.error; return; }
      const cur = tasks.find((t) => t.state === 'processing');
      if (cur) live.textContent = cur.name + '…';
    } catch { /* keep polling */ }
    setTimeout(poll, 350);
  };
  poll();

  // Readiness 0..1: backend tasks done (weighted 0.9) + assets warmed (0.1); only reaches 1 when
  // every backend task is done AND the assets have finished downloading.
  function target() {
    const done = tasks.filter((t) => t.state === 'done').length;
    const tasksFrac = tasks.length ? done / tasks.length : 0;
    const allDone = done === tasks.length && tasks.length > 0;
    if (allDone && assetsDone) return 1;
    return Math.min(0.94, tasksFrac * 0.9 + (assetsDone ? 0.08 : 0));
  }

  let prog = 0;
  const render = () => {
    if (failed) return;
    const t = target();
    // Ease toward the target, with a tiny floor so the wave always drifts forward.
    prog += Math.max((t - prog) * 0.06, prog < t ? 0.0012 : 0);
    if (prog > t) prog = t;
    const frontier = prog * CELLS;
    for (let cell = 0; cell < CELLS; cell++) {
      const i = posOf[cell];
      let cls;
      if (i < frontier - PROC_BAND) cls = 'd';          // finished → green
      else if (i < frontier) cls = 'p';                 // started → solid yellow
      else if (i < frontier + SCHED_BAND) cls = 's';    // about to start → flashing yellow
      else cls = '';                                    // not started → grey
      if (shown[cell] !== cls) { shown[cell] = cls; rects[cell].setAttribute('class', cls); }
    }
    if (prog >= 0.9999 && target() === 1) return complete();
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);

  async function complete() {
    if (finished) return;
    finished = true;
    for (const r of rects) r.setAttribute('class', 'd'); // everything finished → green
    live.textContent = 'Ready';
    await new Promise((r) => setTimeout(r, 700));
    for (const r of rects) r.setAttribute('class', 'b'); // all turn blue → active
    live.textContent = 'Active';
    await new Promise((r) => setTimeout(r, 5000));        // auto-refresh after 5 seconds
    location.reload();                                    // reload into onboarding / setup
  }
}

// Downloads the large runtime assets into the HTTP/SW caches so the app opens instantly after the
// init screen. Resolves when all have settled (or after a safety timeout — never blocks forever).
function warmAssets() {
  const base = new URL('./', location.href).pathname;
  const urls = [
    'vendor/scramjet/scramjet.all.js', 'vendor/scramjet/scramjet.wasm.wasm', 'vendor/scramjet/scramjet.sync.js',
    'vendor/baremux/index.js', 'vendor/baremux/worker.js', 'vendor/epoxy/index.mjs',
    'vendor/xterm/lib/xterm.js', 'vendor/xterm/css/xterm.css', 'vendor/xterm-fit/lib/addon-fit.js',
    'vendor/webauthn/index.umd.min.js', 'sw.js',
    'js/app.js', 'js/core.js',
    'js/views/onboarding.js', 'js/views/home.js', 'js/views/browser.js', 'js/views/terminal.js',
    'js/views/files.js', 'js/views/admin.js', 'js/views/settings.js', 'js/views/security.js', 'js/views/shell.js',
    'fonts/inter/inter-latin-400-normal.woff2', 'fonts/bricolage/bricolage-grotesque-latin-800-normal.woff2',
    'fonts/mono/jetbrains-mono-latin-400-normal.woff2',
  ].map((u) => base + u);
  const fetches = urls.map((u) => fetch(u, { cache: 'force-cache' }).then((r) => r.arrayBuffer()).catch(() => {}));
  return Promise.race([
    Promise.allSettled(fetches),
    new Promise((r) => setTimeout(r, 20000)), // safety cap
  ]);
}

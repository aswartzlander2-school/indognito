// First-visit initialization: a 25×25 SVG grid fills the background and follows the real
// initialization tasks (flashing yellow = scheduled, solid yellow = processing, green = done,
// blue = final state), with a centered glass card on top. No color legend — the grid is decorative.
import { api, h } from '../core.js';

const N = 25, CELLS = N * N;

export function showInit(mount, status) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${N} ${N}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'init-grid');
  svg.setAttribute('aria-hidden', 'true');
  const rects = [];
  for (let i = 0; i < CELLS; i++) {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', (i % N) + 0.08); r.setAttribute('y', Math.floor(i / N) + 0.08);
    r.setAttribute('width', 0.84); r.setAttribute('height', 0.84);
    r.setAttribute('class', 's');
    r.style.animationDelay = `${(Math.random() * 1.1).toFixed(2)}s`;
    svg.append(r); rects.push(r);
  }
  const errLine = h('p', { class: 'err hidden' });
  const glass = h('div', { class: 'glass-card', role: 'status' },
    h('h1', {}, 'Setting up Indognito.'), h('p', {}, 'This will take a minute.'), errLine);
  const live = h('div', { class: 'sr', 'aria-live': 'polite' }); // screen-reader progress only
  mount(h('div', { class: 'screen init-screen' }, svg, glass, live));

  // Shuffle cells, then give each real task a contiguous slice of the shuffled order.
  const order = [...Array(CELLS).keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let tasks = status.tasks;
  const slice = (t) => { const a = Math.floor((t * CELLS) / tasks.length), b = Math.floor(((t + 1) * CELLS) / tasks.length); return order.slice(a, b); };
  const shown = new Array(CELLS).fill('s'); // what each cell currently shows
  let finished = false, failed = false;

  api('api/setup/init', { method: 'POST', body: {} }).catch(() => {});

  const poll = async () => {
    if (finished || failed) return;
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

  // Animation pacing: at most a few cells change per frame, and a cell only turns green after its task is done.
  const step = () => {
    if (failed) return;
    let changed = 0, greens = 0;
    tasks.forEach((t, ti) => {
      const cells = slice(ti);
      for (const c of cells) {
        const want = t.state === 'done' ? 'd' : t.state === 'processing' ? 'p' : 's';
        if (shown[c] === 'd') { greens++; continue; }
        if (shown[c] !== want && changed < 7) {
          if (want === 'd' && shown[c] === 's') { shown[c] = 'p'; } else { shown[c] = want; }
          rects[c].setAttribute('class', shown[c]);
          changed++;
        }
        if (shown[c] === 'd') greens++;
      }
    });
    if (greens === CELLS) return complete();
    setTimeout(step, 28);
  };
  step();

  async function complete() {
    finished = true;
    live.textContent = 'Ready';
    await new Promise((r) => setTimeout(r, 3000));     // wait several seconds on all-green
    for (const r of rects) r.setAttribute('class', 'b'); // all blue at once
    await new Promise((r) => setTimeout(r, 1400));
    location.reload();                                   // reload into onboarding
  }
}

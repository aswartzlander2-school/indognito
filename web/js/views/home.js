// Home screen: a greeting hero, primary action cards, a workspace strip, and app category rows.
import { api, h, icon, appIcon, logo, meter, fmtBytes, state, toast } from '../core.js';
import { go } from '../app.js';
import { userMenu } from './shell.js';

// Warm gradient accents (brand palette) cycled across app tiles.
const APP_BG = [
  'linear-gradient(145deg,#e5322d,#8f1712)', 'linear-gradient(145deg,#ff6a2b,#b33d10)', 'linear-gradient(145deg,#c2410c,#5c1d06)',
  'linear-gradient(145deg,#be123c,#4c0519)', 'linear-gradient(145deg,#d97706,#7c2d12)', 'linear-gradient(145deg,#b91c48,#4c0519)',
];
const ACTIONS = [
  ['browser', 'globe', 'Browser', 'Private, isolated web browsing', 'linear-gradient(145deg,#ff3b30,#b61a14)'],
  ['terminal', 'terminal', 'Terminal', 'A shell in your isolated workspace', 'linear-gradient(145deg,#ff8a2a,#c2410c)'],
  ['files', 'folder', 'Files', 'Your files and downloads', 'linear-gradient(145deg,#f59e0b,#b45309)'],
];

// An app tile: a white icon chip at the top, name + description below — no overlap, consistent height.
function tile(app, desc, bg, onclick) {
  return h('button', { class: 'tile', style: { '--tile-bg': bg }, onclick, 'aria-label': `${app.name}: ${desc}` },
    h('span', { class: 'tile-ic' }, appIcon(app)),
    h('span', { class: 'tile-text' }, h('b', {}, app.name), h('small', {}, desc)));
}

function actionCard(route, ic, title, desc, grad) {
  return h('button', { class: 'action', style: { '--act-bg': grad }, onclick: () => go(route), 'aria-label': `${title}: ${desc}` },
    h('span', { class: 'action-ic' }, icon(ic)),
    h('span', { class: 'action-text' }, h('b', {}, title), h('small', {}, desc)),
    h('span', { class: 'action-go', 'aria-hidden': 'true' }, icon('fwd')));
}

export async function showHome(mount) {
  const u = state.user;
  const clock = h('span', { class: 'hero-clock' });
  const dateEl = h('span', { class: 'hero-date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  tick();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const stats = { storage: h('div', { class: 'stat' }), ram: h('div', { class: 'stat' }), cpu: h('div', { class: 'stat' }) };
  const runtimeNote = h('p', { class: 'runtime-note faint' });
  const canAdmin = u.isOwner || u.perms.length > 0;
  const iconBtn = (ic, label, route) => h('button', { class: 'btn icon ghost', 'aria-label': label, title: label, onclick: () => go(route) }, icon(ic));

  const rows = h('div', { class: 'app-rows' });
  const main = h('main', { class: 'main home' },
    h('section', { class: 'hero' },
      h('div', { class: 'hero-text' }, h('h1', { class: 'hero-greet' }, greeting, ', ', h('span', { class: 'hero-name' }, u.username)),
        h('div', { class: 'hero-sub' }, dateEl)),
      h('div', { class: 'hero-end' }, clock)),
    h('section', { class: 'actions', 'aria-label': 'Open an app' }, ...ACTIONS.map((a) => actionCard(...a))),
    h('section', { class: 'ws-strip', 'aria-labelledby': 'ws-title' },
      h('div', { class: 'ws-head' }, h('h2', { id: 'ws-title' }, 'My Workspace'), h('span', { class: 'pill' }, u.roleName)),
      h('div', { class: 'stats' }, stats.storage, stats.ram, stats.cpu),
      runtimeNote),
    rows);

  const shell = h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, logo('sm'), h('span', { class: 'grow' }),
      iconBtn('settings', 'Settings', 'settings'), canAdmin ? iconBtn('shield', 'Administration', 'admin') : null, userMenu()),
    main);
  let timer;
  mount(shell, () => clearInterval(timer));
  setTimeout(() => shell.querySelector('.action')?.focus({ preventScroll: true }), 50);

  const refresh = async () => {
    tick();
    try {
      const s = await api('api/workspace/stats');
      const st = (el, k, v, sub, m) => el.replaceChildren(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, ' ', h('small', {}, sub)), m);
      st(stats.storage, 'Storage', fmtBytes(s.storage.used), `of ${fmtBytes(s.storage.max)}`, meter(s.storage.used, s.storage.max));
      st(stats.ram, 'RAM', s.ram.measured ? fmtBytes(s.ram.used) : 'n/a', `of ${fmtBytes(s.ram.max)}`, meter(s.ram.used, s.ram.max));
      st(stats.cpu, 'CPU', s.cpu.measured ? `${s.cpu.percent}%` : 'n/a', `limit ${s.cpu.max}%`, meter(s.cpu.percent, s.cpu.max));
      const drv = { sandbox: 'sandboxed (bubblewrap)', process: 'unsandboxed process', microvm: 'isolated Linux microVM' }[s.runtime.driver] || s.runtime.driver;
      runtimeNote.textContent = `Runtime: ${drv} · ${s.runtime.limits === 'cgroup' ? 'kernel-enforced limits' : 'monitored limits'} · ` +
        `${s.terminals.open}/${s.terminals.max} terminals · ${s.browser.open}/${s.browser.max} browser sessions`;
    } catch (e) { if (e.status !== 401) runtimeNote.textContent = e.message; }
  };
  refresh();
  timer = setInterval(refresh, 4000);

  try {
    const { apps } = await api('api/apps');
    const cats = [...new Set(apps.map((a) => a.category))];
    let n = 0;
    rows.replaceChildren(...cats.map((c) => h('section', { class: 'app-cat' },
      h('h3', { class: 'row-title' }, c),
      h('div', { class: 'tiles' }, apps.filter((a) => a.category === c).map((a) => tile(a, a.description || new URL(a.url).hostname, APP_BG[n++ % APP_BG.length],
        () => { sessionStorage.setItem('gnito.open', a.url); go('browser'); }))))));
    if (!apps.length) rows.append(h('p', { class: 'muted' }, 'No applications yet. Administrators can add them in Administration → Applications.'));
  } catch (e) { toast(e.message, true); }
}

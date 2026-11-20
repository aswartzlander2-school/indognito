// Home screen: "My Workspace" dashboard + TV-style tile rows.
import { api, h, icon, logo, meter, fmtBytes, state, toast } from '../core.js';
import { go } from '../app.js';
import { userMenu } from './shell.js';

const _TILE_BG = {
  browser: 'linear-gradient(140deg,#ff3b30,#c41f1a)', terminal: 'linear-gradient(140deg,#3a2a26,#1b1311)',
  files: 'linear-gradient(140deg,#ff8a2a,#d4561a)', workspace: 'linear-gradient(140deg,#7c3aed55,#2a1a3a)',
  apps: 'linear-gradient(140deg,#ffb02e,#e0661c)', settings: 'linear-gradient(140deg,#4a3a36,#241a17)',
  admin: 'linear-gradient(140deg,#2563eb,#1e3a8a)',
};
const APP_BG = ['linear-gradient(140deg,#e5322d,#8f1712)', 'linear-gradient(140deg,#ff6a2b,#b33d10)', 'linear-gradient(140deg,#c2410c,#5c1d06)',
  'linear-gradient(140deg,#be123c,#4c0519)', 'linear-gradient(140deg,#9a3412,#431407)', 'linear-gradient(140deg,#b45309,#451a03)'];

function tile(name, desc, ic, bg, onclick) {
  return h('button', { class: 'tile', style: { '--tile-bg': bg }, onclick, 'aria-label': `${name}: ${desc}` }, icon(ic), h('b', {}, name), h('small', {}, desc));
}

export async function showHome(mount) {
  const clock = h('span', { class: 'clock' });
  const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick();
  const stats = {
    storage: h('div', { class: 'stat' }), ram: h('div', { class: 'stat' }), cpu: h('div', { class: 'stat' }),
  };
  const runtimeNote = h('p', { class: 'faint', style: { margin: '12px 0 0', fontSize: '13px' } });
  const u = state.user;
  const canAdmin = u.isOwner || u.perms.length > 0;

  const rows = h('div', {});
  const iconBtn = (ic, label, route) => h('button', { class: 'btn icon ghost', 'aria-label': label, title: label, onclick: () => go(route) }, icon(ic));
  const main = h('main', { class: 'main' },
    h('section', { class: 'ws', 'aria-labelledby': 'ws-title' },
      h('div', { class: 'ws-card' },
        h('h2', { id: 'ws-title' }, 'My Workspace'),
        h('div', { class: 'muted' }, `Signed in as ${u.username} · ${u.roleName}`),
        h('div', { class: 'stats' }, stats.storage, stats.ram, stats.cpu), runtimeNote),
      h('div', { class: 'shortcuts' },
        h('button', { class: 'shortcut', onclick: () => go('browser') }, icon('globe'), 'Browser'),
        h('button', { class: 'shortcut', onclick: () => go('terminal') }, icon('terminal'), 'Terminal'),
        h('button', { class: 'shortcut', onclick: () => go('files') }, icon('folder'), 'Files'))),
    rows);

  const shell = h('div', { class: 'shell' },
    h('header', { class: 'topbar' }, logo('sm'), h('span', { class: 'grow' }), clock,
      iconBtn('settings', 'Settings', 'settings'), canAdmin ? iconBtn('shield', 'Administration', 'admin') : null, userMenu()),
    main);
  let timer;
  mount(shell, () => clearInterval(timer));
  setTimeout(() => shell.querySelector('.shortcut')?.focus({ preventScroll: true }), 50);

  const refresh = async () => {
    tick();
    try {
      const s = await api('api/workspace/stats');
      const st = (el, k, v, sub, m) => el.replaceChildren(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, ' ', h('small', {}, sub)), m);
      st(stats.storage, 'Storage', fmtBytes(s.storage.used), `of ${fmtBytes(s.storage.max)}`, meter(s.storage.used, s.storage.max));
      st(stats.ram, 'RAM', s.ram.measured ? fmtBytes(s.ram.used) : 'n/a', `of ${fmtBytes(s.ram.max)}`, meter(s.ram.used, s.ram.max));
      st(stats.cpu, 'CPU', s.cpu.measured ? `${s.cpu.percent}%` : 'n/a', `limit ${s.cpu.max}%`, meter(s.cpu.percent, s.cpu.max));
      const drv = { sandbox: 'sandboxed (bubblewrap)', process: 'unsandboxed process', microvm: 'isolated Linux microVM' }[s.runtime.driver] || s.runtime.driver;
      runtimeNote.textContent = `Runtime: ${drv} · limits: ${s.runtime.limits === 'cgroup' ? 'enforced by the kernel' : 'enforced by monitoring'} · ` +
        `${s.terminals.open}/${s.terminals.max} terminals · ${s.browser.open}/${s.browser.max} browser sessions. RAM and CPU are measured from your running terminal processes.`;
    } catch (e) { if (e.status !== 401) runtimeNote.textContent = e.message; }
  };
  refresh();
  timer = setInterval(refresh, 4000);

  try {
    const { apps } = await api('api/apps');
    const cats = [...new Set(apps.map((a) => a.category))];
    let n = 0;
    rows.replaceChildren(...cats.map((c) => [
      h('h3', { class: 'row-title' }, c),
      h('div', { class: 'tiles' }, apps.filter((a) => a.category === c).map((a) => tile(a.name, a.description || new URL(a.url).hostname, a.icon, APP_BG[n++ % APP_BG.length],
        () => { sessionStorage.setItem('gnito.open', a.url); go('browser'); }))),
    ]).flat());
    if (!apps.length) rows.append(h('p', { class: 'muted' }, 'No applications yet. Administrators can add them in Administration → Applications.'));
  } catch (e) { toast(e.message, true); }
}

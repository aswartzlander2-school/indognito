// Indognito web app entry: decides between the init animation, onboarding, sign-in and the home screen.
import { api, h, icon, state, toast } from './core.js';
import { showInit } from './views/init.js';
import { showOnboarding, showLogin } from './views/onboarding.js';

const root = document.getElementById('app');
let cleanup = null;

export function mount(node, onLeave) {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } }
  cleanup = onLeave || null;
  root.replaceChildren(node);
  dismissBoot();
}

// Warn when the browser↔server connection is plain http to a remote host (password/data exposed).
function showInsecureWarning() {
  if (document.querySelector('.insecure-bar') || sessionStorage.getItem('gnito.insecureDismissed')) return;
  const bar = h('div', { class: 'insecure-bar', role: 'alert' },
    icon('shield'),
    h('span', {}, h('b', {}, 'This connection isn’t encrypted. '), 'You’re on http, so your password and data could be read in transit. Put Indognito behind HTTPS (a reverse proxy, or run ', h('code', { class: 'mono' }, 'gnito tls --self-signed'), ' on the host).'),
    h('button', { class: 'btn sm ghost', onclick: () => { bar.remove(); sessionStorage.setItem('gnito.insecureDismissed', '1'); } }, 'Dismiss'));
  document.body.append(bar);
}

// Fade out the instant boot splash once the first real screen is on-screen.
function dismissBoot() {
  const boot = document.getElementById('boot');
  if (!boot || boot.classList.contains('gone')) return;
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 400);
}

// Each view (and its own dependencies) is a separate module loaded only when first navigated to,
// so the sign-in/home path never downloads the admin, files, terminal or browser code up front.
const routes = {
  home: () => import('./views/home.js').then((m) => m.showHome),
  browser: () => import('./views/browser.js').then((m) => m.showBrowser),
  terminal: () => import('./views/terminal.js').then((m) => m.showTerminal),
  files: () => import('./views/files.js').then((m) => m.showFiles),
  admin: () => import('./views/admin.js').then((m) => m.showAdmin),
  settings: () => import('./views/settings.js').then((m) => m.showSettings),
  workspace: () => import('./views/home.js').then((m) => m.showHome),
  apps: () => import('./views/home.js').then((m) => m.showHome),
};

export function go(route) { if (location.hash !== '#/' + route) location.hash = '#/' + route; else route_(); }

// Once the user is in, warm the common view modules during idle time so navigating to them is
// instant — without adding their weight to the initial page load.
let prefetched = false;
function prefetchViews() {
  if (prefetched) return; prefetched = true;
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => { for (const n of ['browser', 'terminal', 'files', 'settings']) routes[n]?.().catch(() => {}); });
}

async function route_() {
  if (!state.user) return;
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const loader = routes[name] || routes.home;
  try { const view = await loader(); await view(mount, rest.join('/')); }
  catch (e) { console.error(e); toast(e.message, true); }
}

async function boot() {
  let status;
  try { status = await api('api/setup/status'); }
  catch {
    root.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'errpage', role: 'alert' },
      h('div', { class: 'code' }, 'INDOGNITO · backend-unreachable'),
      h('h1', {}, 'The Indognito backend isn’t responding'),
      h('p', {}, 'The web interface loaded, but the backend server didn’t answer. It may still be starting, or it crashed. On the host, run ', h('code', { class: 'mono' }, 'gnito status'), ' or ', h('code', { class: 'mono' }, 'gnito logs'), '.'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again'))));
    dismissBoot();
    return;
  }
  state.version = status.version;
  if (status.insecure) showInsecureWarning();
  if (!status.initialized) return showInit(mount, status);
  if (!status.hasOwner) return showOnboarding(mount, status);
  try {
    const me = await api('api/auth/me');
    Object.assign(state, { user: me.user, limits: me.limits });
  } catch { return showLogin(mount); }
  if (!location.hash || location.hash === '#/') location.hash = '#/home';
  route_();
  prefetchViews();
}

window.addEventListener('hashchange', route_);
window.addEventListener('gnito:signedout', () => { if (state.user) { state.user = null; toast('You were signed out.', true); showLogin(mount); } });
window.addEventListener('gnito:signedin', (e) => { Object.assign(state, e.detail); location.hash = '#/home'; route_(); prefetchViews(); });

// Arrow-key focus movement between tiles (TV-style navigation).
document.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const a = document.activeElement;
  if (!a || !a.matches('.tile, .action')) return;
  const items = [...document.querySelectorAll('.tile, .action')];
  const r0 = a.getBoundingClientRect();
  const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
  let best = null, bestD = Infinity;
  for (const el of items) {
    if (el === a) continue;
    const r = el.getBoundingClientRect(); const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const dx = c.x - c0.x, dy = c.y - c0.y;
    const ok = { ArrowLeft: dx < -5, ArrowRight: dx > 5, ArrowUp: dy < -5, ArrowDown: dy > 5 }[e.key];
    if (!ok) continue;
    const d = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 3;
    if (d < bestD) { bestD = d; best = el; }
  }
  if (best) { e.preventDefault(); best.focus(); best.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
});

boot();

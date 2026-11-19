// Indognito web app entry: decides between the init animation, onboarding, sign-in and the home screen.
import { api, h, state, toast } from './core.js';
import { showInit } from './views/init.js';
import { showOnboarding, showLogin } from './views/onboarding.js';
import { showHome } from './views/home.js';
import { showBrowser } from './views/browser.js';
import { showTerminal } from './views/terminal.js';
import { showFiles } from './views/files.js';
import { showAdmin } from './views/admin.js';
import { showSettings } from './views/settings.js';

const root = document.getElementById('app');
let cleanup = null;

export function mount(node, onLeave) {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } }
  cleanup = onLeave || null;
  root.replaceChildren(node);
}

const routes = {
  home: showHome, browser: showBrowser, terminal: showTerminal, files: showFiles,
  admin: showAdmin, settings: showSettings, workspace: showHome, apps: showHome,
};

export function go(route) { if (location.hash !== '#/' + route) location.hash = '#/' + route; else route_(); }

async function route_() {
  if (!state.user) return;
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const view = routes[name] || showHome;
  try { await view(mount, rest.join('/')); } catch (e) { console.error(e); toast(e.message, true); }
}

async function boot() {
  let status;
  try { status = await api('api/setup/status'); }
  catch { root.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'errpage' }, h('div', { class: 'code' }, 'INDOGNITO · backend-unreachable'), h('h1', {}, 'The Indognito backend is not responding'), h('p', {}, 'The web interface loaded, but the backend server did not answer. On the host, run "gnito status" or "gnito logs".')))); return; }
  state.version = status.version;
  if (!status.initialized) return showInit(mount, status);
  if (!status.hasOwner) return showOnboarding(mount, status);
  try {
    const me = await api('api/auth/me');
    Object.assign(state, { user: me.user, limits: me.limits });
  } catch { return showLogin(mount); }
  if (!location.hash || location.hash === '#/') location.hash = '#/home';
  route_();
}

window.addEventListener('hashchange', route_);
window.addEventListener('gnito:signedout', () => { if (state.user) { state.user = null; toast('You were signed out.', true); showLogin(mount); } });
window.addEventListener('gnito:signedin', (e) => { Object.assign(state, e.detail); location.hash = '#/home'; route_(); });

// Arrow-key focus movement between tiles (TV-style navigation).
document.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const a = document.activeElement;
  if (!a || !a.matches('.tile, .shortcut')) return;
  const items = [...document.querySelectorAll('.tile, .shortcut')];
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

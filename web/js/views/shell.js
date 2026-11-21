// Shared chrome for app views: header with back-to-home, and the user menu.
import { api, h, icon, state } from '../core.js';
import { go } from '../app.js';
import { lockHistory } from '../crypto.js';

export function appHeader(title, ic, ...right) {
  return h('header', { class: 'app-head' },
    h('button', { class: 'btn ghost sm', onclick: () => go('home'), 'aria-label': 'Back to home' }, icon('home'), 'Home'),
    icon(ic), h('h2', {}, title), h('span', { class: 'grow' }), ...right, userMenu());
}

export function userMenu() {
  const u = state.user;
  const btn = h('button', { class: 'avatar', style: { border: 0, cursor: 'pointer' }, 'aria-label': 'Account menu', 'aria-haspopup': 'menu' }, (u.username[0] || '?').toUpperCase());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector('.menu')?.remove();
    const r = btn.getBoundingClientRect();
    const m = h('div', { class: 'menu', role: 'menu', style: { top: `${r.bottom + 8}px`, right: `${innerWidth - r.right}px`, position: 'fixed' } },
      h('div', { style: { padding: '8px 12px 10px' } }, h('b', {}, u.username), h('div', { class: 'faint', style: { fontSize: '13px' } }, u.roleName)),
      h('button', { role: 'menuitem', onclick: () => go('settings') }, icon('settings'), 'Settings'),
      (u.isOwner || u.perms.length) ? h('button', { role: 'menuitem', onclick: () => go('admin') }, icon('shield'), 'Administration') : null,
      h('button', { role: 'menuitem', onclick: async () => {
        await clearBrowserData();
        await lockHistory(); // forget the zero-knowledge history key on this device
        await api('api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
        location.hash = ''; location.reload();
      } }, icon('logout'), 'Sign out'));
    document.body.append(m);
    m.querySelector('button')?.focus();
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off); } };
    setTimeout(() => document.addEventListener('click', off));
  });
  return btn;
}

// Removes proxied-site cookies and storage kept by the browser engine on this device.
export async function clearBrowserData() {
  // Empty the engine's cookie/redirect stores in place (deleting the database would block while the
  // service worker holds it open).
  try {
    if (!(await indexedDB.databases()).some((d) => d.name === '$scramjet')) return; // opening would create it empty
    const db = await new Promise((res) => { const r = indexedDB.open('$scramjet'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (db) {
      const stores = ['cookies', 'redirectTrackers', 'referrerPolicies'].filter((n) => db.objectStoreNames.contains(n));
      if (stores.length) await new Promise((res) => { const t = db.transaction(stores, 'readwrite'); stores.forEach((n) => t.objectStore(n).clear()); t.oncomplete = t.onerror = () => res(); });
      db.close();
    }
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* best effort */ }
}

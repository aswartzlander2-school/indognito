// Isolated browser: Scramjet (service-worker proxy) + a selectable WASM transport (Epoxy or libcurl)
// over this server's Wisp relay.
// Server capacity is managed by a queue: when all browser slots are busy, the user sees "You're in line."
import { api, h, icon, appIcon, BASE, toast, state, fmtTime, logo, pixelBackground } from '../core.js';
import { userMenu } from './shell.js';
import { historyKey, encryptEntry, decryptEntry } from '../crypto.js';

const ENGINES = {
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'], startpage: ['Startpage', 'https://www.startpage.com/do/search?q=%s'],
  brave: ['Brave Search', 'https://search.brave.com/search?q=%s'], ecosia: ['Ecosia', 'https://www.ecosia.org/search?q=%s'],
  bing: ['Bing', 'https://www.bing.com/search?q=%s'], google: ['Google', 'https://www.google.com/search?q=%s'],
};

let engine = null; // { scramjet, conn, ticket } — the running engine for the current ticket
let enginePromise = null; // memoized setup for the parts that only need to happen once per page lifetime

function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s;
  const tpl = (ENGINES[state.user.searchEngine] || ENGINES.duckduckgo)[1];
  return tpl.replace('%s', encodeURIComponent(s));
}

// A '$scramjet' database created without its object stores (e.g. opened by a worker before the
// controller initialised it) can never be upgraded, so drop it and let the controller recreate it.
async function repairEngineDb() {
  if (!(await indexedDB.databases()).some((d) => d.name === '$scramjet')) return; // opening would create it empty
  const db = await new Promise((res) => { const r = indexedDB.open('$scramjet'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  if (!db) return;
  const ok = db.objectStoreNames.contains('config') && db.objectStoreNames.contains('cookies');
  db.close();
  if (ok) return;
  const done = await new Promise((res) => {
    const r = indexedDB.deleteDatabase('$scramjet');
    r.onsuccess = () => res(true); r.onerror = () => res(false);
    setTimeout(() => res(false), 2500); // blocked by the service worker's open connection
  });
  if (!done) {
    (await navigator.serviceWorker.getRegistration(BASE))?.unregister();
    throw new Error('The browser engine storage had to be reset. Close other Indognito tabs, then reload this page.');
  }
}

// Sets up the controller, the service worker and the bare-mux connection exactly once per page
// lifetime. Re-registering and re-activating the service worker on every visit to the Browser
// view re-opens a startup race in the SW's client/port handshake (the SW asks window clients for
// a bare-mux MessagePort via clients.matchAll(), which is only reliable once the SW has settled
// into actually controlling the page) — so these parts are memoized and only the per-session wisp
// transport is swapped out when a new browser-session ticket is granted.
function setupEngineOnce() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers. Indognito needs HTTPS (or localhost) for its browser.');
    // Order matters: the controller must create its IndexedDB stores before the service worker opens the database.
    await repairEngineDb();
    const { ScramjetController } = $scramjetLoadController();
    const scramjet = new ScramjetController({
      prefix: BASE + 'service/',
      files: { wasm: BASE + 'vendor/scramjet/scramjet.wasm.wasm', all: BASE + 'vendor/scramjet/scramjet.all.js', sync: BASE + 'vendor/scramjet/scramjet.sync.js' },
    });
    await scramjet.init();
    await navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // First registration ever for this tab: the page is not controlled yet; wait for clients.claim().
      await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 3000); });
      // The SW's own client/port bookkeeping needs a moment to settle right after it starts
      // controlling the page — this margin is paid once, not on every Browser visit.
      await new Promise((r) => setTimeout(r, 300));
    }
    // scramjet.init() posts its config to the service worker only if the SW was already controlling
    // the page at that moment — which it is NOT on the first ever load. Without the config the SW
    // crashes on `config.prefix` the first time it proxies a request. Re-push the config now that the
    // SW is definitely controlling, so it is populated regardless of first-load ordering.
    await scramjet.modifyConfig({});
    const v = encodeURIComponent(state.version || '1');
    const conn = new BareMux.BareMuxConnection(`${BASE}vendor/baremux/worker.js?v=${v}`);
    return { scramjet, conn };
  })().catch((e) => { enginePromise = null; throw e; }); // let a failed setup be retried
  return enginePromise;
}

// Client-side transports. Both perform TLS to each website *inside* the page, so this server's
// relay only ever sees encrypted bytes for https sites — the choice is about compatibility and
// performance, not disguising traffic. The admin picks one; the server tells us which per session.
const TRANSPORTS = { epoxy: 'vendor/epoxy/index.mjs', libcurl: 'vendor/libcurl/index.mjs' };

async function startEngine(ticket, transport = 'epoxy') {
  const { scramjet, conn } = await setupEngineOnce();
  const wisp = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}wisp/${ticket}/`;
  const mod = TRANSPORTS[transport] || TRANSPORTS.epoxy;
  await conn.setTransport(`${BASE}${mod}?v=${encodeURIComponent(state.version || '1')}`, [{ wisp }]);
  return { scramjet, conn, ticket };
}

export async function showBrowser(mount) {
  const tabsEl = h('div', { class: 'tabstrip', role: 'tablist', 'aria-label': 'Browser tabs' });
  const addr = h('input', { class: 'input grow', placeholder: `Search with ${(ENGINES[state.user.searchEngine] || ENGINES.duckduckgo)[0]} or type an address`, 'aria-label': 'Address', spellcheck: 'false', autocomplete: 'off' });
  const viewport = h('div', { class: 'viewport' });
  const btn = (ic, label, fn) => h('button', { class: 'btn icon sm ghost', 'aria-label': label, title: label, onclick: fn }, icon(ic));
  // Connection indicator inside the address bar: a lock for https (end-to-end encrypted to the
  // site), a globe otherwise. Honest — it reflects the real scheme, not the proxy hop.
  const secure = h('span', { class: 'secure none', 'aria-hidden': 'true' }, icon('globe'));
  const setSecure = (url) => {
    const https = /^https:/i.test(url || '');
    secure.replaceChildren(icon(https ? 'lock' : 'globe'));
    secure.className = 'secure ' + (https ? 'ok' : url ? 'warn' : 'none');
    secure.title = https ? 'Secure — encrypted end-to-end to this site' : url ? 'Not secure (no https)' : '';
  };
  const addrForm = h('form', { class: 'addr-form', onsubmit: (e) => { e.preventDefault(); navigate(addr.value); } },
    h('div', { class: 'addr-wrap' }, secure, addr));
  const navbar = h('div', { class: 'navbar' },
    btn('back', 'Back', () => cur()?.frame?.back()), btn('fwd', 'Forward', () => cur()?.frame?.forward()),
    btn('reload', 'Reload', () => cur()?.frame?.reload()),
    addrForm, btn('history', 'History', () => toggleHistory()));
  // Thin indeterminate loading bar under the toolbar, shown while the active tab is navigating.
  const loadbar = h('div', { class: 'loadbar', 'aria-hidden': 'true' });
  const setLoading = (on) => loadbar.classList.toggle('on', !!on);
  // Session status: a small dot with a text tooltip instead of a separate header bar.
  const statusDot = h('span', { class: 'dot-status', role: 'status', title: 'Connecting…', 'aria-label': 'Connecting…' });
  const setStatus = (kind, text) => { statusDot.className = 'dot-status ' + kind; statusDot.title = text; statusDot.setAttribute('aria-label', text); };
  const top = h('div', { class: 'topstrip' },
    h('button', { class: 'btn icon sm ghost', 'aria-label': 'Home', title: 'Home', onclick: () => { location.hash = '#/home'; } }, icon('home')),
    tabsEl,
    h('div', { class: 'strip-end' }, statusDot, userMenu()));
  const view = h('div', { class: 'shell' }, h('div', { class: 'browser', style: { flex: 1, minHeight: 0 } }, top, navbar, loadbar, viewport));

  let tabs = [], active = null, hb = null, poll = null, sessionId = null, alive = true, nextId = 1;
  const cur = () => tabs.find((t) => t.id === active);

  const release = () => {
    alive = false; clearInterval(hb); clearTimeout(poll);
    if (sessionId) api(`api/browser/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    if (engine) { engine = null; }
  };
  mount(view, release);

  // ----- session / queue -----
  const overlay = (node) => { viewport.querySelector('.queue')?.remove(); if (node) viewport.append(node); };
  const fail = (code, msg) => {
    const e = GNITO_ERRORS.catalog[code] || GNITO_ERRORS.catalog.network;
    overlay(h('div', { class: 'queue', role: 'alert' }, h('div', { class: 'errpage', style: { textAlign: 'left' } },
      h('div', { class: 'code' }, 'INDOGNITO · ' + code), h('h1', {}, e.title), h('p', {}, e.text),
      h('ul', {}, e.tips.map((t) => h('li', {}, t))),
      msg ? h('details', { class: 'faint' }, h('summary', {}, 'Technical details'), h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap' } }, msg)) : null,
      h('button', { class: 'btn primary', style: { marginTop: '16px' }, onclick: () => location.reload() }, 'Try again'))));
  };

  overlay(h('div', { class: 'queue' }, h('div', {}, h('div', { class: 'dots' }, h('i'), h('i'), h('i')), h('h1', { style: { fontSize: '28px' } }, 'Requesting a browser session…'))));

  async function request() {
    let r;
    try { r = await api('api/browser/sessions', { method: 'POST', body: {} }); }
    catch (e) { setStatus('bad', 'No session'); return overlay(h('div', { class: 'queue' }, h('div', {}, h('h1', { style: { fontSize: '30px' } }, 'Browser unavailable'), h('p', {}, e.message)))); }
    handle(r);
  }

  async function handle(r) {
    if (!alive) return;
    sessionId = r.id;
    if (r.status === 'queued') {
      setStatus('warn', `In line · #${r.position}`);
      overlay(h('div', { class: 'queue', role: 'status' }, h('div', {},
        h('div', { class: 'dots' }, h('i'), h('i'), h('i')),
        h('h1', {}, "You're in line."),
        h('p', {}, `The host machine's servers are busy and cannot process your request. The server will be available in approximately ${r.etaMinutes} minute${r.etaMinutes === 1 ? '' : 's'}.`),
        h('div', { class: 'facts' },
          h('span', { class: 'pill' }, `Position ${r.position}`), h('span', { class: 'pill' }, `${r.active} of ${r.capacity} sessions in use`),
          h('span', { class: 'pill' }, `Average session ${r.averageSessionMinutes} min`)),
        h('p', { class: 'faint', style: { marginTop: '18px', fontSize: '14px' } }, 'Keep this page open — you will be connected automatically.'))));
      poll = setTimeout(async () => {
        try { handle(await api(`api/browser/sessions/${sessionId}`)); } catch { poll = setTimeout(() => request(), 5000); }
      }, 5000);
      return;
    }
    if (r.status === 'expired') return request();
    // active
    try {
      engine = await startEngine(r.ticket, r.transport);
    } catch (e) { return fail('network', e.message); }
    overlay(null);
    setStatus('ok', 'Session active');
    hb = setInterval(async () => {
      try { await api(`api/browser/sessions/${r.ticket}/heartbeat`, { method: 'POST', body: {} }); }
      catch { clearInterval(hb); setStatus('bad', 'Session ended'); fail('session-ended'); }
    }, 30_000);
    const pending = sessionStorage.getItem('gnito.open');
    sessionStorage.removeItem('gnito.open');
    newTab(pending || null);
  }

  // ----- tabs -----
  function favNode(t) {
    const label = t.title || (t.url ? new URL(t.url).hostname : 'New tab');
    if (t.loading) return h('span', { class: 'tab-spin', 'aria-label': 'Loading' });
    if (t.favicon) {
      const img = h('img', { class: 'fav', src: t.favicon, alt: '', width: 18, height: 18 });
      img.addEventListener('error', () => { t.favicon = null; renderTabs(); }, { once: true });
      return img;
    }
    return h('span', { class: 'fav' }, (label[0] || '+').toUpperCase());
  }
  function renderTabs() {
    tabsEl.replaceChildren(...tabs.map((t) => {
      const label = t.title || (t.url ? new URL(t.url).hostname : 'New tab');
      return h('div', { class: 'tab' + (t.id === active ? ' on' : ''), role: 'tab', tabindex: 0, 'aria-selected': t.id === active, title: t.url || 'New tab',
        onclick: () => select(t.id), onkeydown: (e) => { if (e.key === 'Enter') select(t.id); } },
      favNode(t), h('span', { class: 't' }, label),
      h('button', { class: 'x', 'aria-label': `Close ${label}`, onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, icon('x')));
    }), h('button', { class: 'tab-add', 'aria-label': 'New tab', title: 'New tab', onclick: () => newTab() }, '+'));
  }

  // The favicon is read from the proxied document and loaded through the proxy, so it never
  // reaches an external favicon service.
  function readFavicon(t) {
    try {
      const doc = t.iframe.contentDocument;
      const link = doc?.querySelector('link[rel~="icon" i]');
      let href = link?.href || null;
      if (!href && t.url) { try { href = engine.scramjet.encodeUrl(new URL('/favicon.ico', t.url).href); } catch { href = null; } }
      if (href !== t.favicon) { t.favicon = href; return true; }
    } catch { /* same-origin under proxy; ignore */ }
    return false;
  }

  function newTab(url) {
    if (!engine) return;
    const iframe = h('iframe', { title: 'Web page', allow: 'fullscreen; clipboard-write', referrerpolicy: 'no-referrer' });
    const frame = engine.scramjet.createFrame(iframe);
    const t = { id: nextId++, frame, iframe, url: null, title: '', favicon: null };
    frame.addEventListener('urlchange', (e) => {
      t.url = e.url; t.favicon = null; t.loading = true;
      if (t.id === active) { addr.value = e.url; setSecure(e.url); setLoading(true); }
      recordHistory(t);
      renderTabs();
    });
    iframe.addEventListener('load', () => {
      try { t.title = iframe.contentDocument?.title || t.title; } catch { /* cross-origin */ }
      t.loading = false;
      if (t.id === active) setLoading(false);
      readFavicon(t);
      renderTabs(); recordHistory(t);
    });
    tabs.push(t);
    viewport.append(iframe);
    select(t.id);
    if (url) go(t, url); else showNewTab(t);
  }

  function select(id) {
    active = id;
    for (const t of tabs) { t.iframe.style.display = t.id === id ? '' : 'none'; t.ntp && (t.ntp.style.display = t.id === id ? '' : 'none'); }
    const c = cur();
    addr.value = c?.url || '';
    setSecure(c?.url); setLoading(c?.loading);
    renderTabs();
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    t.iframe.remove(); t.ntp?.remove();
    if (!tabs.length) return newTab();
    if (active === id) select(tabs[Math.max(0, i - 1)].id); else renderTabs();
  }

  function go(t, url) {
    t.ntp?.remove(); t.ntp = null;
    t.url = url; t.title = ''; t.loading = true;
    if (t.id === active) { addr.value = url; setSecure(url); setLoading(true); }
    t.frame.go(url);
    renderTabs();
  }

  function navigate(input) {
    const url = toUrl(input);
    if (!url) return;
    const t = cur(); if (t) go(t, url);
  }

  async function showNewTab(t) {
    if (!t) return;
    t.ntp?.remove();
    const search = h('input', { class: 'input', placeholder: `Search with ${(ENGINES[state.user.searchEngine] || ENGINES.duckduckgo)[0]} or type an address`, 'aria-label': 'Search or address', spellcheck: 'false', autocomplete: 'off' });
    const groups = h('div', { class: 'newtab-groups' });
    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const card = h('div', { class: 'center-card newtab-card fade-in' },
      h('div', { class: 'newtab-head' }, logo('lg'),
        h('h2', { class: 'newtab-greet' }, `${greeting}${state.user?.username ? ', ' + state.user.username : ''}`)),
      h('form', { class: 'newtab-search', onsubmit: (e) => { e.preventDefault(); const u = toUrl(search.value); if (u) go(t, u); } }, icon('search'), search),
      groups,
      h('p', { class: 'note' }, 'Pages load through this Indognito server. Secure (https) sites stay encrypted end-to-end. Your administrator’s network policy applies.'));
    t.ntp = h('div', { class: 'newtab' }, pixelBackground(28, 16), card);
    viewport.append(t.ntp);
    t.url = null; t.loading = false; addr.value = ''; setSecure(null); setLoading(false); renderTabs();
    setTimeout(() => search.focus(), 30);
    try {
      const { apps } = await api('api/apps');
      const cats = [...new Set(apps.map((a) => a.category))];
      groups.replaceChildren(...cats.map((c) => h('section', {}, h('h4', {}, c),
        h('div', { class: 'quick' }, apps.filter((a) => a.category === c).map((a) => h('button', { onclick: () => go(t, a.url) }, appIcon(a), a.name))))));
    } catch { /* ignore */ }
  }

  // ----- history -----
  let lastRecorded = '';
  async function recordHistory(t) {
    if (!t.url || t.url === lastRecorded || !/^https?:/.test(t.url)) return;
    lastRecorded = t.url;
    // Encrypt the entry in the browser when a history key is available, so the server stores only
    // ciphertext. Without a key (e.g. a passkey-only sign-in) fall back to plaintext.
    const key = await historyKey(state.user.id).catch(() => null);
    const body = key ? await encryptEntry(key, { url: t.url, title: t.title }).catch(() => null) : { url: t.url, title: t.title };
    if (body) api('api/browser/history', { method: 'POST', body }).catch(() => {});
  }
  async function toggleHistory() {
    const open = viewport.querySelector('.side-panel');
    if (open) return open.remove();
    const list = h('div', { class: 'list' }, h('p', { class: 'faint', style: { padding: '8px' } }, 'Loading…'));
    const panel = h('aside', { class: 'side-panel', 'aria-label': 'History' },
      h('header', {}, icon('history'), h('b', { class: 'grow' }, 'History'),
        h('button', { class: 'btn sm danger', onclick: async () => { await api('api/browser/history', { method: 'DELETE' }); toast('History cleared'); load(); } }, 'Clear all'),
        h('button', { class: 'btn sm icon ghost', 'aria-label': 'Close', onclick: () => panel.remove() }, icon('x'))), list);
    viewport.append(panel);
    const load = async () => {
      const { history } = await api('api/browser/history');
      const key = await historyKey(state.user.id).catch(() => null);
      // Decrypt zero-knowledge entries client-side; rows we can't unlock (no password key on this
      // device, or stored under an old key) are shown as a locked placeholder.
      const items = [];
      for (const x of history) {
        let url = x.url, title = x.title, locked = false;
        if (x.enc) {
          if (key) { try { const d = await decryptEntry(key, x.iv, x.ct); url = d.url; title = d.title; } catch { locked = true; } }
          else locked = true;
        }
        items.push({ id: x.id, ts: x.ts, url, title, locked });
      }
      const host = (u) => { try { return new URL(u).hostname; } catch { return u; } };
      list.replaceChildren(...(items.length ? items.map((x) => x.locked
        ? h('div', { class: 'hist-item' }, h('div', {}, h('b', {}, icon('lock'), ' Encrypted entry'), h('small', {}, `Sign in with your password to read · ${fmtTime(x.ts)}`)),
          h('button', { class: 'btn sm icon ghost', 'aria-label': 'Remove', onclick: async (e) => { e.stopPropagation(); await api(`api/browser/history/${x.id}`, { method: 'DELETE' }); load(); } }, icon('x')))
        : h('div', { class: 'hist-item', onclick: () => { const c = cur(); if (c) go(c, x.url); panel.remove(); } },
          h('div', {}, h('b', {}, x.title || host(x.url)), h('small', {}, `${x.url} · ${fmtTime(x.ts)}`)),
          h('button', { class: 'btn sm icon ghost', 'aria-label': 'Remove', onclick: async (e) => { e.stopPropagation(); await api(`api/browser/history/${x.id}`, { method: 'DELETE' }); load(); } }, icon('x'))))
        : [h('p', { class: 'faint', style: { padding: '8px' } }, 'No history. You can turn history off in Settings.')]));
    };
    load();
  }

  renderTabs();
  request();
}

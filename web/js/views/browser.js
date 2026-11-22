// Isolated browser: Scramjet (service-worker proxy) + a selectable WASM transport (Epoxy or libcurl)
// over this server's Wisp relay.
// Server capacity is managed by a queue: when all browser slots are busy, the user sees "You're in line."
import { api, h, icon, appIcon, BASE, toast, state, fmtTime, logo, pixelBackground, loadScript } from '../core.js';
import { userMenu } from './shell.js';
import { historyKey, encryptEntry, decryptEntry } from '../crypto.js';

const ENGINES = {
  duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'], startpage: ['Startpage', 'https://www.startpage.com/do/search?q=%s'],
  brave: ['Brave Search', 'https://search.brave.com/search?q=%s'], ecosia: ['Ecosia', 'https://www.ecosia.org/search?q=%s'],
  bing: ['Bing', 'https://www.bing.com/search?q=%s'], google: ['Google', 'https://www.google.com/search?q=%s'],
};

let engine = null; // { controller, ticket } — the running Scramjet controller for the current ticket
let swPromise = null; // registers the service worker + loads the engine scripts exactly once per page

function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) && !s.includes(' ')) return 'https://' + s;
  const tpl = (ENGINES[state.user.searchEngine] || ENGINES.duckduckgo)[1];
  return tpl.replace('%s', encodeURIComponent(s));
}

// Load the Scramjet core (sets the $scramjet global) and the controller API (sets $scramjetController),
// then register the service worker — once per page lifetime. Returns the active ServiceWorker, which
// the controller drives over a MessagePort.
function setupSWOnce() {
  if (swPromise) return swPromise;
  swPromise = (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers. Indognito needs HTTPS (or localhost) for its browser.');
    await loadScript('vendor/scramjet/scramjet.js');
    await loadScript('vendor/controller/controller.api.js');
    await navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE });
    await navigator.serviceWorker.ready;
    // The controller↔SW handshake only works with the worker that actually CONTROLS this page
    // (postMessage to a merely-"active" registration can land on a different instance). Wait for
    // control; if it doesn't arrive (first registration ever), reload once so the fresh load is
    // controlled from the start — this happens at most once per device.
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 4000); });
    }
    if (!navigator.serviceWorker.controller) {
      if (!sessionStorage.getItem('gnito.swReloaded')) { sessionStorage.setItem('gnito.swReloaded', '1'); location.reload(); await new Promise(() => {}); }
      throw new Error('The browser engine could not take control of this page. Reload and try again.');
    }
    sessionStorage.removeItem('gnito.swReloaded');
    return navigator.serviceWorker.controller;
  })().catch((e) => { swPromise = null; throw e; }); // let a failed setup be retried
  return swPromise;
}

// Client-side transports. Both perform TLS to each website *inside* the page, so this server's relay
// only ever sees encrypted bytes for https sites — the choice is about compatibility and performance,
// not disguising traffic. The admin or the user picks one; the server tells us which per session.
const TRANSPORTS = { epoxy: 'vendor/epoxy/index.mjs', libcurl: 'vendor/libcurl/index.mjs' };

async function startEngine(ticket, transport = 'epoxy') {
  const sw = await setupSWOnce();
  const wisp = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}wisp/${ticket}/`;
  const mod = TRANSPORTS[transport] || TRANSPORTS.epoxy;
  const v = encodeURIComponent(state.version || '1');
  const TransportClass = (await import(`${BASE}${mod}?v=${v}`)).default;
  const tp = new TransportClass({ wisp });
  const { Controller } = $scramjetController;
  const controller = new Controller({
    serviceworker: sw,
    transport: tp,
    config: {
      prefix: BASE + 'service/',
      scramjetPath: BASE + 'vendor/scramjet/scramjet.js',
      injectPath: BASE + 'vendor/controller/controller.inject.js',
      wasmPath: BASE + 'vendor/scramjet/scramjet.wasm',
    },
  });
  await controller.wait();
  return { controller, ticket };
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

  let tabs = [], active = null, hb = null, poll = null, syncTimer = null, sessionId = null, alive = true, nextId = 1;
  const cur = () => tabs.find((t) => t.id === active);

  const release = () => {
    alive = false; clearInterval(hb); clearTimeout(poll); clearInterval(syncTimer);
    if (sessionId) api(`api/browser/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    if (engine) { engine = null; }
  };
  mount(view, release);
  // Catch in-page (SPA) navigations the iframe 'load' event misses.
  syncTimer = setInterval(() => { const c = cur(); if (c && engine) syncFrame(c); }, 1200);

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

  // Opens a short-lived WebSocket to this server's relay for our ticket. Resolves true if it
  // connects (relay reachable), false if it errors or doesn't open within a few seconds (blocked
  // or down). Cookies ride along for auth; we close it immediately — the real transport opens its own.
  function probeRelay(ticket) {
    return new Promise((resolve) => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}wisp/${ticket}/`;
      let ws;
      const done = (ok) => { clearTimeout(timer); if (ws) { ws.onopen = ws.onerror = ws.onclose = null; try { ws.close(); } catch { /* ignore */ } } resolve(ok); };
      const timer = setTimeout(() => done(false), 6000);
      try { ws = new WebSocket(url); } catch { return done(false); }
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
    });
  }

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
    // active — first confirm the relay WebSocket is actually reachable. If it's blocked or down
    // (e.g. a firewall between the user and this server drops the WebSocket), say so clearly and
    // stop, instead of loading a tab that silently never connects.
    overlay(h('div', { class: 'queue' }, h('div', {}, h('div', { class: 'dots' }, h('i'), h('i'), h('i')), h('h1', { style: { fontSize: '26px' } }, 'Connecting to the relay…'))));
    if (!(await probeRelay(r.ticket))) { setStatus('bad', 'Relay unreachable'); return fail('relay-unreachable'); }
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

  // The proxied page is served from this origin, so its <link rel="icon"> href is already a
  // same-origin (proxied) URL that loads through the service worker — use it directly. That keeps the
  // tab favicon within the page's CSP (img-src 'self') instead of hitting the site directly.
  function readFavicon(t) {
    try {
      const doc = t.iframe.contentDocument;
      const link = doc?.querySelector('link[rel~="icon" i], link[rel~="shortcut" i]');
      const href = link?.href || null;
      if (href !== t.favicon) { t.favicon = href; return true; }
    } catch { /* cross-origin edge under proxy */ }
    return false;
  }

  // Turn a proxied frame URL (<origin><BASE>service/<controller>/<frame>/<encoded real url>) back
  // into the real address for the tab/address bar.
  function decodeProxied(href) {
    try {
      const u = new URL(href);
      const marker = BASE + 'service/';
      if (u.origin !== location.origin || !u.pathname.startsWith(marker)) return null;
      const enc = u.pathname.slice(marker.length).split('/').slice(2).join('/'); // drop controller + frame ids
      if (!enc) return null;
      const real = decodeURIComponent(enc) + (u.search || '') + (u.hash || '');
      return /^https?:\/\//i.test(real) ? real : null;
    } catch { return null; }
  }

  // Scramjet 2.x has no urlchange event, but the proxied iframe is same-origin, so we read its real
  // location (decoded) and title on load and on a short poll (to catch in-page SPA navigations).
  function syncFrame(t) {
    try {
      const href = t.iframe.contentWindow?.location?.href;
      if (!href) return;
      const real = decodeProxied(href);
      if (real && real !== t.url) {
        t.url = real; t.favicon = null;
        if (t.id === active) { addr.value = real; setSecure(real); }
        recordHistory(t); renderTabs();
      }
      const title = t.iframe.contentDocument?.title;
      if (title && title !== t.title) { t.title = title; renderTabs(); }
    } catch { /* cross-origin edge under proxy */ }
  }

  function newTab(url) {
    if (!engine) return;
    const iframe = h('iframe', { title: 'Web page', allow: 'fullscreen; clipboard-write', referrerpolicy: 'no-referrer' });
    const frame = engine.controller.createFrame(iframe);
    const t = { id: nextId++, frame, iframe, url: null, title: '', favicon: null, loading: false };
    iframe.addEventListener('load', () => {
      t.loading = false;
      if (t.id === active) setLoading(false);
      syncFrame(t);
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

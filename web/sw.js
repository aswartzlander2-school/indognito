// Indognito service worker: runs the Scramjet proxy for the Browser and replaces Scramjet's
// default error page with Indognito's centralized error pages.
importScripts('vendor/scramjet/scramjet.all.js', 'js/errors-catalog.js');
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const BASE = new URL('./', self.location).pathname;
const PREFIX = self.location.origin + BASE + 'service/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function handle(event) {
  const url = event.request.url;
  let routed = false;
  if (url.startsWith(PREFIX)) {
    try {
      // The config normally arrives by postMessage from the controller; if it has not yet (first
      // load ordering), fall back to reading it from IndexedDB, retrying briefly for the write.
      for (let i = 0; i < 20 && !scramjet.config; i++) { await scramjet.loadConfig().catch(() => {}); if (!scramjet.config) await new Promise((r) => setTimeout(r, 100)); }
      routed = !!scramjet.config && scramjet.route(event);
      if (url.startsWith(PREFIX) && !scramjet.config) throw new Error('browser engine not ready');
    }
    catch (e) { return new Response(GNITO_ERRORS.render('session-ended', '', String(e)), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }); }
  }
  if (routed) {
    let res;
    try { res = await scramjet.fetch(event); }
    catch (e) {
      // A transport-layer failure (e.g. the bare-mux worker port handshake, which can briefly
      // fail right after the service worker first starts controlling the page) throws here
      // instead of returning a response. Render our own page rather than letting the browser's
      // raw network-error page leak through.
      const isDoc = event.request.destination === 'document' || event.request.destination === 'iframe';
      if (!isDoc) return new Response('', { status: 502 });
      return new Response(GNITO_ERRORS.render(GNITO_ERRORS.classify(String(e && e.message || e)), '', String(e && e.stack || e)),
        { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (res.status === 500 && (event.request.destination === 'document' || event.request.destination === 'iframe') &&
        res.headers.get('content-type') === 'text/html' && [...res.headers.keys()].length <= 2) {
      const body = await res.clone().text();
      if (body.includes('Scramjet v')) {
        let detail = '';
        const m = /data:application\/javascript,([^"]+)"/.exec(body);
        if (m) { try { detail = decodeURIComponent(m[1]); } catch { /* ignore */ } }
        const m2 = /errorTrace\.value = (.*);\s*\n\s*fetchedURL\.textContent = (.*);/.exec(detail);
        let msg = detail, target = '';
        if (m2) { try { msg = JSON.parse(m2[1]); target = JSON.parse(m2[2]); } catch { /* keep raw */ } }
        return new Response(GNITO_ERRORS.render(GNITO_ERRORS.classify(msg), target, msg), { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }
    return res;
  }
  // Defense in depth: proxied pages must not reach Indognito's own API with the user's cookies.
  if (event.clientId && new URL(url).origin === self.location.origin && new URL(url).pathname.startsWith(BASE + 'api/')) {
    const client = await self.clients.get(event.clientId);
    if (client && client.url.startsWith(PREFIX)) return new Response('Blocked by Indognito', { status: 403 });
  }
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => event.respondWith(handle(event)));

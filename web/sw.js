// Indognito service worker (Scramjet 2.x). Loads the Scramjet core rewriter and the Scramjet
// controller's service-worker half, then lets the controller route proxied traffic. The controller
// (in the page) hands this worker its config, wasm and transport at runtime over a MessagePort.

// Scramjet 2.1.0's core captures `URL.createObjectURL.bind(...)` at load, but that API doesn't exist
// in a ServiceWorker, so the import would throw and the worker would never evaluate. Stub it before
// importing — the SW routing path never creates blob URLs (that happens on the window side).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => { throw new Error('URL.createObjectURL is not available in a service worker'); };
  URL.revokeObjectURL = () => {};
}

importScripts('vendor/scramjet/scramjet.js', 'vendor/controller/controller.sw.js', 'js/errors-catalog.js');

const { shouldRoute, route } = $scramjetController;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const BASE = new URL('./', self.location).pathname;
const ORIGIN = self.location.origin;

async function handle(event) {
  if (shouldRoute(event)) {
    try {
      return await route(event);
    } catch (e) {
      const isDoc = event.request.destination === 'document' || event.request.destination === 'iframe';
      const body = GNITO_ERRORS.render(GNITO_ERRORS.classify(String(e && e.message || e)), '', String(e && e.stack || e));
      return new Response(isDoc ? body : '', { status: 502, headers: isDoc ? { 'content-type': 'text/html; charset=utf-8' } : {} });
    }
  }
  // Defense in depth: a proxied page must never reach Indognito's own API with the user's cookies.
  const u = new URL(event.request.url);
  if (event.clientId && u.origin === ORIGIN && u.pathname.startsWith(BASE + 'api/')) {
    const client = await self.clients.get(event.clientId);
    if (client && client.url.startsWith(ORIGIN + BASE + 'service/')) return new Response('Blocked by Indognito', { status: 403 });
  }
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => event.respondWith(handle(event)));

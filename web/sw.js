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
const SERVICE = BASE + 'service/';

// Shown in an iframe that asked for a proxied page while our routing registry was still cold; it
// reloads itself once, by which time the controller has re-registered. Self-heals without a 404.
const RECONNECT_HTML = '<!doctype html><meta charset="utf-8"><title>Reconnecting…</title>' +
  '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#120d0c;color:#c9b8b0;font:15px/1.5 system-ui,sans-serif">' +
  '<div>Reconnecting…</div><script>setTimeout(function(){location.reload()},700)</script>';

const isDoc = (req) => req.destination === 'document' || req.destination === 'iframe';

// The Scramjet controller keeps its routing registry in this worker's memory; a worker restart wipes
// it, and the controller re-registers asynchronously (via the revive the controller SW broadcasts on
// evaluation). Poll briefly so a request through a just-restarted worker waits for that rather than
// missing the route.
async function waitForRoute(event) {
  for (let i = 0; i < 25 && !shouldRoute(event); i++) await new Promise((r) => setTimeout(r, 80));
  return shouldRoute(event);
}

async function handle(event) {
  const u = new URL(event.request.url);
  const proxied = u.origin === ORIGIN && u.pathname.startsWith(SERVICE);

  if (proxied && !shouldRoute(event)) {
    // Cold worker: wait for the controller to re-register, then route.
    if (!(await waitForRoute(event))) {
      if (isDoc(event.request)) return new Response(RECONNECT_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('', { status: 503 }); // subresource: let the page retry it
    }
  }

  if (shouldRoute(event)) {
    try {
      return await route(event);
    } catch (e) {
      const body = GNITO_ERRORS.render(GNITO_ERRORS.classify(String(e && e.message || e)), '', String(e && e.stack || e));
      return new Response(isDoc(event.request) ? body : '', { status: 502, headers: isDoc(event.request) ? { 'content-type': 'text/html; charset=utf-8' } : {} });
    }
  }

  // Defense in depth: a proxied page must never reach Indognito's own API with the user's cookies.
  if (event.clientId && u.origin === ORIGIN && u.pathname.startsWith(BASE + 'api/')) {
    const client = await self.clients.get(event.clientId);
    if (client && client.url.startsWith(ORIGIN + SERVICE)) return new Response('Blocked by Indognito', { status: 403 });
  }
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => event.respondWith(handle(event)));

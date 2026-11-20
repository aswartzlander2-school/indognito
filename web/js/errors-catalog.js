// Centralized error pages. Loaded by the web app (<script>) and by the service worker (importScripts).
// Each entry: title + descriptive text + suggestions. No warning-triangle icons, by design.
(function (g) {
  const E = {
    'policy-blocked': {
      title: 'This site is blocked on this server',
      text: 'The administrator of this Indognito server has a network policy that does not allow this address. Indognito does not try to get around policies.',
      tips: ['If you think this is a mistake, ask your Indognito administrator.', 'Policies are set in Admin → Network policy.'],
    },
    'dns': {
      title: 'This address could not be found',
      text: 'The server could not look up the site’s name (DNS). The address may be misspelled, or the site may no longer exist.',
      tips: ['Check the spelling of the address.', 'Try searching for the site instead.'],
    },
    'refused': {
      title: 'The site refused the connection',
      text: 'The site’s server is reachable but did not accept the connection. It may be down or not accepting visitors on that port.',
      tips: ['Try again in a few minutes.', 'Only ports 80, 443, 8080 and 8443 are allowed unless the administrator changed this.'],
    },
    'timeout': {
      title: 'The site took too long to respond',
      text: 'The connection started, but the site did not answer in time. It may be overloaded, or the network between this server and the site is slow.',
      tips: ['Reload the page.', 'Try again later.'],
    },
    'tls': {
      title: 'A secure connection could not be made',
      text: 'The site’s security certificate could not be verified, so the connection was stopped to protect you. Indognito does not skip certificate checks.',
      tips: ['Check that the address starts with the right domain.', 'The site may have an expired or misconfigured certificate.'],
    },
    'private-address': {
      title: 'Private and local addresses are not reachable',
      text: 'For safety, the browser cannot open addresses on the server’s own network (such as 192.168.x.x, 10.x.x.x or localhost).',
      tips: ['Use the site’s public address instead.'],
    },
    'session-ended': {
      title: 'Your browser session ended',
      text: 'This tab lost its connection to the Indognito server, usually because the session was idle or an administrator released it.',
      tips: ['Close the browser and open it again to get a new session.'],
    },
    'network': {
      title: 'The page could not be loaded',
      text: 'Something went wrong while fetching this page through the Indognito server.',
      tips: ['Reload the page.', 'If it keeps happening, the site may not work through a web proxy.'],
    },
  };
  function classify(msg) {
    const m = String(msg || '').toLowerCase();
    if (/host ?blocked|hostblocked|blocked|0x48/.test(m)) return 'policy-blocked';
    if (/private|loopback|forbidden ip|0x46/.test(m)) return 'private-address';
    if (/enotfound|dns|name not resolved|getaddrinfo|0x42/.test(m)) return 'dns';
    if (/econnrefused|refused|0x43/.test(m)) return 'refused';
    if (/timed? ?out|etimedout|0x44/.test(m)) return 'timeout';
    if (/certificate|tls|ssl|handshake/.test(m)) return 'tls';
    if (/websocket|closed|wisp|transport/.test(m)) return 'session-ended';
    return 'network';
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function render(code, url, detail) {
    const e = E[code] || E.network;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(e.title)}</title><style>
@font-face{font-family:'Inter Variable';font-weight:100 900;font-display:swap;src:url('/fonts/inter/inter-latin-wght-normal.woff2') format('woff2-variations')}
@font-face{font-family:'JetBrains Mono Variable';font-weight:100 800;font-display:swap;src:url('/fonts/mono/jetbrains-mono-latin-wght-normal.woff2') format('woff2-variations')}
:root{--mono:'JetBrains Mono Variable',ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#120d0c;color:#f6ede8;font:14.5px/1.55 'Inter Variable',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:520px;width:100%;padding:32px 30px;background:#211816;border:1px solid rgba(255,220,200,.16);border-radius:22px;box-shadow:0 24px 60px -24px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05)}
.code{font-family:var(--mono);font-size:12.5px;letter-spacing:.02em;color:#8f7d75}
h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin:10px 0 10px}p,li{color:#c9b8b0}p{line-height:1.55}
.url{word-break:break-all;color:#ffb07a;font-family:var(--mono);font-size:13px}ul{padding-left:20px;font-size:14px}li{margin:3px 0}
details{margin-top:18px;color:#8f7d75;font-size:13px}summary{cursor:pointer}pre{white-space:pre-wrap;font-family:var(--mono);background:#170f0e;border:1px solid rgba(255,220,200,.09);border-radius:12px;padding:12px}
button{margin-top:18px;height:40px;padding:0 20px;border-radius:999px;border:0;background:linear-gradient(100deg,#ff3b30,#ff6a2b 55%,#ff9a2e);color:#fff;font-weight:600;font-family:inherit;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.08)}
</style></head><body><main><div class="code">INDOGNITO · ${esc(code)}</div><h1>${esc(e.title)}</h1><p>${esc(e.text)}</p>
${url ? `<p>Address: <span class="url">${esc(url)}</span></p>` : ''}<ul>${e.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<button onclick="location.reload()">Try again</button>
${detail ? `<details><summary>Technical details</summary><pre>${esc(String(detail).slice(0, 2000))}</pre></details>` : ''}
</main></body></html>`;
  }
  g.GNITO_ERRORS = { catalog: E, classify, render };
})(typeof self !== 'undefined' ? self : window);

#!/usr/bin/env node
// Applies small, documented compatibility patches to vendored dependencies after `npm install`.
// Each patch is idempotent (safe to run repeatedly) and checks a marker before writing.
//
// Why this exists: @mercuryworkshop/scramjet@1.1.0 sends request headers across the bare-mux
// worker postMessage boundary as a plain object (the only header shape that survives structured
// clone). @mercuryworkshop/epoxy-transport's WASM `client.fetch()` binding expects something
// iterable (Headers/Map/array-of-pairs) and throws "headers is not iterable" on a plain object.
// This was true of both 2.1.28 (which we cannot ship — it bundles an epoxy-tls build that trusts
// the compromised eMudhra intermediate CAs disclosed Oct 2026) and the patched 2.1.29. Scramjet
// has no v1.1.0 release built against a transport that normalizes this, so we patch the one call
// site instead of forking the whole package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const MARKER = '/* gnito-patched: headers-iterable */';

function patchEpoxyHeaders(file) {
  if (!fs.existsSync(file)) { console.warn(`[patch-deps] skip (not installed): ${file}`); return; }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARKER)) { console.log(`[patch-deps] already applied: ${file}`); return; }
  const needle = 'async request(remote, method, body, headers, signal) {';
  if (!src.includes(needle)) throw new Error(`[patch-deps] expected call site not found in ${file} — epoxy-transport's internals changed; update scripts/patch-deps.mjs`);
  const replacement = `async request(remote, method, body, headers, signal) {\n    ${MARKER} headers = headers instanceof Headers || headers?.[Symbol.iterator] ? headers : new Headers(headers || {});`;
  src = src.replace(needle, replacement);
  fs.writeFileSync(file, src);
  console.log(`[patch-deps] patched: ${file}`);
}

for (const rel of ['node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs', 'node_modules/@mercuryworkshop/epoxy-transport/dist/index.js']) {
  patchEpoxyHeaders(path.join(root, rel));
}

// Scramjet's service-worker config handshake: when the controller delivers its config to the worker
// by postMessage (which happens whenever the SW is already controlling the page at init time — i.e.
// every visit after the first), the worker's message handler sets `this.config` but skips the
// `Nk()` global-config install and the wasm rewriter init that the IndexedDB `loadConfig()` path
// does. The worker's `fetch()` then skips `loadConfig()` entirely (`this.config || await ...`), so
// the rewriter runs with an empty global config and crashes on `config.prefix` the first time it
// proxies a request. We make `loadConfig()` idempotently ensure the global config + wasm are set
// even when `this.config` is already populated, and make `fetch()` always call it.
function patchScramjetConfig(file) {
  if (!fs.existsSync(file)) { console.warn(`[patch-deps] skip (not installed): ${file}`); return; }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('/* gnito-cfg */')) { console.log(`[patch-deps] already applied: ${file}`); return; }
  const a = 'async loadConfig(){if(this.config)return;';
  const b = 'this.config||await this.loadConfig()';
  if (!src.includes(a) || !src.includes(b)) throw new Error(`[patch-deps] scramjet config tokens not found in ${file} — the scramjet build changed; update scripts/patch-deps.mjs`);
  // When config is already present, still (re)install the global config + wasm, then return.
  src = src.replace(a, 'async loadConfig(){/* gnito-cfg */if(this.config){(0,c.Nk)(this.config);await (0,s.n$)();return;}');
  // Always run loadConfig before a proxied fetch so the above runs at least once per worker.
  src = src.replace(b, 'await this.loadConfig()');
  fs.writeFileSync(file, src);
  console.log(`[patch-deps] patched scramjet config handshake: ${file}`);
}

patchScramjetConfig(path.join(root, 'node_modules/@mercuryworkshop/scramjet/dist/scramjet.all.js'));

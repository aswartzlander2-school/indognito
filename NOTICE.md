# Third-party notices

Indognito is distributed under the GNU Affero General Public License v3.0 (see `LICENSE`).
It bundles and builds on the following open-source projects. Their licenses apply to their
respective code.

| Project | License | Use in Indognito |
|---|---|---|
| [Scramjet](https://github.com/MercuryWorkshop/scramjet) (`@mercuryworkshop/scramjet`) | MIT | Browser proxy engine (service worker + rewriter) |
| [wisp-js](https://github.com/MercuryWorkshop/wisp-js) (`@mercuryworkshop/wisp-js`) | LGPL-3.0-or-later | Wisp relay server + protocol |
| [bare-mux](https://github.com/MercuryWorkshop/bare-mux) (`@mercuryworkshop/bare-mux`) | GPL-3.0 | Transport multiplexing in the browser |
| [epoxy-transport](https://github.com/MercuryWorkshop/epoxy-tls) (`@mercuryworkshop/epoxy-transport`) | AGPL-3.0-only | TLS-in-browser transport (pinned to the 2.1.x line) |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit`) | MIT | Terminal UI |
| [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) (`@simplewebauthn/*`) | MIT | Passkey (WebAuthn) support |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server |
| [Fontsource](https://github.com/fontsource/fontsource) (Inter, Bricolage Grotesque, JetBrains Mono) | OFL-1.1 (fonts) | UI typography |
| [Node.js](https://nodejs.org/) | MIT (+ others) | Runtime downloaded by the installer |

Because Indognito bundles epoxy-transport (AGPL-3.0), the combined distributed work is
licensed under AGPL-3.0. If you run a modified version of Indognito as a network service,
the AGPL requires you to offer users the corresponding source of your modified version.

## Local modifications to dependencies

`server/scripts/patch-deps.mjs` applies small, documented compatibility patches to two
vendored packages after `npm install` (it runs automatically as a `postinstall` hook):

- **epoxy-transport** — normalizes request headers to an iterable form, because this
  Scramjet build passes headers as a plain object across the bare-mux worker boundary.
- **scramjet** — makes the service worker's `loadConfig()` idempotently (re)install the
  global rewriter config so proxied fetches don't crash on first load when the config
  arrives by `postMessage`.

Neither patch changes network behavior, impersonates another service, or alters what
network-security products observe. They are integration fixes only.

## Evaluated but not used

- [MicroVM-Playground](https://github.com/aswartzlander2-sys/microvm-playground) — evaluated
  as an optional, experimental workspace backend (see `server/src/backend/runtime/microvm.js`).
  It is off by default and not required.
- [AX Workspaces](https://gitlab.com/alexander-datskov/ax-workspaces) — reviewed as a
  reference for the file-explorer / workspace model; no code was copied.

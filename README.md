<div align="center">

# Indognito

**A self-hosted, isolated browser, terminal, file workspace and admin platform — in the browser.**

`v1.0.0` · AGPL-3.0

</div>

Indognito gives each user an isolated environment: a proxied web browser, a real terminal
connected to their workspace, a file explorer over that same workspace, a live resource
dashboard, and a role-based administrative console. It is one backend + one frontend, installed
and run through a single CLI, `gnito`.

> **Scope & intent.** Indognito is a privacy-conscious *remote browser isolation* and workspace
> platform. It does **not** disguise its traffic, impersonate other services, or try to defeat
> organizational network security or content filtering. Its Wisp relay is a declared, documented
> endpoint (`/.well-known/indognito.json`), and administrators set an explicit network policy.
> Private, loopback and link-local destinations are always refused.

---

## Install

Installation first downloads only the `gnito` CLI. Running `gnito start` then opens a graphical
setup wizard that checks compatibility, lets you choose ports and resource allocations, downloads
the Node.js runtime and the Indognito application, and starts it.

```sh
curl -fsSL https://indognito.example/install.sh | sh    # see note below
gnito start
```

> The hosted install script / release artifacts are not published here yet; see
> **[Build from source](#build-from-source)** to run it today. The command names and flow above are
> what the installer provides.

### Per-OS notes

| OS | Status | Notes |
|---|---|---|
| **Debian / Ubuntu** | Tested (arm64) | Setup wizard uses GTK via `python3-gi`, else Tk (`python3-tk`). Sandboxed terminals need `bubblewrap`. |
| **Fedora** | Supported, not yet tested | Same as above (`python3-gobject` / `python3-tkinter`). |
| **Arch Linux** | Supported, not yet tested | `python-gobject` / `tk`, `bubblewrap`. |
| **Other Linux** | Best effort | The wizard falls back to a text mode (`gnito start --tui`). |
| **macOS** | Supported, not yet tested | Native Tk wizard; terminals run unsandboxed as your user. |
| **Windows** | Supported, not yet tested | WinForms wizard; terminals use ConPTY (Windows 10 1809+). |

Only Debian/Ubuntu on arm64 has been run end-to-end so far. Other targets are implemented and
cross-compile cleanly, but are not yet verified — they are listed as *supported, not yet tested*
on purpose.

---

## Build from source

Requires Go 1.24+, Node.js 22 LTS, and (on Linux, for sandboxed terminals) `bubblewrap`.

```sh
git clone https://github.com/aswartzlander2-school/indognito
cd indognito

# 1. Server deps (postinstall applies the documented dependency patches — see NOTICE.md)
cd server && npm install && cd ..

# 2. The gnito CLI (also the PTY helper used by terminals)
cd cli && go build -o build/gnito -ldflags "-X main.Version=$(cat ../VERSION)" . && cd ..

# 3. Run it
./cli/build/gnito start          # opens the setup wizard
#   or run the servers directly for development:
GNITO_CONFIG=./data/config.json node server/src/main.js
```

On first web visit you'll see the initialization animation, then create the **Owner** account.

### `gnito` commands

```
gnito start                 Start Indognito (setup wizard on first run)
gnito stop                  Stop the server
gnito restart [--reinit]    Restart; --reinit replays setup, keeping accounts & files
gnito status                Show the frontend URL and backend status
gnito re-install            Reinstall over an existing installation
gnito uninstall [--purge]   Remove Indognito (--purge also deletes data)
gnito logs [-f]             Show / follow the server log
```

---

## Architecture

```
                 ┌──────────── gnito (Go) ────────────┐
                 │ installer · setup wizard · PTY helper · supervisor
                 └───────────────────┬─────────────────┘
                                     │ starts
  browser ──https──▶ frontend (Node) ──proxy──▶ backend (Node, 127.0.0.1)
                      static + /api,/ws,/wisp        REST · SQLite · auth/RBAC
                                                     terminals (bwrap PTY)
                                                     Wisp relay (wisp-js)
                                                     browser queue
        page ──service worker (Scramjet) ──bare-mux/epoxy──▶ /wisp ──▶ site
```

- **Frontend** serves the UI and the browser-engine assets and reverse-proxies `/api`, `/ws`
  and `/wisp` to the backend (loopback-only by default).
- **Backend** is a dependency-light Node server: SQLite (`node:sqlite`), scrypt passwords,
  sessions, TOTP + passkeys, role-based authorization, per-user resource limits measured from
  real process stats, a fair browser-session queue, and the Wisp relay.
- **Terminals** run on a pseudo-terminal via the `gnito` helper; on Linux they are sandboxed
  with bubblewrap so a user's shell only sees their own workspace.
- **Browser** uses Scramjet in a service worker, with Epoxy (TLS-in-browser) over the server's
  Wisp relay — so for `https` sites the relay only ever carries encrypted bytes.

See **[NOTICE.md](NOTICE.md)** for third-party licenses and the exact dependency patches.

---

## Security model

- First account is the sole **Owner**; RBAC prevents privilege escalation. All admin actions
  are audited.
- The Wisp relay refuses private/loopback/link-local IPs (SSRF protection) and enforces the
  administrator's domain and port policy.
- Passkeys require a real hostname or `localhost` over a secure context (not a bare IP).
- No authentication secrets are exposed to user shells; the frontend↔backend channel is
  authenticated with a per-install secret.

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). Running a modified version as a
network service triggers the AGPL's source-offer requirement.

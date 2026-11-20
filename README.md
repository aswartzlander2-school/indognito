<div align="center">

# Indognito

**A self-hosted, isolated browser, terminal, file workspace and admin platform — in the browser.**

`v0.1.4` · AGPL-3.0

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

Installation downloads only the `gnito` CLI. Running `gnito start` then opens a setup wizard that
checks compatibility, lets you choose ports and resource allocations, downloads the Node.js runtime
and the Indognito application, and starts it.

The first command on each OS is optional — it installs the graphical wizard toolkit and (on Linux)
the terminal sandbox. Without them, setup falls back to the text wizard (`gnito start --tui`) and
terminals run unsandboxed.

### Ubuntu / Debian

```sh
sudo apt update && sudo apt install -y python3-gi gir1.2-gtk-3.0 bubblewrap   # optional: GUI wizard + sandbox
curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
gnito start
```

### Fedora

```sh
sudo dnf install -y python3-gobject gtk3 bubblewrap                            # optional: GUI wizard + sandbox
curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
gnito start
```

### Arch Linux

```sh
sudo pacman -S --needed python-gobject gtk3 bubblewrap                         # optional: GUI wizard + sandbox
curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
gnito start
```

### Other Linux

```sh
# Install python3 + GTK3 bindings (or Tk) and bubblewrap with your package manager for the
# graphical wizard and sandboxed terminals; otherwise the text wizard is used.
curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
gnito start
```

### macOS

```sh
# Tk ships with the system Python (used for the wizard). If needed: brew install python-tk
curl -fsSL https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.sh | sh
gnito start
```

### Windows (PowerShell)

```powershell
irm https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.ps1 | iex
gnito start
```

The installer places `gnito` on your PATH (`/usr/local/bin`, else `~/.local/bin`; on Windows
`%LOCALAPPDATA%\Indognito\bin`). Open a new terminal after installing so the PATH change takes
effect.

> **Availability.** The one-line installers (`install/install.sh`, `install/install.ps1`) are
> published as assets on each GitHub release by `scripts/build-release.sh`, alongside the `gnito`
> binaries. They work once a release is published; for a private repo the installer uses a GitHub
> token (`GH_TOKEN`/`GITHUB_TOKEN`, or the `gh` CLI) to fetch assets. To run it today without a
> release, use **[Build from source](#build-from-source)**.

### Tested status

| OS | Status | Wizard | Terminal sandbox |
|---|---|---|---|
| **Debian / Ubuntu** | Tested (arm64) | GTK (`python3-gi`), else Tk | `bubblewrap` |
| **Fedora** | Builds, not yet tested | GTK / Tk | `bubblewrap` |
| **Arch Linux** | Builds, not yet tested | GTK / Tk | `bubblewrap` |
| **Other Linux** | Best effort | GTK / Tk / text | `bubblewrap` if present |
| **macOS** | Builds, not yet tested | Native Tk | none (runs as your user) |
| **Windows** | Builds, not yet tested | WinForms | ConPTY (Win10 1809+) |

Only Debian/Ubuntu on arm64 has been run end-to-end so far. The other targets cross-compile cleanly
but are not yet verified — listed honestly as *builds, not yet tested*.

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
gnito update                Download and install the latest release
gnito check-update          Check now whether a newer version exists
```

### Updates

`gnito` checks for a newer release in the background at most once every 30 minutes (piggy-backed on
normal commands, never a daemon). When one is found, a banner appears above the next command's
output:

```
================================================================
  An update is available: Indognito 0.1.0 → 0.2.0
  Run gnito update to install it.
================================================================
```

Run `gnito update` to replace the binary with the latest release build for your platform, or
`gnito check-update` to check on demand. Set `GNITO_NO_UPDATE_CHECK=1` to turn the automatic check
off. For a private repository the check and download use your GitHub token (`gh auth login`, or
`GITHUB_TOKEN`).

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

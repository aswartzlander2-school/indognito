// Runtime drivers: how a user's terminal process is started.
//   sandbox  – Linux bubblewrap: the workspace is the only writable, visible user data; host data dir hidden.
//   process  – plain child process in the workspace dir (no filesystem isolation; Owner-only by default).
//   microvm  – a VM from a MicroVM-Playground server (experimental; separate disk, see docs/EVALUATION.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { APP_ROOT } from '../../lib/config.js';

function which(cmd) {
  const exts = os.platform() === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) { const p = path.join(dir, cmd + e); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } }
  }
  return null;
}

export function ptyHelperPath() {
  const exe = os.platform() === 'win32' ? 'gnito.exe' : 'gnito';
  const candidates = [process.env.GNITO_PTY_HELPER, path.join(APP_ROOT, 'bin', exe), path.join(APP_ROOT, 'cli', 'build', exe)];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (found) return found;
  // Fall back to the installed `gnito` command on PATH, so a missing/not-yet-copied bundled helper
  // (e.g. an interrupted update) doesn't disable terminals.
  return which(exe);
}

// Validated elsewhere (USERNAME regex), but belt-and-suspenders: keep only safe prompt characters.
function safeName(u) { return String(u || 'user').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'user'; }

function sandboxArgs(ws, opts) {
  const user = safeName(opts.user);
  const a = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--hostname', 'gnito',
    '--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run'];
  for (const d of ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32']) {
    const p = '/' + d;
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) a.push('--symlink', fs.readlinkSync(p), p);
      else if (st.isDirectory()) a.push('--ro-bind', p, p);
    } catch { /* absent */ }
  }
  // /etc read-only (passwd, ssl certs, resolv.conf, alternatives…)
  a.push('--ro-bind', '/etc', '/etc');
  if (fs.existsSync('/opt')) a.push('--ro-bind', '/opt', '/opt');
  a.push('--bind', ws, '/home/gnito', '--chdir', '/home/gnito');
  if (!opts.network) a.push('--unshare-net');
  a.push('--clearenv', '--setenv', 'HOME', '/home/gnito', '--setenv', 'USER', user, '--setenv', 'LOGNAME', user,
    '--setenv', 'GNITO_MACHINE', '1', // marks this shell as being inside an Indognito machine
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'TERM', 'xterm-256color',
    '--setenv', 'LANG', process.env.LANG || 'C.UTF-8', '--setenv', 'SHELL', '/bin/bash',
    '--setenv', 'PS1', `\\[\\e[1;31m\\]${user}@gnito\\[\\e[0m\\]:\\[\\e[1;33m\\]\\w\\[\\e[0m\\]\\$ `);
  a.push('/bin/bash', '--noprofile', '--norc', '-i');
  return a;
}

let probe;
export function detectDrivers(cfg) {
  if (probe) return probe;
  const plat = os.platform();
  const out = { platform: plat, pty: !!ptyHelperPath(), sandbox: false, sandboxReason: '', limits: 'monitor', process: true, microvm: !!cfg.runtime?.microvm?.url };
  if (plat !== 'linux') out.sandboxReason = 'Bubblewrap sandboxing is Linux-only.';
  else if (!which('bwrap')) out.sandboxReason = 'bubblewrap (bwrap) is not installed.';
  else {
    const tmp = fs.mkdtempSync(path.join(cfg.dataDir, '.probe-'));
    const r = spawnSync('bwrap', [...sandboxArgs(tmp, { network: true }).slice(0, -4), '/bin/true'], { timeout: 5000, encoding: 'utf8' });
    fs.rmSync(tmp, { recursive: true, force: true });
    out.sandbox = r.status === 0;
    if (!out.sandbox) out.sandboxReason = (r.stderr || r.error?.message || 'bwrap failed').trim().split('\n')[0];
  }
  if (plat === 'linux' && which('systemd-run')) {
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'MemoryMax=64M', '/bin/true'], { timeout: 5000 });
    if (r.status === 0) out.limits = 'cgroup';
  }
  const want = cfg.runtime?.driver || 'auto';
  // Terminals must run isolated: a MicroVM-Playground microVM (firecracker/QEMU; any host OS) when
  // one is configured, otherwise a bubblewrap sandbox on Linux. "auto" NEVER silently downgrades to
  // an unsandboxed host shell — if neither is available the terminal is refused (see allowedFor).
  // The plain 'process' driver is only reachable as an explicit, Owner-gated override.
  out.selected = want === 'auto' ? (out.microvm ? 'microvm' : 'sandbox') : want;
  probe = out;
  return out;
}

function defaultShell() {
  if (os.platform() === 'win32') return { cmd: which('pwsh') || 'powershell.exe', args: ['-NoLogo'] };
  const sh = ['/bin/bash', '/bin/zsh', '/bin/sh'].find((p) => fs.existsSync(p));
  return { cmd: sh, args: sh.endsWith('bash') ? ['--noprofile', '--norc', '-i'] : ['-i'] };
}

// Returns a ChildProcess speaking the gnito pty-helper framing on stdin; raw terminal output on stdout.
export function spawnLocal(kind, { ws, cols, rows, limits, network, user, probe: p }) {
  const helper = ptyHelperPath();
  if (!helper) throw new Error('The gnito PTY helper is missing (expected bin/gnito in the install directory).');
  const uname = safeName(user);
  let argv;
  let env;
  if (kind === 'sandbox' && p.sandbox) {
    argv = ['bwrap', ...sandboxArgs(ws, { network, user: uname })];
    env = { PATH: process.env.PATH };
  } else {
    // Unsandboxed host shell — only reached as an explicit, Owner-allowed override (allowedFor
    // refuses it otherwise), e.g. a dev host with no microVM and no working bubblewrap.
    const sh = defaultShell();
    argv = [sh.cmd, ...sh.args];
    env = { ...cleanEnv(), HOME: ws, USERPROFILE: ws, USER: uname, LOGNAME: uname, TERM: 'xterm-256color', GNITO_WORKSPACE: ws, GNITO_MACHINE: '1',
      PS1: `\\[\\e[1;31m\\]${uname}@gnito\\[\\e[0m\\]:\\[\\e[1;33m\\]\\w\\[\\e[0m\\]\\$ ` };
  }
  if (p.limits === 'cgroup' && limits) {
    argv = ['systemd-run', '--user', '--scope', '--quiet', '-p', `MemoryMax=${limits.ram_mb}M`,
      '-p', `CPUQuota=${limits.cpu_pct}%`, '--', ...argv];
  }
  return spawn(helper, ['__pty', '--cols', String(cols), '--rows', String(rows), '--', ...argv], {
    cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

function cleanEnv() {
  // Never leak server secrets or config paths into user shells.
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'SHELL'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

export function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const h = Buffer.alloc(5); h[0] = type.charCodeAt(0); h.writeUInt32BE(body.length, 1);
  return Buffer.concat([h, body]);
}

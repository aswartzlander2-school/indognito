// Supervisor: runs the backend and the frontend as two separate Node.js processes
// and restarts either one if it crashes. Started by "gnito start" or the system service.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const children = new Map();
let stopping = false;

function run(name, file) {
  const started = Date.now();
  // On Windows, give each child its own process group (detached) so a Ctrl+C sent to the console
  // that launched gnito can't reach them and kill them with STATUS_CONTROL_C_EXIT (0xC000013A),
  // which caused a one-time crash-and-restart of the backend/frontend on startup.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, file)],
    { stdio: 'inherit', env: process.env, windowsHide: true, detached: process.platform === 'win32' });
  children.set(name, child);
  child.on('exit', (code, sig) => {
    children.delete(name);
    if (stopping) { if (!children.size) process.exit(0); return; }
    const quick = Date.now() - started < 5000;
    console.error(`[gnito] ${name} exited (${sig || code}); restarting in ${quick ? 5 : 1}s`);
    setTimeout(() => run(name, file), quick ? 5000 : 1000);
  });
}

run('backend', 'backend/index.js');
setTimeout(() => run('frontend', 'frontend/index.js'), 300);

process.on('SIGTERM', () => {
  stopping = true;
  for (const c of children.values()) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
});
// A detached background supervisor should not tear down on stray console control events.
for (const sig of ['SIGINT', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => {}); } catch { /* not supported */ } }

// Per-user workspace directories (the filesystem shared by the terminal and the file explorer).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class Workspaces {
  constructor(cfg) {
    this.root = path.join(cfg.dataDir, 'workspaces');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.usageCache = new Map(); // userId -> { bytes, at }
  }
  dir(userId) { return path.join(this.root, `u${Number(userId)}`); }
  ensure(user) {
    const d = this.dir(user.id);
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      for (const sub of ['Documents', 'Downloads', 'Projects']) fs.mkdirSync(path.join(d, sub));
      fs.writeFileSync(path.join(d, 'WELCOME.txt'),
        `Welcome to your Indognito workspace, ${user.username}.\n\n` +
        `This folder is the same one you see in the terminal (as your home directory)\n` +
        `and in the File Explorer. Anything you save here counts toward your storage limit.\n`);
    }
    return d;
  }
  async remove(userId) { await fsp.rm(this.dir(userId), { recursive: true, force: true }); this.usageCache.delete(userId); }
  invalidate(userId) { this.usageCache.delete(Number(userId)); }

  // Measured on disk (allocated blocks where the OS reports them), cached for 15 s.
  async usage(userId, maxAgeMs = 15_000) {
    userId = Number(userId);
    const c = this.usageCache.get(userId);
    if (c && Date.now() - c.at < maxAgeMs) return c.bytes;
    let bytes = 0, entries = 0;
    const walk = async (d) => {
      let list; try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (++entries > 200_000) return;
        const p = path.join(d, e.name);
        try {
          const st = await fsp.lstat(p);
          bytes += st.blocks ? st.blocks * 512 : st.size;
          if (e.isDirectory()) await walk(p);
        } catch { /* vanished */ }
      }
    };
    await walk(this.dir(userId));
    this.usageCache.set(userId, { bytes, at: Date.now() });
    return bytes;
  }
}

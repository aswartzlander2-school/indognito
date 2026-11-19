// Persistent database (SQLite via node:sqlite — no native addon needed).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const PERMISSIONS = {
  'users.view': 'See accounts and their usage',
  'users.create': 'Create accounts',
  'users.manage': 'Change roles, disable and re-enable accounts, reset passwords',
  'users.lock': 'Lock and unlock accounts',
  'limits.manage': 'Change storage, RAM, CPU and session limits',
  'roles.manage': 'Create and edit administrative roles',
  'audit.view': 'Read the audit log',
  'policy.manage': 'Change network policy, browser capacity and the app catalog',
  'system.view': 'See runtime, queue and host status',
};
const ALL = Object.keys(PERMISSIONS);

const MIGRATIONS = [
  `CREATE TABLE roles (
     id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
     rank INTEGER NOT NULL, perms TEXT NOT NULL DEFAULT '[]', builtin INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE users (
     id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
     pw_hash TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id),
     is_owner INTEGER, status TEXT NOT NULL DEFAULT 'active', locked INTEGER NOT NULL DEFAULT 0,
     locked_reason TEXT, failed_logins INTEGER NOT NULL DEFAULT 0, lock_until INTEGER,
     totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, session_hours INTEGER NOT NULL DEFAULT 12,
     search_engine TEXT NOT NULL DEFAULT 'duckduckgo',
     created_at INTEGER NOT NULL, last_login INTEGER);
   CREATE UNIQUE INDEX one_owner ON users(is_owner) WHERE is_owner = 1;
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created INTEGER NOT NULL, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT);
   CREATE TABLE limits (
     user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     storage_mb INTEGER NOT NULL, ram_mb INTEGER NOT NULL, cpu_pct INTEGER NOT NULL,
     browser_sessions INTEGER NOT NULL, terminal_sessions INTEGER NOT NULL);
   CREATE TABLE passkeys (
     id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
     name TEXT, created INTEGER NOT NULL, last_used INTEGER);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor_id INTEGER, actor TEXT,
     action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE browser_runs (
     id INTEGER PRIMARY KEY, user_id INTEGER, started INTEGER NOT NULL, ended INTEGER);
   CREATE TABLE history (
     id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     url TEXT NOT NULL, title TEXT, ts INTEGER NOT NULL);
   CREATE INDEX history_user ON history(user_id, ts);
   CREATE TABLE apps (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL,
     description TEXT, icon TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);`,
];

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'indognito.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, at INTEGER)');
  const done = db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM _migrations').get().n;
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO _migrations (n, at) VALUES (?, ?)').run(i + 1, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function seedRoles(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO roles (key, name, rank, perms, builtin) VALUES (?, ?, ?, ?, 1)');
  ins.run('owner', 'Owner', 100, JSON.stringify(ALL));
  ins.run('admin', 'Administrator', 80, JSON.stringify(ALL.filter((p) => p !== 'roles.manage')));
  ins.run('moderator', 'Moderator', 50, JSON.stringify(['users.view', 'users.lock', 'audit.view', 'system.view']));
  ins.run('user', 'User', 0, '[]');
  // The owner role always carries every permission, including ones added in later versions.
  db.prepare("UPDATE roles SET perms = ? WHERE key = 'owner'").run(JSON.stringify(ALL));
}

const DEFAULT_APPS = [
  ['game-gnmath', 'GN-Math', 'https://gn-math.dev/', 'Games', 'Browser games, music and creative tools', 'gamepad'],
  ['game-coolmath', 'Coolmath Games', 'https://www.coolmathgames.com/', 'Games', 'Logic and strategy games', 'gamepad'],
  ['game-poki', 'Poki', 'https://poki.com/', 'Games', 'Free online games', 'gamepad'],
  ['game-2048', '2048', 'https://play2048.co/', 'Games', 'The sliding number puzzle', 'puzzle'],
  ['game-chess', 'Chess', 'https://lichess.org/', 'Games', 'Free, open-source chess', 'gamepad'],
  ['edu-encyclopedia', 'Encyclopedia', 'https://en.wikipedia.org/', 'Learning', 'Free online encyclopedia', 'book'],
  ['edu-world-map', 'World Map', 'https://www.openstreetmap.org/', 'Learning', 'Open collaborative world map', 'map'],
  ['edu-dictionary', 'Dictionary', 'https://en.wiktionary.org/', 'Learning', 'Free multilingual dictionary', 'type'],
  ['edu-library', 'Open Library', 'https://openlibrary.org/', 'Learning', 'Borrow and read books', 'library'],
  ['edu-science', 'Science Sims', 'https://phet.colorado.edu/', 'Learning', 'Interactive science and math simulations', 'atom'],
  ['dev-docs', 'Web Docs', 'https://developer.mozilla.org/', 'Developer', 'Web platform documentation', 'code'],
  ['dev-sandbox', 'JSFiddle', 'https://jsfiddle.net/', 'Developer', 'Try HTML, CSS and JavaScript', 'brackets'],
];
// Defaults that earlier versions shipped and later dropped (removed once, if still present).
const RETIRED_APPS = ['tool-search'];

// Adds catalog defaults that have never been added before, so admins' removals stick across upgrades.
export function seedApps(db) {
  const get = db.prepare("SELECT value FROM settings WHERE key = 'apps.seeded'").get();
  let seeded = get ? JSON.parse(get.value) : db.prepare('SELECT id FROM apps').all().map((r) => r.id);
  const ins = db.prepare('INSERT OR IGNORE INTO apps (id, name, url, category, description, icon, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
  DEFAULT_APPS.forEach((a, i) => { if (!seeded.includes(a[0])) { ins.run(...a, i); seeded.push(a[0]); } });
  for (const id of RETIRED_APPS) if (!seeded.includes('retired:' + id)) { db.prepare('DELETE FROM apps WHERE id = ?').run(id); seeded.push('retired:' + id); }
  // keep the catalog order sensible for rows that are still the shipped defaults
  DEFAULT_APPS.forEach((a, i) => db.prepare('UPDATE apps SET sort = ? WHERE id = ? AND url = ?').run(i, a[0], a[2]));
  db.prepare("INSERT INTO settings (key, value) VALUES ('apps.seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(seeded));
}

export class Settings {
  constructor(db) { this.db = db; }
  get(key, fallback) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
  delete(key) { this.db.prepare('DELETE FROM settings WHERE key = ?').run(key); }
}

export function audit(db, actor, action, target, detail, ip) {
  db.prepare('INSERT INTO audit (ts, actor_id, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor?.id ?? null, actor?.username ?? 'system', action, target ?? null,
      detail ? JSON.stringify(detail) : null, ip ?? null);
}

// Zero-knowledge browsing history. A random 256-bit AES-GCM "master" key encrypts each history
// entry ({url,title}) in the browser; the server only ever stores ciphertext, so it cannot tell
// which sites a user visits. The master key itself is wrapped (encrypted) with a key derived from
// the account password via PBKDF2, and the wrapped blob is kept on the server — so the key survives
// across devices without the server ever seeing it. Because history is encrypted under the stable
// master key, a password change only re-wraps that key; it never re-encrypts the history.
//
// Limits (stated honestly in the UI): a password is needed to unwrap the key, so a passkey-only
// sign-in cannot decrypt history, and an admin password *reset* makes earlier history unrecoverable.

import { api } from './core.js';

const KEYDB = 'gnito-keys', STORE = 'keys', PBKDF2_ITERS = 210_000;
let mem = null; // { uid, key } cached for this session to avoid an IndexedDB hit per entry

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
export const cryptoAvailable = () => !!(window.crypto && window.crypto.subtle && window.indexedDB);

function openKeyDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(KEYDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const db = await openKeyDb();
  try { return await new Promise((res, rej) => { const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); }
  finally { db.close(); }
}

async function kekFrom(password, encSaltB64) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(encSaltB64), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Wrap/unwrap the raw master-key bytes with the password-derived KEK. Stored as JSON {iv,ct} base64.
async function wrapMaster(kek, masterBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterBytes);
  return JSON.stringify({ iv: bytesToB64(iv), ct: bytesToB64(ct) });
}
async function unwrapMaster(kek, wrapped) {
  const { iv, ct } = JSON.parse(wrapped);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, kek, b64ToBytes(ct));
  return new Uint8Array(raw);
}
const importMaster = (bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

// Called right after a password sign-in / account setup, while the password is available. Derives
// the KEK, unwraps the existing master key (or mints and uploads a new one on first use), and caches
// the master key for the session. Returns the key, or null if crypto isn't available.
export async function unlockHistory(uid, password, { encSalt, wrappedKey } = {}) {
  if (!cryptoAvailable() || !password || !encSalt) return null;
  try {
    const kek = await kekFrom(password, encSalt);
    let masterBytes;
    if (wrappedKey) {
      masterBytes = await unwrapMaster(kek, wrappedKey);
    } else {
      masterBytes = crypto.getRandomValues(new Uint8Array(32));
      await api('api/me/keybundle', { method: 'PUT', body: { wrapped: await wrapMaster(kek, masterBytes) } });
    }
    const key = await importMaster(masterBytes);
    mem = { uid, key };
    await idb('readwrite', (s) => s.put({ uid, key }, 'history'));
    return key;
  } catch { return null; } // wrong password after a reset, corrupt blob, etc. — history stays locked
}

// The cached master key for this user, or null (e.g. a passkey-only sign-in — no password was given).
export async function historyKey(uid) {
  if (mem && mem.uid === uid) return mem.key;
  try { const rec = await idb('readonly', (s) => s.get('history')); if (rec?.uid === uid && rec.key) { mem = rec; return rec.key; } } catch { /* ignore */ }
  return null;
}

// Re-wrap the master key under a new password when the user changes their own password. The change
// form supplies both the current and new password, so this is stateless: unwrap with the old KEK,
// re-wrap with the new one, and upload. Call it AFTER the server has accepted the password change.
// Returns true on success; false (e.g. no existing wrapped key / not using password history) is a
// no-op the caller can ignore.
export async function rewrapHistory(currentPassword, newPassword, { encSalt, wrappedKey } = {}) {
  if (!cryptoAvailable() || !wrappedKey || !encSalt || !currentPassword || !newPassword) return false;
  try {
    const masterBytes = await unwrapMaster(await kekFrom(currentPassword, encSalt), wrappedKey);
    const rewrapped = await wrapMaster(await kekFrom(newPassword, encSalt), masterBytes);
    await api('api/me/keybundle', { method: 'PUT', body: { wrapped: rewrapped } });
    return true;
  } catch { return false; }
}

export async function lockHistory() { mem = null; try { await idb('readwrite', (s) => s.clear()); } catch { /* ignore */ } }

export async function encryptEntry(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct) };
}
export async function decryptEntry(key, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Shared helpers for the Indognito web UI.
export const BASE = new URL('./', location.href.split('#')[0]).pathname;

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export class ApiError extends Error { constructor(status, msg, body) { super(msg); this.status = status; this.body = body; } }

export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { 'x-gnito': '1', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(BASE + path.replace(/^\//, ''), opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && path !== 'api/auth/me' && !path.startsWith('api/auth/')) window.dispatchEvent(new Event('gnito:signedout'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

export function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}

export function modal(title, content, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', {}, title), content,
      h('div', { class: 'actions' }, actions.map((a) => h('button', {
        class: 'btn ' + (a.kind || ''), type: a.submit ? 'submit' : 'button',
        onclick: async () => {
          if (!a.run) return close(a.value);
          try { const v = await a.run(); if (v !== false) close(v ?? a.value); } catch (e) { toast(e.message, true); }
        },
      }, a.label))));
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } }, box);
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    setTimeout(() => (box.querySelector('input,select,textarea') || box.querySelector('.btn.primary'))?.focus(), 30);
  });
}

export const confirmBox = (title, text, label = 'Confirm', kind = 'danger') =>
  modal(title, h('p', { class: 'muted', style: { margin: 0 } }, text), [{ label: 'Cancel', value: false }, { label, kind, value: true }]);

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
export const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
export function meter(value, max) {
  const p = pct(value, max);
  return h('div', { class: 'meter' + (p > 90 ? ' hot' : ''), role: 'meter', 'aria-valuenow': p, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: p + '%' } }));
}

// Simple line icons (stroke = currentColor)
const P = {
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 4 3 3-3 3m5 0h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  file: 'M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3 2-1-2-4-2 .5-1.5-1.5L16 4h-4l-.5 2L10 7.5 8 7 6 11l2 1-2 1 2 4 2-.5 1.5 1.5.5 2h4l.5-2 1.5-1.5 2 .5 2-4-2-1Z',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6l-8-3Z',
  workspace: 'M3 5h18v11H3zM8 20h8M12 16v4',
  apps: 'M5 5h4v4H5zM10 5h4v4h-4zM15 5h4v4h-4zM5 10h4v4H5zM10 10h4v4h-4zM15 10h4v4h-4zM5 15h4v4H5zM10 15h4v4h-4zM15 15h4v4h-4z',
  back: 'M15 5l-7 7 7 7', fwd: 'M9 5l7 7-7 7', reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', home: 'M4 11l8-7 8 7v9H4z',
  plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6 6 18', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.3-4.3',
  history: 'M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4', upload: 'M12 16V4m-5 5 5-5 5 5M4 20h16', download: 'M12 4v12m-5-5 5 5 5-5M4 20h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', edit: 'M4 20h4L19 9l-4-4L4 16v4Z', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0', users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3',
  log: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5', network: 'M12 3v6M5 21v-4h14v4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 15v2',
  cpu: 'M7 7h10v10H7zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4', key: 'M14 10a4 4 0 1 0-1.2 2.8L20 20M17 17l2-2',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm0 13a3 3 0 0 1 3-3h11', map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  type: 'M5 6V4h14v2M12 4v16M9 20h6', library: 'M5 4h3v16H5zM10 4h3v16h-3zM15 5l3 .5-2 15-3-.5z', atom: 'M12 12m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M12 3c4 0 7 4 7 9s-3 9-7 9-7-4-7-9 3-9 7-9Z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5', brackets: 'M8 4H5v16h3M16 4h3v16h-3', play: 'M7 4l13 8-13 8z', logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  gamepad: 'M7 9h10a4 4 0 0 1 4 4v.5a3 3 0 0 1-5.5 1.7L14.5 14h-5l-1 1.2A3 3 0 0 1 3 13.5V13a4 4 0 0 1 4-4Zm.5 2v3M6 12.5h3M15 12h.01M17 14h.01',
  puzzle: 'M10 4a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H7v-3a2 2 0 1 1 0-4V4Z',
};
export function icon(name, cls = 'ico') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', P[name] || P.globe); s.append(p);
  return s;
}

// The Indognito logo: red rounded-square mark with an "incognito" disguise glyph (hat + glasses),
// red pill container, gradient wordmark.
export function logo(size = '') {
  const mark = h('span', { class: 'mark', html:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none">' +
    '<path d="M6.3 10.3c.6-3.2 1.7-4.8 5.7-4.8s5.1 1.6 5.7 4.8" fill="#fff"/>' +
    '<rect x="3.4" y="10" width="17.2" height="1.9" rx=".95" fill="#fff"/>' +
    '<circle cx="8.6" cy="15.4" r="2.7" fill="#fff"/><circle cx="15.4" cy="15.4" r="2.7" fill="#fff"/>' +
    '<path d="M10.9 15c.7-.6 1.5-.6 2.2 0" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>' +
    '<circle cx="8.6" cy="15.5" r="1.05" fill="#e5322d"/><circle cx="15.4" cy="15.5" r="1.05" fill="#e5322d"/></svg>' });
  return h('span', { class: 'logo ' + size, role: 'img', 'aria-label': 'Indognito' }, mark, h('span', { class: 'word', 'aria-hidden': 'true' }, 'indognito'));
}

// Decorative animated pixel-square background (SVG).
export function pixelBackground(cols = 32, rows = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'pixel-bg'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`); svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', x + 0.1); r.setAttribute('y', y + 0.1); r.setAttribute('width', 0.8); r.setAttribute('height', 0.8); r.setAttribute('rx', 0.15);
    r.style.animationDelay = `${(Math.random() * 7).toFixed(2)}s`;
    r.style.animationDuration = `${(5 + Math.random() * 6).toFixed(2)}s`;
    svg.append(r);
  }
  return svg;
}

export function field(label, input) { return h('label', { class: 'field' }, h('span', {}, label), input); }
// Passkeys only work on localhost or a real domain over a secure context — never a bare IP.
export const passkeysPossible = () => !!window.PublicKeyCredential && window.isSecureContext &&
  (location.hostname === 'localhost' || (!/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) && !location.hostname.includes(':') && location.hostname.includes('.')));

export const state = { user: null, limits: null, version: '' };

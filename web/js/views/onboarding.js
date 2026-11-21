// Onboarding (first Owner account + optional security) and sign-in.
import { api, h, logo, pixelBackground, field, toast, state, passkeysPossible } from '../core.js';
import { registerPasskey, setupTotp } from './security.js';
import { unlockHistory } from '../crypto.js';

const card = (...kids) => h('div', { class: 'center-card fade-in' }, ...kids);
const steps = (n) => h('div', { class: 'steps', 'aria-label': `Step ${n} of 3` }, [1, 2, 3].map((i) => h('i', { class: i <= n ? 'on' : '' })));

export function showOnboarding(mount) {
  const bg = pixelBackground();
  const holder = h('div', { class: 'screen' });
  let ownerPassword = null; // held briefly to unlock zero-knowledge history on first sign-in
  mount(h('div', {}, bg, holder));

  const welcome = () => holder.replaceChildren(h('div', { class: 'center-card hero fade-in' },
    logo('lg'),
    h('p', { class: 'lead' }, 'Your private browser, terminal and files — in one isolated workspace.'),
    h('button', { class: 'btn primary huge', onclick: account }, 'Get Started')));

  const account = () => {
    const user = h('input', { class: 'input', autocomplete: 'username', placeholder: 'e.g. andrew', maxlength: 32 });
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'At least 10 characters' });
    const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const err = h('div', { class: 'err', role: 'alert' });
    const next = h('button', { class: 'btn primary', type: 'submit' }, 'Next');
    const form = h('form', { class: 'col', style: { gap: '16px' }, onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (pw.value !== pw2.value) { err.textContent = 'The passwords do not match.'; return; }
      next.disabled = true;
      try {
        const r = await api('api/setup/owner', { method: 'POST', body: { username: user.value, password: pw.value } });
        state.user = r.user;
        ownerPassword = pw.value;
        security();
      } catch (ex) { err.textContent = ex.message; next.disabled = false; }
    } },
    field('Administrator username', user), field('Password', pw), field('Confirm password', pw2), err,
    h('div', { class: 'row' }, h('span', { class: 'grow faint', style: { fontSize: '13px' } }, 'This account becomes the Owner — the highest rank on this server.'), next));
    holder.replaceChildren(card(steps(1), h('h1', {}, 'Create your account'),
      h('p', { class: 'lead' }, 'You will use this to sign in and manage Indognito.'), form));
    user.focus();
  };

  const security = () => {
    const status = { passkey: h('span', { class: 'pill' }, 'Not set up'), totp: h('span', { class: 'pill' }, 'Not set up') };
    const hours = h('select', { class: 'input' }, [[4, '4 hours'], [12, '12 hours'], [24, '1 day'], [168, '1 week']].map(([v, l]) => h('option', { value: v, selected: v === 12 }, l)));
    const canPasskey = passkeysPossible();
    holder.replaceChildren(card(steps(2), h('h1', {}, 'Optional security'),
      h('p', { class: 'lead' }, 'You can add these now or later in Settings.'),
      h('div', { class: 'opt' }, h('div', { class: 'grow' }, h('b', {}, 'Passkey'), h('p', {}, canPasskey ? 'Sign in with your fingerprint, face or security key instead of a password.' : 'Passkeys need localhost or a domain name over HTTPS — not a bare IP address. Set up a hostname or TLS to enable them.')),
        status.passkey, h('button', { class: 'btn sm', disabled: !canPasskey, onclick: async () => { if (await registerPasskey()) { status.passkey.className = 'pill ok'; status.passkey.textContent = 'Added'; } } }, 'Add')),
      h('div', { class: 'opt' }, h('div', { class: 'grow' }, h('b', {}, 'Authenticator app (2-step)'), h('p', {}, 'Ask for a 6-digit code from an authenticator app after your password.')),
        status.totp, h('button', { class: 'btn sm', onclick: async () => { if (await setupTotp()) { status.totp.className = 'pill ok'; status.totp.textContent = 'On'; } } }, 'Set up')),
      h('div', { class: 'opt' }, h('div', { class: 'grow' }, h('b', {}, 'Stay signed in for'), h('p', {}, 'After this, you need to sign in again.')), hours),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        await api('api/me/preferences', { method: 'PUT', body: { sessionHours: Number(hours.value) } }).catch(() => {});
        finish();
      } }, 'Finish'))));
  };

  const finish = async () => {
    holder.replaceChildren(card(steps(3), h('h1', {}, 'Setting up your workspace…'), h('div', { class: 'dots' }, h('i'), h('i'), h('i'))));
    try {
      await api('api/workspace/stats'); // creates and measures the workspace
      const me = await api('api/auth/me');
      if (ownerPassword) { await unlockHistory(me.user.id, ownerPassword, me).catch(() => {}); ownerPassword = null; }
      window.dispatchEvent(new CustomEvent('gnito:signedin', { detail: { user: me.user, limits: me.limits } }));
    } catch (e) { toast(e.message, true); }
  };
  welcome();
}

export function showLogin(mount) {
  const bg = pixelBackground();
  const user = h('input', { class: 'input', autocomplete: 'username webauthn', required: true });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'err', role: 'alert' });
  const done = (r) => window.dispatchEvent(new CustomEvent('gnito:signedin', { detail: { user: r.user, limits: null } }));
  // `password`, when present (a password or password+TOTP sign-in), unlocks the user's
  // zero-knowledge browsing history. A passkey sign-in has no password, so history stays locked.
  const afterLogin = async (password) => {
    const me = await api('api/auth/me');
    if (password) await unlockHistory(me.user.id, password, me).catch(() => {});
    window.dispatchEvent(new CustomEvent('gnito:signedin', { detail: { user: me.user, limits: me.limits } }));
  };
  const totpStep = (challenge, password) => {
    const code = h('input', { class: 'input mono', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
    const e2 = h('div', { class: 'err', role: 'alert' });
    holder.replaceChildren(card(logo(), h('h1', {}, 'Enter your code'), h('p', { class: 'lead' }, 'Open your authenticator app and type the 6-digit code for Indognito.'),
      h('form', { class: 'col', onsubmit: async (ev) => {
        ev.preventDefault();
        try { await api('api/auth/totp', { method: 'POST', body: { challenge, code: code.value } }); await afterLogin(password); }
        catch (ex) { e2.textContent = ex.message; setTimeout(() => showLogin(mount), 2500); }
      } }, code, e2, h('button', { class: 'btn primary' }, 'Verify'))));
    code.focus();
  };
  const passkey = async () => {
    err.textContent = '';
    try {
      const o = await api('api/auth/passkey-options', { method: 'POST', body: {} });
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: o.options });
      await api('api/auth/passkey', { method: 'POST', body: { challenge: o.challenge, response } });
      await afterLogin();
    } catch (ex) { if (ex.name !== 'NotAllowedError') err.textContent = ex.message; }
  };
  const holder = h('div', { class: 'screen' }, card(logo(), h('h1', {}, 'Sign in'),
    h('form', { class: 'col', style: { gap: '16px' }, onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('api/auth/login', { method: 'POST', body: { username: user.value, password: pw.value } });
        if (r.mfa === 'totp') return totpStep(r.challenge, pw.value);
        await afterLogin(pw.value);
      } catch (ex) { err.textContent = ex.message; }
    } }, field('Username', user), field('Password', pw), err,
    h('div', { class: 'row' },
      passkeysPossible() ? h('button', { class: 'btn', type: 'button', onclick: passkey }, 'Use a passkey') : null,
      h('span', { class: 'grow' }), h('button', { class: 'btn primary' }, 'Sign in'))),
    h('p', { class: 'faint', style: { margin: 0, fontSize: '13px' } }, `Indognito v${state.version || ''}`)));
  void done;
  mount(h('div', {}, bg, holder));
  user.focus();
}

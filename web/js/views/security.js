// Passkey + authenticator-app setup dialogs (used by onboarding and Settings).
import { api, h, modal, field, toast } from '../core.js';

export async function registerPasskey() {
  try {
    const o = await api('api/security/passkey/register-options', { method: 'POST', body: {} });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: o.options });
    const name = navigator.userAgent.includes('Mac') ? 'Mac passkey' : navigator.userAgent.includes('Windows') ? 'Windows passkey' : navigator.userAgent.includes('Android') ? 'Android passkey' : 'Passkey';
    await api('api/security/passkey/register', { method: 'POST', body: { challenge: o.challenge, response, name } });
    toast('Passkey added');
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError') toast('Passkey setup was cancelled', true);
    else toast(e.message, true);
    return false;
  }
}

export async function setupTotp() {
  let s;
  try { s = await api('api/security/totp/setup', { method: 'POST', body: {} }); } catch (e) { toast(e.message, true); return false; }
  const code = h('input', { class: 'input mono', inputmode: 'numeric', maxlength: 6, placeholder: '123456', autocomplete: 'one-time-code' });
  const groups = s.secret.match(/.{1,4}/g).join(' ');
  const ok = await modal('Set up an authenticator app', h('div', { class: 'col', style: { gap: '14px' } },
    h('p', { class: 'muted', style: { margin: 0 } }, 'In your authenticator app (for example Aegis, 2FAS, Google Authenticator or 1Password), add an account with this setup key, then type the 6-digit code it shows.'),
    h('div', { class: 'well mono', style: { fontSize: '17px', letterSpacing: '.06em', textAlign: 'center', userSelect: 'all' } }, groups),
    h('a', { href: s.uri, class: 'faint', style: { fontSize: '13px' } }, 'Open in an authenticator app on this device'),
    field('Code from the app', code)), [
    { label: 'Cancel', value: false },
    { label: 'Turn on', kind: 'primary', run: async () => { await api('api/security/totp/enable', { method: 'POST', body: { challenge: s.challenge, code: code.value } }); return true; } },
  ]);
  if (ok) toast('Two-step sign-in is on');
  return !!ok;
}

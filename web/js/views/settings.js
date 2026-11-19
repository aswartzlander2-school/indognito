// Settings: password, passkeys, two-step sign-in, sessions, browser preferences.
import { api, h, icon, toast, modal, field, confirmBox, fmtTime, state, passkeysPossible } from '../core.js';
import { appHeader, clearBrowserData } from './shell.js';
import { registerPasskey, setupTotp } from './security.js';

export async function showSettings(mount) {
  const pane = h('main', { class: 'main', style: { paddingTop: '24px', maxWidth: '880px', margin: '0 auto', width: '100%' } });
  mount(h('div', { class: 'shell' }, appHeader('Settings', 'settings'), pane));
  const render = async () => {
    const [me, prefs, pk, sess] = await Promise.all([api('api/auth/me'), api('api/me/preferences'), api('api/security/passkeys'), api('api/me/sessions')]);
    state.user = me.user;
    const engine = h('select', { class: 'input' }, prefs.engines.map((e) => h('option', { value: e, selected: e === prefs.searchEngine }, { duckduckgo: 'DuckDuckGo (default)', startpage: 'Startpage', brave: 'Brave Search', ecosia: 'Ecosia', bing: 'Bing', google: 'Google' }[e])));
    const saveHist = h('input', { type: 'checkbox', checked: prefs.saveHistory });
    const hours = h('select', { class: 'input' }, [[4, '4 hours'], [12, '12 hours'], [24, '1 day'], [168, '1 week'], [720, '30 days']].map(([v, l]) => h('option', { value: v, selected: v === prefs.sessionHours }, l)));
    const canPk = passkeysPossible();
    pane.replaceChildren(
      h('h3', { class: 'row-title' }, 'Account'),
      h('div', { class: 'card col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, me.user.username), h('div', { class: 'muted' }, `${me.user.roleName} · Indognito ${me.version}`)),
        h('button', { class: 'btn', onclick: changePassword }, icon('key'), 'Change password'))),
      h('h3', { class: 'row-title section' }, 'Security'),
      h('div', { class: 'card col', style: { gap: '16px' } },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Passkeys'), h('div', { class: 'muted' }, canPk ? `${pk.passkeys.length} registered` : 'Passkeys need localhost or a domain over HTTPS, not a bare IP.')),
          h('button', { class: 'btn', disabled: !canPk, onclick: async () => { if (await registerPasskey()) render(); } }, icon('plus'), 'Add passkey')),
        ...pk.passkeys.map((p) => h('div', { class: 'row well' }, h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'faint', style: { fontSize: '13px' } }, `Added ${fmtTime(p.created)} · last used ${fmtTime(p.last_used)}`)),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('Remove passkey?', 'You will not be able to sign in with it anymore.', 'Remove')) { await api(`api/security/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); render(); } } }, 'Remove'))),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Two-step sign-in (authenticator app)'), h('div', { class: 'muted' }, me.user.totpEnabled ? 'On' : 'Off')),
          me.user.totpEnabled ? h('button', { class: 'btn danger', onclick: disableTotp }, 'Turn off') : h('button', { class: 'btn', onclick: async () => { if (await setupTotp()) render(); } }, 'Set up')),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, 'Stay signed in for'), h('div', { class: 'muted' }, 'Applies to new sign-ins.')), h('div', { style: { width: '180px' } }, hours))),
      h('h3', { class: 'row-title section' }, 'Signed-in devices'),
      h('div', { class: 'card col' }, ...sess.sessions.map((s) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, s.current ? 'This device' : (s.ua || 'Unknown device').slice(0, 70)), h('div', { class: 'faint', style: { fontSize: '13px' } }, `${s.ip || ''} · last active ${fmtTime(s.last_seen)}`)))),
        sess.sessions.length > 1 ? h('div', {}, h('button', { class: 'btn danger sm', onclick: async () => { await api('api/me/sessions/revoke-others', { method: 'POST', body: {} }); toast('Other devices were signed out'); render(); } }, 'Sign out other devices')) : null),
      h('h3', { class: 'row-title section' }, 'Browser'),
      h('div', { class: 'card col', style: { gap: '16px' } },
        field('Search engine', engine),
        h('label', { class: 'check' }, saveHist, 'Save browsing history to my account'),
        h('div', { class: 'row' },
          h('button', { class: 'btn danger sm', onclick: async () => { await api('api/browser/history', { method: 'DELETE' }); toast('History cleared'); } }, 'Clear history'),
          h('button', { class: 'btn sm', onclick: async () => { await clearBrowserData(); toast('Site cookies and storage on this device were cleared'); } }, 'Clear site data on this device'))),
      h('div', { style: { marginTop: '22px' } }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api('api/me/preferences', { method: 'PUT', body: { searchEngine: engine.value, saveHistory: saveHist.checked, sessionHours: Number(hours.value) } });
          state.user = r.user; toast('Settings saved');
        } catch (e) { toast(e.message, true); }
      } }, 'Save settings')));
  };
  const changePassword = async () => {
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const ok = await modal('Change password', h('div', { class: 'col' }, field('Current password', cur), field('New password (10+ characters)', nw)), [
      { label: 'Cancel', value: false }, { label: 'Change', kind: 'primary', run: async () => { await api('api/auth/password', { method: 'POST', body: { current: cur.value, password: nw.value } }); return true; } }]);
    if (ok) toast('Password changed. Other devices were signed out.');
  };
  const disableTotp = async () => {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const ok = await modal('Turn off two-step sign-in', field('Your password', pw), [{ label: 'Cancel', value: false },
      { label: 'Turn off', kind: 'danger', run: async () => { await api('api/security/totp/disable', { method: 'POST', body: { password: pw.value } }); return true; } }]);
    if (ok) { toast('Two-step sign-in is off'); render(); }
  };
  try { await render(); } catch (e) { toast(e.message, true); }
}

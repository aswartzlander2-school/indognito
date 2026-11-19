// Administration: accounts, roles, resource limits, network policy, apps, runtime, audit log.
import { api, h, icon, toast, modal, field, confirmBox, fmtBytes, fmtTime, meter, state } from '../core.js';
import { appHeader } from './shell.js';

const has = (p) => state.user.isOwner || state.user.perms.includes(p);

export async function showAdmin(mount, sub) {
  const sections = [
    ['overview', 'Overview', 'grid', 'system.view'], ['users', 'Accounts', 'users', 'users.view'], ['roles', 'Roles', 'shield', 'users.view'],
    ['policy', 'Network policy', 'network', 'policy.manage'], ['apps', 'Applications', 'apps', 'policy.manage'],
    ['runtime', 'Runtime', 'cpu', 'system.view'], ['audit', 'Audit log', 'log', 'audit.view'],
  ].filter((s) => has(s[3]));
  if (!sections.length) { toast('You do not have administrative permissions', true); location.hash = '#/home'; return; }
  const cur = sections.find((s) => s[0] === sub) ? sub : sections[0][0];
  const pane = h('section', { class: 'pane' });
  const nav = h('nav', { 'aria-label': 'Administration sections' }, sections.map(([k, label, ic]) =>
    h('button', { class: k === cur ? 'on' : '', 'aria-current': k === cur ? 'page' : null, onclick: () => { location.hash = `#/admin/${k}`; } }, icon(ic), label)));
  let timer;
  mount(h('div', { class: 'shell' }, appHeader('Administration', 'shield'), h('div', { class: 'admin', style: { flex: 1, minHeight: 0 } }, nav, pane)), () => clearInterval(timer));
  const views = { overview, users, roles, policy, apps, runtime, audit };
  try { await views[cur](pane, (fn, ms) => { timer = setInterval(fn, ms); }); } catch (e) { pane.append(h('p', { class: 'err' }, e.message)); }
}

const kpi = (k, v, sub) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'faint', style: { fontSize: '13px' } }, sub) : null);

async function overview(pane, every) {
  const render = async () => {
    const s = await api('api/admin/status');
    const u = has('users.view') ? (await api('api/admin/users')).users : [];
    pane.replaceChildren(
      h('h3', {}, 'Overview'), h('p', { class: 'muted' }, `Indognito ${s.version} on ${s.platform} · ${s.permissionMode === 'admin' ? 'administrator' : 'standard-user'} install`),
      h('div', { class: 'kpis' },
        kpi('Accounts', u.length, `${u.filter((x) => x.locked || x.status !== 'active').length} locked or disabled`),
        kpi('Browser sessions', `${s.browser.active} / ${s.browser.capacity}`, `${s.browser.queued} waiting in line`),
        kpi('Terminal sessions', s.terminals.filter((t) => t.status !== 'exited').length, `driver: ${s.runtime.selected}`),
        kpi('Host memory', s.host ? fmtBytes(s.host.memAvailable) : '—', s.host ? `available of ${fmtBytes(s.host.memTotal)}` : ''),
        kpi('Host CPU', s.host ? `${Math.round(s.host.cpuPercent)}%` : '—', s.host ? `${s.host.cpuCount} cores · load ${s.host.load[0].toFixed(2)}` : ''),
        kpi('Allocation', fmtBytes(s.allocation.ramMb * 1048576), `RAM · ${fmtBytes(s.allocation.storageMb * 1048576)} storage · ${s.allocation.cpuPercent}% CPU`)),
      h('div', { class: 'card' }, h('b', {}, 'Ports'), h('p', { class: 'muted', style: { margin: '6px 0 0' } },
        `Frontend ${s.ports.frontend} (public) · Backend ${s.ports.backend} (127.0.0.1 only) · TLS: ${s.tls === 'files' ? 'on (certificate files)' : 'off — put Indognito behind an HTTPS proxy for remote use'} · DNS check: ${s.dns?.ok ? 'ok' : 'failed'}`)));
  };
  await render(); every(() => render().catch(() => {}), 5000);
}

async function users(pane, every) {
  const { roles } = await api('api/admin/roles');
  const render = async () => {
    const { users: list } = await api('api/admin/users');
    pane.replaceChildren(
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, 'Accounts'), h('p', { class: 'muted', style: { margin: 0 } }, 'Usage is measured live. You can only manage accounts ranked below you.')),
        has('users.create') ? h('button', { class: 'btn primary', onclick: () => createUser(roles).then((ok) => ok && render()) }, icon('plus'), 'Create account') : null),
      h('div', { style: { overflowX: 'auto', marginTop: '18px' } }, h('table', { class: 'dtable' },
        h('thead', {}, h('tr', {}, ['Account', 'Role', 'Status', 'Storage', 'RAM', 'CPU', 'Sessions', 'Last sign-in', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, list.map((u) => h('tr', {},
          h('td', {}, h('b', {}, u.username), u.id === state.user.id ? h('span', { class: 'faint' }, ' (you)') : null),
          h('td', {}, h('span', { class: 'pill ' + (u.isOwner ? 'brand' : '') }, u.roleName)),
          h('td', {}, u.locked ? h('span', { class: 'pill bad', title: u.lockedReason || '' }, 'Locked') : u.status !== 'active' ? h('span', { class: 'pill warn' }, 'Disabled') : h('span', { class: 'pill ok' }, 'Active')),
          h('td', { class: 'mini' }, `${fmtBytes(u.usage.storage.used)} / ${fmtBytes(u.usage.storage.max)}`, meter(u.usage.storage.used, u.usage.storage.max)),
          h('td', { class: 'mini' }, `${fmtBytes(u.usage.ram.used)} / ${fmtBytes(u.usage.ram.max)}`, meter(u.usage.ram.used, u.usage.ram.max)),
          h('td', {}, `${u.usage.cpu.percent}% / ${u.usage.cpu.max}%`),
          h('td', { class: 'faint' }, `${u.usage.terminals.open}/${u.usage.terminals.max} term · ${u.usage.browser.open}/${u.usage.browser.max} web`),
          h('td', { class: 'faint' }, fmtTime(u.lastLogin)),
          h('td', {}, manageable(u) ? h('button', { class: 'btn sm', onclick: () => manage(u, roles).then(render) }, 'Manage') : null)))))));
  };
  await render(); every(() => render().catch(() => {}), 8000);
}

const manageable = (u) => u.id !== state.user.id && !u.isOwner && (state.user.isOwner || state.user.rank > u.rank);

function limitInputs(lim) {
  const mk = (k, v) => h('input', { class: 'input', type: 'number', min: 0, value: v, 'data-k': k });
  const els = { storage_mb: mk('storage_mb', lim.storage_mb), ram_mb: mk('ram_mb', lim.ram_mb), cpu_pct: mk('cpu_pct', lim.cpu_pct),
    browser_sessions: mk('browser_sessions', lim.browser_sessions), terminal_sessions: mk('terminal_sessions', lim.terminal_sessions) };
  const node = h('div', { class: 'form-grid' }, field('Storage (MB)', els.storage_mb), field('RAM (MB)', els.ram_mb), field('CPU (% of one core)', els.cpu_pct),
    field('Browser sessions', els.browser_sessions), field('Terminal sessions', els.terminal_sessions));
  return { node, value: () => Object.fromEntries(Object.entries(els).map(([k, e]) => [k, Number(e.value)])) };
}

async function createUser(roles) {
  const name = h('input', { class: 'input', autocomplete: 'off' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const role = h('select', { class: 'input' }, roles.filter((r) => r.key !== 'owner' && (state.user.isOwner || r.rank < state.user.rank)).map((r) => h('option', { value: r.key, selected: r.key === 'user' }, r.name)));
  const lim = limitInputs({ storage_mb: 2048, ram_mb: 512, cpu_pct: 50, browser_sessions: 1, terminal_sessions: 2 });
  return modal('Create account', h('div', { class: 'col', style: { gap: '14px' } }, field('Username', name), field('Temporary password', pw), field('Role', role),
    has('limits.manage') ? h('div', {}, h('b', {}, 'Limits'), lim.node) : null), [
    { label: 'Cancel', value: false },
    { label: 'Create', kind: 'primary', run: async () => {
      await api('api/admin/users', { method: 'POST', body: { username: name.value, password: pw.value, role: role.value, limits: has('limits.manage') ? lim.value() : undefined } });
      toast(`Created ${name.value}`); return true;
    } }]);
}

async function manage(u, roles) {
  const role = h('select', { class: 'input' }, roles.filter((r) => r.key !== 'owner' && (state.user.isOwner || r.rank < state.user.rank)).map((r) => h('option', { value: r.key, selected: r.key === u.role }, r.name)));
  const lim = limitInputs(u.limits);
  const reason = h('input', { class: 'input', placeholder: 'Shown to the user when they try to sign in' });
  const act = (label, kind, fn) => h('button', { class: 'btn sm ' + kind, onclick: async () => { try { await fn(); toast('Saved'); document.querySelector('.modal-back')?.remove(); } catch (e) { toast(e.message, true); } } }, label);
  const patch = (body) => api(`api/admin/users/${u.id}`, { method: 'PATCH', body });
  await modal(`Manage ${u.username}`, h('div', { class: 'col', style: { gap: '16px' } },
    has('users.manage') ? h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Role', role)), h('button', { class: 'btn', style: { alignSelf: 'flex-end' }, onclick: async () => { try { await patch({ role: role.value }); toast('Role changed — they will be asked to sign in again'); } catch (e) { toast(e.message, true); } } }, 'Change role')) : null,
    has('limits.manage') ? h('div', {}, h('b', {}, 'Resource limits'), lim.node, h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: async () => { try { await patch({ limits: lim.value() }); toast('Limits saved'); } catch (e) { toast(e.message, true); } } }, 'Save limits')) : null,
    has('users.lock') ? h('div', { class: 'col' }, h('b', {}, u.locked ? 'Account is locked' : 'Lock account'), u.locked ? null : field('Reason (optional)', reason),
      h('div', { class: 'row' }, u.locked ? act('Unlock', '', () => patch({ locked: false })) : act('Lock out now', 'danger', () => patch({ locked: true, reason: reason.value })))) : null,
    has('users.manage') ? h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      u.status === 'active' ? act('Disable account', 'danger', () => patch({ status: 'disabled' })) : act('Enable account', '', () => patch({ status: 'active' })),
      act('Reset password', '', async () => {
        const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
        const v = await modal(`New password for ${u.username}`, field('Password (10+ characters)', pw), [{ label: 'Cancel', value: null }, { label: 'Set', kind: 'primary', run: () => pw.value }]);
        if (v) await patch({ password: v });
      }),
      act('Delete account', 'danger', async () => {
        if (!(await confirmBox(`Delete ${u.username}?`, 'Their account and workspace files are deleted permanently.', 'Delete'))) throw new Error('Cancelled');
        await api(`api/admin/users/${u.id}`, { method: 'DELETE' });
      }),
      state.user.isOwner ? act('Make Owner…', '', async () => {
        const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
        const v = await modal('Transfer ownership', h('div', { class: 'col' }, h('p', { class: 'muted', style: { margin: 0 } }, `${u.username} becomes the Owner and you become an Administrator. There is only ever one Owner.`), field('Your password', pw)),
          [{ label: 'Cancel', value: null }, { label: 'Transfer', kind: 'danger', run: () => pw.value }]);
        if (!v) throw new Error('Cancelled');
        await api('api/admin/transfer-ownership', { method: 'POST', body: { userId: u.id, password: v } });
        location.reload();
      }) : null) : null), [{ label: 'Close', value: true }]);
}

async function roles(pane) {
  const render = async () => {
    const { roles: list, permissions } = await api('api/admin/roles');
    pane.replaceChildren(
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, 'Roles'), h('p', { class: 'muted', style: { margin: 0 } }, 'Higher rank can manage lower rank. There is exactly one Owner. Nobody can raise their own permissions.')),
        has('roles.manage') ? h('button', { class: 'btn primary', onclick: () => editRole(null, permissions).then((ok) => ok && render()) }, icon('plus'), 'New role') : null),
      h('table', { class: 'dtable', style: { marginTop: '18px' } }, h('thead', {}, h('tr', {}, ['Role', 'Rank', 'Members', 'Permissions', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, list.map((r) => h('tr', {},
          h('td', {}, h('b', {}, r.name), r.builtin ? h('span', { class: 'faint' }, ' · built-in') : null),
          h('td', {}, r.rank), h('td', {}, r.members),
          h('td', { class: 'faint', style: { fontSize: '13px' } }, r.key === 'owner' ? 'Everything' : r.perms.length ? r.perms.join(', ') : 'None (regular user)'),
          h('td', {}, has('roles.manage') && (!r.builtin || r.key === 'moderator') ? h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => editRole(r, permissions).then((ok) => ok && render()) }, 'Edit'),
            !r.builtin ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox(`Delete ${r.name}?`, 'Members become regular users.', 'Delete')) { await api(`api/admin/roles/${r.key}`, { method: 'DELETE' }); render(); } } }, 'Delete') : null) : null))))));
  };
  await render();
}

async function editRole(r, permissions) {
  const name = h('input', { class: 'input', value: r?.name || '' });
  const rank = h('input', { class: 'input', type: 'number', min: 1, max: 79, value: r?.rank || 40 });
  const boxes = Object.entries(permissions).map(([k, d]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: r?.perms.includes(k), disabled: !has(k) }), h('span', {}, h('b', {}, k), h('div', { class: 'faint', style: { fontSize: '13px' } }, d))));
  return modal(r ? `Edit ${r.name}` : 'New role', h('div', { class: 'col', style: { gap: '14px' } }, field('Name', name), field('Rank (1–79, below Administrator)', rank), h('div', { class: 'col' }, boxes)), [
    { label: 'Cancel', value: false },
    { label: 'Save', kind: 'primary', run: async () => {
      const body = { name: name.value, rank: Number(rank.value), perms: boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value) };
      await api(r ? `api/admin/roles/${r.key}` : 'api/admin/roles', { method: r ? 'PATCH' : 'POST', body });
      return true;
    } }]);
}

async function policy(pane) {
  const { policy: p, capacity } = await api('api/admin/policy');
  const mode = h('select', { class: 'input' }, h('option', { value: 'blocklist', selected: p.mode === 'blocklist' }, 'Block listed sites (allow everything else)'), h('option', { value: 'allowlist', selected: p.mode === 'allowlist' }, 'Allow only listed sites'));
  const block = h('textarea', { class: 'input mono', rows: 6, placeholder: 'example.com\n*.example.org' }, p.block.join('\n'));
  const allow = h('textarea', { class: 'input mono', rows: 6, placeholder: 'wikipedia.org\n*.edu' }, p.allow.join('\n'));
  const ports = h('select', { class: 'input' }, h('option', { value: 'web', selected: p.ports === 'web' }, 'Web ports only (80, 443, 8080, 8443)'), h('option', { value: 'any', selected: p.ports === 'any' }, 'Any port'));
  const cap = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: capacity });
  pane.replaceChildren(h('h3', {}, 'Network policy'),
    h('p', { class: 'muted' }, 'Applies to every browser session on this server. Private, local and loopback addresses are always refused. Indognito does not hide or disguise its traffic; see docs/NETWORK.md for what network security products will see.'),
    h('div', { class: 'card col', style: { gap: '16px' } }, field('Mode', mode),
      h('div', { class: 'form-grid' }, field('Blocked domains (one per line)', block), field('Allowed domains (allowlist mode)', allow)),
      h('div', { class: 'form-grid' }, field('Destination ports', ports), field('Concurrent browser sessions (server capacity)', cap)),
      h('p', { class: 'faint', style: { margin: 0, fontSize: '13px' } }, 'When all sessions are in use, new visitors wait in a fair queue and see an estimated wait time based on recent session lengths.'),
      h('div', {}, h('button', { class: 'btn primary', onclick: async () => {
        try { await api('api/admin/policy', { method: 'PUT', body: { mode: mode.value, block: block.value, allow: allow.value, ports: ports.value, capacity: Number(cap.value) } }); toast('Policy saved and applied'); }
        catch (e) { toast(e.message, true); }
      } }, 'Save policy'))));
}

async function apps(pane) {
  const render = async () => {
    const { apps: list } = await api('api/admin/apps');
    pane.replaceChildren(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', {}, 'Applications'), h('p', { class: 'muted', style: { margin: 0 } }, 'Tiles on the home screen. They open in the isolated browser.')),
      h('button', { class: 'btn primary', onclick: () => editApp(null).then((ok) => ok && render()) }, icon('plus'), 'Add application')),
    h('table', { class: 'dtable', style: { marginTop: '18px' } }, h('thead', {}, h('tr', {}, ['Name', 'Identifier', 'Address', 'Category', 'Shown', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, list.map((a) => h('tr', {}, h('td', {}, h('b', {}, a.name)), h('td', { class: 'mono faint' }, a.id), h('td', { class: 'faint' }, a.url), h('td', {}, a.category),
        h('td', {}, a.enabled ? h('span', { class: 'pill ok' }, 'Yes') : h('span', { class: 'pill' }, 'Hidden')),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => editApp(a).then((ok) => ok && render()) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox(`Remove ${a.name}?`, 'The tile disappears for everyone.', 'Remove')) { await api(`api/admin/apps/${a.id}`, { method: 'DELETE' }); render(); } } }, 'Remove'))))))));
  };
  await render();
}

async function editApp(a) {
  const id = h('input', { class: 'input mono', value: a?.id || '', disabled: !!a, placeholder: 'edu-example' });
  const name = h('input', { class: 'input', value: a?.name || '' });
  const url = h('input', { class: 'input', value: a?.url || 'https://' });
  const cat = h('input', { class: 'input', value: a?.category || 'Learning' });
  const desc = h('input', { class: 'input', value: a?.description || '' });
  const en = h('input', { type: 'checkbox', checked: a ? !!a.enabled : true });
  return modal(a ? `Edit ${a.name}` : 'Add application', h('div', { class: 'col', style: { gap: '12px' } },
    field('Identifier (lowercase, used internally)', id), field('Name', name), field('Address (https://)', url), field('Category', cat), field('Description', desc),
    h('label', { class: 'check' }, en, 'Show on the home screen')), [
    { label: 'Cancel', value: false },
    { label: 'Save', kind: 'primary', run: async () => { await api(`api/admin/apps/${encodeURIComponent(id.value)}`, { method: 'PUT', body: { name: name.value, url: url.value, category: cat.value, description: desc.value, enabled: en.checked, icon: a?.icon || 'globe', sort: a?.sort || 99 } }); return true; } }]);
}

async function runtime(pane, every) {
  const render = async () => {
    const s = await api('api/admin/status');
    const r = s.runtime;
    const allow = h('input', { type: 'checkbox', checked: s.allowUnsandboxed, disabled: !state.user.isOwner });
    const net = h('input', { type: 'checkbox', checked: s.terminalNetwork, disabled: !has('policy.manage') });
    pane.replaceChildren(h('h3', {}, 'Runtime'),
      h('div', { class: 'kpis' }, kpi('Terminal driver', r.selected, r.sandbox ? 'bubblewrap sandbox available' : r.sandboxReason),
        kpi('Resource limits', r.limits === 'cgroup' ? 'Kernel (cgroups)' : 'Monitoring', r.limits === 'cgroup' ? 'systemd scopes enforce RAM/CPU' : 'over-limit sessions are stopped / deprioritized'),
        kpi('PTY helper', r.pty ? 'Installed' : 'Missing'), kpi('MicroVM', r.microvm ? 'Configured' : 'Not configured', 'experimental; see docs')),
      h('div', { class: 'card col', style: { gap: '12px' } },
        h('label', { class: 'check' }, allow, h('span', {}, h('b', {}, 'Allow unsandboxed terminals for other accounts'), h('div', { class: 'faint', style: { fontSize: '13px' } }, 'Only the Owner can change this. Without a sandbox, a shell runs as the server’s own user and can read the server’s files. Leave this off on shared servers.'))),
        h('label', { class: 'check' }, net, h('span', {}, h('b', {}, 'Terminals can reach the internet'), h('div', { class: 'faint', style: { fontSize: '13px' } }, 'In sandbox mode, turning this off gives each terminal its own empty network.'))),
        h('div', {}, h('button', { class: 'btn primary', onclick: async () => { try { await api('api/admin/runtime', { method: 'PUT', body: { ...(state.user.isOwner ? { allowUnsandboxed: allow.checked } : {}), terminalNetwork: net.checked } }); toast('Saved'); } catch (e) { toast(e.message, true); } } }, 'Save'))),
      h('h3', { style: { marginTop: '26px', fontSize: '19px' } }, 'Active terminal sessions'),
      s.terminals.length ? h('table', { class: 'dtable', style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['Account', 'Session', 'Driver', 'Status', 'Started'].map((x) => h('th', {}, x)))),
        h('tbody', {}, s.terminals.map((t) => h('tr', {}, h('td', {}, t.username), h('td', {}, t.title), h('td', {}, t.driver), h('td', {}, t.status), h('td', { class: 'faint' }, fmtTime(t.created))))))
        : h('p', { class: 'muted' }, 'None.'));
  };
  await render(); every(() => { if (!document.activeElement?.matches('input')) render().catch(() => {}); }, 6000);
}

async function audit(pane) {
  const rows = h('tbody');
  let last = null;
  const more = h('button', { class: 'btn sm', onclick: () => load() }, 'Load older');
  const load = async () => {
    const { entries } = await api(`api/admin/audit${last ? `?before=${last}` : ''}`);
    for (const e of entries) rows.append(h('tr', {}, h('td', { class: 'faint', style: { whiteSpace: 'nowrap' } }, fmtTime(e.ts)), h('td', {}, e.actor), h('td', { class: 'mono' }, e.action), h('td', { class: 'faint' }, e.target || ''),
      h('td', { class: 'faint mono', style: { fontSize: '12px', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.detail ? JSON.stringify(e.detail) : ''), h('td', { class: 'faint' }, e.ip || '')));
    if (entries.length) last = entries[entries.length - 1].id;
    if (entries.length < 100) more.remove();
  };
  pane.replaceChildren(h('h3', {}, 'Audit log'), h('p', { class: 'muted' }, 'Every administrative action, sign-in and security change is recorded. Browsing destinations are not logged.'),
    h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'dtable' }, h('thead', {}, h('tr', {}, ['Time', 'Actor', 'Action', 'Target', 'Details', 'IP'].map((x) => h('th', {}, x)))), rows)),
    h('div', { style: { marginTop: '12px' } }, more));
  await load();
}

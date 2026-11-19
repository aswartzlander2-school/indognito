// File Explorer over the user's workspace (the same folder the terminal opens in).
import { api, h, icon, BASE, toast, modal, field, confirmBox, fmtBytes, fmtTime, meter } from '../core.js';
import { appHeader } from './shell.js';

const TEXT_EXT = /\.(txt|md|json|js|mjs|ts|py|sh|c|h|cpp|go|rs|java|rb|php|css|html|xml|ya?ml|toml|ini|cfg|conf|log|csv|sql|env|gitignore)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i, VID_EXT = /\.(mp4|webm)$/i, AUD_EXT = /\.(mp3|wav|ogg)$/i, PDF_EXT = /\.pdf$/i;
const join = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
const q = (p) => encodeURIComponent(p);

export async function showFiles(mount) {
  let path = sessionStorage.getItem('gnito.files.path') || '/';
  let selected = null, entries = [];
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
  const tbody = h('tbody');
  const list = h('div', { class: 'flist' }, h('table', { class: 'ftable' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Size'), h('th', {}, 'Modified'), h('th', {}, 'Permissions'))), tbody));
  const usage = h('div', { class: 'usage' });
  const pvHead = h('header', {}, h('b', { class: 'grow' }, 'Preview'));
  const pv = h('div', { class: 'pv' }, h('p', { class: 'faint' }, 'Select a file to preview it.'));
  const preview = h('aside', { class: 'preview', 'aria-label': 'Preview' }, pvHead, pv);
  const upload = h('input', { type: 'file', multiple: true, class: 'sr', onchange: () => uploadFiles([...upload.files]) });
  const b = (ic, label, fn, kind = '') => h('button', { class: 'btn sm ' + kind, onclick: fn }, icon(ic), label);
  const toolbar = h('div', { class: 'toolbar' },
    b('folder', 'New folder', newFolder), b('file', 'New file', newFile), b('upload', 'Upload', () => upload.click()), upload,
    h('span', { class: 'grow' }),
    b('download', 'Download', () => selected && selected.type === 'file' && download(selected)),
    b('edit', 'Rename', () => selected && rename(selected)), b('lock', 'Permissions', () => selected && perms(selected)),
    b('trash', 'Delete', () => selected && del(selected), 'danger'),
    b('terminal', 'Open in terminal', () => { sessionStorage.setItem('gnito.cd', path); location.hash = '#/terminal'; }));
  const root = h('div', { class: 'files', style: { flex: 1, minHeight: 0 } }, h('div', { class: 'files-main' }, toolbar, crumbs, list, usage), preview);
  mount(h('div', { class: 'shell' }, appHeader('File Explorer', 'folder'), root));

  // drag & drop upload
  list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drop'); });
  list.addEventListener('dragleave', () => list.classList.remove('drop'));
  list.addEventListener('drop', (e) => { e.preventDefault(); list.classList.remove('drop'); uploadFiles([...e.dataTransfer.files]); });

  async function load(p = path) {
    try {
      const r = await api(`api/files/list?path=${q(p)}`);
      path = r.path; entries = r.entries; selected = null;
      sessionStorage.setItem('gnito.files.path', path);
      renderCrumbs(); renderList();
      usage.replaceChildren(h('span', {}, 'Storage'), meter(r.usage.used, r.usage.max), h('span', {}, `${fmtBytes(r.usage.used)} of ${fmtBytes(r.usage.max)} used`));
    } catch (e) { toast(e.message, true); if (p !== '/') load('/'); }
  }

  function renderCrumbs() {
    const parts = path.split('/').filter(Boolean);
    crumbs.replaceChildren(h('button', { onclick: () => load('/') }, icon('home'), ' Workspace'),
      ...parts.flatMap((part, i) => [h('span', { class: 'faint' }, '/'), h('button', { onclick: () => load('/' + parts.slice(0, i + 1).join('/')) }, part)]));
  }

  function renderList() {
    tbody.replaceChildren(...(path !== '/' ? [h('tr', { ondblclick: () => load(path.replace(/\/[^/]+\/?$/, '') || '/') }, h('td', { colspan: 4 }, h('span', { class: 'fname' }, icon('back'), '..')))] : []),
      ...entries.map((e) => {
        const tr = h('tr', {
          tabindex: 0, class: selected?.name === e.name ? 'sel' : '',
          onclick: () => { selected = e; renderList(); showPreview(e); },
          ondblclick: () => (e.type === 'dir' ? load(join(path, e.name)) : showPreview(e)),
          onkeydown: (ev) => { if (ev.key === 'Enter') (e.type === 'dir' ? load(join(path, e.name)) : showPreview(e)); if (ev.key === 'Delete') del(e); },
        },
        h('td', {}, h('span', { class: 'fname' }, icon(e.type === 'dir' ? 'folder' : IMG_EXT.test(e.name) ? 'image' : 'file'), e.name)),
        h('td', { class: 'muted' }, e.type === 'dir' ? '—' : fmtBytes(e.size)),
        h('td', { class: 'muted' }, fmtTime(e.mtime)),
        h('td', { class: 'mono faint' }, e.mode));
        return tr;
      }));
    if (!entries.length) tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'faint', style: { padding: '24px 12px' } }, 'This folder is empty. Drop files here to upload them.')));
  }

  async function showPreview(e) {
    const p = join(path, e.name);
    pvHead.replaceChildren(h('b', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, e.name));
    root.classList.add('showpv');
    pvHead.append(h('button', { class: 'btn sm icon ghost', 'aria-label': 'Close preview', onclick: () => root.classList.remove('showpv') }, icon('x')));
    if (e.type === 'dir') { pv.replaceChildren(h('p', { class: 'muted' }, `Folder · ${fmtTime(e.mtime)}`), h('button', { class: 'btn sm', onclick: () => load(p) }, 'Open folder')); return; }
    const url = `${BASE}api/files/preview?path=${q(p)}`;
    if (IMG_EXT.test(e.name)) return pv.replaceChildren(h('img', { src: url, alt: e.name }));
    if (VID_EXT.test(e.name)) return pv.replaceChildren(h('video', { src: url, controls: true }));
    if (AUD_EXT.test(e.name)) return pv.replaceChildren(h('audio', { src: url, controls: true }));
    if (PDF_EXT.test(e.name)) return pv.replaceChildren(h('iframe', { src: url, title: e.name, sandbox: '' }));
    if (e.size > 1 << 20) return pv.replaceChildren(h('p', { class: 'muted' }, `${fmtBytes(e.size)} — too large to preview. Download it instead.`));
    try {
      const r = await api(`api/files/preview?path=${q(p)}&as=text`);
      if (r.kind === 'binary') return pv.replaceChildren(h('p', { class: 'muted' }, 'This looks like a binary file, so it is not shown. Download it instead.'));
      const ta = h('textarea', { spellcheck: 'false', 'aria-label': `Contents of ${e.name}` }, r.content);
      pvHead.insertBefore(h('button', { class: 'btn sm primary', onclick: async () => {
        try { await api('api/files/create', { method: 'POST', body: { path, name: e.name, content: ta.value, overwrite: true } }); toast('Saved'); load(); }
        catch (ex) { toast(ex.message, true); }
      } }, 'Save'), pvHead.lastChild);
      pv.replaceChildren(ta);
    } catch (ex) { pv.replaceChildren(h('p', { class: 'err' }, ex.message)); }
  }

  async function ask(title, label, value = '') {
    const inp = h('input', { class: 'input', value });
    return modal(title, field(label, inp), [{ label: 'Cancel', value: null }, { label: 'OK', kind: 'primary', run: () => inp.value.trim() || false }]);
  }
  async function newFolder() {
    const name = await ask('New folder', 'Folder name'); if (!name) return;
    try { await api('api/files/mkdir', { method: 'POST', body: { path, name } }); load(); } catch (e) { toast(e.message, true); }
  }
  async function newFile() {
    const name = await ask('New file', 'File name', 'notes.txt'); if (!name) return;
    try { await api('api/files/create', { method: 'POST', body: { path, name, content: '' } }); await load(); } catch (e) { toast(e.message, true); }
  }
  async function rename(e) {
    const name = await ask(`Rename ${e.name}`, 'New name', e.name); if (!name || name === e.name) return;
    try { await api('api/files/rename', { method: 'POST', body: { path: join(path, e.name), name } }); load(); } catch (ex) { toast(ex.message, true); }
  }
  async function del(e) {
    if (!(await confirmBox(`Delete ${e.name}?`, e.type === 'dir' ? 'The folder and everything in it will be deleted. This cannot be undone.' : 'This cannot be undone.', 'Delete'))) return;
    try { await api('api/files/delete', { method: 'POST', body: { path: join(path, e.name) } }); pv.replaceChildren(); load(); } catch (ex) { toast(ex.message, true); }
  }
  async function perms(e) {
    const inp = h('input', { class: 'input mono', value: e.perm, maxlength: 3, inputmode: 'numeric' });
    const mode = await modal(`Permissions for ${e.name}`, h('div', { class: 'col' },
      h('p', { class: 'muted', style: { margin: 0 } }, `Current: ${e.mode}. Use three octal digits for owner, group and others (e.g. 644 = owner can write, everyone can read; 755 = also executable).`),
      field('Mode', inp)), [{ label: 'Cancel', value: null }, { label: 'Apply', kind: 'primary', run: () => inp.value }]);
    if (!mode) return;
    try { await api('api/files/chmod', { method: 'POST', body: { path: join(path, e.name), mode } }); load(); } catch (ex) { toast(ex.message, true); }
  }
  function download(e) {
    const a = h('a', { href: `${BASE}api/files/download?path=${q(join(path, e.name))}`, download: e.name });
    document.body.append(a); a.click(); a.remove();
  }
  async function uploadFiles(files) {
    for (const f of files) {
      toast(`Uploading ${f.name}…`);
      try { await api(`api/files/upload?path=${q(join(path, f.name))}`, { method: 'PUT', body: f, raw: true, headers: { 'content-type': 'application/octet-stream' } }); }
      catch (e) { toast(`${f.name}: ${e.message}`, true); }
    }
    upload.value = '';
    load();
  }
  load();
}

// NoteCompanion app: inbox capture, notebook tree, page editor, search, settings.
(function () {
  const { notebooks, sections, pages, assets, meta, deviceName } = window.NCDB;
  const G = window.NCGraph;
  const S = window.NCSync;
  const C = window.NC_CONFIG;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const content = $('#content');
  const state = { view: 'inbox', pageId: null, editor: null, viewer: null, saveTimer: null, mode: 'read', expanded: new Set(), query: '' };
  const isNarrow = () => matchMedia('(max-width: 899px)').matches;
  const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  // ---------- small UI helpers ----------
  let toastTimer = null;
  function toast(msg, action) {
    const t = $('#toast'); t.innerHTML = ''; t.append(msg);
    if (action) t.append(el('button', { type: 'button', onclick: () => { action.fn(); t.hidden = true; } }, action.label));
    t.hidden = false; clearTimeout(toastTimer);
    if (!action || !action.sticky) toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 2600);
  }
  function sheet(build) {
    return new Promise((resolve) => {
      const host = $('#sheet-host'); host.innerHTML = '';
      const close = (v) => { host.hidden = true; host.innerHTML = ''; resolve(v); };
      const box = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
      build(box, close);
      host.append(box); host.hidden = false;
      host.onclick = (e) => { if (e.target === host) close(undefined); };
      const first = box.querySelector('input, textarea, button'); if (first) setTimeout(() => first.focus(), 30);
    });
  }
  const ask = (title, placeholder, value, okLabel) => sheet((box, close) => {
    const input = el('input', { type: 'text', placeholder: placeholder || '', value: value || '', id: 'ask-input' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); } if (e.key === 'Escape') close(undefined); });
    box.append(el('h2', {}, title), input, el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
      el('button', { class: 'btn primary', type: 'button', onclick: () => close(input.value.trim()) }, okLabel || 'OK')));
  });
  const confirm = (title, note, okLabel) => sheet((box, close) => {
    box.append(el('h2', {}, title), note ? el('p', { class: 'danger-note' }, note) : null, el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => close(true) }, okLabel || 'Delete')));
  });
  const fmtWhen = (ms) => {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const same = d.toDateString() === now.toDateString();
    const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (same) return t;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday ' + t;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + t;
  };
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function onChanged() { S.schedule(); refreshTree(); refreshInboxCount(); }

  // ---------- assets ----------
  async function downscale(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)/.test(file.type) || file.size < 400 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const max = 1800, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (e) { return file; }
  }
  async function storeAsset(file, name) {
    const blob = file.type.startsWith('image/') ? await downscale(file) : file;
    const rec = await assets.create(blob, name || file.name || 'file');
    return rec;
  }
  const assetUrl = (id) => 'asset/' + id;

  // ---------- inbox ----------
  let recorder = null, recChunks = [], recStream = null;
  async function captureText(text, title) {
    text = (text || '').trim(); if (!text) return null;
    const p = await pages.create({ inbox: 1, kind: 'text', title: title || text.split('\n')[0].slice(0, 60), md: text, mode: 'markdown' });
    onChanged(); return p;
  }
  async function captureImage(file) {
    const a = await storeAsset(file);
    const p = await pages.create({ inbox: 1, kind: 'image', title: file.name ? file.name.replace(/\.\w+$/, '') : 'Photo', md: '![' + (file.name || 'photo') + '](' + assetUrl(a.id) + ')', assetId: a.id });
    onChanged(); return p;
  }
  async function captureFile(file) {
    const a = await storeAsset(file);
    const p = await pages.create({ inbox: 1, kind: 'file', title: file.name || 'File', md: '[' + (file.name || 'file') + '](' + assetUrl(a.id) + ')', assetId: a.id });
    onChanged(); return p;
  }
  async function captureAudio(blob, seconds) {
    const name = 'Voice note ' + new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const a = await assets.create(blob, name + '.' + ext);
    const p = await pages.create({ inbox: 1, kind: 'audio', title: name, md: '🎙 [Play ' + name + '](' + assetUrl(a.id) + ')  \n_' + seconds + ' s recording_', assetId: a.id });
    onChanged(); return p;
  }
  async function toggleRecording(btn) {
    if (recorder) {
      recorder.stop(); return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording is not available in this browser.'); return; }
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { toast('Microphone access was refused.'); return; }
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recChunks = []; const started = Date.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      recStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || mime || 'audio/webm' });
      recorder = null; recStream = null;
      btn.classList.remove('recording'); btn.textContent = '● Record';
      if (blob.size > 0) { await captureAudio(blob, Math.round((Date.now() - started) / 1000)); renderInbox(); toast('Voice note saved'); }
    };
    recorder.start();
    btn.classList.add('recording'); btn.textContent = '■ Stop';
  }

  async function renderInbox() {
    state.view = 'inbox';
    const list = await pages.inbox();
    const view = el('div', { class: 'view' });
    const ta = el('textarea', { id: 'capture-text', placeholder: 'Quick note…', rows: 2 });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; });
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn.click(); });
    ta.addEventListener('paste', async (e) => {
      const items = [...(e.clipboardData && e.clipboardData.items || [])].filter((i) => i.kind === 'file');
      if (!items.length) return;
      e.preventDefault();
      for (const it of items) { const f = it.getAsFile(); if (f) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f)); }
      renderInbox(); toast('Added to inbox');
    });
    const saveBtn = el('button', { class: 'btn primary', type: 'button', onclick: async () => { if (await captureText(ta.value)) { ta.value = ''; ta.style.height = ''; renderInbox(); } } }, 'Save');
    const photoBtn = el('button', { class: 'btn', type: 'button', onclick: () => $('#file-image').click() }, '📷 Photo');
    const recBtn = el('button', { class: 'btn', type: 'button', onclick: () => toggleRecording(recBtn) }, '● Record');
    const fileBtn = el('button', { class: 'btn', type: 'button', onclick: () => $('#file-any').click() }, '📎 File');
    const composer = el('div', { class: 'composer' }, ta, el('div', { class: 'bar' }, photoBtn, recBtn, fileBtn, el('span', { class: 'spacer' }), saveBtn));
    composer.addEventListener('dragover', (e) => { e.preventDefault(); });
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const f of [...e.dataTransfer.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
      renderInbox();
    });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Inbox'), el('p', { class: 'sub' }, list.length ? list.length + ' to file' : 'Capture now, file later')), composer);
    const cards = el('div', { class: 'cards' });
    for (const p of list) cards.append(inboxCard(p));
    view.append(cards);
    content.replaceChildren(view);
    syncNav();
    if (location.hash === '#capture') setTimeout(() => ta.focus(), 50);
  }

  function inboxCard(p) {
    const card = el('div', { class: 'card' + (p.pinned ? ' pinned' : '') });
    card.append(el('div', { class: 'meta' }, el('span', { class: 'kind' }, p.kind), el('span', {}, fmtWhen(p.updated)), p.tags && p.tags.length ? el('span', {}, p.tags.map((t) => '#' + t).join(' ')) : null));
    if (p.kind === 'image' && p.assetId) {
      card.append(el('img', { src: assetUrl(p.assetId), alt: p.title, loading: 'lazy', onclick: () => openPage(p.id) }));
    } else if (p.kind === 'audio' && p.assetId) {
      card.append(el('div', {}, p.title), el('audio', { controls: '', src: assetUrl(p.assetId), preload: 'none' }));
    } else if (p.kind === 'file' && p.assetId) {
      card.append(el('a', { href: assetUrl(p.assetId), target: '_blank', rel: 'noopener' }, '📎 ' + p.title));
    } else {
      const body = el('div', { class: 'body' + (p.md.length < 220 ? ' short' : ''), onclick: () => openPage(p.id) }, p.md);
      card.append(body);
    }
    const fileBtn = el('button', { class: 'btn small', type: 'button', onclick: async () => { if (await fileInto(p.id)) renderInbox(); } }, 'File to…');
    const openBtn = el('button', { class: 'btn small', type: 'button', onclick: () => openPage(p.id) }, 'Open');
    const pinBtn = el('button', { class: 'btn small', type: 'button', onclick: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); renderInbox(); } }, p.pinned ? 'Unpin' : 'Pin');
    const delBtn = el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirm('Delete this capture?')) { await pages.remove(p.id); onChanged(); renderInbox(); } } }, 'Delete');
    card.append(el('div', { class: 'actions' }, openBtn, fileBtn, pinBtn, el('span', { class: 'spacer' }), delBtn));
    return card;
  }

  $('#file-image').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await captureImage(f);
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('Photo added to inbox');
  });
  $('#file-any').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('File added to inbox');
  });

  // ---------- section picker / filing ----------
  async function pickSection(title) {
    const nbs = await notebooks.all();
    return sheet(async (box, close) => {
      box.append(el('h2', {}, title || 'File to section'));
      const list = el('div', { class: 'list' });
      for (const nb of nbs) {
        list.append(el('div', { class: 'group' }, nb.name));
        const secs = await sections.forNotebook(nb.id);
        for (const s of secs) list.append(el('button', { type: 'button', onclick: () => close({ notebookId: nb.id, sectionId: s.id }) }, s.name));
        list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => {
          const name = await ask('New section in ' + nb.name, 'Section name'); if (!name) return;
          const s = await sections.create(nb.id, name); onChanged(); close({ notebookId: nb.id, sectionId: s.id });
        } }, '+ New section'));
      }
      list.append(el('div', { class: 'group' }, ''));
      list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => {
        const name = await ask('New notebook', 'Notebook name'); if (!name) return;
        const nb = await notebooks.create(name); const s = await sections.create(nb.id, 'General'); onChanged(); close({ notebookId: nb.id, sectionId: s.id });
      } }, '+ New notebook'));
      box.append(list, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    });
  }
  async function fileInto(pageId) {
    const target = await pickSection(); if (!target) return false;
    await pages.update(pageId, { inbox: 0, notebookId: target.notebookId, sectionId: target.sectionId });
    onChanged(); toast('Filed'); return true;
  }

  // ---------- notebook tree ----------
  async function buildTree() {
    const wrap = el('div', { class: 'tree' });
    const nbs = await notebooks.all();
    if (!nbs.length) wrap.append(el('div', { class: 'empty' }, 'No notebooks yet. Create one below, or file a capture.'));
    for (const nb of nbs) {
      const nbEl = el('div', { class: 'nb' });
      const open = state.expanded.has(nb.id) || nbs.length <= 2;
      const tw = el('button', { class: 'twisty', type: 'button', 'aria-label': 'Toggle', onclick: () => { state.expanded.has(nb.id) ? state.expanded.delete(nb.id) : state.expanded.add(nb.id); if (nbs.length <= 2 && !open) state.expanded.add(nb.id); refreshTree(); } }, open ? '▾' : '▸');
      const name = el('button', { class: 'row-name nb-name', type: 'button', onclick: () => tw.click() }, nb.name);
      const more = el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: () => notebookMenu(nb) }, '…');
      nbEl.append(el('div', { class: 'nb-head' }, tw, name, more));
      if (open) {
        const secs = await sections.forNotebook(nb.id);
        for (const s of secs) {
          const secEl = el('div', { class: 'sec' });
          const sopen = state.expanded.has(s.id);
          const stw = el('button', { class: 'twisty', type: 'button', 'aria-label': 'Toggle', onclick: () => { state.expanded.has(s.id) ? state.expanded.delete(s.id) : state.expanded.add(s.id); refreshTree(); } }, sopen ? '▾' : '▸');
          const sname = el('button', { class: 'row-name sec-name', type: 'button', onclick: () => stw.click() }, s.name);
          const smore = el('button', { class: 'more', type: 'button', 'aria-label': 'Section options', onclick: () => sectionMenu(nb, s) }, '…');
          secEl.append(el('div', { class: 'sec-head' }, stw, sname, smore));
          if (sopen) {
            const pgs = await pages.forSection(s.id);
            const pl = el('div', { class: 'pages' });
            for (const p of pgs) pl.append(el('button', { class: 'row-name page-row' + (p.id === state.pageId ? ' active' : ''), type: 'button', onclick: () => openPage(p.id) }, p.title || 'Untitled'));
            pl.append(el('button', { class: 'addrow', type: 'button', onclick: () => newPage(nb.id, s.id) }, '+ Page'));
            secEl.append(pl);
          }
          nbEl.append(secEl);
        }
        nbEl.append(el('div', { class: 'sec' }, el('button', { class: 'addrow', type: 'button', onclick: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const s = await sections.create(nb.id, n); state.expanded.add(nb.id); state.expanded.add(s.id); onChanged(); } } }, '+ Section')));
      }
      wrap.append(nbEl);
    }
    return wrap;
  }
  async function refreshTree() {
    const tree = await buildTree();
    $('#tree').replaceChildren(...tree.children);
    if (state.view === 'notes') { const tv = $('.tree-view'); if (tv) { const t2 = await buildTree(); tv.replaceChildren(t2); } }
  }
  async function refreshInboxCount() {
    const n = (await pages.inbox()).length; $('#inbox-count').textContent = n ? String(n) : '';
  }
  function notebookMenu(nb) {
    sheet((box, close) => {
      box.append(el('h2', {}, nb.name), el('div', { class: 'list' },
        el('button', { type: 'button', onclick: async () => { close(); const n = await ask('Rename notebook', '', nb.name, 'Rename'); if (n && n !== nb.name) { await notebooks.update(nb.id, { name: n }); onChanged(); } } }, 'Rename'),
        el('button', { type: 'button', onclick: async () => { close(); const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const s = await sections.create(nb.id, n); state.expanded.add(nb.id); state.expanded.add(s.id); onChanged(); } } }, 'Add section'),
        el('button', { type: 'button', style: 'color: var(--bad)', onclick: async () => { close(); if (await confirm('Delete notebook "' + nb.name + '"?', 'All its sections and pages go to the bin too.')) { await notebooks.remove(nb.id); onChanged(); if (state.view === 'page') go('#inbox'); } } }, 'Delete notebook')),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
    });
  }
  function sectionMenu(nb, s) {
    sheet((box, close) => {
      box.append(el('h2', {}, nb.name + ' › ' + s.name), el('div', { class: 'list' },
        el('button', { type: 'button', onclick: () => { close(); newPage(nb.id, s.id); } }, 'New page'),
        el('button', { type: 'button', onclick: async () => { close(); const n = await ask('Rename section', '', s.name, 'Rename'); if (n && n !== s.name) { await sections.update(s.id, { name: n }); onChanged(); } } }, 'Rename'),
        el('button', { type: 'button', style: 'color: var(--bad)', onclick: async () => { close(); if (await confirm('Delete section "' + s.name + '"?', 'Its pages go to the bin too.')) { await sections.remove(s.id); onChanged(); if (state.view === 'page') go('#inbox'); } } }, 'Delete section')),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
    });
  }
  async function renderNotes() {
    state.view = 'notes';
    const view = el('div', { class: 'view' });
    const recent = await pages.recent(8);
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Notebooks'), el('button', { class: 'btn small', type: 'button', onclick: async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); state.expanded.add(nb.id); onChanged(); renderNotes(); } } }, '+ Notebook')));
    const tv = el('div', { class: 'tree-view panel' }); tv.append(await buildTree());
    view.append(tv);
    if (recent.length) {
      view.append(el('h2', { style: 'font-size:1.05rem' }, 'Recent'));
      const pl = el('div', { class: 'pagelist' });
      for (const p of recent) pl.append(el('a', { href: '#page/' + p.id }, el('span', {}, p.title || 'Untitled'), el('span', { class: 'when' }, fmtWhen(p.updated))));
      view.append(pl);
    }
    content.replaceChildren(view); syncNav();
  }

  // ---------- templates ----------
  const TEMPLATES = {
    'Blank': () => '',
    'Teaching session': () => '## Teaching: \n\n**Date:** ' + new Date().toLocaleDateString('en-GB') + '  \n**Speaker:**  \n**Hours:** core  / non-core \n\n### Key points\n\n- \n\n### Reflection\n\n',
    'Journal club': () => '## Journal club: \n\n**Paper:**  \n**Date:** ' + new Date().toLocaleDateString('en-GB') + '\n\n| | |\n| --- | --- |\n| Question | |\n| Design | |\n| Population | |\n| Intervention | |\n| Comparator | |\n| Outcome | |\n| Result | |\n| Limitations | |\n\n### Bottom line\n\n',
    'Reading note': () => '## \n\n**Source:**  \n**Tags:** \n\n### Summary\n\n### Key points\n\n- \n\n### Cards to make\n\n- [ ] ',
    'Procedure log': () => '## Procedure: \n\n**Date:** ' + new Date().toLocaleDateString('en-GB') + '  \n**Supervision:** observed / supervised / independent  \n\n### What went well\n\n### What to do differently\n\n',
    'Meeting': () => '## Meeting: \n\n**Date:** ' + new Date().toLocaleDateString('en-GB') + '  \n**Present:** \n\n### Discussion\n\n- \n\n### Actions\n\n- [ ] '
  };
  async function newPage(notebookId, sectionId) {
    const tpl = await sheet((box, close) => {
      box.append(el('h2', {}, 'New page'), el('div', { class: 'list' }, Object.keys(TEMPLATES).map((k) => el('button', { type: 'button', onclick: () => close(k) }, k))),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    });
    if (tpl === undefined) return;
    const p = await pages.create({ notebookId, sectionId, title: tpl === 'Blank' ? '' : tpl, md: TEMPLATES[tpl](), mode: 'wysiwyg' });
    state.expanded.add(notebookId); state.expanded.add(sectionId);
    onChanged(); state.nextMode = 'edit'; go('#page/' + p.id);
  }
  async function todayNote() {
    let nb = (await notebooks.all()).find((n) => n.name === 'Journal');
    if (!nb) nb = await notebooks.create('Journal');
    let sec = (await sections.forNotebook(nb.id)).find((s) => s.name === 'Daily');
    if (!sec) sec = await sections.create(nb.id, 'Daily');
    const title = isoDay(new Date());
    let p = await pages.byTitle(title);
    if (!p) {
      const d = new Date();
      p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title, md: '## ' + d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '\n\n', mode: 'wysiwyg' });
      state.nextMode = 'edit';
    }
    state.expanded.add(nb.id); state.expanded.add(sec.id);
    onChanged(); go('#page/' + p.id);
  }

  // ---------- page view ----------
  function destroyEditor() {
    clearTimeout(state.saveTimer);
    if (state.editor) { try { state.editor.destroy(); } catch (e) { /* ignore */ } state.editor = null; }
    if (state.viewer) { try { state.viewer.destroy(); } catch (e) { /* ignore */ } state.viewer = null; }
  }
  function wikify(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; let n;
    while ((n = walker.nextNode())) if (n.nodeValue.includes('[[') && !n.parentElement.closest('code, pre, a')) nodes.push(n);
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      const parts = node.nodeValue.split(/(\[\[[^\]\n]+\]\])/);
      for (const part of parts) {
        const m = part.match(/^\[\[([^\]\n]+)\]\]$/);
        if (m) frag.append(el('a', { class: 'wikilink', 'data-title': m[1].trim(), onclick: (e) => { e.preventDefault(); openByTitle(m[1].trim()); } }, m[1].trim()));
        else frag.append(part);
      }
      node.replaceWith(frag);
    }
    pages.live().then((all) => {
      const titles = new Set(all.map((p) => (p.title || '').toLowerCase()));
      root.querySelectorAll('.wikilink').forEach((a) => { if (!titles.has(a.dataset.title.toLowerCase())) a.classList.add('missing'); });
    });
  }
  async function openByTitle(title) {
    let p = await pages.byTitle(title);
    if (!p) {
      const cur = state.pageId ? await pages.get(state.pageId) : null;
      p = await pages.create({ title, notebookId: cur ? cur.notebookId : null, sectionId: cur ? cur.sectionId : null, inbox: cur && cur.sectionId ? 0 : 1, md: '' });
      onChanged(); toast('Created "' + title + '"');
    }
    go('#page/' + p.id);
  }
  async function openPage(id) { go('#page/' + id); }

  async function renderPage(id) {
    destroyEditor();
    const p = await pages.get(id);
    if (!p || p.deleted) { content.replaceChildren(el('div', { class: 'view' }, el('h1', {}, 'Page not found'))); return; }
    state.view = 'page'; state.pageId = id;
    const nb = p.notebookId ? await notebooks.get(p.notebookId) : null;
    const sec = p.sectionId ? await sections.get(p.sectionId) : null;
    if (nb) state.expanded.add(nb.id); if (sec) state.expanded.add(sec.id);
    const view = el('div', { class: 'view page-view' });

    const crumbs = el('div', { class: 'crumbs' });
    if (p.inbox) crumbs.append('Inbox', el('button', { type: 'button', onclick: async () => { if (await fileInto(p.id)) renderPage(id); } }, 'File to…'));
    else crumbs.append(nb ? nb.name : '—', '›', sec ? sec.name : '—', el('button', { type: 'button', onclick: async () => { const t = await pickSection('Move page to'); if (t) { await pages.update(p.id, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId }); onChanged(); renderPage(id); } } }, 'Move'));
    view.append(crumbs);

    const title = el('input', { class: 'title-input', id: 'page-title', type: 'text', placeholder: 'Untitled', value: p.title || '' });
    title.addEventListener('input', () => queueSave({ title: title.value }));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (state.editor) state.editor.focus(); } });
    view.append(title);

    const modeSeg = el('div', { class: 'seg' });
    const readBtn = el('button', { type: 'button', class: state.mode === 'read' ? 'on' : '', onclick: () => { state.mode = 'read'; renderPage(id); } }, 'Read');
    const editBtn = el('button', { type: 'button', class: state.mode === 'edit' ? 'on' : '', onclick: () => { state.mode = 'edit'; renderPage(id); } }, 'Edit');
    modeSeg.append(readBtn, editBtn);
    const tools = el('div', { class: 'toolrow' }, modeSeg);
    let wys = null, mdb = null;
    if (state.mode === 'edit') {
      const typeSeg = el('div', { class: 'seg' });
      wys = el('button', { type: 'button', class: p.mode !== 'markdown' ? 'on' : '', onclick: () => { if (state.editor) state.editor.changeMode('wysiwyg'); } }, 'Rich text');
      mdb = el('button', { type: 'button', class: p.mode === 'markdown' ? 'on' : '', onclick: () => { if (state.editor) state.editor.changeMode('markdown'); } }, 'Markdown');
      typeSeg.append(wys, mdb); tools.append(typeSeg);
      tools.append(el('button', { class: 'btn small', type: 'button', onclick: async () => {
        const t = await pickPage('Link to page'); if (t && state.editor) state.editor.insertText('[[' + t + ']]');
      } }, '[[ Link'));
    }
    tools.append(el('span', { class: 'spacer' }));
    tools.append(el('button', { class: 'btn small', type: 'button', onclick: () => exportMenu(p) }, 'Export'));
    tools.append(el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { destroyEditor(); await pages.remove(p.id); onChanged(); go(p.inbox ? '#inbox' : '#notes'); } } }, 'Delete'));
    view.append(tools);

    const host = el('div', { class: 'editor-host' + (isDark() ? ' toastui-editor-dark' : '') });
    view.append(host);

    const tagrow = el('div', { class: 'tagrow' });
    const renderTags = () => {
      tagrow.innerHTML = '';
      for (const t of p.tags || []) tagrow.append(el('button', { class: 'chip on', type: 'button', title: 'Remove tag', onclick: async () => { p.tags = p.tags.filter((x) => x !== t); await pages.update(p.id, { tags: p.tags }); onChanged(); renderTags(); } }, '#' + t, el('span', { class: 'x' }, '×')));
      const inp = el('input', { type: 'text', placeholder: '+ tag', id: 'tag-input' });
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault(); const t = inp.value.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
          if (t && !(p.tags || []).includes(t)) { p.tags = [...(p.tags || []), t]; await pages.update(p.id, { tags: p.tags }); onChanged(); renderTags(); }
          inp.value = '';
        }
      });
      tagrow.append(inp);
    };
    renderTags(); view.append(tagrow);

    const back = el('div', { class: 'backlinks' });
    view.append(back);
    content.replaceChildren(view); syncNav();

    if (state.mode === 'edit') {
      state.editor = new toastui.Editor({
        el: host, height: 'auto', minHeight: isNarrow() ? '50vh' : '60vh', initialEditType: p.mode === 'markdown' ? 'markdown' : 'wysiwyg',
        previewStyle: isNarrow() ? 'tab' : 'vertical', initialValue: p.md || '', usageStatistics: false, theme: isDark() ? 'dark' : 'light',
        placeholder: 'Start writing…', autofocus: false, hideModeSwitch: true,
        toolbarItems: [['heading', 'bold', 'italic', 'strike'], ['hr', 'quote'], ['ul', 'ol', 'task', 'indent', 'outdent'], ['table', 'image', 'link'], ['code', 'codeblock']],
        hooks: {
          addImageBlobHook: async (blob, callback) => {
            const a = await storeAsset(blob, blob.name || 'image');
            onChanged(); callback(assetUrl(a.id), (blob.name || 'image').replace(/\.\w+$/, ''));
          }
        }
      });
      state.editor.on('change', () => queueSave({ md: state.editor.getMarkdown() }));
      state.editor.on('changeMode', (m) => { p.mode = m; queueSave({ mode: m }); if (wys) wys.classList.toggle('on', m === 'wysiwyg'); if (mdb) mdb.classList.toggle('on', m === 'markdown'); });
      if (!p.title && !p.md) setTimeout(() => title.focus(), 50);
    } else {
      const reader = el('div', { class: 'reader' }); host.append(reader);
      state.viewer = toastui.Editor.factory({ el: reader, viewer: true, initialValue: p.md || '', usageStatistics: false, theme: isDark() ? 'dark' : 'light' });
      wikify(reader);
      reader.addEventListener('dblclick', () => { state.mode = 'edit'; renderPage(id); });
    }
    renderBacklinks(p, back);

    function queueSave(patch) {
      Object.assign(p, patch);
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(async () => { await pages.update(p.id, patch); S.schedule(); refreshTree(); }, 700);
    }
  }
  async function renderBacklinks(p, back) {
    back.innerHTML = '';
    if (!p.title) return;
    const needle = '[[' + p.title.toLowerCase() + ']]';
    const all = (await pages.live()).filter((q) => q.id !== p.id && (q.md || '').toLowerCase().includes(needle));
    if (!all.length) return;
    back.append(el('h3', {}, 'Linked from'));
    for (const q of all) back.append(el('a', { href: '#page/' + q.id }, q.title || 'Untitled'));
  }
  async function pickPage(title) {
    const all = (await pages.live()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    return sheet((box, close) => {
      const inp = el('input', { type: 'text', placeholder: 'Search pages or type a new title', id: 'pick-input' });
      const list = el('div', { class: 'list' });
      const fill = () => {
        const q = inp.value.trim().toLowerCase(); list.innerHTML = '';
        const hits = all.filter((p) => p.title && (!q || p.title.toLowerCase().includes(q))).slice(0, 30);
        for (const p of hits) list.append(el('button', { type: 'button', onclick: () => close(p.title) }, p.title));
        if (q && !hits.some((p) => p.title.toLowerCase() === q)) list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: () => close(inp.value.trim()) }, 'Link to new page "' + inp.value.trim() + '"'));
      };
      inp.addEventListener('input', fill); fill();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = list.querySelector('button'); if (b) b.click(); } });
      box.append(el('h2', {}, title), inp, list, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    });
  }

  // ---------- export ----------
  async function renderHTML(md) {
    const tmp = el('div', { style: 'position:absolute; left:-9999px; top:0; width:700px' }); document.body.append(tmp);
    const v = toastui.Editor.factory({ el: tmp, viewer: true, initialValue: md || '', usageStatistics: false });
    await new Promise((r) => setTimeout(r, 50));
    let html = tmp.querySelector('.toastui-editor-contents') ? tmp.querySelector('.toastui-editor-contents').innerHTML : tmp.innerHTML;
    v.destroy(); tmp.remove();
    // Inline local assets as data URLs so the export is self-contained.
    const ids = [...html.matchAll(/asset\/([0-9a-f-]{36})/g)].map((m) => m[1]);
    for (const id of new Set(ids)) {
      const a = await assets.get(id);
      if (a && a.blob) {
        const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(a.blob); });
        html = html.split('asset/' + id).join(data);
      }
    }
    return html;
  }
  async function deliver(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = el('a', { href: URL.createObjectURL(blob), download: filename }); document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function exportMenu(p) {
    const base = (p.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '_');
    sheet((box, close) => {
      box.append(el('h2', {}, 'Export "' + (p.title || 'Untitled') + '"'), el('div', { class: 'list' },
        el('button', { type: 'button', onclick: async () => { close(); await deliver(new Blob(['# ' + (p.title || '') + '\n\n' + (p.md || '')], { type: 'text/markdown' }), base + '.md'); } }, 'Markdown (.md)'),
        el('button', { type: 'button', onclick: async () => {
          close();
          const html = await renderHTML(p.md);
          const doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + esc(p.title || '') + '</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1,h2,h3{font-family:Cambria,Georgia,serif}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}</style></head><body><h1>' + esc(p.title || '') + '</h1>' + html + '</body></html>';
          await deliver(new Blob(['﻿', doc], { type: 'application/msword' }), base + '.doc');
        } }, 'Word (.doc)'),
        el('button', { type: 'button', onclick: async () => { close(); if (state.mode !== 'read') { state.mode = 'read'; await renderPage(p.id); } setTimeout(() => window.print(), 300); } }, 'PDF (print / Save as PDF)')),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel')));
    });
  }

  // ---------- search ----------
  async function renderSearch() {
    state.view = 'search';
    const view = el('div', { class: 'view' });
    const inp = el('input', { class: 'searchbox', type: 'search', placeholder: 'Search notes, captures, tags…', value: state.query, id: 'search-input', autocomplete: 'off' });
    const results = el('div', { class: 'results' });
    const tagbar = el('div', { class: 'tagchips' });
    const tags = await pages.tags();
    for (const t of tags.slice(0, 20)) tagbar.append(el('button', { class: 'chip', type: 'button', onclick: () => { inp.value = '#' + t.tag; run(); } }, '#' + t.tag + ' ' + t.n));
    let timer = null;
    const run = async () => {
      state.query = inp.value; const q = inp.value.trim().toLowerCase(); results.innerHTML = '';
      if (!q) return;
      const all = await pages.live();
      const tagQ = q.startsWith('#') ? q.slice(1) : null;
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const p of all) {
        const title = (p.title || '').toLowerCase(), body = (p.md || '').toLowerCase(), tgs = (p.tags || []).join(' ');
        if (tagQ) { if (!(p.tags || []).includes(tagQ)) continue; scored.push({ p, score: p.updated, idx: -1 }); continue; }
        let score = 0, idx = -1;
        for (const t of terms) {
          if (title.includes(t)) score += 10; if (tgs.includes(t)) score += 5;
          const i = body.indexOf(t); if (i >= 0) { score += 2; if (idx < 0) idx = i; }
        }
        if (score) scored.push({ p, score: score * 1e13 + (p.updated || 0), idx });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const { p, idx } of scored.slice(0, 60)) {
        const raw = p.md || '';
        const start = Math.max(0, idx - 60), snip = (start > 0 ? '…' : '') + raw.slice(start, start + 160) + (start + 160 < raw.length ? '…' : '');
        let shtml = esc(snip);
        if (!tagQ) for (const t of terms) shtml = shtml.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => '<mark>' + m + '</mark>');
        const where = p.inbox ? 'Inbox' : await whereIs(p);
        results.append(el('a', { class: 'result', href: '#page/' + p.id }, el('b', {}, p.title || 'Untitled'), el('span', { class: 'snip', html: shtml }), el('span', { class: 'where' }, where + ' · ' + fmtWhen(p.updated) + ((p.tags || []).length ? ' · ' + p.tags.map((t) => '#' + t).join(' ') : ''))));
      }
      if (!scored.length) results.append(el('p', { class: 'sub' }, 'Nothing matched.'));
    };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Search')), inp, tagbar, results);
    content.replaceChildren(view); syncNav();
    if (state.query) run(); else setTimeout(() => inp.focus(), 60);
  }
  const whereCache = new Map();
  async function whereIs(p) {
    const key = p.notebookId + '/' + p.sectionId;
    if (!whereCache.has(key)) {
      const nb = p.notebookId ? await notebooks.get(p.notebookId) : null; const s = p.sectionId ? await sections.get(p.sectionId) : null;
      whereCache.set(key, (nb ? nb.name : '—') + ' › ' + (s ? s.name : '—'));
    }
    return whereCache.get(key);
  }

  // ---------- settings ----------
  async function renderSettings() {
    state.view = 'settings';
    const g = G.state(); const st = S.status(); const dev = await deviceName();
    const view = el('div', { class: 'view settings' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'More')));
    const acct = el('div', { class: 'panel' }, el('h2', {}, 'OneDrive sync'));
    if (g.signedIn) {
      acct.append(el('div', { class: 'kv' }, el('span', {}, 'Signed in as'), el('span', {}, g.name)),
        el('div', { class: 'kv' }, el('span', {}, 'Last sync'), el('span', { id: 'kv-last' }, st.lastSync ? fmtWhen(st.lastSync) : 'Never')),
        el('div', { class: 'kv' }, el('span', {}, 'Waiting to upload'), el('span', { id: 'kv-pending' }, String(st.pending))),
        el('div', { class: 'kv' }, el('span', {}, 'Status'), el('span', { id: 'kv-status' }, st.message || st.state)),
        el('div', { class: 'actions', style: 'display:flex; gap:8px; flex-wrap:wrap' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => S.run() }, 'Sync now'),
          el('button', { class: 'btn', type: 'button', onclick: () => G.signOut() }, 'Sign out')));
    } else {
      acct.append(el('p', { class: 'rule' }, 'Sign in with the personal Microsoft account that owns your OneDrive. Notes sync to a NoteCompanion folder there; nothing goes anywhere else.'),
        el('div', {}, el('button', { class: 'btn primary', type: 'button', onclick: () => G.signIn().catch((e) => toast(e.message)) }, g.available ? 'Sign in to Microsoft' : 'Sign-in unavailable')));
    }
    view.append(acct);
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'This device'),
      el('div', { class: 'kv' }, el('span', {}, 'Name'), el('span', {}, dev)),
      el('div', { class: 'kv' }, el('span', {}, 'Installed as app'), el('span', {}, (navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? 'Yes' : 'No (use Add to Home Screen)')),
      el('div', { class: 'kv' }, el('span', {}, 'Offline cache'), el('span', { id: 'kv-sw' }, navigator.serviceWorker && navigator.serviceWorker.controller ? 'Ready' : 'Not yet; reload once')),
      el('div', { class: 'kv' }, el('span', {}, 'Storage kept'), el('span', { id: 'kv-persist' }, '…')),
      el('div', { class: 'kv' }, el('span', {}, 'Version'), el('span', {}, C.version))));
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const k = $('#kv-persist'); if (k) k.textContent = p ? 'Yes' : 'Not promised by the browser'; });
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Backup'),
      el('p', { class: 'rule' }, 'Everything is in your OneDrive folder as plain JSON and files. This also downloads a single JSON file of all notes from this device.'),
      el('div', {}, el('button', { class: 'btn', type: 'button', onclick: async () => { const data = await window.NCDB.exportAll(); await deliver(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'notecompanion-backup-' + isoDay(new Date()) + '.json'); } }, 'Download backup'))));
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Capture from the iPhone Share Sheet'),
      el('p', {}, 'In the Shortcuts app, make a shortcut with "Receive Text and URLs from Share Sheet", then an "Open URLs" action set to:'),
      el('p', {}, el('code', {}, C.redirectUri + '?capture=1&text=[Shortcut Input]')),
      el('p', {}, 'Tick "Show in Share Sheet". Sharing text or a link from any app then lands in the Inbox. Photos: use the Photo button in the Inbox, or paste on desktop.')));
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Rules of the house'),
      el('p', { class: 'rule' }, 'No patient-identifiable data. Notes, references, teaching and portfolio material only.')));
    content.replaceChildren(view); syncNav();
  }

  // ---------- navigation ----------
  function syncNav() {
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.view || (state.view === 'page' && a.dataset.nav === 'notes')));
    closeSidebar();
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  async function route() {
    const h = location.hash || '#inbox';
    if (h.startsWith('#page/')) {
      const id = h.slice(6);
      if (state.nextMode) { state.mode = state.nextMode; state.nextMode = null; }
      else if (state.pageId !== id) state.mode = 'read';
      return renderPage(id);
    }
    destroyEditor(); state.pageId = null;
    if (h === '#notes') return renderNotes();
    if (h === '#search') return renderSearch();
    if (h === '#settings') return renderSettings();
    return renderInbox();
  }
  addEventListener('hashchange', route);
  const sidebar = $('#sidebar'), scrim = $('#scrim');
  const closeSidebar = () => { sidebar.classList.remove('open'); scrim.classList.remove('open'); };
  $('#btn-menu').addEventListener('click', () => { sidebar.classList.toggle('open'); scrim.classList.toggle('open'); });
  scrim.addEventListener('click', closeSidebar);
  $('#btn-today').addEventListener('click', todayNote);
  $('#btn-new-notebook').addEventListener('click', async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); state.expanded.add(nb.id); onChanged(); } });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); go('#search'); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); go('#inbox'); setTimeout(() => { const t = $('#capture-text'); if (t) t.focus(); }, 50); }
  });

  // ---------- sync status pill ----------
  const pill = $('#syncpill');
  function showStatus(st) {
    pill.dataset.state = st.state;
    const n = st.pending ? ' · ' + st.pending + ' pending' : '';
    const label = st.state === 'ok' ? 'Synced' + n : st.state === 'syncing' ? 'Syncing…' : st.state === 'offline' ? 'Offline' + n : st.state === 'signedout' ? 'Not signed in' + n : st.state === 'error' ? 'Sync problem' + n : 'Ready' + n;
    pill.querySelector('.label').textContent = label;
    pill.title = st.message || label;
    const kp = $('#kv-pending'), ks = $('#kv-status'), kl = $('#kv-last');
    if (kp) kp.textContent = String(st.pending); if (ks) ks.textContent = st.message || st.state; if (kl) kl.textContent = st.lastSync ? fmtWhen(st.lastSync) : 'Never';
  }
  pill.addEventListener('click', () => { if (!G.state().signedIn) go('#settings'); else { S.run(); toast('Syncing…'); } });
  S.onChange(showStatus);
  G.onChange(() => { if (state.view === 'settings') renderSettings(); S.schedule(300); });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('NoteCompanion updated', { label: 'Reload', fn: () => location.reload(), sticky: true });
        });
      });
    }).catch((e) => console.warn('SW failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => { const k = $('#kv-sw'); if (k) k.textContent = 'Ready'; });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- capture via URL (iOS Shortcut) ----------
  async function handleURLCapture() {
    const q = new URLSearchParams(location.search);
    if (!q.has('capture')) return;
    const text = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n');
    history.replaceState(null, '', location.pathname + '#inbox');
    if (text.trim()) { await captureText(text, q.get('title') || undefined); toast('Captured'); }
  }

  // ---------- boot ----------
  (async () => {
    await handleURLCapture();
    await refreshTree(); await refreshInboxCount();
    await route();
    await G.init();
    await S.init();
    if (G.state().signedIn) S.schedule(600);
    else { const seen = await meta.get('introSeen'); if (!seen) { await meta.set('introSeen', true); toast('Sign in to sync with OneDrive', { label: 'Open settings', fn: () => go('#settings') }); } }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.view === 'page') renderPage(state.pageId); });
  })();
})();

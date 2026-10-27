// NoteCompanion app: inbox capture, notebook tree, page editor, sections, search, graph, settings.
(function () {
  const { notebooks, sections, pages, assets, versions, meta, deviceName } = window.NCDB;
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
  const state = { view: 'inbox', pageId: null, editor: null, saveTimer: null, expanded: new Set(), query: '', focusNew: false, openedHtml: '', openedPage: null, versionTimer: null, sectionView: {} };
  const isNarrow = () => matchMedia('(max-width: 899px)').matches;
  const themePref = () => { try { return localStorage.getItem('nc-theme') || 'system'; } catch (e) { return 'system'; } };
  const applyTheme = (t) => { if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('nc-theme', t); } catch (e) { /* ignore */ } };
  applyTheme(themePref());
  const isDark = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const NB_COLOURS = ['#2f5d8a', '#2e7d5b', '#b8651b', '#7b3f8c', '#1d7f8c', '#8d5a2b', '#5b6472', '#b03a5b'];

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
    box.append(el('h2', {}, title), ...(note ? [el('p', { class: 'danger-note' }, note)] : []), el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => close(true) }, okLabel || 'Delete')));
  });
  const menu = (title, items, note) => sheet((box, close) => {
    box.append(el('h2', {}, title), ...(note ? [el('p', { class: 'rule' }, note)] : []),
      el('div', { class: 'list' }, items.filter(Boolean).map((it) => el('button', { type: 'button', style: it.danger ? 'color: var(--bad)' : (it.accent ? 'color: var(--accent)' : ''), onclick: () => { close(); it.fn(); } }, it.label))),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
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
  const isoDay = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const textToHtml = (text) => text.split(/\n{2,}/).map((para) => '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>').join('\n');
  const htmlOf = (p) => (p.html != null && p.html !== '') ? p.html : (p.md ? (window.marked ? marked.parse(p.md) : textToHtml(p.md)) : '');
  const textOf = (p) => { const d = document.createElement('div'); d.innerHTML = htmlOf(p); const props = (p.props || []).map((x) => x.k + ' ' + x.v).join(' '); return ((d.textContent || '') + ' ' + props + ' ' + (p.kind === 'pdf' ? (p.pdfText || '') : '')).replace(/\s+/g, ' ').trim(); };
  const wordCount = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return ((d.textContent || '').match(/\S+/g) || []).length; };
  const linkIds = (html) => [...new Set([...(html || '').matchAll(/#page\/([0-9a-f-]{36})/g)].map((m) => m[1]))];
  const pinnedFirst = (a, b) => (b.pinned || 0) - (a.pinned || 0) || (a.title || '').localeCompare(b.title || '');

  const ICONS = {
    scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M7 12h10"/>',
    mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    file: '<path d="M14.5 4H7.5A1.5 1.5 0 0 0 6 5.5v13A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 4v4h4M9 13h6M9 16.5h6"/>'
  };
  const icon = (name) => el('span', { class: 'ic', html: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>' });
  const setBtn = (btn, name, label) => { btn.replaceChildren(icon(name), el('span', {}, label)); };

  // Swipe left to reveal Delete; press and hold (or right-click) for a menu.
  function gestures(front, { onDelete, onLongPress }) {
    const wrap = el('div', { class: 'swipe' });
    const under = el('div', { class: 'swipe-under' }, el('button', { class: 'swipe-del', type: 'button', onclick: (e) => { e.stopPropagation(); reset(); onDelete(); } }, 'Delete'));
    front.classList.add('swipe-front');
    wrap.append(under, front);
    let sx = 0, sy = 0, dx = 0, dragging = null, open = false, lp = null, fired = false;
    const reset = () => { open = false; front.style.transform = ''; wrap.classList.remove('open'); };
    const setX = (x) => { front.style.transition = 'none'; front.style.transform = 'translateX(' + x + 'px)'; };
    front.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; dragging = null; fired = false;
      clearTimeout(lp); lp = setTimeout(() => { lp = null; if (dragging === null && onLongPress) { fired = true; if (navigator.vibrate) navigator.vibrate(10); onLongPress(); } }, 480);
    }, { passive: true });
    front.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
      if (dragging === null) { if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { dragging = Math.abs(dx) > Math.abs(dy); clearTimeout(lp); lp = null; } else return; }
      if (!dragging) return;
      e.preventDefault();
      const base = open ? -96 : 0;
      setX(Math.max(-140, Math.min(0, base + dx)));
    }, { passive: false });
    front.addEventListener('touchend', () => {
      clearTimeout(lp); lp = null;
      front.style.transition = '';
      if (dragging) { const pos = (open ? -96 : 0) + dx; if (pos < -70) { open = true; front.style.transform = 'translateX(-96px)'; wrap.classList.add('open'); } else reset(); }
      dragging = null;
    });
    front.addEventListener('touchcancel', () => { clearTimeout(lp); lp = null; front.style.transition = ''; dragging = null; });
    front.addEventListener('click', (e) => { if (fired || open) { e.preventDefault(); e.stopPropagation(); fired = false; reset(); } }, true);
    front.addEventListener('contextmenu', (e) => { if (onLongPress) { e.preventDefault(); onLongPress(); } });
    return wrap;
  }

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
      return blob && blob.size < file.size ? new File([blob], (file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (e) { return file; }
  }
  // Document scan: grey, level-stretched, sharpened; straightening is a later phase.
  async function scanify(file) {
    const bmp = await createImageBitmap(file);
    const max = 2000, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; hist[g]++; }
    const total = c.width * c.height; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.08) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { let v = (d[i] - lo) / span; v = v < 0 ? 0 : v > 1 ? 1 : v; v = Math.pow(v, 1.15) * 255; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return new File([blob], 'scan-' + isoDay(new Date()) + '.jpg', { type: 'image/jpeg' });
  }
  async function storeAsset(file, name) {
    const blob = file.type && file.type.startsWith('image/') ? await downscale(file) : file;
    return assets.create(blob, name || file.name || 'file');
  }
  const assetUrl = (id) => 'asset/' + id;

  // ---------- inbox ----------
  let recorder = null, recChunks = [], recStream = null;
  async function captureText(text, title) {
    text = (text || '').trim(); if (!text) return null;
    const p = await pages.create({ inbox: 1, kind: 'text', title: title || text.split('\n')[0].slice(0, 60), html: textToHtml(text) });
    onChanged(); return p;
  }
  async function captureImage(file, kind) {
    const a = await storeAsset(file);
    const p = await pages.create({ inbox: 1, kind: kind || 'image', title: file.name ? file.name.replace(/\.\w+$/, '') : 'Photo', html: '<p><img src="' + assetUrl(a.id) + '" alt="' + esc(file.name || 'photo') + '"></p>', assetId: a.id });
    onChanged(); return p;
  }
  async function captureFile(file, target) {
    const a = await storeAsset(file);
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    const base = Object.assign({ inbox: 1 }, target || {});
    const p = isPdf
      ? await pages.create(Object.assign(base, { kind: 'pdf', title: (file.name || 'Document').replace(/\.pdf$/i, ''), html: '', assetId: a.id, annots: {} }))
      : await pages.create(Object.assign(base, { kind: 'file', title: file.name || 'File', html: '<p><a href="' + assetUrl(a.id) + '">📎 ' + esc(file.name || 'file') + '</a></p>', assetId: a.id }));
    onChanged();
    if (isPdf) window.NCPDF.enrich(p.id, a.id).then(() => { if (state.view === 'pdfs') renderLibrary(); refreshTree(); });
    return p;
  }
  async function captureAudio(blob, seconds) {
    const name = 'Voice note ' + new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const a = await assets.create(blob, name + '.' + ext);
    const p = await pages.create({ inbox: 1, kind: 'audio', title: name, html: '<p><a href="' + assetUrl(a.id) + '">🎙 Play ' + esc(name) + '</a> <em>(' + seconds + ' s)</em></p>', assetId: a.id });
    onChanged(); return p;
  }
  async function toggleRecording(btn) {
    if (recorder) { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording is not available in this browser.'); return; }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('Microphone access was refused.'); return; }
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    recChunks = []; const started = Date.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      recStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || mime || 'audio/webm' });
      recorder = null; recStream = null;
      btn.classList.remove('recording'); setBtn(btn, 'mic', 'Record');
      if (blob.size > 0) { await captureAudio(blob, Math.round((Date.now() - started) / 1000)); renderInbox(); toast('Voice note saved'); }
    };
    recorder.start();
    btn.classList.add('recording'); setBtn(btn, 'stop', 'Stop');
  }

  async function renderInbox() {
    state.view = 'inbox';
    const list = (await pages.inbox()).sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.updated || 0) - (a.updated || 0));
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
    const scanBtn = el('button', { class: 'btn', type: 'button', onclick: () => $('#file-scan').click() }, icon('scan'), el('span', {}, 'Scan'));
    const recBtn = el('button', { class: 'btn', type: 'button', onclick: () => toggleRecording(recBtn) }, icon('mic'), el('span', {}, 'Record'));
    const fileBtn = el('button', { class: 'btn', type: 'button', onclick: () => $('#file-any').click() }, icon('file'), el('span', {}, 'File'));
    const composer = el('div', { class: 'composer' }, ta, el('div', { class: 'bar' }, fileBtn, scanBtn, recBtn, el('span', { class: 'spacer' }), saveBtn));
    composer.addEventListener('dragover', (e) => { e.preventDefault(); });
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const f of [...e.dataTransfer.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
      renderInbox();
    });
    const cur = (await allNotebooks()).find((n) => n.current);
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Inbox')), composer);
    state.suggestIndex = await buildSuggestIndex();
    if (cur) view.append(el('p', { class: 'rule' }, 'Current rotation: ', el('b', {}, cur.name), ' — filing offers it first.'));
    const cards = el('div', { class: 'cards' });
    for (const p of list) cards.append(inboxCard(p));
    view.append(cards);
    content.replaceChildren(view);
    syncNav();
    if (location.hash === '#capture') setTimeout(() => ta.focus(), 50);
  }

  // Suggested filing: score each section by how many of the capture's words appear in its name, its pages' titles, tags and text.
  const STOP = new Set('the a an and or of to in on for with at by from is are was were be this that it as its into about over after before not no yes you your my our we i he she they them his her their what which who when where how why can will would should could'.split(' '));
  const tokens = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f#+-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));
  async function buildSuggestIndex() {
    const nbs = await notebooks.all(); const nbById = new Map(nbs.map((n) => [n.id, n]));
    const secs = (await window.NCDB.db.sections.where('deleted').equals(0).toArray()).filter((sc) => nbById.has(sc.notebookId));
    const live = (await pages.live()).filter((q) => !q.inbox && q.sectionId);
    const idx = [];
    for (const sc of secs) {
      const nb = nbById.get(sc.notebookId);
      const strong = new Set(tokens(sc.name + ' ' + nb.name));
      const weak = new Map();
      for (const q of live) if (q.sectionId === sc.id) {
        for (const w of tokens(q.title)) strong.add(w);
        for (const w of (q.tags || [])) strong.add(w.toLowerCase());
        for (const w of tokens(textOf(q).slice(0, 3000))) weak.set(w, (weak.get(w) || 0) + 1);
      }
      idx.push({ sc, nb, strong, weak, boost: nb.current ? 1.5 : 0 });
    }
    return idx;
  }
  function suggestFor(p, idx) {
    const words = [...new Set(tokens((p.title || '') + ' ' + textOf(p).slice(0, 2000) + ' ' + (p.tags || []).join(' ')))];
    if (!words.length) return [];
    const scored = idx.map((e) => { let sc = 0; for (const w of words) { if (e.strong.has(w)) sc += 3; else if (e.weak.has(w)) sc += Math.min(2, e.weak.get(w) * 0.5); } return { e, sc: sc ? sc + e.boost : 0 }; }).filter((x) => x.sc >= 3).sort((a, b) => b.sc - a.sc);
    return scored.slice(0, 2).map((x) => x.e);
  }
  function inboxCard(p) {
    const card = el('div', { class: 'card' + (p.pinned ? ' pinned' : '') });
    card.append(el('div', { class: 'meta' }, el('span', { class: 'kind' }, p.kind), el('span', {}, fmtWhen(p.updated)), p.tags && p.tags.length ? el('span', {}, p.tags.map((t) => '#' + t).join(' ')) : null));
    if ((p.kind === 'image' || p.kind === 'scan') && p.assetId) {
      card.append(el('img', { src: assetUrl(p.assetId), alt: p.title, loading: 'lazy', onclick: () => quickLook(p) }));
    } else if (p.kind === 'audio' && p.assetId) {
      card.append(el('div', {}, p.title), el('audio', { controls: '', src: assetUrl(p.assetId), preload: 'none' }));
    } else if (p.kind === 'pdf') {
      card.append(el('div', { class: 'pdfcard-row', onclick: () => openPage(p.id) }, p.thumb ? el('img', { class: 'pdfthumb', src: p.thumb, alt: '' }) : el('span', { class: 'pdfglyph' }, 'PDF'), el('div', {}, el('b', {}, p.title), el('div', { class: 'sub' }, (p.pdfPages ? p.pdfPages + ' pages' : 'PDF')))));
    } else if (p.kind === 'file' && p.assetId) {
      card.append(el('a', { class: 'filelink', href: assetUrl(p.assetId), target: '_blank', rel: 'noopener' }, icon('file'), el('span', {}, p.title)));
    } else {
      const text = textOf(p);
      card.append(el('div', { class: 'body' + (text.length < 220 ? ' short' : ''), onclick: () => quickLook(p) }, text || p.title));
    }
    const sugg = state.suggestIndex ? suggestFor(p, state.suggestIndex) : [];
    if (sugg.length) card.append(el('div', { class: 'suggest' }, el('span', { class: 'suggest-label' }, 'File to'), ...sugg.map((e) => el('button', { class: 'chip', type: 'button', onclick: async () => { await pages.update(p.id, { inbox: 0, notebookId: e.nb.id, sectionId: e.sc.id }); onChanged(); toast('Filed to ' + e.sc.name); renderInbox(); } }, e.nb.name + ' › ' + e.sc.name))));
    const fileBtn = el('button', { class: 'btn small', type: 'button', onclick: async () => { if (await fileInto(p.id)) renderInbox(); } }, 'File to…');
    const openBtn = el('button', { class: 'btn small', type: 'button', onclick: () => openPage(p.id) }, 'Open');
    const pinBtn = el('button', { class: 'btn small', type: 'button', onclick: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); renderInbox(); } }, p.pinned ? 'Unpin' : 'Pin');
    const delBtn = el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirm('Delete this capture?')) { await pages.remove(p.id); onChanged(); renderInbox(); } } }, 'Delete');
    card.append(el('div', { class: 'actions' }, openBtn, fileBtn, pinBtn, el('span', { class: 'spacer' }), delBtn));
    return gestures(card, { onDelete: () => delBtn.click(), onLongPress: () => pageQuickMenu(p, () => renderInbox()) });
  }
  function pageQuickMenu(p, after) {
    menu(p.title || 'Untitled', [
      { label: 'Open', fn: () => openPage(p.id) },
      p.inbox ? { label: 'File to…', fn: async () => { if (await fileInto(p.id)) after && after(); } } : { label: 'Move to…', fn: async () => { const t = await pickSection('Move page to'); if (t) { await pages.update(p.id, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId }); onChanged(); after && after(); } } },
      { label: p.pinned ? 'Unpin' : 'Pin', fn: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); after && after(); } },
      { label: 'Delete', danger: true, fn: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { if (state.pageId === p.id) destroyEditor(); await pages.remove(p.id); onChanged(); if (state.pageId === p.id) go('#notes'); else after && after(); } } }
    ]);
  }
  function quickLook(p) {
    sheet((box, close) => {
      const body = p.kind === 'pdf' ? el('div', { class: 'quicklook' }, p.thumb ? el('img', { src: p.thumb, alt: '' }) : null, el('p', {}, (p.pdfPages || '?') + ' pages')) : el('div', { class: 'quicklook', html: htmlOf(p) });
      box.append(el('h2', {}, p.title || 'Untitled'), el('p', { class: 'rule' }, fmtWhen(p.updated) + ' · ' + wordCount(htmlOf(p)) + ' words'), body,
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close'), el('button', { class: 'btn primary', type: 'button', onclick: () => { close(); openPage(p.id); } }, 'Open')));
    });
  }

  $('#file-scan').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) { try { await captureImage(await scanify(f), 'scan'); } catch (err) { await captureImage(f, 'scan'); } }
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('Scan added to inbox');
  });
  $('#file-any').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('File added to inbox');
  });

  // ---------- section picker / filing ----------
  const allNotebooks = async () => (await notebooks.all()).sort((a, b) => (b.current || 0) - (a.current || 0) || (a.order || 0) - (b.order || 0));
  async function pickSection(title) {
    const nbs = await allNotebooks();
    return sheet(async (box, close) => {
      box.append(el('h2', {}, title || 'File to section'));
      const list = el('div', { class: 'list' });
      for (const nb of nbs) {
        list.append(el('div', { class: 'group' }, nb.name + (nb.current ? ' · current' : '')));
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
  const chevron = (open) => el('span', { class: 'chev' + (open ? ' open' : ''), html: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
  const toggle = (id) => { state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); refreshTree(); };
  const nbColour = (nb, i) => nb.color || NB_COLOURS[(i == null ? 0 : i) % NB_COLOURS.length];
  async function buildTree() {
    const wrap = el('div', { class: 'tree' });
    const nbs = await notebooks.all();
    if (!nbs.length) wrap.append(el('div', { class: 'empty' }, 'No notebooks yet. Create one below, or file a capture.'));
    const allSecs = await window.NCDB.db.sections.where('deleted').equals(0).toArray();
    const livePages = await pages.live();
    const pagesBySec = new Map();
    for (const p of livePages) if (p.sectionId) pagesBySec.set(p.sectionId, (pagesBySec.get(p.sectionId) || 0) + 1);
    if (nbs.length <= 2) nbs.forEach((nb) => state.expanded.add(nb.id));
    for (const [i, nb] of nbs.entries()) {
      const colour = nbColour(nb, i);
      const open = state.expanded.has(nb.id);
      const secs = allSecs.filter((s) => s.notebookId === nb.id).sort((a, b) => (a.order || 0) - (b.order || 0));
      const nPages = secs.reduce((n, s) => n + (pagesBySec.get(s.id) || 0), 0);
      const nbEl = el('div', { class: 'nb' + (open ? ' open' : ''), style: '--nb: ' + colour });
      const head = el('div', { class: 'nb-head', role: 'button', tabindex: '0', onclick: () => toggle(nb.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(nb.id); } } },
        el('span', { class: 'spine' }), chevron(open),
        el('span', { class: 'nb-name' }, nb.name), nb.current ? el('span', { class: 'badge-current' }, 'current') : null,
        el('span', { class: 'nb-meta' }, secs.length + (secs.length === 1 ? ' section' : ' sections') + ' · ' + nPages + (nPages === 1 ? ' page' : ' pages')),
        el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: (e) => { e.stopPropagation(); notebookMenu(nb); } }, '···'));
      nbEl.append(head);
      if (open) {
        const body = el('div', { class: 'nb-body' });
        for (const s of secs) {
          const sopen = state.expanded.has(s.id);
          const count = pagesBySec.get(s.id) || 0;
          const secEl = el('div', { class: 'sec' + (sopen ? ' open' : '') });
          secEl.append(el('div', { class: 'sec-head' },
            el('button', { class: 'sec-toggle', type: 'button', 'aria-label': 'Expand', onclick: () => toggle(s.id) }, chevron(sopen)),
            el('button', { class: 'sec-name', type: 'button', title: 'Open section', onclick: () => go('#section/' + s.id) }, s.name),
            el('span', { class: 'sec-count' }, count ? String(count) : ''),
            el('button', { class: 'more', type: 'button', 'aria-label': 'Section options', onclick: (e) => { e.stopPropagation(); sectionMenu(nb, s); } }, '···')));
          if (sopen) {
            const pgs = livePages.filter((p) => p.sectionId === s.id).sort(pinnedFirst);
            const pl = el('div', { class: 'pages' });
            for (const p of pgs) pl.append(gestures(el('button', { class: 'page-row' + (p.id === state.pageId ? ' active' : '') + (p.pinned ? ' pinned' : ''), type: 'button', onclick: () => openPage(p.id) }, p.kind === 'pdf' ? el('span', { class: 'page-pdf' }, 'PDF') : el('span', { class: 'page-dot' }), el('span', { class: 'page-title' }, p.title || 'Untitled')),
              { onDelete: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { if (state.pageId === p.id) destroyEditor(); await pages.remove(p.id); onChanged(); if (state.pageId === p.id) go('#notes'); } }, onLongPress: () => pageQuickMenu(p) }));
            pl.append(el('button', { class: 'addrow', type: 'button', onclick: () => newPage(nb.id, s.id) }, '+ New page'));
            secEl.append(pl);
          }
          body.append(secEl);
        }
        body.append(el('button', { class: 'addrow addsec', type: 'button', onclick: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); state.expanded.add(nb.id); state.expanded.add(sc.id); onChanged(); } } }, '+ New section'));
        nbEl.append(body);
      }
      wrap.append(nbEl);
    }
    const archived = await notebooks.archived();
    if (archived.length) {
      const open = state.expanded.has('__archived');
      const box = el('div', { class: 'archived' + (open ? ' open' : '') });
      box.append(el('button', { class: 'archived-head', type: 'button', onclick: () => toggle('__archived') }, chevron(open), el('span', {}, 'Archived'), el('span', { class: 'sec-count' }, String(archived.length))));
      if (open) for (const nb of archived) box.append(el('div', { class: 'archived-row' }, el('span', { class: 'page-title' }, nb.name), el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: () => notebookMenu(nb) }, '···')));
      wrap.append(box);
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
    menu(nb.name, [
      { label: 'Rename', fn: async () => { const n = await ask('Rename notebook', '', nb.name, 'Rename'); if (n && n !== nb.name) { await notebooks.update(nb.id, { name: n }); onChanged(); } } },
      { label: 'Add section', fn: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const s = await sections.create(nb.id, n); state.expanded.add(nb.id); state.expanded.add(s.id); onChanged(); } } },
      { label: nb.current ? 'Unset as current rotation' : 'Set as current rotation', fn: async () => {
        for (const o of await notebooks.all()) if (o.current && o.id !== nb.id) await notebooks.update(o.id, { current: 0 });
        await notebooks.update(nb.id, { current: nb.current ? 0 : 1 }); onChanged(); toast(nb.current ? 'Cleared' : nb.name + ' is the current rotation');
      } },
      { label: nb.archived ? 'Unarchive' : 'Archive notebook', fn: async () => { await notebooks.update(nb.id, { archived: nb.archived ? 0 : 1, current: 0 }); state.expanded.delete(nb.id); onChanged(); toast(nb.archived ? 'Restored' : 'Archived'); } },
      { label: 'Delete notebook', danger: true, fn: async () => { if (await confirm('Delete notebook "' + nb.name + '"?', 'All its sections and pages go to the bin too.')) { await notebooks.remove(nb.id); onChanged(); if (state.view === 'page') go('#inbox'); } } }
    ]);
  }
  function sectionMenu(nb, s) {
    menu(nb.name + ' › ' + s.name, [
      { label: 'Open section', fn: () => go('#section/' + s.id) },
      { label: 'New page', fn: () => newPage(nb.id, s.id) },
      { label: s.view === 'table' ? 'Show as list' : 'Show as table (database view)', fn: async () => { await sections.update(s.id, { view: s.view === 'table' ? 'list' : 'table' }); onChanged(); if (state.view === 'section') renderSection(s.id); } },
      { label: 'Rename', fn: async () => { const n = await ask('Rename section', '', s.name, 'Rename'); if (n && n !== s.name) { await sections.update(s.id, { name: n }); onChanged(); } } },
      { label: 'Delete section', danger: true, fn: async () => { if (await confirm('Delete section "' + s.name + '"?', 'Its pages go to the bin too.')) { await sections.remove(s.id); onChanged(); if (state.view === 'page' || state.view === 'section') go('#inbox'); } } }
    ]);
  }
  async function renderNotes() {
    state.view = 'notes';
    const view = el('div', { class: 'view' });
    const recent = (await pages.recent(12)).filter((q) => q.kind !== 'app').slice(0, 8);
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Notebooks'), el('div', { class: 'toolrow' },
      el('a', { class: 'btn small', href: '#pdfs' }, 'PDFs'), el('a', { class: 'btn small', href: '#apps' }, 'Apps'),
      el('button', { class: 'btn small', type: 'button', onclick: async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); state.expanded.add(nb.id); onChanged(); renderNotes(); } } }, '+ Notebook'))));
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

  // ---------- section view (list or database table) ----------
  async function renderSection(id) {
    const s = await sections.get(id);
    if (!s || s.deleted) { content.replaceChildren(el('div', { class: 'view' }, el('h1', {}, 'Section not found'))); return; }
    state.view = 'section';
    const nb = await notebooks.get(s.notebookId);
    const sv = state.sectionView[id] || (state.sectionView[id] = { sort: 'updated', dir: -1, q: '' });
    const pgs = (await pages.forSection(id));
    const view = el('div', { class: 'view' });
    view.append(el('div', { class: 'crumbs' }, el('a', { href: '#notes' }, nb ? nb.name : '—'), '›', s.name, el('span', { class: 'spacer' }), el('button', { class: 'more-page', type: 'button', 'aria-label': 'Section options', onclick: () => sectionMenu(nb, s) }, '···')));
    const head = el('div', { class: 'view-head' }, el('h1', {}, s.name), el('div', { class: 'toolrow' },
      el('div', { class: 'seg' }, el('button', { type: 'button', class: s.view !== 'table' ? 'on' : '', onclick: async () => { await sections.update(id, { view: 'list' }); onChanged(); renderSection(id); } }, 'List'), el('button', { type: 'button', class: s.view === 'table' ? 'on' : '', onclick: async () => { await sections.update(id, { view: 'table' }); onChanged(); renderSection(id); } }, 'Table')),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => newPage(nb.id, id) }, '+ Page')));
    view.append(head);
    const filter = el('input', { class: 'searchbox', type: 'search', placeholder: 'Filter this section…', value: sv.q, id: 'section-filter' });
    filter.addEventListener('input', () => { sv.q = filter.value; draw(); });
    view.append(filter);
    const holder = el('div', {});
    view.append(holder);
    const propVal = (p, k) => { const f = (p.props || []).find((x) => x.k === k); return f ? f.v : ''; };
    const draw = () => {
      const q = sv.q.trim().toLowerCase();
      let rows = pgs.filter((p) => !q || (p.title || '').toLowerCase().includes(q) || textOf(p).toLowerCase().includes(q) || (p.tags || []).join(' ').includes(q));
      const keys = [...new Set(rows.flatMap((p) => (p.props || []).map((x) => x.k)))];
      const val = (p, k) => k === 'title' ? (p.title || '') : k === 'updated' ? (p.updated || 0) : k === 'tags' ? (p.tags || []).join(', ') : propVal(p, k);
      rows.sort((a, b) => { const pa = (b.pinned || 0) - (a.pinned || 0); if (pa) return pa; const va = val(a, sv.sort), vb = val(b, sv.sort); return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true })) * sv.dir; });
      holder.innerHTML = '';
      if (!rows.length) { holder.append(el('p', { class: 'sub' }, q ? 'Nothing matched.' : 'No pages yet.')); return; }
      if (s.view === 'table') {
        const cols = [['title', 'Title'], ...keys.map((k) => [k, k]), ['tags', 'Tags'], ['updated', 'Updated']];
        const table = el('table', { class: 'dbtable' });
        const tr = el('tr', {});
        for (const [k, label] of cols) tr.append(el('th', { onclick: () => { if (sv.sort === k) sv.dir = -sv.dir; else { sv.sort = k; sv.dir = k === 'updated' ? -1 : 1; } draw(); } }, label, sv.sort === k ? (sv.dir > 0 ? ' ▲' : ' ▼') : ''));
        table.append(el('thead', {}, tr));
        const tb = el('tbody', {});
        for (const p of rows) {
          const r = el('tr', { onclick: () => openPage(p.id) });
          for (const [k] of cols) r.append(el('td', { class: k === 'title' ? 'tcell' : '' }, k === 'updated' ? fmtWhen(p.updated) : (k === 'title' ? (p.pinned ? '📌 ' : '') + (p.title || 'Untitled') : String(val(p, k)))));
          tb.append(r);
        }
        table.append(tb);
        holder.append(el('div', { class: 'dbwrap' }, table));
      } else {
        const pl = el('div', { class: 'pagelist' });
        for (const p of rows) pl.append(gestures(el('a', { href: '#page/' + p.id }, el('span', {}, (p.pinned ? '📌 ' : '') + (p.title || 'Untitled'), (p.props || []).length ? el('span', { class: 'proptxt' }, ' · ' + p.props.map((x) => x.k + ': ' + x.v).join(' · ')) : null), el('span', { class: 'when' }, fmtWhen(p.updated))),
          { onDelete: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { await pages.remove(p.id); onChanged(); renderSection(id); } }, onLongPress: () => pageQuickMenu(p, () => renderSection(id)) }));
        holder.append(pl);
      }
    };
    draw();
    content.replaceChildren(view); syncNav();
  }

  // ---------- App hub ----------
  const SEED_APPS = [
    { title: 'Trials & Pearls', url: 'https://claude.ai/artifact/JZ6mj3tFturHFWoMjxghQ7', desc: 'Landmark trials table and medical pearls' },
    { title: 'Shopping List Manager', url: 'https://claude.ai/artifact/18W6PdBdb3tftdqSi75fVC', desc: 'Shared Lidl list, with an Elsewhere list' },
    { title: 'Brick Viewer', url: 'https://rellovrollover.github.io/brick-viewer/', desc: 'Stud.io and LDraw file viewer' },
    { title: 'Brick Locator', url: '', desc: 'Which drawer a LEGO part lives in (local file on the PC)' },
    { title: 'Portfolio Log', url: '', desc: 'Portfolio evidence and teaching hours (moving into NoteCompanion)' }
  ];
  async function appPages() {
    let apps = (await pages.live()).filter((q) => q.kind === 'app');
    if (!apps.length && !(await meta.get('appsSeeded'))) {
      for (const a of SEED_APPS) await pages.create({ kind: 'app', inbox: 0, title: a.title, url: a.url, html: '<p>' + esc(a.desc) + '</p>' });
      await meta.set('appsSeeded', true); S.schedule();
      apps = (await pages.live()).filter((q) => q.kind === 'app');
    }
    return apps.sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (a.title || '').localeCompare(b.title || ''));
  }
  // Import a seed file (a notebook of pages) into NoteCompanion; idempotent by page id.
  async function importSeed(file) {
    const res = await fetch(file); if (!res.ok) throw new Error('Could not load ' + file);
    const seed = await res.json();
    let nb = (await window.NCDB.db.notebooks.where('deleted').equals(0).toArray()).find((n) => n.name === seed.notebook);
    if (!nb) nb = await notebooks.create(seed.notebook);
    const secs = new Map((await sections.forNotebook(nb.id)).map((sc) => [sc.name, sc]));
    const existing = new Set((await window.NCDB.db.pages.toArray()).map((q) => q.id));
    let n = 0;
    for (const pg of seed.pages) {
      if (existing.has(pg.id)) continue;
      let sc = secs.get(pg.section);
      if (!sc) { sc = await sections.create(nb.id, pg.section); await sections.update(sc.id, { view: 'table' }); sc.view = 'table'; secs.set(pg.section, sc); }
      await pages.create({ id: pg.id, notebookId: nb.id, sectionId: sc.id, title: pg.title, html: pg.html, props: pg.props || [], tags: pg.tags || [], pinned: pg.pinned || 0, created: pg.created ? Date.parse(pg.created) || Date.now() : Date.now() });
      n++;
    }
    state.expanded.add(nb.id); onChanged();
    return { notebook: nb, added: n, total: seed.pages.length };
  }
  const SEED_FILES = { 'Trials & Pearls': 'seed/trials-pearls.json' };
  const appIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>';
  async function renderApps() {
    state.view = 'apps';
    const apps = await appPages();
    const view = el('div', { class: 'view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Apps'), el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
      const name = await ask('App name', 'e.g. Portfolio Log'); if (!name) return;
      const url = await ask('Link (optional)', 'https://…'); if (url === undefined) return;
      const np = await pages.create({ kind: 'app', inbox: 0, title: name, url: url || '', html: '' }); S.schedule(); go('#page/' + np.id);
    } }, '+ Add app')));
    const grid = el('div', { class: 'appgrid' });
    for (const a of apps) {
      const tile = el('div', { class: 'apptile' + (a.pinned ? ' pinned' : '') },
        el('div', { class: 'apphead' }, el('span', { class: 'appico', html: appIcon }), el('b', {}, a.title)),
        el('div', { class: 'appdesc' }, textOf(a).slice(0, 120)),
        el('div', { class: 'actions' },
          a.url ? el('a', { class: 'btn small primary', href: a.url, target: '_blank', rel: 'noopener' }, 'Open') : el('span', { class: 'sub' }, 'No link yet'),
          el('button', { class: 'btn small', type: 'button', onclick: () => openPage(a.id) }, 'Notes'),
          SEED_FILES[a.title] ? el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.target.disabled = true; toast('Importing…'); try { const r = await importSeed(SEED_FILES[a.title]); toast(r.added ? 'Imported ' + r.added + ' pages into ' + r.notebook.name : 'Already imported (' + r.total + ' pages)'); } catch (err) { toast(err.message); } e.target.disabled = false; } }, 'Import into NoteCompanion') : null));
      grid.append(gestures(tile, { onDelete: async () => { if (await confirm('Remove "' + a.title + '" from the hub?', null, 'Remove')) { await pages.remove(a.id); S.schedule(); renderApps(); } }, onLongPress: () => menu(a.title, [
        { label: 'Open notes', fn: () => openPage(a.id) },
        { label: 'Change link', fn: async () => { const u = await ask('Link', 'https://…', a.url || '', 'Save'); if (u !== undefined) { await pages.update(a.id, { url: u }); S.schedule(); renderApps(); } } },
        { label: a.pinned ? 'Unpin' : 'Pin', fn: async () => { await pages.update(a.id, { pinned: a.pinned ? 0 : 1 }); S.schedule(); renderApps(); } },
        { label: 'Remove from hub', danger: true, fn: async () => { if (await confirm('Remove "' + a.title + '"?', null, 'Remove')) { await pages.remove(a.id); S.schedule(); renderApps(); } } }
      ]) }));
    }
    view.append(grid, el('p', { class: 'rule' }, 'Open launches the app in its own tab; Notes is a page for how it works and how to update it. Press and hold a tile for more.'));
    content.replaceChildren(view); syncNav();
  }

  // ---------- PDF library ----------
  async function renderLibrary() {
    state.view = 'pdfs';
    const all = (await pages.live()).filter((p) => p.kind === 'pdf').sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.updated || 0) - (a.updated || 0));
    const view = el('div', { class: 'view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'PDF library'), el('button', { class: 'btn small primary', type: 'button', onclick: () => $('#file-pdf').click() }, '+ Add PDF')));
    const filter = el('input', { class: 'searchbox', type: 'search', placeholder: 'Filter PDFs…', id: 'pdf-filter' });
    const grid = el('div', { class: 'pdfgrid' });
    const draw = async () => {
      const q = filter.value.trim().toLowerCase(); grid.innerHTML = '';
      const rows = all.filter((p) => !q || (p.title || '').toLowerCase().includes(q) || (p.tags || []).join(' ').includes(q));
      if (!rows.length) grid.append(el('p', { class: 'sub' }, all.length ? 'Nothing matched.' : 'No PDFs yet. Add one here or through the Inbox File button.'));
      for (const p of rows) {
        const where = p.inbox ? 'Inbox' : await whereIs(p);
        const nAnn = Object.values(p.annots || {}).reduce((n, l) => n + l.length, 0);
        grid.append(gestures(el('a', { class: 'pdftile', href: '#page/' + p.id }, p.thumb ? el('img', { src: p.thumb, alt: '' }) : el('div', { class: 'pdfglyph big' }, 'PDF'),
          el('div', { class: 'pdftitle' }, (p.pinned ? '📌 ' : '') + p.title), el('div', { class: 'pdfmeta' }, (p.pdfPages ? p.pdfPages + ' pp' : '') + (nAnn ? ' · ' + nAnn + ' marks' : '') + ' · ' + where)),
          { onDelete: async () => { if (await confirm('Delete "' + p.title + '"?')) { await pages.remove(p.id); onChanged(); renderLibrary(); } }, onLongPress: () => pageQuickMenu(p, () => renderLibrary()) }));
      }
    };
    filter.addEventListener('input', draw);
    view.append(filter, grid); draw();
    content.replaceChildren(view); syncNav();
  }
  $('#file-pdf').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await captureFile(f);
    e.target.value = ''; toast('PDF added to the Inbox'); if (state.view === 'pdfs') renderLibrary(); else if (state.view === 'inbox') renderInbox();
  });

  // ---------- new page ----------
  async function newPage(notebookId, sectionId) {
    const paper = await sheet((box, close) => {
      box.append(el('h2', {}, 'New page'), el('p', { class: 'rule' }, 'Paper'), el('div', { class: 'list papers' }, Object.entries(PAPERS).map(([k, v]) => el('button', { type: 'button', class: 'paper-' + k, onclick: () => close(k) }, el('span', { class: 'swatch' }), v))),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    });
    if (paper === undefined) return;
    const p = await pages.create({ notebookId, sectionId, title: '', html: '', paper });
    state.expanded.add(notebookId); state.expanded.add(sectionId);
    onChanged(); state.focusNew = true; go('#page/' + p.id);
  }

  // ---------- page view ----------
  async function snapshotIfChanged() {
    const p = state.openedPage; if (!p || !state.editor) return;
    let html; try { html = state.editor.getContent(); } catch (e) { return; }
    if (html === state.openedHtml) return;
    await versions.add({ id: p.id, title: p.title, html: state.openedHtml, props: p.props });
    state.openedHtml = html;
  }
  function destroyEditor() {
    clearTimeout(state.saveTimer); clearInterval(state.versionTimer);
    if (state.pendingSave) { const ps = state.pendingSave; state.pendingSave = null; pages.update(ps.id, ps.patch).then(() => S.schedule()); }
    if (state.pdfTeardown) { try { state.pdfTeardown(); } catch (e) { /* ignore */ } state.pdfTeardown = null; }
    if (state.editor) { snapshotIfChanged().catch(() => {}); try { state.editor.remove(); } catch (e) { /* ignore */ } state.editor = null; }
    state.openedPage = null;
  }
  // A 24px baseline grid: every line of body text, list item and heading sits on it, so ruled and squared paper line up.
  const FONT_BASE = new URL('vendor/fonts/', C.redirectUri).href;
  const EDITOR_CSS = `
    @font-face { font-family: Carlito; font-style: normal; font-weight: 400; src: local('Carlito'), url('${FONT_BASE}carlito-latin-400-normal.woff2') format('woff2'); }
    @font-face { font-family: Carlito; font-style: italic; font-weight: 400; src: url('${FONT_BASE}carlito-latin-400-italic.woff2') format('woff2'); }
    @font-face { font-family: Carlito; font-style: normal; font-weight: 700; src: url('${FONT_BASE}carlito-latin-700-normal.woff2') format('woff2'); }
    @font-face { font-family: Carlito; font-style: italic; font-weight: 700; src: url('${FONT_BASE}carlito-latin-700-italic.woff2') format('woff2'); }
    :root { --pitch: 24px; --rule: rgba(47,93,138,.18); --grid: rgba(47,93,138,.13); --ink: #1a1d23; color-scheme: light; }
    html { background: #ffffff; min-height: 100%; }
    body { background: #ffffff; color: var(--ink); font-family: Calibri, Carlito, "Segoe UI", -apple-system, system-ui, sans-serif; font-size: 17px; line-height: var(--pitch); padding: var(--pitch) 24px var(--pitch); max-width: 50rem; margin: 0 auto; box-sizing: border-box; min-height: 100%; }
    html.paper-ruled { background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--pitch) - 1px), var(--rule) calc(var(--pitch) - 1px), var(--rule) var(--pitch)); background-origin: border-box; }
    html.paper-grid { background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--pitch) - 1px), var(--grid) calc(var(--pitch) - 1px), var(--grid) var(--pitch)), repeating-linear-gradient(to right, transparent 0, transparent calc(var(--pitch) - 1px), var(--grid) calc(var(--pitch) - 1px), var(--grid) var(--pitch)); background-origin: border-box; }
    html.paper-dots { background-image: radial-gradient(circle, var(--rule) 1.2px, transparent 1.6px); background-size: var(--pitch) var(--pitch); background-position: calc(var(--pitch) / 2) calc(var(--pitch) / 2); background-origin: border-box; }
    html.paper-ruled, html.paper-grid, html.paper-dots { background-attachment: scroll; min-height: 100%; }
    p, ul, ol, blockquote, pre, table, details, .callout { margin: 0; }
    li { line-height: var(--pitch); }
    h1, h2, h3 { font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif; letter-spacing: -0.01em; margin: 0; }
    h1 { font-size: 28px; line-height: calc(var(--pitch) * 2); }
    h2 { font-size: 22px; line-height: var(--pitch); }
    h3 { font-size: 18px; line-height: var(--pitch); }
    img { max-width: 100%; height: auto; border-radius: 8px; vertical-align: top; }
    table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #b9b4a8; padding: 0 8px; line-height: var(--pitch); vertical-align: top; } th { background: rgba(127,127,127,.12); }
    a.wikilink { color: #1f3a5f; text-decoration: none; border-bottom: 1px dashed currentColor; }
    li[data-todo] { list-style: none; position: relative; padding-left: 1.7em; margin-left: -1.4em; }
    li[data-todo]::before { content: ""; position: absolute; left: 0; top: .28em; width: 1em; height: 1em; border: 1.6px solid #7a7f88; border-radius: 4px; box-sizing: border-box; background: transparent; }
    li[data-todo="done"]::before { background: #2d7a4f; border-color: #2d7a4f; }
    li[data-todo="done"] { text-decoration: line-through; opacity: .65; }
    mark { background: #fde68a; color: inherit; padding: 0 2px; }
    blockquote { border-left: 3px solid #b9b4a8; margin-left: 0; padding-left: 12px; color: #6a6e78; }
    pre { background: rgba(127,127,127,.12); padding: 0 12px; line-height: var(--pitch); border-radius: 8px; overflow-x: auto; }
    .callout { border-radius: 10px; padding: calc(var(--pitch) / 2 - 1px) 14px calc(var(--pitch) / 2 - 1px) 44px; border: 1px solid transparent; position: relative; }
    .callout > :last-child { margin-bottom: 0; }
    .callout::before { position: absolute; left: 14px; top: calc(var(--pitch) / 2 - 1px); font-size: 18px; line-height: var(--pitch); }
    .callout-info { background: rgba(31,58,95,.1); border-color: rgba(31,58,95,.25); } .callout-info::before { content: "ⓘ"; }
    .callout-tip { background: rgba(45,122,79,.12); border-color: rgba(45,122,79,.3); } .callout-tip::before { content: "✓"; }
    .callout-warning { background: rgba(180,98,14,.12); border-color: rgba(180,98,14,.3); } .callout-warning::before { content: "⚠"; }
    .callout-danger { background: rgba(179,38,30,.1); border-color: rgba(179,38,30,.3); } .callout-danger::before { content: "✕"; }
    details { border-left: 3px solid #b9b4a8; padding-left: 12px; }
    details > summary { font-weight: 600; line-height: var(--pitch); cursor: pointer; }
  `;
  const PAPERS = { plain: 'Plain', ruled: 'Lined', grid: 'Graph', dots: 'Dotted' };
  function applyPaper(ed, paper) {
    const doc = ed.getDoc(); if (!doc) return;
    const h = doc.documentElement;
    h.className = h.className.replace(/\bpaper-\w+/g, '').trim();
    if (paper && paper !== 'plain') h.classList.add('paper-' + paper);
  }
  const CALLOUTS = { info: 'Info', tip: 'Tip', warning: 'Warning', danger: 'Important' };
  function insertCallout(ed, kind) {
    const cur = ed.dom.getParent(ed.selection.getNode(), '.callout');
    if (cur) { cur.className = 'callout callout-' + kind; ed.undoManager.add(); return; }
    const sel = ed.selection.getContent({ format: 'html' });
    ed.insertContent('<div class="callout callout-' + kind + '"><p>' + (sel || '&nbsp;') + '</p></div><p>&nbsp;</p>');
  }

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
    if (p.kind === 'app') crumbs.append(el('a', { href: '#apps' }, 'Apps'), '›', p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'Open app') : el('button', { type: 'button', onclick: async () => { const u = await ask('Link', 'https://…', '', 'Save'); if (u) { await pages.update(p.id, { url: u }); S.schedule(); renderPage(id); } } }, 'Add link'));
    else if (p.inbox) crumbs.append('Inbox', el('button', { type: 'button', onclick: async () => { if (await fileInto(p.id)) renderPage(id); } }, 'File to…'));
    else crumbs.append(el('a', { href: '#notes' }, nb ? nb.name : '—'), '›', el('a', { href: sec ? '#section/' + sec.id : '#notes' }, sec ? sec.name : '—'));
    crumbs.append(el('span', { class: 'spacer' }));
    if (p.pinned) crumbs.append(el('span', { class: 'pinmark', title: 'Pinned' }, '📌'));
    crumbs.append(el('button', { class: 'more-page', type: 'button', 'aria-label': 'Page options', onclick: () => pageMenu(p) }, '···'));
    crumbs.append(el('button', { class: 'done-page', type: 'button', 'aria-label': 'Done', title: 'Save and close', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', onclick: () => { destroyEditor(); go(p.kind === 'app' ? '#apps' : p.inbox ? '#inbox' : (p.sectionId ? '#section/' + p.sectionId : '#notes')); } }));
    view.append(crumbs);

    const title = el('input', { class: 'title-input', id: 'page-title', type: 'text', placeholder: 'Untitled', value: p.title || '' });
    title.addEventListener('input', () => queueSave({ title: title.value }));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (state.editor) state.editor.focus(); } });
    view.append(title);

    if (p.kind === 'pdf') {
      const host = el('div', { class: 'pdfhost' });
      view.append(host);
      content.replaceChildren(view); syncNav();
      state.pdfTeardown = await window.NCPDF.render(p, host, { queueSave: (patch) => queueSave(patch) });
      return;
    }

    // Properties: small key-value chips under the title.
    const props = el('div', { class: 'props' });
    const renderProps = () => {
      props.innerHTML = '';
      for (const [i, pr] of (p.props || []).entries()) {
        props.append(el('button', { class: 'prop', type: 'button', title: 'Edit property', onclick: async () => {
          const choice = await menu(pr.k, [
            { label: 'Change value', fn: async () => { const v = await ask(pr.k, 'Value', pr.v, 'Save'); if (v !== undefined) { p.props[i].v = v; await pages.update(p.id, { props: p.props }); S.schedule(); renderProps(); } } },
            { label: 'Rename property', fn: async () => { const k = await ask('Rename property', 'Name', pr.k, 'Rename'); if (k) { p.props[i].k = k; await pages.update(p.id, { props: p.props }); S.schedule(); renderProps(); } } },
            { label: 'Remove', danger: true, fn: async () => { p.props.splice(i, 1); await pages.update(p.id, { props: p.props }); S.schedule(); renderProps(); } }
          ]);
          return choice;
        } }, el('span', { class: 'pk' }, pr.k), el('span', { class: 'pv' }, pr.v || '—')));
      }
      for (const t of p.tags || []) props.append(el('button', { class: 'prop tag', type: 'button', title: 'Remove tag', onclick: async () => { if (await confirm('Remove tag #' + t + '?', null, 'Remove')) { p.tags = p.tags.filter((x) => x !== t); await pages.update(p.id, { tags: p.tags }); onChanged(); renderProps(); } } }, '#' + t));
      props.append(el('button', { class: 'prop add', type: 'button', onclick: async () => {
        const known = [...new Set((await pages.live()).flatMap((q) => (q.props || []).map((x) => x.k)))].filter((k) => !(p.props || []).some((x) => x.k === k));
        const pick = (k) => ask(k, 'Value', '', 'Add').then(async (v) => { if (v === undefined) return; p.props = [...(p.props || []), { k, v }]; await pages.update(p.id, { props: p.props }); S.schedule(); renderProps(); });
        const addTag = async () => {
          const all = await pages.tags();
          const t = await sheet((box, close) => {
            const inp = el('input', { type: 'text', placeholder: 'Tag name', id: 'tag-pick' });
            const list = el('div', { class: 'list' });
            const fill = () => { const q = inp.value.trim().toLowerCase().replace(/^#/, ''); list.innerHTML = ''; for (const x of all.filter((x) => !(p.tags || []).includes(x.tag) && (!q || x.tag.includes(q))).slice(0, 12)) list.append(el('button', { type: 'button', onclick: () => close(x.tag) }, '#' + x.tag + '  ·  ' + x.n)); };
            inp.addEventListener('input', fill); fill();
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close(inp.value.trim()); } });
            box.append(el('h2', {}, 'Add tag'), inp, list, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', onclick: () => close(inp.value.trim()) }, 'Add')));
          });
          const tag = (t || '').replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
          if (tag && !(p.tags || []).includes(tag)) { p.tags = [...(p.tags || []), tag]; await pages.update(p.id, { tags: p.tags }); onChanged(); renderProps(); }
        };
        menu('Add to this page', [{ label: '# Tag', fn: addTag }, ...known.map((k) => ({ label: k, fn: () => pick(k) })), { label: 'New property…', accent: true, fn: async () => { const k = await ask('Property name', 'e.g. Date, Rotation, Status'); if (k) pick(k); } }]);
      } }, '+ add'));
    };
    renderProps(); view.append(props);

    const host = el('div', { class: 'editor-host' });
    const ta = el('textarea', { id: 'page-editor' });
    host.append(ta); view.append(host);

    const back = el('div', { class: 'backlinks' });
    view.append(back);
    content.replaceChildren(view); syncNav();
    renderBacklinks(p, back);

    const initial = htmlOf(p);
    const dark = isDark();
    const focusNew = state.focusNew; state.focusNew = false;
    const editors = await tinymce.init({
      target: ta, base_url: new URL('vendor/tinymce', C.redirectUri).href, suffix: '.min', license_key: 'gpl', promotion: false, branding: false,
      skin: dark ? 'oxide-dark' : 'oxide', content_css: 'default', content_style: EDITOR_CSS,
      plugins: 'lists advlist table link image autolink autoresize searchreplace codesample quickbars accordion',
      menubar: false, statusbar: false, toolbar_mode: 'sliding', toolbar_sticky: true, toolbar_sticky_offset: 52,
      toolbar: 'undo redo | blocks | bold italic underline strikethrough | forecolor backcolor | bullist numlist todo | outdent indent | alignleft aligncenter alignright | callout accordion table image link pagelink | fontsize fontfamily | codesample removeformat searchreplace',
      quickbars_selection_toolbar: 'bold italic underline | forecolor backcolor | quicklink',
      quickbars_insert_toolbar: false, quickbars_image_toolbar: 'alignleft aligncenter alignright | imageoptions',
      autoresize_bottom_margin: 24, min_height: isNarrow() ? 360 : 460,
      convert_urls: false, paste_data_images: true, automatic_uploads: true, image_title: false, image_dimensions: false,
      images_upload_handler: (blobInfo) => storeAsset(blobInfo.blob(), blobInfo.filename()).then((a) => { onChanged(); return assetUrl(a.id); }),
      link_default_target: '_blank', link_assume_external_targets: 'https',
      font_size_formats: '12px 14px 16px 18px 20px 24px 28px',
      font_family_formats: 'Calibri=Calibri,Carlito,Segoe UI,-apple-system,system-ui,sans-serif; System=-apple-system,Segoe UI,system-ui,sans-serif; Serif=Iowan Old Style,Palatino Linotype,Georgia,serif; Arial=arial,helvetica,sans-serif; Mono=ui-monospace,Menlo,Consolas,monospace',
      block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; Quote=blockquote; Code=pre',
      table_toolbar: 'tableprops tabledelete | tableinsertrowbefore tableinsertrowafter tabledeleterow | tableinsertcolbefore tableinsertcolafter tabledeletecol',
      placeholder: 'Start writing… (type / for commands)', extended_valid_elements: 'li[data-todo|style|class],a[href|class|target|rel|title],audio[src|controls],div[class|style]',
      setup: (ed) => {
        ed.ui.registry.addButton('todo', { icon: 'checklist', tooltip: 'To-do item', onAction: () => toggleTodo(ed) });
        ed.ui.registry.addMenuButton('callout', { icon: 'info', tooltip: 'Callout', fetch: (cb) => cb(Object.entries(CALLOUTS).map(([k, v]) => ({ type: 'menuitem', text: v, onAction: () => { insertCallout(ed, k); scheduleSave(); } })).concat([{ type: 'menuitem', text: 'Remove callout', onAction: () => { const c = ed.dom.getParent(ed.selection.getNode(), '.callout'); if (c) { ed.dom.remove(c, true); ed.undoManager.add(); scheduleSave(); } } }])) });
        ed.ui.registry.addButton('pagelink', { text: '[[', tooltip: 'Link to a page', onAction: () => insertPageLink(ed) });
        // Slash commands
        ed.ui.registry.addAutocompleter('slash', {
          trigger: '/', minChars: 0, columns: 1,
          fetch: (pattern) => Promise.resolve(SLASH.filter((c) => c.text.toLowerCase().includes(pattern.toLowerCase())).map((c) => ({ type: 'autocompleteitem', value: c.value, text: c.text, icon: c.icon }))),
          onAction: (api, rng, value) => { ed.selection.setRng(rng); ed.selection.setContent(''); api.hide(); runSlash(ed, value); }
        });
        ed.on('click', (e) => {
          const a = e.target.closest && e.target.closest('a.wikilink');
          if (a) { e.preventDefault(); go(a.getAttribute('href')); return; }
          const li = e.target.closest && e.target.closest('li[data-todo]');
          if (li && e.target === li && e.offsetX < 24) { ed.dom.setAttrib(li, 'data-todo', li.getAttribute('data-todo') === 'done' ? '' : 'done'); ed.undoManager.add(); scheduleSave(); }
        });
        ed.on('input change undo redo SetContent ExecCommand', () => { if (ed.initialized) scheduleSave(); });
        ed.on('init', () => { ed.setContent(initial); applyPaper(ed, p.paper); ed.undoManager.clear(); ed.setDirty(false); if (focusNew && !p.title) setTimeout(() => title.focus(), 60); });
      }
    });
    state.editor = editors && editors[0];
    if (!state.editor) return;
    state.openedPage = p; state.openedHtml = initial;
    state.versionTimer = setInterval(() => snapshotIfChanged().catch(() => {}), 10 * 60 * 1000);
    function toggleTodo(ed) {
      let li = ed.dom.getParent(ed.selection.getNode(), 'li');
      if (!li) { ed.execCommand('InsertUnorderedList'); li = ed.dom.getParent(ed.selection.getNode(), 'li'); }
      if (!li) return;
      if (li.hasAttribute('data-todo')) ed.dom.setAttrib(li, 'data-todo', null); else ed.dom.setAttrib(li, 'data-todo', '');
      ed.undoManager.add(); scheduleSave();
    }
    async function insertPageLink(ed) {
      const t = await pickPage('Link to page'); if (!t) return;
      const sel = ed.selection.getContent({ format: 'text' });
      ed.insertContent('<a class="wikilink" href="#page/' + t.id + '">' + esc(sel || t.title) + '</a>&nbsp;');
    }
    const SLASH = [
      { value: 'h1', text: 'Heading 1', icon: 'h1' }, { value: 'h2', text: 'Heading 2', icon: 'h2' }, { value: 'h3', text: 'Heading 3', icon: 'h3' },
      { value: 'p', text: 'Paragraph', icon: 'paragraph' }, { value: 'ul', text: 'Bullet list', icon: 'unordered-list' }, { value: 'ol', text: 'Numbered list', icon: 'ordered-list' },
      { value: 'todo', text: 'To-do', icon: 'checklist' }, { value: 'table', text: 'Table', icon: 'table' }, { value: 'toggle', text: 'Toggle (collapsible)', icon: 'accordion' },
      { value: 'callout-info', text: 'Callout: info', icon: 'info' }, { value: 'callout-tip', text: 'Callout: tip', icon: 'checkmark' }, { value: 'callout-warning', text: 'Callout: warning', icon: 'warning' }, { value: 'callout-danger', text: 'Callout: important', icon: 'close' },
      { value: 'quote', text: 'Quote', icon: 'quote' }, { value: 'code', text: 'Code block', icon: 'sourcecode' }, { value: 'hr', text: 'Divider', icon: 'horizontal-rule' },
      { value: 'date', text: 'Today\'s date', icon: 'insert-time' }, { value: 'link', text: 'Link to page', icon: 'link' }, { value: 'image', text: 'Image', icon: 'image' }
    ];
    function runSlash(ed, v) {
      if (v === 'h1' || v === 'h2' || v === 'h3' || v === 'p') ed.execCommand('FormatBlock', false, v);
      else if (v === 'ul') ed.execCommand('InsertUnorderedList');
      else if (v === 'ol') ed.execCommand('InsertOrderedList');
      else if (v === 'todo') toggleTodo(ed);
      else if (v === 'table') ed.execCommand('mceInsertTable', false, { rows: 3, columns: 3 });
      else if (v === 'toggle') ed.execCommand('InsertAccordion');
      else if (v.startsWith('callout-')) insertCallout(ed, v.slice(8));
      else if (v === 'quote') ed.execCommand('FormatBlock', false, 'blockquote');
      else if (v === 'code') ed.execCommand('FormatBlock', false, 'pre');
      else if (v === 'hr') ed.execCommand('InsertHorizontalRule');
      else if (v === 'date') ed.insertContent(new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' ');
      else if (v === 'link') insertPageLink(ed);
      else if (v === 'image') ed.execCommand('mceImage');
      scheduleSave();
    }
    function scheduleSave() {
      if (state.pageId !== id || !state.editor) return;
      let html; try { html = state.editor.getContent(); } catch (e) { return; }
      if (html === htmlOf(p)) return;
      queueSave({ html, md: '' });
    }
    function queueSave(patch) {
      Object.assign(p, patch);
      clearTimeout(state.saveTimer);
      state.pendingSave = { id: p.id, patch };
      state.saveTimer = setTimeout(async () => { state.pendingSave = null; await pages.update(p.id, patch); S.schedule(); refreshTree(); }, 700);
    }
  }
  function pageMenu(p) {
    const html = state.editor && state.pageId === p.id ? state.editor.getContent() : htmlOf(p);
    const words = wordCount(html);
    const note = p.kind === 'pdf' ? ((p.pdfPages || '?') + ' pages · ' + Object.values(p.annots || {}).reduce((n, l) => n + l.length, 0) + ' marks · edited ' + fmtWhen(p.updated)) : (words + (words === 1 ? ' word' : ' words') + ' · about ' + Math.max(1, Math.round(words / 220)) + ' min read · edited ' + fmtWhen(p.updated));
    menu(p.title || 'Untitled', [
      p.kind === 'app' ? { label: 'Change link', fn: async () => { const u = await ask('Link', 'https://…', p.url || '', 'Save'); if (u !== undefined) { await pages.update(p.id, { url: u }); S.schedule(); renderPage(p.id); } } } : p.inbox ? { label: 'File to section…', fn: async () => { if (await fileInto(p.id)) renderPage(p.id); } } : { label: 'Move to…', fn: async () => { const t = await pickSection('Move page to'); if (t) { await pages.update(p.id, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId }); onChanged(); renderPage(p.id); } } },
      { label: p.pinned ? 'Unpin' : 'Pin to top of section', fn: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); renderPage(p.id); } },
      p.kind === 'pdf' ? null : { label: 'Paper: ' + (PAPERS[p.paper] || 'Plain') + '…', fn: () => menu('Paper', Object.entries(PAPERS).map(([k, v]) => ({ label: v + (k === (p.paper || 'plain') ? '  ✓' : ''), fn: async () => { p.paper = k; await pages.update(p.id, { paper: k }); S.schedule(); if (state.editor && state.pageId === p.id) applyPaper(state.editor, k); } }))) },
      p.kind === 'pdf' ? null : { label: 'History…', fn: () => historySheet(p) },
      p.kind === 'pdf' ? { label: 'Export annotated PDF', fn: async () => { try { toast('Preparing PDF…'); const blob = await window.NCPDF.exportAnnotated(p); await deliver(blob, (p.title || 'document') + ' (annotated).pdf'); } catch (e) { toast(e.message); } } } : { label: 'Export as Markdown (.md)', fn: () => exportPage(p, 'md') },
      p.kind === 'pdf' ? { label: 'Export original PDF', fn: async () => { const a = await assets.get(p.assetId); if (a && a.blob) await deliver(a.blob, (p.title || 'document') + '.pdf'); else toast('PDF not on this device'); } } : { label: 'Export as Word (.doc)', fn: () => exportPage(p, 'doc') },
      p.kind === 'pdf' ? { label: 'Clear all marks', danger: true, fn: async () => { if (await confirm('Remove every pen and highlighter mark from this PDF?', null, 'Clear')) { await pages.update(p.id, { annots: {} }); S.schedule(); renderPage(p.id); } } } : { label: 'Print / Save as PDF', fn: () => setTimeout(() => window.print(), 200) },
      { label: 'Delete page', danger: true, fn: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { destroyEditor(); await pages.remove(p.id); onChanged(); go(p.kind === 'app' ? '#apps' : p.inbox ? '#inbox' : '#notes'); } } }
    ], note);
  }
  async function historySheet(p) {
    await snapshotIfChanged().catch(() => {});
    const list = await versions.forPage(p.id);
    sheet((box, close) => {
      box.append(el('h2', {}, 'History: ' + (p.title || 'Untitled')), el('p', { class: 'rule' }, list.length ? 'Snapshots are taken when you leave a page after editing, and every 10 minutes while you type. The newest 20 are kept.' : 'No snapshots yet. One is taken when you leave the page after editing.'));
      const ul = el('div', { class: 'list' });
      for (const v of list) ul.append(el('button', { type: 'button', onclick: () => { close(); previewVersion(p, v); } }, fmtWhen(v.created || v.updated) + ' · ' + wordCount(v.html) + ' words' + (v.title && v.title !== p.title ? ' · "' + v.title + '"' : '')));
      box.append(ul, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
    });
  }
  function previewVersion(p, v) {
    sheet((box, close) => {
      box.append(el('h2', {}, 'Version from ' + fmtWhen(v.created || v.updated)), el('div', { class: 'quicklook', html: v.html || '<p><em>(empty)</em></p>' }),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => { close(); historySheet(p); } }, 'Back'),
          el('button', { class: 'btn primary', type: 'button', onclick: async () => {
            close();
            if (state.editor && state.pageId === p.id) { await versions.add({ id: p.id, title: p.title, html: state.editor.getContent(), props: p.props }); state.editor.setContent(v.html || ''); state.openedHtml = v.html || ''; }
            await pages.update(p.id, { html: v.html || '', md: '' }); p.html = v.html || ''; S.schedule(); toast('Restored');
          } }, 'Restore this version')));
    });
  }
  async function renderBacklinks(p, back) {
    back.innerHTML = '';
    const needle = '#page/' + p.id;
    const all = await pages.live();
    const linked = all.filter((q) => q.id !== p.id && (q.html || '').includes(needle));
    const t = (p.title || '').trim().toLowerCase();
    const mentions = t.length >= 4 ? all.filter((q) => q.id !== p.id && !linked.includes(q) && textOf(q).toLowerCase().includes(t)) : [];
    if (linked.length) { back.append(el('h3', {}, 'Linked from')); for (const q of linked) back.append(el('a', { href: '#page/' + q.id }, q.title || 'Untitled')); }
    if (mentions.length) {
      back.append(el('h3', {}, 'Mentioned in (not linked)'));
      for (const q of mentions.slice(0, 15)) back.append(el('div', { class: 'mention' }, el('a', { href: '#page/' + q.id }, q.title || 'Untitled'), el('button', { class: 'btn small', type: 'button', onclick: async () => {
        const re = new RegExp('(' + (p.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![^<]*>)', 'i');
        const html = htmlOf(q).replace(re, '<a class="wikilink" href="#page/' + p.id + '">$1</a>');
        await pages.update(q.id, { html, md: '' }); S.schedule(); renderBacklinks(p, back); toast('Linked');
      } }, 'Link it')));
    }
  }
  async function pickPage(title) {
    const all = (await pages.live()).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const cur = state.pageId ? await pages.get(state.pageId) : null;
    return sheet((box, close) => {
      const inp = el('input', { type: 'text', placeholder: 'Search pages or type a new title', id: 'pick-input' });
      const list = el('div', { class: 'list' });
      const fill = () => {
        const q = inp.value.trim().toLowerCase(); list.innerHTML = '';
        const hits = all.filter((pg) => pg.id !== state.pageId && pg.title && (!q || pg.title.toLowerCase().includes(q))).slice(0, 30);
        for (const pg of hits) list.append(el('button', { type: 'button', onclick: () => close({ id: pg.id, title: pg.title }) }, pg.title));
        if (q) list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => {
          const np = await pages.create({ title: inp.value.trim(), notebookId: cur ? cur.notebookId : null, sectionId: cur ? cur.sectionId : null, inbox: cur && cur.sectionId ? 0 : 1, html: '' });
          onChanged(); close({ id: np.id, title: np.title });
        } }, 'Create new page "' + inp.value.trim() + '"'));
      };
      inp.addEventListener('input', fill); fill();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = list.querySelector('button'); if (b) b.click(); } });
      box.append(el('h2', {}, title), inp, list, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    });
  }

  // ---------- export ----------
  async function inlineAssets(html) {
    const ids = [...html.matchAll(/asset\/([0-9a-f-]{36})/g)].map((m) => m[1]);
    for (const aid of new Set(ids)) {
      const a = await assets.get(aid);
      if (a && a.blob) {
        const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(a.blob); });
        html = html.split('asset/' + aid).join(data);
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
  async function exportPage(p, kind) {
    const base = (p.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '_');
    const html = state.editor && state.pageId === p.id ? state.editor.getContent() : htmlOf(p);
    const propsHtml = (p.props || []).length ? '<p>' + p.props.map((x) => '<strong>' + esc(x.k) + ':</strong> ' + esc(x.v)).join('<br>') + '</p>' : '';
    if (kind === 'md') {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
      td.addRule('todo', { filter: (node) => node.nodeName === 'LI' && node.hasAttribute('data-todo'), replacement: (c, node) => '- [' + (node.getAttribute('data-todo') === 'done' ? 'x' : ' ') + '] ' + c.trim() + '\n' });
      td.addRule('callout', { filter: (node) => node.nodeName === 'DIV' && node.classList.contains('callout'), replacement: (c) => '\n> ' + c.trim().replace(/\n/g, '\n> ') + '\n\n' });
      const md = '# ' + (p.title || '') + '\n\n' + td.turndown(propsHtml + html);
      await deliver(new Blob([md], { type: 'text/markdown' }), base + '.md');
    } else {
      const body = await inlineAssets(propsHtml + html);
      const doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + esc(p.title || '') + '</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt}h1,h2,h3{font-family:Cambria,Georgia,serif}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}li[data-todo]:before{content:"\\2610 "}li[data-todo=done]:before{content:"\\2611 "}.callout{border:1px solid #999;padding:6px 10px;margin:8px 0}</style></head><body><h1>' + esc(p.title || '') + '</h1>' + body + '</body></html>';
      await deliver(new Blob(['﻿', doc], { type: 'application/msword' }), base + '.doc');
    }
  }

  // ---------- search ----------
  async function renderSearch() {
    state.view = 'search';
    const view = el('div', { class: 'view' });
    const inp = el('input', { class: 'searchbox', type: 'search', placeholder: 'Search notes, captures, tags, properties…', value: state.query, id: 'search-input', autocomplete: 'off' });
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
        const title = (p.title || '').toLowerCase(), raw = textOf(p), body = raw.toLowerCase(), tgs = (p.tags || []).join(' ');
        if (tagQ) { if (!(p.tags || []).includes(tagQ)) continue; scored.push({ p, raw, score: p.updated, idx: -1 }); continue; }
        let score = 0, idx = -1;
        for (const t of terms) {
          if (title.includes(t)) score += 10; if (tgs.includes(t)) score += 5;
          const i = body.indexOf(t); if (i >= 0) { score += 2; if (idx < 0) idx = i; }
        }
        if (score) scored.push({ p, raw, score: score * 1e13 + (p.updated || 0), idx });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const { p, raw, idx } of scored.slice(0, 60)) {
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
    const cur = themePref();
    const seg = el('div', { class: 'seg' }, ...[['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([k, v]) => el('button', { type: 'button', class: k === cur ? 'on' : '', onclick: () => { applyTheme(k); renderSettings(); } }, v)));
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Appearance'), el('p', { class: 'rule' }, 'Note paper stays white in either mode.'), seg));
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'This device'),
      el('div', { class: 'kv' }, el('span', {}, 'Name'), el('span', {}, dev)),
      el('div', { class: 'kv' }, el('span', {}, 'Installed as app'), el('span', {}, (navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? 'Yes' : 'No (use Add to Home Screen)')),
      el('div', { class: 'kv' }, el('span', {}, 'Offline cache'), el('span', { id: 'kv-sw' }, navigator.serviceWorker && navigator.serviceWorker.controller ? 'Ready' : 'Not yet; reload once')),
      el('div', { class: 'kv' }, el('span', {}, 'Storage kept'), el('span', { id: 'kv-persist' }, '…')),
      el('div', { class: 'kv' }, el('span', {}, 'Version'), el('span', {}, C.version))));
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { const k = $('#kv-persist'); if (k) k.textContent = p ? 'Yes' : 'Not promised by the browser'; });
    if (g.signedIn) {
      const on = el('div', { class: 'panel' }, el('h2', {}, 'Import from OneNote'),
        el('p', { class: 'rule' }, 'Copies a OneNote notebook into NoteCompanion: sections (section groups become "Group / Section"), pages, images and attachments. Ink comes across as pictures. Safe to run again; pages already imported are skipped.'),
        el('div', { id: 'onenote-list' }, el('button', { class: 'btn', type: 'button', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Loading notebooks…';
          try {
            const nbs = await window.NCOneNote.listNotebooks();
            const list = el('div', { class: 'list' });
            if (!nbs.length) list.append(el('p', { class: 'sub' }, 'No OneNote notebooks found on this account.'));
            for (const nb of nbs) {
              const row = el('button', { type: 'button' }, nb.displayName);
              row.addEventListener('click', async () => {
                if (!(await confirm('Import "' + nb.displayName + '"?', 'This can take a few minutes for a big notebook. Keep this screen open.', 'Import'))) return;
                row.disabled = true;
                const bar = el('div', { class: 'progress' }, el('div', { class: 'progress-fill' }));
                const status = el('p', { class: 'rule' }, 'Counting pages…');
                row.after(bar, status);
                try {
                  const r = await window.NCOneNote.importNotebook(nb, (m, done, total) => { status.textContent = m; if (total) bar.firstChild.style.width = Math.round(done / total * 100) + '%'; });
                  bar.firstChild.style.width = '100%';
                  status.textContent = 'Done: ' + r.count + ' pages imported into "' + r.notebook.name + '" (' + r.sections + ' sections' + (r.skipped ? ', ' + r.skipped + ' already there' : '') + (r.failed ? ', ' + r.failed + ' failed' : '') + ').';
                  toast('Notebook added: ' + r.notebook.name, { label: 'Open', fn: () => { state.expanded.add(r.notebook.id); go('#notes'); } });
                  onChanged();
                } catch (err) { status.textContent = 'Import failed: ' + (err.message || err); console.warn(err); }
                row.disabled = false;
              });
              list.append(row);
            }
            $('#onenote-list').replaceChildren(list);
          } catch (err) {
            e.target.disabled = false; e.target.textContent = 'Show my OneNote notebooks';
            toast(/403|consent|Notes\.Read/i.test(err.message || '') ? 'Sign out and in again to grant OneNote access' : (err.message || 'Could not list notebooks'));
          }
        } }, 'Show my OneNote notebooks')));
      view.append(on);
    }
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Backup'),
      el('p', { class: 'rule' }, 'Everything is in your OneDrive folder as plain JSON and files. This also downloads a single JSON file of all notes from this device.'),
      el('div', {}, el('button', { class: 'btn', type: 'button', onclick: async () => { const data = await window.NCDB.exportAll(); await deliver(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'notecompanion-backup-' + isoDay(new Date()) + '.json'); } }, 'Download backup'))));
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Tips'),
      el('ul', {}, el('li', {}, 'Type / in a page for headings, lists, to-dos, tables, callouts, toggles and more.'),
        el('li', {}, 'Tap a section name to open it; the chevron expands it in place. Any section can be shown as a table of its pages and their properties.'),
        el('li', {}, 'Set a notebook as the current rotation and filing offers it first.'),
        el('li', {}, 'Scan in the Inbox cleans up a photo of a document; straightening comes with the PDF phase.'))));
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Capture from the iPhone Share Sheet'),
      el('p', {}, el('b', {}, 'Best way (no browser):'), ' in Shortcuts, make a shortcut that receives anything from the Share Sheet, then a ', el('b', {}, 'Save File'), ' action with "Ask Where to Save" off and the destination set to the OneDrive folder ', el('code', {}, 'NoteCompanion/inbox'), '. Text, links, photos and PDFs saved there appear in the Inbox the next time any device syncs, and the dropped file is cleared from OneDrive.'),
      el('p', {}, el('b', {}, 'Instant way (opens Safari):'), ' an "Open URLs" action set to ', el('code', {}, C.redirectUri + '?capture=1&text=[Shortcut Input]'), '. iOS always opens a URL in Safari rather than the home-screen app, so the note lands in the same shared inbox but the app itself does not come to the front.')));
    content.replaceChildren(view); syncNav();
  }

  // ---------- navigation ----------
  function syncNav() {
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.view || ((state.view === 'page' || state.view === 'section' || ((state.view === 'pdfs' || state.view === 'apps') && a.closest('.tabbar'))) && a.dataset.nav === 'notes')));
    closeSidebar();
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  const openPage = (id) => go('#page/' + id);
  async function route() {
    const h = location.hash || '#inbox';
    if (h.startsWith('#page/')) return renderPage(h.slice(6));
    destroyEditor(); state.pageId = null;
    if (h.startsWith('#section/')) return renderSection(h.slice(9));
    if (h === '#notes') return renderNotes();
    if (h === '#pdfs') return renderLibrary();
    if (h === '#apps') return renderApps();
    if (h === '#search') return renderSearch();
    if (h === '#settings') return renderSettings();
    return renderInbox();
  }
  addEventListener('hashchange', route);
  const sidebar = $('#sidebar'), scrim = $('#scrim');
  const closeSidebar = () => { sidebar.classList.remove('open'); scrim.classList.remove('open'); };
  $('#btn-menu').addEventListener('click', () => { sidebar.classList.toggle('open'); scrim.classList.toggle('open'); });
  $('#btn-back').addEventListener('click', () => history.back());
  $('#btn-fwd').addEventListener('click', () => history.forward());
  scrim.addEventListener('click', closeSidebar);
  $('#btn-new-notebook').addEventListener('click', async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); state.expanded.add(nb.id); onChanged(); } });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); go('#search'); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); go('#inbox'); setTimeout(() => { const t = $('#capture-text'); if (t) t.focus(); }, 50); }
  });
  addEventListener('pagehide', () => { snapshotIfChanged().catch(() => {}); });

  // ---------- sync status pill ----------
  const pill = $('#syncpill');
  function showStatus(st) {
    pill.dataset.state = st.state;
    const n = st.pending ? ' · ' + st.pending + ' pending' : '';
    const label = st.state === 'ok' ? 'Synced' + n : st.state === 'syncing' ? (st.message && st.message !== 'Syncing with OneDrive' ? st.message : 'Syncing…') : st.state === 'offline' ? 'Offline' + n : st.state === 'signedout' ? 'Not signed in' + n : st.state === 'error' ? 'Sync problem' + n : 'Ready' + n;
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

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
  const state = { view: 'inbox', pageId: null, editor: null, saveTimer: null, expanded: new Set(), query: '', focusNew: false, openedHtml: '', openedPage: null, versionTimer: null, sectionView: {}, nbId: null };
  try { state.nbId = localStorage.getItem('nc-nb') || null; } catch (e) { /* ignore */ }
  const setNotebook = (id) => { if (state.nbId === id) return false; state.nbId = id; state.nbCollapsed = false; try { localStorage.setItem('nc-nb', id || ''); } catch (e) { /* ignore */ } return true; };
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
  // Where the last click/tap happened, so desktop menus open there rather than at the bottom of the screen.
  const lastPoint = { x: 0, y: 0, t: 0 };
  document.addEventListener('pointerdown', (e) => { lastPoint.x = e.clientX; lastPoint.y = e.clientY; lastPoint.t = Date.now(); }, true);
  function sheet(build, opts = {}) {
    return new Promise(async (resolve) => {
      const host = $('#sheet-host'); host.innerHTML = '';
      const close = (v) => { host.hidden = true; host.innerHTML = ''; host.classList.remove('popover', 'centre'); resolve(v); };
      const box = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
      await build(box, close);
      const anchored = !opts.centre && !isNarrow() && Date.now() - lastPoint.t < 1500;
      host.classList.toggle('popover', anchored);
      host.classList.toggle('centre', !!opts.centre && !isNarrow());
      host.append(box); host.hidden = false;
      if (anchored) {
        const margin = 12, w = Math.min(380, innerWidth - 2 * margin);
        box.style.width = w + 'px';
        const h = Math.min(box.offsetHeight, innerHeight - 2 * margin);
        let x = lastPoint.x - 20, y = lastPoint.y + 8;
        if (x + w > innerWidth - margin) x = innerWidth - margin - w;
        if (x < margin) x = margin;
        if (y + h > innerHeight - margin) y = Math.max(margin, lastPoint.y - h - 8);
        box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.maxHeight = (innerHeight - y - margin) + 'px';
      }
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
  // Pages keep a manual order within their section (pinned ones float to the top).
  const orderOf = (q) => q.order != null ? q.order : (q.created || 0);
  const pinnedFirst = (a, b) => (b.pinned || 0) - (a.pinned || 0) || orderOf(a) - orderOf(b) || (a.title || '').localeCompare(b.title || '');
  async function placePage(id, beforeId) {
    const q = await pages.get(id); if (!q || !q.sectionId) return;
    const list = (await pages.forSection(q.sectionId)).sort(pinnedFirst).filter((x) => x.id !== id);
    const at = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
    if (at >= 0) list.splice(at, 0, q); else list.push(q);
    for (const [k, x] of list.entries()) if (x.order !== k + 1) await pages.update(x.id, { order: k + 1 });
    onChanged();
    if (state.view === 'section' && state.sectionId) renderSection(state.sectionId);
    const col = $('.pagecol'); if (col && state.view === 'page') { const nb = await notebooks.get(col.dataset.nb), sec = await sections.get(col.dataset.sec); if (nb && sec) col.replaceWith(await pageColumn(nb, sec, state.pageId)); }
  }
  // Move a page into another section (dropped on a section header, a tab, or a page in that section).
  async function movePageTo(id, sectionId, beforeId) {
    const sec = await sections.get(sectionId); const q = await pages.get(id); if (!sec || !q) return;
    if (q.sectionId !== sectionId) await pages.update(id, { inbox: 0, notebookId: sec.notebookId, sectionId, order: Date.now() });
    if (beforeId) await placePage(id, beforeId); else { onChanged(); if (state.view === 'section' && state.sectionId) renderSection(state.sectionId); }
    toast('Moved to ' + sec.name);
  }
  async function nudgePage(q, dir) {
    const list = (await pages.forSection(q.sectionId)).sort(pinnedFirst);
    const i = list.findIndex((x) => x.id === q.id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    await placePage(q.id, dir < 0 ? list[j].id : (list[j + 1] ? list[j + 1].id : null));
  }
  // HTML5 drag for a row representing page q; drop on another row places before it, drop on the list end appends.
  function dragPage(row, q) {
    if (isNarrow()) return row;
    row.draggable = true;
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/nc-page', q.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-page')) { e.preventDefault(); row.classList.add('dropbefore'); } });
    row.addEventListener('dragleave', () => row.classList.remove('dropbefore'));
    row.addEventListener('drop', async (e) => { e.preventDefault(); row.classList.remove('dropbefore'); const id = e.dataTransfer.getData('text/nc-page'); if (id && id !== q.id) { const src = await pages.get(id); if (!src) return; if (src.sectionId === q.sectionId) await placePage(id, q.id); else await movePageTo(id, q.sectionId, q.id); } });
    return row;
  }
  // Any element standing for a section accepts dropped pages (and, in the tree, sections).
  function sectionDropTarget(target, sectionId) {
    if (isNarrow()) return target;
    target.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-page')) { e.preventDefault(); target.classList.add('dropinto'); } });
    target.addEventListener('dragleave', () => target.classList.remove('dropinto'));
    target.addEventListener('drop', async (e) => { const id = e.dataTransfer.getData('text/nc-page'); if (!id) return; e.preventDefault(); e.stopPropagation(); target.classList.remove('dropinto'); await movePageTo(id, sectionId, null); });
    return target;
  }
  function dropEnd(target, sectionId) {
    if (isNarrow()) return target;
    target.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-page')) { e.preventDefault(); target.classList.add('dropinto'); } });
    target.addEventListener('dragleave', () => target.classList.remove('dropinto'));
    target.addEventListener('drop', async (e) => { e.preventDefault(); target.classList.remove('dropinto'); const id = e.dataTransfer.getData('text/nc-page'); if (id) { const src = await pages.get(id); if (!src) return; if (src.sectionId === sectionId) await placePage(id, null); else await movePageTo(id, sectionId, null); } });
    return target;
  }

  const ICONS = {
    job: '<path d="M12 3v3M8.5 4.5l1 2.5M15.5 4.5l-1 2.5"/><rect x="5" y="8" width="14" height="12" rx="2.5"/><path d="M9 13h6M9 16.5h4"/>',
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
    const reset = () => { open = false; front.style.transform = ''; wrap.classList.remove('open', 'swiping'); };
    const setX = (x) => { front.style.transition = 'none'; front.style.transform = 'translateX(' + x + 'px)'; };
    front.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; dragging = null; fired = false;
      clearTimeout(lp); lp = setTimeout(() => { lp = null; if (dragging === null && onLongPress) { fired = true; if (navigator.vibrate) navigator.vibrate(10); onLongPress(); } }, 480);
    }, { passive: true });
    front.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
      if (dragging === null) { if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { dragging = Math.abs(dx) > Math.abs(dy); clearTimeout(lp); lp = null; if (dragging) wrap.classList.add('swiping'); } else return; }
      if (!dragging) return;
      e.preventDefault();
      const base = open ? -96 : 0;
      setX(Math.max(-140, Math.min(0, base + dx)));
    }, { passive: false });
    front.addEventListener('touchend', () => {
      clearTimeout(lp); lp = null;
      front.style.transition = '';
      if (dragging) { const pos = (open ? -96 : 0) + dx; if (pos < -70) { open = true; front.style.transform = 'translateX(-96px)'; wrap.classList.add('open'); } else reset(); }
      wrap.classList.remove('swiping'); dragging = null;
    });
    front.addEventListener('touchcancel', () => { clearTimeout(lp); lp = null; front.style.transition = ''; dragging = null; });
    front.addEventListener('click', (e) => { if (fired || open) { e.preventDefault(); e.stopPropagation(); fired = false; reset(); } }, true);
    front.addEventListener('contextmenu', (e) => { if (onLongPress) { e.preventDefault(); onLongPress(); } });
    return wrap;
  }

  function onChanged() { if (typeof PANE === 'undefined' || !PANE) S.schedule(); refreshTree(); refreshInboxCount(); if (typeof announce === 'function') announce('changed'); }

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
  // Straighten a photographed page: show the photo with four corner handles (guessed automatically), then warp.
  async function straighten(file) {
    if (!window.NCScan) return null;
    let bmp; try { bmp = await createImageBitmap(file); } catch (e) { return null; }
    const guess = NCScan.detectCorners(bmp) || [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];
    const corners = guess.map((c) => c.slice());
    return sheet((box, close) => {
      const stage = el('div', { class: 'scanstage' });
      const cv = el('canvas', { class: 'scanpreview' });
      const maxW = Math.min(innerWidth - 48, 680), maxH = Math.max(240, innerHeight * 0.62);
      const sc = Math.min(maxW / bmp.width, maxH / bmp.height);
      cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const svg = el('svg', { class: 'scanlines' }); svg.setAttribute('viewBox', '0 0 ' + cv.width + ' ' + cv.height);
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon'); svg.append(poly);
      const handles = corners.map((c, i) => el('div', { class: 'scanhandle', 'data-i': String(i) }));
      stage.style.width = cv.width + 'px'; stage.style.height = cv.height + 'px';
      stage.append(cv, svg, ...handles);
      const place = () => { poly.setAttribute('points', corners.map(([x, y]) => (x * cv.width) + ',' + (y * cv.height)).join(' ')); handles.forEach((h, i) => { h.style.left = (corners[i][0] * cv.width) + 'px'; h.style.top = (corners[i][1] * cv.height) + 'px'; }); };
      place();
      let drag = null;
      const at = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))]; };
      for (const h of handles) {
        h.addEventListener('pointerdown', (e) => { e.preventDefault(); drag = +h.dataset.i; h.setPointerCapture(e.pointerId); h.classList.add('on'); });
        h.addEventListener('pointermove', (e) => { if (drag === null) return; e.preventDefault(); corners[drag] = at(e); place(); });
        const up = () => { drag = null; h.classList.remove('on'); };
        h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      }
      box.append(el('h2', {}, 'Straighten'), el('p', { class: 'rule' }, 'Drag the corners onto the page edges.'), stage,
        el('div', { class: 'actions' },
          el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Keep as taken'),
          el('button', { class: 'btn', type: 'button', onclick: () => { [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((c, i) => corners[i] = c); place(); } }, 'Whole photo'),
          el('button', { class: 'btn primary', type: 'button', onclick: async () => {
            try {
              const out = NCScan.warp(bmp, corners, 2000);
              const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
              close(new File([blob], (file.name || 'scan').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
            } catch (e) { toast('Could not straighten: ' + e.message); close(null); }
          } }, 'Straighten')));
    }, { centre: true });
  }
  async function storeAsset(file, name) {
    const blob = file.type && file.type.startsWith('image/') ? await downscale(file) : file;
    return assets.create(blob, name || file.name || 'file');
  }
  const assetUrl = (id) => 'asset/' + id;
  async function inlineAssets(html) {
    const ids = [...new Set([...html.matchAll(/src="[^"]*asset\/([^"?#]+)"/g)].map((m) => m[1]))];
    const map = {};
    for (const id of ids) { const a = await NCDB.db.assets.get(id); if (a && a.blob) map[id] = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(a.blob); }); }
    return html.replace(/src="[^"]*asset\/([^"?#]+)"/g, (m, id) => map[id] ? 'src="' + map[id] + '"' : m);
  }
  async function localiseImages(ed, onDone) {
    const own = new URL('asset/', C.redirectUri).href;
    let changed = false;
    for (const img of ed.dom.select('img')) {
      const src = img.getAttribute('src') || '';
      if (!/^https?:/i.test(src) || src.startsWith(own)) continue;
      try {
        const res = await fetch(src, { mode: 'cors' }); if (!res.ok) continue;
        const blob = await res.blob(); if (!blob.type.startsWith('image/')) continue;
        const a = await storeAsset(blob, (src.split('/').pop().split('?')[0] || 'image').slice(0, 60));
        ed.dom.setAttrib(img, 'src', assetUrl(a.id)); changed = true;
      } catch (e) { /* cross-origin refusal: keep the remote link */ }
    }
    if (changed) { ed.undoManager.add(); onDone && onDone(); }
  }

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
    if (isPdf) window.NCPDF.enrich(p.id, a.id).then(() => { refreshTree(); });
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
    const scanBtn = el('button', { class: 'btn', type: 'button', title: 'Scan a page', 'aria-label': 'Scan', onclick: () => $('#file-scan').click() }, icon('scan'), el('span', {}, 'Scan'));
    const recBtn = el('button', { class: 'btn', type: 'button', title: 'Record a voice note', 'aria-label': 'Record', onclick: () => toggleRecording(recBtn) }, icon('mic'), el('span', {}, 'Record'));
    const fileBtn = el('button', { class: 'btn', type: 'button', title: 'Add a file or photo', 'aria-label': 'File', onclick: () => $('#file-any').click() }, icon('file'), el('span', {}, 'File'));
    const jobBtn = el('button', { class: 'btn jobbtn', type: 'button', title: 'Shift Companion: add a job', onclick: () => { if (window.NCShift) NCShift.quickSheet({ toast, sheet, confirm, pickSection, createPage: async (f) => { const np = await pages.create(f); onChanged(); return np; } }, () => {}); } }, icon('job'), el('span', {}, 'Job'));
    const composer = el('div', { class: 'composer' }, ta, el('div', { class: 'bar' }, fileBtn, scanBtn, recBtn, jobBtn, el('span', { class: 'spacer' }), saveBtn));
    composer.addEventListener('dragover', (e) => { e.preventDefault(); });
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const f of [...e.dataTransfer.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
      renderInbox();
    });
    const cur = (await allNotebooks()).find((n) => n.current);
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Inbox')), composer);
    state.suggestIndex = await buildSuggestIndex();
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
      (!PANE && !isNarrow()) ? { label: 'Open in split view', fn: () => openSplit('#page/' + p.id) } : null,
      p.inbox ? { label: 'File to…', fn: async () => { if (await fileInto(p.id)) after && after(); } } : { label: 'Move to…', fn: async () => { const t = await pickSection('Move page to'); if (t) { await pages.update(p.id, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId, order: Date.now() }); onChanged(); after && after(); } } },
      { label: p.pinned ? 'Unpin' : 'Pin', fn: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); after && after(); } },
      p.sectionId ? { label: 'Move up', fn: async () => { await nudgePage(p, -1); after && after(); } } : null,
      p.sectionId ? { label: 'Move down', fn: async () => { await nudgePage(p, 1); after && after(); } } : null,
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
    for (const f of [...e.target.files]) { try { const flat = await straighten(f); await captureImage(await scanify(flat || f), 'scan'); } catch (err) { await captureImage(f, 'scan'); } }
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('Scan added to inbox');
  });
  $('#file-any').addEventListener('change', async (e) => {
    for (const f of [...e.target.files]) await (f.type.startsWith('image/') ? captureImage(f) : captureFile(f));
    e.target.value = ''; if (state.view === 'inbox') renderInbox(); toast('File added to inbox');
  });

  // ---------- section picker / filing ----------
  const allNotebooks = async () => (await notebooks.all()).sort((a, b) => (b.current || 0) - (a.current || 0) || (a.order || 0) - (b.order || 0));
  async function pickSection(title, opts = {}) {
    const nbs = await sortedNotebooks();
    const recent = (await meta.get('recentTargets', [])) || [];
    const all = [];
    for (const nb of nbs) for (const sec of await sections.forNotebook(nb.id)) all.push({ nb, sec, label: (sec.group ? sec.group + ' › ' : '') + sec.name, key: (nb.name + ' ' + (sec.group || '') + ' ' + sec.name).toLowerCase() });
    const choose = async (nb, sec) => {
      await meta.set('recentTargets', [sec.id, ...recent.filter((x) => x !== sec.id)].slice(0, 6));
      return { notebookId: nb.id, sectionId: sec.id };
    };
    return sheet(async (box, close) => {
      const filter = el('input', { type: 'search', placeholder: 'Type to filter…', autocomplete: 'off' });
      const list = el('div', { class: 'list pick' });
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        list.innerHTML = '';
        const rows = all.filter((x) => !q || x.key.includes(q));
        if (!q) {
          const rec = recent.map((id) => all.find((x) => x.sec.id === id)).filter(Boolean);
          if (rec.length) { list.append(el('div', { class: 'group' }, 'Recent')); for (const x of rec) list.append(el('button', { type: 'button', onclick: async () => close(await choose(x.nb, x.sec)) }, el('span', {}, x.label), el('span', { class: 'sub' }, x.nb.name))); }
        }
        let lastNb = null;
        for (const x of rows) {
          if (x.nb !== lastNb) { lastNb = x.nb; list.append(el('div', { class: 'group' }, x.nb.name + (x.nb.current ? ' · current' : ''))); }
          list.append(el('button', { type: 'button', onclick: async () => close(await choose(x.nb, x.sec)) }, x.label));
        }
        if (!q) {
          list.append(el('div', { class: 'group' }, ''));
          for (const nb of nbs) list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => { const name = await ask('New section in ' + nb.name, 'Section name'); if (!name) return; const sec = await sections.create(nb.id, name); onChanged(); close(await choose(nb, sec)); } }, '+ New section in ' + nb.name));
          list.append(el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => { const name = await ask('New notebook', 'Notebook name'); if (!name) return; const nb = await notebooks.create(name); const sec = await sections.create(nb.id, 'General'); onChanged(); close(await choose(nb, sec)); } }, '+ New notebook'));
        } else if (!rows.length) list.append(el('p', { class: 'sub' }, 'No section matches.'));
      };
      filter.addEventListener('input', draw);
      filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = list.querySelector('button'); if (b) b.click(); } if (e.key === 'Escape') close(undefined); });
      draw();
      box.append(el('h2', {}, title || 'File to section'), filter, list, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
    }, { centre: true });
  }
  async function fileInto(pageId) {
    const target = await pickSection(); if (!target) return false;
    await pages.update(pageId, { inbox: 0, notebookId: target.notebookId, sectionId: target.sectionId, order: Date.now() });
    onChanged(); toast('Filed'); return true;
  }

  // ---------- notebook tree ----------
  const chevron = (open) => el('span', { class: 'chev' + (open ? ' open' : ''), html: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
  const toggle = (id) => { state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); refreshTree(); };
  const nbColour = (nb, i) => nb.color || NB_COLOURS[(i == null ? 0 : i) % NB_COLOURS.length];
  // Notebooks in display order: the current rotation is pinned to the top, the rest by their manual order.
  async function sortedNotebooks() { return (await notebooks.all()).sort((a, b) => (b.current || 0) - (a.current || 0) || (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)); }
  async function moveNotebook(nb, dir) {
    const list = (await sortedNotebooks()).filter((x) => !x.current || x.id === nb.id);
    for (const [i, x] of list.entries()) if (x.order !== i + 1) await notebooks.update(x.id, { order: i + 1 });
    const i = list.findIndex((x) => x.id === nb.id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    await notebooks.update(list[i].id, { order: j + 1 }); await notebooks.update(list[j].id, { order: i + 1 });
    onChanged();
  }
  async function currentNotebook(nbs) {
    nbs = nbs || await sortedNotebooks();
    const nb = nbs.find((n) => n.id === state.nbId) || nbs.find((n) => n.current) || nbs[0] || null;
    if (nb) setNotebook(nb.id);
    return nb;
  }
  const groupsOf = (secs) => { const groups = []; const seen = new Map(); for (const s of secs) { const g = s.group || ''; if (!seen.has(g)) { seen.set(g, { name: g, secs: [] }); groups.push(seen.get(g)); } seen.get(g).secs.push(s); } return groups; };
  // Sections are kept in a dense 1..n order per notebook; imports and drags call this.
  async function renumber(nbId) {
    const secs = await sections.forNotebook(nbId);
    for (const [i, sc] of secs.entries()) if (sc.order !== i + 1) await sections.update(sc.id, { order: i + 1 });
  }
  async function moveSection(s, dir) {
    await renumber(s.notebookId);
    const secs = await sections.forNotebook(s.notebookId);
    const i = secs.findIndex((x) => x.id === s.id), j = i + dir;
    if (i < 0 || j < 0 || j >= secs.length) return;
    await sections.update(secs[i].id, { order: secs[j].order }); await sections.update(secs[j].id, { order: secs[i].order });
    onChanged();
  }
  // Drop section `id` just before `beforeId` (or at the end of the group when beforeId is null), adopting that group.
  async function placeSection(id, beforeId, group) {
    const s = await sections.get(id); if (!s) return;
    const secs = (await sections.forNotebook(s.notebookId)).filter((x) => x.id !== id);
    const at = beforeId ? secs.findIndex((x) => x.id === beforeId) : -1;
    if (at >= 0) secs.splice(at, 0, s); else { let last = -1; secs.forEach((x, k) => { if ((x.group || '') === (group || '')) last = k; }); secs.splice(last + 1, 0, s); }
    for (const [k, x] of secs.entries()) await sections.update(x.id, Object.assign({ order: k + 1 }, x.id === id ? { group: group || '' } : {}));
    onChanged();
  }
  function dragSection(secEl, s, nb) {
    const head = secEl.firstChild;
    head.draggable = true;
    head.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/nc-section', s.id); e.dataTransfer.effectAllowed = 'move'; secEl.classList.add('dragging'); });
    head.addEventListener('dragend', () => secEl.classList.remove('dragging'));
    head.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-section')) { e.preventDefault(); secEl.classList.add('dropbefore'); } });
    head.addEventListener('dragleave', () => secEl.classList.remove('dropbefore'));
    head.addEventListener('drop', async (e) => { e.preventDefault(); secEl.classList.remove('dropbefore'); const id = e.dataTransfer.getData('text/nc-section'); if (id && id !== s.id) await placeSection(id, s.id, s.group || ''); });
  }
  async function buildTree() {
    const wrap = el('div', { class: 'tree' });
    const nbs = await sortedNotebooks();
    const cur = await currentNotebook(nbs);
    if (!cur) { wrap.append(el('div', { class: 'empty' }, 'No notebooks yet. Create one below, or file a capture.')); return wrap; }
    const livePages = await pages.live();
    const pagesBySec = new Map();
    for (const q of livePages) if (q.sectionId) pagesBySec.set(q.sectionId, (pagesBySec.get(q.sectionId) || 0) + 1);
    for (const [i, nb] of nbs.entries()) {
    const colour = nbColour(nb, i);
    const selected = nb.id === cur.id;
    const open = selected && !state.nbCollapsed;
    const secs = await sections.forNotebook(nb.id);
    const nPages = secs.reduce((n, sc) => n + (pagesBySec.get(sc.id) || 0), 0);
    const nbEl = el('div', { class: 'nb' + (selected ? ' selected' : '') + (open ? ' open' : ''), style: '--nb: ' + colour });
    // Notebook header: click a closed notebook to select it; click the selected one to fold or unfold it.
    const pick = () => { if (selected) { state.nbCollapsed = !state.nbCollapsed; } else { setNotebook(nb.id); state.nbCollapsed = false; } refreshTree(); };
    const head = el('div', { class: 'nb-head', role: 'button', tabindex: '0', title: selected ? (open ? 'Collapse' : 'Expand') : 'Open ' + nb.name, onclick: pick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
      el('span', { class: 'spine' }), selected ? chevron(open) : null,
      el('span', { class: 'nb-text' }, el('span', { class: 'nb-name' }, nb.name), el('span', { class: 'nb-sub' }, nb.current ? el('span', { class: 'badge-current' }, 'current') : null, el('span', { class: 'nb-meta' }, secs.length + (secs.length === 1 ? ' section' : ' sections') + ' · ' + nPages + (nPages === 1 ? ' page' : ' pages')))),
      el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: (e) => { e.stopPropagation(); notebookMenu(nb); } }));
    nbEl.append(head);
    if (!open) { wrap.append(nbEl); continue; }
    const body = el('div', { class: 'nb-body' });
    const renderSec = (sc, inGroup) => {
      const sopen = state.expanded.has(sc.id);
      const count = pagesBySec.get(sc.id) || 0;
      const secEl = el('div', { class: 'sec' + (sopen ? ' open' : '') + (inGroup ? ' grouped' : '') + (state.view === 'section' && state.sectionId === sc.id ? ' here' : '') });
      secEl.append(el('div', { class: 'sec-head' },
        el('button', { class: 'sec-toggle', type: 'button', 'aria-label': 'Expand', onclick: () => toggle(sc.id) }, chevron(sopen)),
        el('button', { class: 'sec-name', type: 'button', title: sc.name, onclick: () => go('#section/' + sc.id) }, sc.name),
        el('span', { class: 'sec-count' }, count ? String(count) : ''),
        el('button', { class: 'more', type: 'button', 'aria-label': 'Section options', onclick: (e) => { e.stopPropagation(); sectionMenu(nb, sc); } })));
      if (!isNarrow()) { dragSection(secEl, sc, nb); sectionDropTarget(secEl.firstChild, sc.id); }
      if (sopen) {
        const pgs = livePages.filter((q) => q.sectionId === sc.id).sort(pinnedFirst);
        const pl = el('div', { class: 'pages' });
        for (const q of pgs) pl.append(gestures(dragPage(el('button', { class: 'page-row' + (q.id === state.pageId ? ' active' : '') + (q.pinned ? ' pinned' : ''), type: 'button', title: q.title || 'Untitled', onclick: () => openPage(q.id) }, q.kind === 'pdf' ? el('span', { class: 'page-pdf' }, 'PDF') : el('span', { class: 'page-dot' }), el('span', { class: 'page-title' }, q.title || 'Untitled')), q),
          { onDelete: async () => { if (await confirm('Delete "' + (q.title || 'Untitled') + '"?')) { if (state.pageId === q.id) destroyEditor(); await pages.remove(q.id); onChanged(); if (state.pageId === q.id) go('#notes'); } }, onLongPress: () => pageQuickMenu(q) }));
        pl.append(dropEnd(el('button', { class: 'addrow', type: 'button', onclick: () => newPage(nb.id, sc.id) }, '+ New page'), sc.id));
        secEl.append(pl);
      }
      return secEl;
    };
    for (const g of groupsOf(secs)) {
      if (!g.name) { for (const sc of g.secs) body.append(renderSec(sc, false)); continue; }
      const gid = 'g:' + nb.id + ':' + g.name;
      const gopen = state.expanded.has(gid) || g.secs.some((sc) => sc.id === state.sectionId);
      const gEl = el('div', { class: 'secgroup' + (gopen ? ' open' : '') });
      const gcount = g.secs.reduce((n, sc) => n + (pagesBySec.get(sc.id) || 0), 0);
      const ghead = el('div', { class: 'group-head', role: 'button', tabindex: '0', onclick: () => toggle(gid), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(gid); } } },
        chevron(gopen), el('span', { class: 'group-ico', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>' }),
        el('span', { class: 'group-name', title: g.name }, g.name), el('span', { class: 'sec-count' }, g.secs.length + ' · ' + gcount),
        el('button', { class: 'more', type: 'button', 'aria-label': 'Group options', onclick: (e) => { e.stopPropagation(); groupMenu(nb, g.name, g.secs); } }));
      // Dropping a section on a group header files it at the end of that group.
      ghead.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-section')) { e.preventDefault(); gEl.classList.add('dropinto'); } });
      ghead.addEventListener('dragleave', () => gEl.classList.remove('dropinto'));
      ghead.addEventListener('drop', async (e) => { e.preventDefault(); gEl.classList.remove('dropinto'); const id = e.dataTransfer.getData('text/nc-section'); if (id) { state.expanded.add(gid); await placeSection(id, null, g.name); } });
      gEl.append(ghead);
      if (gopen) { const inner = el('div', { class: 'group-body' }); for (const sc of g.secs) inner.append(renderSec(sc, true)); inner.append(el('button', { class: 'addrow', type: 'button', onclick: async () => { const n = await ask('New section in ' + g.name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); await sections.update(sc.id, { group: g.name }); state.expanded.add(gid); state.expanded.add(sc.id); onChanged(); } } }, '+ New section here')); gEl.append(inner); }
      body.append(gEl);
    }
    const addsec = el('button', { class: 'addrow addsec', type: 'button', onclick: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); state.expanded.add(sc.id); onChanged(); } } }, '+ New section');
    addsec.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/nc-section')) { e.preventDefault(); addsec.classList.add('dropinto'); } });
    addsec.addEventListener('dragleave', () => addsec.classList.remove('dropinto'));
    addsec.addEventListener('drop', async (e) => { e.preventDefault(); addsec.classList.remove('dropinto'); const id = e.dataTransfer.getData('text/nc-section'); if (id) await placeSection(id, null, ''); });
    body.append(addsec);
    nbEl.append(body);
    wrap.append(nbEl);
    }
    const archived = await notebooks.archived();
    if (archived.length) wrap.append(el('button', { class: 'addrow archived-link', type: 'button', onclick: () => go('#notes') }, archived.length + ' archived'));
    return wrap;
  }
  async function notebookPicker(current) {
    const nbs = await notebooks.all(); const archived = await notebooks.archived();
    menu('Notebooks', [
      ...nbs.map((n, i) => ({ label: (n.id === current.id ? '● ' : '○ ') + n.name + (n.current ? ' · current rotation' : ''), fn: () => { setNotebook(n.id); go('#nb/' + n.id); } })),
      { label: '+ New notebook', accent: true, fn: async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); setNotebook(nb.id); onChanged(); go('#nb/' + nb.id); } } },
      archived.length ? { label: 'Archived (' + archived.length + ')', fn: () => go('#notes') } : null,
      { label: 'All notebooks', fn: () => go('#notes') }
    ]);
  }
  let treeTimer = null;
  const refreshTreeSoon = () => { clearTimeout(treeTimer); treeTimer = setTimeout(refreshTree, 30); };
  async function refreshTree() {
    const tree = await buildTree();
    $('#tree').replaceChildren(...tree.children);
    if (state.view === 'notes') renderNotes();
    const tabs = $('.sectabs'); if (tabs && tabs.dataset.nb) { const fresh = await sectionTabs(await notebooks.get(tabs.dataset.nb), tabs.dataset.sec || null); if (fresh) tabs.replaceWith(fresh); }
  }
  async function refreshInboxCount() {
    const n = (await pages.inbox()).length; $('#inbox-count').textContent = n ? String(n) : '';
  }
  function notebookMenu(nb) {
    menu(nb.name, [
      { label: 'Open notebook home', fn: () => go('#nb/' + nb.id) },
      { label: 'Rename', fn: async () => { const n = await ask('Rename notebook', '', nb.name, 'Rename'); if (n && n !== nb.name) { await notebooks.update(nb.id, { name: n }); onChanged(); } } },
      nb.current ? null : { label: 'Move up', fn: () => moveNotebook(nb, -1) },
      nb.current ? null : { label: 'Move down', fn: () => moveNotebook(nb, 1) },
      { label: 'Add section', fn: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const s = await sections.create(nb.id, n); state.expanded.add(nb.id); state.expanded.add(s.id); onChanged(); } } },
      { label: 'Add section group', fn: async () => { const g = await ask('New section group', 'Group name'); if (!g) return; const n = await ask('First section in ' + g, 'Section name', 'General'); if (n) { const s = await sections.create(nb.id, n); await sections.update(s.id, { group: g }); state.expanded.add(nb.id); state.expanded.add('g:' + nb.id + ':' + g); onChanged(); } } },
      { label: nb.current ? 'Unset as current rotation' : 'Set as current rotation', fn: async () => {
        for (const o of await notebooks.all()) if (o.current && o.id !== nb.id) await notebooks.update(o.id, { current: 0 });
        await notebooks.update(nb.id, { current: nb.current ? 0 : 1 }); onChanged(); toast(nb.current ? 'Cleared' : nb.name + ' is the current rotation');
      } },
      { label: nb.archived ? 'Unarchive' : 'Archive notebook', fn: async () => { await notebooks.update(nb.id, { archived: nb.archived ? 0 : 1, current: 0 }); state.expanded.delete(nb.id); onChanged(); toast(nb.archived ? 'Restored' : 'Archived'); } },
      { label: 'Delete notebook', danger: true, fn: async () => { if (await confirm('Delete notebook "' + nb.name + '"?', 'All its sections and pages go to the bin too.')) { await notebooks.remove(nb.id); if (state.nbId === nb.id) setNotebook(null); onChanged(); if (state.view === 'page' || state.view === 'section' || state.view === 'notebook') go('#notes'); } } }
    ]);
  }
  async function pickGroup(nb, current) {
    const secs = await sections.forNotebook(nb.id);
    const groups = [...new Set(secs.map((x) => x.group).filter(Boolean))].sort();
    return new Promise((resolve) => menu('Section group', [
      ...groups.filter((g) => g !== current).map((g) => ({ label: g, fn: () => resolve(g) })),
      { label: 'New group…', accent: true, fn: async () => { const n = await ask('New section group', 'Group name'); resolve(n || undefined); } },
      current ? { label: 'Remove from group', danger: true, fn: () => resolve('') } : null
    ]).then(() => setTimeout(() => resolve(undefined), 0)));
  }
  function groupMenu(nb, name, secs) {
    menu(nb.name + ' › ' + name, [
      { label: 'New section in this group', fn: async () => { const n = await ask('New section in ' + name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); await sections.update(sc.id, { group: name }); state.expanded.add('g:' + nb.id + ':' + name); state.expanded.add(sc.id); onChanged(); } } },
      { label: 'Rename group', fn: async () => { const n = await ask('Rename group', '', name, 'Rename'); if (n && n !== name) { for (const sc of secs) await sections.update(sc.id, { group: n }); state.expanded.add('g:' + nb.id + ':' + n); onChanged(); } } },
      { label: 'Ungroup (sections stay)', danger: true, fn: async () => { if (await confirm('Ungroup "' + name + '"?', 'The sections stay in the notebook, just not grouped.', 'Ungroup')) { for (const sc of secs) await sections.update(sc.id, { group: '' }); onChanged(); } } }
    ]);
  }
  function sectionMenu(nb, s) {
    menu(nb.name + ' › ' + (s.group ? s.group + ' › ' : '') + s.name, [
      { label: 'Open section', fn: () => go('#section/' + s.id) },
      { label: s.group ? 'Move to group… (now in ' + s.group + ')' : 'Move to group…', fn: async () => { const g = await pickGroup(nb, s.group || ''); if (g === undefined) return; await sections.update(s.id, { group: g }); if (g) state.expanded.add('g:' + nb.id + ':' + g); onChanged(); } },
      { label: 'New page', fn: () => newPage(nb.id, s.id) },
      { label: 'Select pages to move or delete…', fn: () => { const sv = state.sectionView[s.id] || (state.sectionView[s.id] = { sort: 'manual', dir: 1, q: '' }); sv.select = true; sv.picked = new Set(); go('#section/' + s.id); if (state.view === 'section' && state.sectionId === s.id) renderSection(s.id); } },
      { label: 'Move up', fn: () => moveSection(s, -1) },
      { label: 'Move down', fn: () => moveSection(s, 1) },
      { label: 'Move to another notebook…', fn: async () => {
        const nbs = (await sortedNotebooks()).filter((x) => x.id !== nb.id); if (!nbs.length) { toast('No other notebook yet'); return; }
        menu('Move "' + s.name + '" to', nbs.map((x) => ({ label: x.name, fn: async () => { await sections.update(s.id, { notebookId: x.id, group: '', order: Date.now() }); for (const q of await pages.forSection(s.id)) await pages.update(q.id, { notebookId: x.id }); onChanged(); toast('Moved to ' + x.name); } })));
      } },
      { label: s.view === 'table' ? 'Show as list' : 'Show as table (database view)', fn: async () => { await sections.update(s.id, { view: s.view === 'table' ? 'list' : 'table' }); onChanged(); if (state.view === 'section') renderSection(s.id); } },
      { label: 'Rename', fn: async () => { const n = await ask('Rename section', '', s.name, 'Rename'); if (n && n !== s.name) { await sections.update(s.id, { name: n }); onChanged(); } } },
      { label: 'Delete section', danger: true, fn: async () => { if (await confirm('Delete section "' + s.name + '"?', 'Its pages go to the bin too.')) { await sections.remove(s.id); onChanged(); if (state.view === 'page' || state.view === 'section') go('#inbox'); } } }
    ]);
  }
  async function renderNotes() {
    state.view = 'notes';
    const view = el('div', { class: 'view' });
    const nbs = await sortedNotebooks(); const archived = await notebooks.archived();
    const allSecs = await window.NCDB.db.sections.where('deleted').equals(0).toArray();
    const livePages = await pages.live();
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Notebooks'), el('div', { class: 'toolrow' },
      el('a', { class: 'btn small', href: '#apps' }, 'Apps'),
      el('button', { class: 'btn small primary', type: 'button', onclick: async () => { const n = await ask('New notebook', 'Notebook name'); if (n) { const nb = await notebooks.create(n); await sections.create(nb.id, 'General'); setNotebook(nb.id); onChanged(); go('#nb/' + nb.id); } } }, '+ Notebook'))));
    const grid = el('div', { class: 'nbgrid' });
    for (const [i, nb] of nbs.entries()) {
      const secs = allSecs.filter((x) => x.notebookId === nb.id);
      const n = livePages.filter((q) => q.notebookId === nb.id).length;
      grid.append(el('a', { class: 'nbcard' + (nb.id === state.nbId ? ' here' : ''), href: '#nb/' + nb.id, style: '--nb: ' + nbColour(nb, i) },
        el('span', { class: 'spine' }), el('span', { class: 'nbcard-body' }, el('span', { class: 'nbcard-name' }, nb.name), el('span', { class: 'nbcard-meta' }, secs.length + ' section' + (secs.length === 1 ? '' : 's') + ' · ' + n + ' page' + (n === 1 ? '' : 's') + (nb.current ? ' · current rotation' : ''))),
        el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: (e) => { e.preventDefault(); e.stopPropagation(); notebookMenu(nb); } })));
    }
    view.append(grid);
    if (archived.length) {
      view.append(el('h2', { style: 'font-size:1.05rem' }, 'Archived'));
      const al = el('div', { class: 'pagelist' });
      for (const nb of archived) al.append(el('a', { href: '#nb/' + nb.id }, el('span', {}, nb.name), el('button', { class: 'more', type: 'button', 'aria-label': 'Notebook options', onclick: (e) => { e.preventDefault(); e.stopPropagation(); notebookMenu(nb); } })));
      view.append(al);
    }
    const recent = (await pages.recent(12)).filter((q) => q.kind !== 'app').slice(0, 8);
    if (recent.length) {
      view.append(el('h2', { style: 'font-size:1.05rem' }, 'Recent'));
      const pl = el('div', { class: 'pagelist' });
      for (const q of recent) pl.append(el('a', { href: '#page/' + q.id }, el('span', {}, q.title || 'Untitled'), el('span', { class: 'when' }, fmtWhen(q.updated))));
      view.append(pl);
    }
    content.replaceChildren(view); syncNav();
  }
  // OneNote-style section tabs for one notebook. Groups are tabs that open a second row.
  async function sectionTabs(nb, activeSecId) {
    if (!nb) return null;
    const secs = await sections.forNotebook(nb.id);
    const groups = groupsOf(secs);
    const active = secs.find((x) => x.id === activeSecId) || null;
    const openGroup = active && active.group ? active.group : (state.openGroup && state.openGroup.nb === nb.id ? state.openGroup.name : null);
    const strip = el('div', { class: 'sectabs', 'data-nb': nb.id, 'data-sec': activeSecId || '' });
    const row1 = el('div', { class: 'tabrow' });
    let ci = 0;
    const tabFor = (sc, i) => sectionDropTarget(el('a', { class: 'stab' + (active && active.id === sc.id ? ' active' : ''), href: '#section/' + sc.id, style: '--tab: ' + NB_COLOURS[i % NB_COLOURS.length], title: sc.name }, sc.name), sc.id);
    for (const g of groups) {
      if (!g.name) { for (const sc of g.secs) row1.append(tabFor(sc, ci++)); continue; }
      const open = openGroup === g.name;
      row1.append(el('button', { class: 'stab group' + (open ? ' active' : ''), type: 'button', style: '--tab: ' + NB_COLOURS[ci++ % NB_COLOURS.length], title: g.name,
        onclick: () => { if (open && !(active && active.group === g.name)) { state.openGroup = null; } else { state.openGroup = { nb: nb.id, name: g.name }; } if (!open && g.secs[0] && !(active && active.group === g.name)) { go('#section/' + g.secs[0].id); return; } refreshTree(); } },
        el('span', { class: 'group-ico', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>' }), g.name));
    }
    row1.append(el('button', { class: 'stab add', type: 'button', title: 'New section', onclick: async () => { const n = await ask('New section in ' + nb.name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); onChanged(); go('#section/' + sc.id); } } }, '+'));
    strip.append(row1);
    const g = openGroup && groups.find((x) => x.name === openGroup);
    if (g) {
      const row2 = el('div', { class: 'tabrow sub' });
      let gi = 0;
      for (const sc of g.secs) row2.append(tabFor(sc, gi++));
      row2.append(el('button', { class: 'stab add', type: 'button', title: 'New section in ' + g.name, onclick: async () => { const n = await ask('New section in ' + g.name, 'Section name'); if (n) { const sc = await sections.create(nb.id, n); await sections.update(sc.id, { group: g.name }); onChanged(); go('#section/' + sc.id); } } }, '+'));
      strip.append(row2);
    }
    setTimeout(() => { const a = strip.querySelector('.stab.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0);
    return strip;
  }
  async function renderNotebook(id) {
    const nb = await notebooks.get(id);
    if (!nb || nb.deleted) { content.replaceChildren(el('div', { class: 'view' }, el('h1', {}, 'Notebook not found'))); return; }
    state.view = 'notebook'; state.sectionId = null;
    setNotebook(nb.id); refreshTreeSoon();
    const view = el('div', { class: 'view' });
    view.append(await sectionTabs(nb, null));
    view.append(el('div', { class: 'view-head' }, el('h1', {}, nb.name), el('div', { class: 'toolrow' },
      el('button', { class: 'btn small', type: 'button', onclick: () => notebookMenu(nb) }, 'Options'))));
    const secs = await sections.forNotebook(nb.id);
    const livePages = (await pages.live()).filter((q) => q.notebookId === nb.id);
    const grid = el('div', { class: 'secgrid' });
    let ci = 0;
    for (const g of groupsOf(secs)) {
      if (g.name) grid.append(el('h2', { class: 'secgrid-group' }, g.name));
      for (const sc of g.secs) { const n = livePages.filter((q) => q.sectionId === sc.id).length; grid.append(el('a', { class: 'seccard', href: '#section/' + sc.id, style: '--tab: ' + NB_COLOURS[ci++ % NB_COLOURS.length] }, el('span', { class: 'seccard-name' }, sc.name), el('span', { class: 'seccard-meta' }, n + ' page' + (n === 1 ? '' : 's')))); }
    }
    if (!secs.length) grid.append(el('p', { class: 'sub' }, 'No sections yet — use + on the tab strip.'));
    view.append(grid);
    const recent = livePages.filter((q) => q.kind !== 'app').sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 8);
    if (recent.length) {
      view.append(el('h2', { style: 'font-size:1.05rem' }, 'Recent in ' + nb.name));
      const pl = el('div', { class: 'pagelist' });
      for (const q of recent) pl.append(el('a', { href: '#page/' + q.id }, el('span', {}, q.title || 'Untitled'), el('span', { class: 'when' }, fmtWhen(q.updated))));
      view.append(pl);
    }
    content.replaceChildren(view); syncNav();
  }

  // ---------- section view (list or database table) ----------
  async function renderSection(id) {
    const s = await sections.get(id);
    if (!s || s.deleted) { content.replaceChildren(el('div', { class: 'view' }, el('h1', {}, 'Section not found'))); return; }
    state.view = 'section'; state.sectionId = id;
    const nb = await notebooks.get(s.notebookId);
    if (nb) setNotebook(nb.id); refreshTreeSoon();
    const sv = state.sectionView[id] || (state.sectionView[id] = { sort: 'manual', dir: 1, q: '' });
    const pgs = (await pages.forSection(id));
    const view = el('div', { class: 'view' });
    view.append(await sectionTabs(nb, id));
    view.append(el('div', { class: 'crumbs' }, el('a', { href: nb ? '#nb/' + nb.id : '#notes' }, nb ? nb.name : '—'), '›', ...(s.group ? [s.group, '›'] : []), s.name, el('span', { class: 'spacer' }), el('button', { class: 'more-page', type: 'button', 'aria-label': 'Section options', onclick: () => sectionMenu(nb, s) }, '···')));
    const head = el('div', { class: 'view-head' }, el('h1', {}, s.name), el('div', { class: 'toolrow' },
      el('div', { class: 'seg' }, el('button', { type: 'button', class: s.view !== 'table' ? 'on' : '', onclick: async () => { await sections.update(id, { view: 'list' }); onChanged(); renderSection(id); } }, 'List'), el('button', { type: 'button', class: s.view === 'table' ? 'on' : '', onclick: async () => { await sections.update(id, { view: 'table' }); onChanged(); renderSection(id); } }, 'Table')),
      el('button', { class: 'btn small', type: 'button', onclick: () => { sv.select = !sv.select; sv.picked = new Set(); renderSection(id); } }, sv.select ? 'Done' : 'Select'),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => newPage(nb.id, id) }, '+ Page')));
    view.append(head);
    const bulk = el('div', { class: 'bulkbar', hidden: '' });
    const syncBulk = () => {
      const n = sv.picked ? sv.picked.size : 0;
      bulk.hidden = !sv.select;
      bulk.replaceChildren(el('span', {}, n + ' selected'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { sv.picked = new Set(pgs.map((x) => x.id)); draw(); } }, 'All'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { sv.picked = new Set(); draw(); } }, 'None'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small primary', type: 'button', disabled: n ? null : '', onclick: async () => { const t = await pickSection('Move ' + n + ' page' + (n === 1 ? '' : 's') + ' to'); if (!t) return; for (const pid of sv.picked) await pages.update(pid, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId, order: Date.now() }); toast('Moved ' + n + ' page' + (n === 1 ? '' : 's')); sv.select = false; sv.picked = new Set(); onChanged(); renderSection(id); } }, 'Move to…'),
        el('button', { class: 'btn small danger', type: 'button', disabled: n ? null : '', onclick: async () => { if (!(await confirm('Delete ' + n + ' page' + (n === 1 ? '' : 's') + '?'))) return; for (const pid of sv.picked) await pages.remove(pid); sv.select = false; sv.picked = new Set(); onChanged(); renderSection(id); } }, 'Delete'));
    };
    view.append(bulk);
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
      const val = (p, k) => k === 'title' ? (p.title || '') : k === 'updated' ? (p.updated || 0) : k === 'manual' ? orderOf(p) : k === 'tags' ? (p.tags || []).join(', ') : propVal(p, k);
      rows.sort((a, b) => { const pa = (b.pinned || 0) - (a.pinned || 0); if (pa) return pa; const va = val(a, sv.sort), vb = val(b, sv.sort); return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true })) * sv.dir; });
      if (s.view === 'table' && sv.sort === 'manual') { sv.sort = 'updated'; sv.dir = -1; rows.sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.updated || 0) - (a.updated || 0)); }
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
          const r = el('tr', { class: sv.select && sv.picked.has(p.id) ? 'picked' : '', onclick: () => { if (!sv.select) { openPage(p.id); return; } if (sv.picked.has(p.id)) sv.picked.delete(p.id); else sv.picked.add(p.id); r.classList.toggle('picked'); syncBulk(); } });
          for (const [k] of cols) r.append(el('td', { class: k === 'title' ? 'tcell' : '' }, k === 'updated' ? fmtWhen(p.updated) : (k === 'title' ? (p.pinned ? '📌 ' : '') + (p.title || 'Untitled') : String(val(p, k)))));
          tb.append(r);
        }
        table.append(tb);
        holder.append(el('div', { class: 'dbwrap' }, table));
        syncBulk();
      } else {
        const pl = el('div', { class: 'pagelist' + (sv.select ? ' selecting' : '') });
        for (const p of rows) {
          if (sv.select) {
            const on = sv.picked.has(p.id);
            pl.append(el('label', { class: on ? 'picked' : '' }, el('input', { type: 'checkbox', checked: on ? '' : null, onchange: (e) => { if (e.target.checked) sv.picked.add(p.id); else sv.picked.delete(p.id); e.target.closest('label').classList.toggle('picked', e.target.checked); syncBulk(); } }), el('span', {}, (p.pinned ? '📌 ' : '') + (p.title || 'Untitled')), el('span', { class: 'when' }, fmtWhen(p.updated))));
            continue;
          }
          pl.append(gestures(dragPage(el('a', { href: '#page/' + p.id }, el('span', {}, (p.pinned ? '📌 ' : '') + (p.title || 'Untitled'), (p.props || []).length ? el('span', { class: 'proptxt' }, ' · ' + p.props.map((x) => x.k + ': ' + x.v).join(' · ')) : null), el('span', { class: 'when' }, fmtWhen(p.updated))), p),
            { onDelete: async () => { if (await confirm('Delete "' + (p.title || 'Untitled') + '"?')) { await pages.remove(p.id); onChanged(); renderSection(id); } }, onLongPress: () => pageQuickMenu(p, () => renderSection(id)) }));
        }
        if (!sv.select && !q) pl.append(dropEnd(el('div', { class: 'pagelist-end' }, 'Drag pages to reorder'), id));
        holder.append(pl);
        syncBulk();
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
    // Tiles that have become built-in views take over their old link tiles by name.
    const builtin = [[/shopping list/i, 'shop'], [/trials/i, 'tp'], [/portfolio/i, 'portfolio']];
    for (const a of apps) for (const [re, key] of builtin) if (!a.app && re.test(a.title || '')) { await pages.update(a.id, { app: key, url: '', assetId: null, embed: 0 }); a.app = key; a.url = ''; a.assetId = null; }
    return apps.sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (a.title || '').localeCompare(b.title || ''));
  }
  // Import a seed file (a notebook of pages) into NoteCompanion; idempotent by page id.
  async function importSeed(file) {
    const res = await fetch(file); if (!res.ok) throw new Error('Could not load ' + file);
    const seed = await res.json();
    let nb = (await window.NCDB.db.notebooks.where('deleted').equals(0).toArray()).find((n) => n.name === seed.notebook);
    if (!nb) nb = await notebooks.create(seed.notebook);
    const secs = new Map();
    const existing = new Map((await window.NCDB.db.pages.toArray()).map((q) => [q.id, q]));
    let n = 0;
    for (const pg of seed.pages) {
      const have = existing.get(pg.id);
      if (have && !have.deleted) continue;
      const isPearl = pg.section === 'Pearls';
      const secName = isPearl ? ((pg.props || []).find((x) => x.k === 'Category') || {}).v || 'General' : pg.section;
      const key = (isPearl ? 'Pearls/' : 'Trials/') + secName;
      let sc = secs.get(key);
      if (!sc) { sc = (await sections.forNotebook(nb.id)).find((x) => x.name === secName && x.group === (isPearl ? 'Pearls' : 'Trials')); if (!sc) { sc = await sections.create(nb.id, secName); await sections.update(sc.id, { group: isPearl ? 'Pearls' : 'Trials', view: isPearl ? 'list' : 'table' }); } secs.set(key, sc); }
      if (have) { await pages.update(pg.id, { deleted: 0, inbox: 0, notebookId: nb.id, sectionId: sc.id, title: pg.title, html: pg.html, props: pg.props || [], tags: pg.tags || [], ptype: isPearl ? 'pearl' : 'trial' }); n++; continue; }
      await pages.create({ id: pg.id, notebookId: nb.id, sectionId: sc.id, title: pg.title, html: pg.html, props: pg.props || [], tags: pg.tags || [], pinned: pg.pinned || 0, ptype: isPearl ? 'pearl' : 'trial', created: pg.created ? Date.parse(pg.created) || Date.now() : Date.now() });
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
    const fileIn = el('input', { type: 'file', accept: '.html,.htm,text/html', hidden: '' });
    fileIn.addEventListener('change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (!f) return; const np = await addAppFromFile(f); toast('Added ' + np.title); go('#page/' + np.id); });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Apps'), el('div', { class: 'toolrow' },
      el('button', { class: 'btn small', type: 'button', onclick: () => fileIn.click() }, '+ From HTML file'),
      el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        const name = await ask('App name', 'e.g. Portfolio Log'); if (!name) return;
        const url = await ask('Link (optional)', 'https://…'); if (url === undefined) return;
        const np = await pages.create({ kind: 'app', inbox: 0, title: name, url: url || '', html: '' }); S.schedule(); go('#page/' + np.id);
      } }, '+ Add link'))), fileIn);
    const grid = el('div', { class: 'appgrid' });
    grid.append(el('div', { class: 'apptile builtin' },
      el('div', { class: 'apphead' }, el('span', { class: 'appico', html: appIcon }), el('b', {}, 'Shift Companion')),
      el('div', { class: 'appdesc' }, 'On-call queue and ward jobs. Lives on this device only, never synced; cleared after 7 days unless kept.'),
      el('div', { class: 'actions' }, el('a', { class: 'btn small primary', href: '#shift' }, 'Open'), el('span', { class: 'sub' }, 'built in'))));
    for (const a of apps) {
      const tile = el('div', { class: 'apptile' + (a.pinned ? ' pinned' : '') },
        el('div', { class: 'apphead' }, el('span', { class: 'appico', html: appIcon }), el('b', {}, a.title)),
        el('div', { class: 'appdesc' }, textOf(a).slice(0, 120)),
        el('div', { class: 'actions' },
          a.app === 'shop' ? el('a', { class: 'btn small primary', href: '#shop' }, 'Open') : a.app === 'tp' ? el('a', { class: 'btn small primary', href: '#tp' }, 'Open') : a.app === 'portfolio' ? el('a', { class: 'btn small primary', href: '#portfolio' }, 'Open') : (a.assetId || a.embed) ? el('button', { class: 'btn small primary', type: 'button', onclick: () => openPage(a.id) }, 'Open') : a.url ? el('a', { class: 'btn small primary', href: a.url, target: '_blank', rel: 'noopener' }, 'Open') : el('span', { class: 'sub' }, 'No link yet'),
          (a.app === 'shop' || a.app === 'tp' || a.app === 'portfolio') ? el('span', { class: 'sub' }, a.app === 'shop' ? 'a view of a note' : 'a view of a notebook') : (a.assetId || a.embed) ? el('span', { class: 'sub' }, a.assetId ? 'runs inside' : 'embedded') : el('button', { class: 'btn small', type: 'button', onclick: () => openPage(a.id) }, 'Notes'),
          SEED_FILES[a.title] && a.app !== 'tp' ? el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.target.disabled = true; toast('Importing…'); try { const r = await importSeed(SEED_FILES[a.title]); toast(r.added ? 'Imported ' + r.added + ' pages into ' + r.notebook.name : 'Already imported (' + r.total + ' pages)'); } catch (err) { toast(err.message); } e.target.disabled = false; } }, 'Import into NoteCompanion') : null));
      grid.append(gestures(tile, { onDelete: async () => { if (await confirm('Remove "' + a.title + '" from the hub?', null, 'Remove')) { await pages.remove(a.id); S.schedule(); renderApps(); } }, onLongPress: () => menu(a.title, [
        (a.assetId || a.embed) ? { label: 'Open', fn: () => openPage(a.id) } : { label: 'Open notes', fn: () => openPage(a.id) },
        a.assetId ? { label: 'Replace HTML file…', fn: () => { const inp = el('input', { type: 'file', accept: '.html,.htm,text/html' }); inp.addEventListener('change', async () => { const f = inp.files[0]; if (!f) return; const na = await storeAsset(f, f.name); if (a.assetId) await assets.remove(a.assetId); await pages.update(a.id, { assetId: na.id }); S.schedule(); toast('Updated ' + a.title); renderApps(); }); inp.click(); } } : null,
        a.url ? { label: a.embed ? 'Open in its own tab instead' : 'Open inside NoteCompanion (embed)', fn: async () => { await pages.update(a.id, { embed: a.embed ? 0 : 1 }); S.schedule(); renderApps(); } } : null,
        { label: 'Change link', fn: async () => { const u = await ask('Link', 'https://…', a.url || '', 'Save'); if (u !== undefined) { await pages.update(a.id, { url: u }); S.schedule(); renderApps(); } } },
        { label: a.pinned ? 'Unpin' : 'Pin', fn: async () => { await pages.update(a.id, { pinned: a.pinned ? 0 : 1 }); S.schedule(); renderApps(); } },
        { label: 'Remove from hub', danger: true, fn: async () => { if (await confirm('Remove "' + a.title + '"?', null, 'Remove')) { await pages.remove(a.id); S.schedule(); renderApps(); } } }
      ]) }));
    }
    view.append(grid, el('p', { class: 'rule' }, 'Open launches the app in its own tab; Notes is a page for how it works and how to update it. Press and hold a tile for more.'));
    content.replaceChildren(view); syncNav();
  }

  // ---------- Shift Companion (device-only) ----------
  async function renderShift() {
    state.view = 'shift';
    const view = el('div', { class: 'view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Shift Companion'), el('div', { class: 'toolrow' }, el('a', { class: 'btn small', href: '#apps' }, 'Apps'))));
    const host = el('div', {});
    view.append(host);
    content.replaceChildren(view); syncNav();
    if (!window.NCShift) { host.append(el('p', { class: 'sub' }, 'Not loaded.')); return; }
    await NCShift.render(host, { toast, sheet, confirm, pickSection, createPage: async (f) => { const np = await pages.create(f); onChanged(); return np; } });
  }

  // ---------- Shopping list (a view over a notebook page) ----------
  async function renderShop() {
    state.view = 'shop';
    const view = el('div', { class: 'view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Shopping list'), el('div', { class: 'toolrow' }, el('a', { class: 'btn small', href: '#apps' }, 'Apps'))));
    const host = el('div', {});
    view.append(host);
    content.replaceChildren(view); syncNav();
    // Make sure the hub tile exists and is the built-in kind (it takes over the old HTML-app tile of the same name).
    let tile = (await pages.live()).find((q) => q.kind === 'app' && q.app === 'shop');
    if (!tile) {
      const old = (await pages.live()).find((q) => q.kind === 'app' && /shopping list/i.test(q.title || ''));
      if (old) { await pages.update(old.id, { app: 'shop', url: '', assetId: null, embed: 0, html: '<p>A view over the "Shopping list" page in your notebook.</p>' }); tile = await pages.get(old.id); }
      else tile = await pages.create({ kind: 'app', inbox: 0, title: 'Shopping List Manager', app: 'shop', url: '', html: '<p>A view over the "Shopping list" page in your notebook.</p>' });
      onChanged();
    }
    if (!window.NCShop) { host.append(el('p', { class: 'sub' }, 'Not loaded.')); return; }
    await NCShop.render(host, { toast, sheet, confirm, pickSection, changed: onChanged });
  }

  // ---------- Trials & Pearls (a view over its notebook) ----------
  async function renderTP() {
    state.view = 'tp';
    const view = el('div', { class: 'view tp-view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Trials & Pearls'), el('div', { class: 'toolrow' }, el('a', { class: 'btn small', href: '#apps' }, 'Apps'))));
    const host = el('div', {});
    view.append(host);
    content.replaceChildren(view); syncNav();
    let tile = (await pages.live()).find((q) => q.kind === 'app' && q.app === 'tp');
    if (!tile) {
      const old = (await pages.live()).find((q) => q.kind === 'app' && /trials/i.test(q.title || ''));
      if (old) await pages.update(old.id, { app: 'tp', url: '', assetId: null, embed: 0, html: '<p>A view over the Trials & Pearls notebook.</p>' });
      else await pages.create({ kind: 'app', inbox: 0, title: 'Trials & Pearls', app: 'tp', url: '', html: '<p>A view over the Trials & Pearls notebook.</p>' });
      onChanged();
    }
    if (!window.NCTP) { host.append(el('p', { class: 'sub' }, 'Not loaded.')); return; }
    await NCTP.render(host, { toast, sheet, confirm, ask, menu, go, changed: onChanged, importSeed: () => importSeed(SEED_FILES['Trials & Pearls']) });
  }

  // ---------- Portfolio log (a view over its notebook) ----------
  async function renderPortfolio() {
    state.view = 'portfolio';
    const view = el('div', { class: 'view pf-view' });
    view.append(el('div', { class: 'view-head' }, el('h1', {}, 'Portfolio log'), el('div', { class: 'toolrow' }, el('a', { class: 'btn small', href: '#apps' }, 'Apps'))));
    const host = el('div', {});
    view.append(host);
    content.replaceChildren(view); syncNav();
    let tile = (await pages.live()).find((q) => q.kind === 'app' && q.app === 'portfolio');
    if (!tile) {
      const old = (await pages.live()).find((q) => q.kind === 'app' && /portfolio/i.test(q.title || ''));
      if (old) await pages.update(old.id, { app: 'portfolio', url: '', assetId: null, embed: 0, html: '<p>A view over the Portfolio notebook.</p>' });
      else await pages.create({ kind: 'app', inbox: 0, title: 'Portfolio Log', app: 'portfolio', url: '', html: '<p>A view over the Portfolio notebook.</p>' });
      onChanged();
    }
    if (!window.NCPortfolio) { host.append(el('p', { class: 'sub' }, 'Not loaded.')); return; }
    await NCPortfolio.render(host, { toast, sheet, confirm, ask, menu, go, changed: onChanged });
  }

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
    if (state.ink) { try { state.ink.destroy(); } catch (e) { /* ignore */ } state.ink = null; }
    if (state.appTeardown) { try { state.appTeardown(); } catch (e) { /* ignore */ } state.appTeardown = null; }
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
    body { background: transparent; color: var(--ink); font-family: Calibri, Carlito, "Segoe UI", -apple-system, system-ui, sans-serif; font-size: 17px; line-height: var(--pitch); padding: var(--pitch) 4px var(--pitch); max-width: none; margin: 0; box-sizing: border-box; min-height: 100%; }
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

  // ---------- apps that run inside NoteCompanion ----------
  // A single-file HTML app is kept as an asset and run in an iframe. A small bridge script is prepended so
  // everything the app writes to localStorage is mirrored into the page record (p.appData) and synced,
  // and restored before the app's own code runs on another device.
  const APP_BRIDGE = `<script>(function(){try{var P=window.parent;var init=null;var seed=JSON.parse(document.documentElement.getAttribute('data-nc-seed')||'{}');
for(var k in seed){try{Storage.prototype.setItem.call(localStorage,k,seed[k]);}catch(e){}}
var send=function(op,k,v){try{P.postMessage({nc:'app-storage',op:op,key:k,value:v},'*');}catch(e){}};
var S=Storage.prototype,si=S.setItem,ri=S.removeItem,cl=S.clear;
S.setItem=function(k,v){si.call(this,k,v);if(this===localStorage)send('set',String(k),String(v));};
S.removeItem=function(k){ri.call(this,k);if(this===localStorage)send('remove',String(k));};
S.clear=function(){cl.call(this);if(this===localStorage)send('clear');};
window.NoteCompanion={back:function(){try{P.postMessage({nc:'app-back'},'*');}catch(e){}}};
if(!window.claude){window.claude={use:function(){return Promise.reject({code:'not_granted'});}};}
window.NoteCompanion.savePage=function(title,html){try{P.postMessage({nc:'app-page',title:String(title||'Untitled'),html:String(html||'')},'*');}catch(e){}};
}catch(e){}})();</script>`;
  async function runApp(p, host, queueSave) {
    const frame = el('iframe', { class: 'appframe', title: p.title || 'App', allow: 'camera; microphone; clipboard-read; clipboard-write; fullscreen' });
    host.append(frame);
    const data = Object.assign({}, p.appData || {});
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data || !e.data.nc) return;
      if (e.data.nc === 'app-back') { go('#apps'); return; }
      if (e.data.nc === 'app-page') { (async () => { const t = await pickSection('Save "' + e.data.title + '" to'); if (!t) return; await pages.create({ notebookId: t.notebookId, sectionId: t.sectionId, title: e.data.title, html: e.data.html }); onChanged(); toast('Saved to notes'); })(); return; }
      if (e.data.nc !== 'app-storage') return;
      if (e.data.op === 'set') data[e.data.key] = e.data.value;
      else if (e.data.op === 'remove') delete data[e.data.key];
      else if (e.data.op === 'clear') for (const k of Object.keys(data)) delete data[k];
      queueSave({ appData: Object.assign({}, data) });
    };
    addEventListener('message', onMsg);
    state.appTeardown = () => removeEventListener('message', onMsg);
    if (p.assetId) {
      const a = await assets.get(p.assetId);
      if (!a || !a.blob) { host.append(el('p', { class: 'sub' }, 'This app\'s file has not reached this device yet — sync and try again.')); return; }
      let html = await a.blob.text();
      // Libraries we keep a local copy of, so the app also opens with no connection.
      html = html.replace(/<script[^>]+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2[^"]*"[^>]*><\/script>/gi, '<script src="' + new URL('vendor/supabase.js', C.redirectUri).href + '"></script>');
      const seed = JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      // Seed goes on <html> so the bridge can read it; the bridge goes at the very top of <head>.
      if (/<html[^>]*>/i.test(html)) html = html.replace(/<html([^>]*)>/i, '<html$1 data-nc-seed="' + seed + '">'); else html = '<html data-nc-seed="' + seed + '">' + html + '</html>';
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>' + APP_BRIDGE); else html = html.replace(/<html([^>]*)>/i, '<html$1><head>' + APP_BRIDGE + '</head>');
      frame.srcdoc = html;
    } else frame.src = p.url;
  }
  async function addAppFromFile(file) {
    const a = await storeAsset(file, file.name);
    const title = file.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ');
    const np = await pages.create({ kind: 'app', inbox: 0, title, url: '', assetId: a.id, html: '<p>Runs inside NoteCompanion. Replace the file from ··· to update it.</p>' });
    S.schedule(); return np;
  }
  async function pageColumn(nb, sec, activeId) {
    const col = el('aside', { class: 'pagecol', 'data-sec': sec.id, 'data-nb': nb.id });
    const secPages = (await pages.forSection(sec.id)).sort(pinnedFirst);
    col.append(el('div', { class: 'pagecol-head' }, el('a', { href: '#section/' + sec.id, title: sec.name }, sec.name), el('button', { class: 'btn small', type: 'button', title: 'New page', onclick: () => newPage(nb.id, sec.id) }, '+')));
    const pl = el('div', { class: 'pagecol-list' });
    for (const q of secPages) pl.append(dragPage(el('a', { class: 'pagecol-row' + (q.id === activeId ? ' active' : ''), href: '#page/' + q.id, title: q.title || 'Untitled' }, el('span', { class: 'pagecol-title' }, (q.pinned ? '📌 ' : '') + (q.title || 'Untitled')), el('span', { class: 'pagecol-when' }, fmtWhen(q.updated))), q));
    pl.append(dropEnd(el('div', { class: 'pagecol-end' }), sec.id));
    col.append(pl);
    return col;
  }
  async function renderPage(id) {
    destroyEditor();
    const p = await pages.get(id);
    if (!p || p.deleted) { content.replaceChildren(el('div', { class: 'view' }, el('h1', {}, 'Page not found'))); return; }
    state.view = 'page'; state.pageId = id; state.sectionId = p.sectionId || null;
    const nb = p.notebookId ? await notebooks.get(p.notebookId) : null;
    const sec = p.sectionId ? await sections.get(p.sectionId) : null;
    if (nb) setNotebook(nb.id); refreshTreeSoon();
    if (sec) state.expanded.add(sec.id);
    const view = el('div', { class: 'view page-view' });
    if (nb && sec && !PANE) view.append(await sectionTabs(nb, sec.id));

    const crumbs = el('div', { class: 'crumbs' });
    if (p.kind === 'app') crumbs.append(el('a', { href: '#apps' }, 'Apps'), '›', p.assetId ? el('span', {}, p.title || 'App') : p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.embed ? 'Open in a tab' : 'Open app') : el('button', { type: 'button', onclick: async () => { const u = await ask('Link', 'https://…', '', 'Save'); if (u) { await pages.update(p.id, { url: u }); S.schedule(); renderPage(id); } } }, 'Add link'));
    else if (p.inbox) crumbs.append('Inbox', el('button', { type: 'button', onclick: async () => { if (await fileInto(p.id)) renderPage(id); } }, 'File to…'));
    else crumbs.append(el('a', { href: nb ? '#nb/' + nb.id : '#notes' }, nb ? nb.name : '—'), '›', el('a', { href: sec ? '#section/' + sec.id : '#notes' }, sec ? sec.name : '—'));
    crumbs.append(el('span', { class: 'spacer' }));
    if (p.pinned) crumbs.append(el('span', { class: 'pinmark', title: 'Pinned' }, '📌'));
    if (p.kind !== 'pdf' && p.kind !== 'app') crumbs.append(el('button', { class: 'more-page draw', id: 'btn-draw', type: 'button', 'aria-label': 'Draw', title: 'Draw with pen or Pencil (D)', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13 7l3 3" stroke="currentColor" stroke-width="1.7"/></svg>', onclick: () => { if (state.ink) state.ink.setDrawing(!state.ink.isDrawing()); } }));
    crumbs.append(el('button', { class: 'more-page', type: 'button', 'aria-label': 'Page options', onclick: () => pageMenu(p) }, '···'));
    crumbs.append(el('button', { class: 'done-page', type: 'button', 'aria-label': 'Done', title: 'Save and close', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>', onclick: () => { destroyEditor(); go(p.kind === 'app' ? '#apps' : p.inbox ? '#inbox' : (p.sectionId ? '#section/' + p.sectionId : '#notes')); } }));
    view.append(crumbs);

    const title = el('input', { class: 'title-input', id: 'page-title', type: 'text', placeholder: 'Untitled', value: p.title || '' });
    title.addEventListener('input', () => queueSave({ title: title.value }));
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (state.editor) state.editor.focus(); } });
    view.append(title);

    if (p.kind === 'app' && p.app === 'shop') { go('#shop'); return; }
    if (p.kind === 'app' && p.app === 'tp') { go('#tp'); return; }
    if (p.kind === 'app' && p.app === 'portfolio') { go('#portfolio'); return; }
    if (p.kind === 'app' && (p.assetId || p.embed)) {
      view.classList.add('app-view');
      const host = el('div', { class: 'apphost' });
      view.append(host);
      content.replaceChildren(view); syncNav();
      await runApp(p, host, queueSave);
      return;
    }
    if (p.kind === 'pdf') {
      const host = el('div', { class: 'pdfhost' });
      view.append(host);
      content.replaceChildren(view); syncNav();
      state.pdfTeardown = await window.NCPDF.render(p, host, { queueSave: (patch) => queueSave(patch) });
      return;
    }

    const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const dates = el('div', { class: 'pagedates' }, el('span', { title: 'Created' }, 'Created ' + fmtDate(p.created)), el('span', { class: 'dot' }, '·'), el('span', { title: 'Last edited', id: 'page-updated' }, 'Edited ' + fmtDate(p.updated)));
    view.append(dates);

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
    if (sec && !PANE) content.replaceChildren(el('div', { class: 'pagegrid' }, await pageColumn(nb, sec, p.id), view));
    else content.replaceChildren(view);
    syncNav();
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
        // Copying a selection that contains pictures: put the pixels on the clipboard, not our local asset URL,
        // so they paste into Word, Teams, other devices and so on.
        ed.on('copy cut', (e) => {
          const html = ed.selection.getContent({ format: 'html' });
          if (!/<img[^>]+src="[^"]*asset\/[^"]+"/.test(html) || !navigator.clipboard || !window.ClipboardItem) return;
          e.preventDefault();
          const text = ed.selection.getContent({ format: 'text' });
          const inlined = inlineAssets(html).then((h) => new Blob([h], { type: 'text/html' }));
          navigator.clipboard.write([new ClipboardItem({ 'text/html': inlined, 'text/plain': new Blob([text], { type: 'text/plain' }) })]).catch(() => {});
          if (e.type === 'cut') { ed.execCommand('Delete'); scheduleSave(); }
        });
        // Pasted HTML with pictures hosted elsewhere: copy them into the note so it works offline.
        ed.on('PastePostProcess', () => setTimeout(() => localiseImages(ed, scheduleSave), 0));
        ed.on('init', () => { ed.setContent(initial); applyPaper(ed, p.paper); ed.undoManager.clear(); ed.setDirty(false); if (focusNew && !p.title) setTimeout(() => title.focus(), 60); });
      }
    });
    state.editor = editors && editors[0];
    if (!state.editor) return;
    state.openedPage = p; state.openedHtml = initial;
    if (window.NCInk) state.ink = NCInk.attach(host, p.ink, (ink) => queueSave({ ink }), { onMode: (on) => { const b = $('#btn-draw'); if (b) b.classList.toggle('on', on); refreshUndoButtons(); } });
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
      state.saveTimer = setTimeout(async () => { state.pendingSave = null; await pages.update(p.id, patch); const u = $('#page-updated'); if (u) u.textContent = 'Edited ' + fmtDate(Date.now()); if (!PANE) S.schedule(); refreshTree(); announce('changed'); }, 700);
    }
  }
  function pageMenu(p) {
    const html = state.editor && state.pageId === p.id ? state.editor.getContent() : htmlOf(p);
    const inkItems = state.ink && state.pageId === p.id && state.ink.hasInk() ? [{ label: 'Clear all ink', danger: true, fn: async () => { if (await confirm('Clear all ink on this page?', '', 'Clear')) state.ink.clear(); } }] : [];
    const words = wordCount(html);
    const note = p.kind === 'pdf' ? ((p.pdfPages || '?') + ' pages · ' + Object.values(p.annots || {}).reduce((n, l) => n + l.length, 0) + ' marks · edited ' + fmtWhen(p.updated)) : (words + (words === 1 ? ' word' : ' words') + ' · about ' + Math.max(1, Math.round(words / 220)) + ' min read · edited ' + fmtWhen(p.updated));
    menu(p.title || 'Untitled', [
      p.kind === 'app' ? { label: 'Change link', fn: async () => { const u = await ask('Link', 'https://…', p.url || '', 'Save'); if (u !== undefined) { await pages.update(p.id, { url: u }); S.schedule(); renderPage(p.id); } } } : p.inbox ? { label: 'File to section…', fn: async () => { if (await fileInto(p.id)) renderPage(p.id); } } : { label: 'Move to…', fn: async () => { const t = await pickSection('Move page to'); if (t) { await pages.update(p.id, { inbox: 0, notebookId: t.notebookId, sectionId: t.sectionId, order: Date.now() }); onChanged(); renderPage(p.id); } } },
      (!PANE && !isNarrow()) ? { label: 'Open in split view', fn: () => openSplit('#page/' + p.id) } : null,
      { label: p.pinned ? 'Unpin' : 'Pin to top of section', fn: async () => { await pages.update(p.id, { pinned: p.pinned ? 0 : 1 }); onChanged(); renderPage(p.id); } },
      p.kind === 'pdf' ? null : { label: 'Paper: ' + (PAPERS[p.paper] || 'Plain') + '…', fn: () => menu('Paper', Object.entries(PAPERS).map(([k, v]) => ({ label: v + (k === (p.paper || 'plain') ? '  ✓' : ''), fn: async () => { p.paper = k; await pages.update(p.id, { paper: k }); S.schedule(); if (state.editor && state.pageId === p.id) applyPaper(state.editor, k); } }))) },
      p.kind === 'pdf' ? null : { label: 'History…', fn: () => historySheet(p) },
      ...inkItems,
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
    const nPdf = (await pages.live()).filter((q) => q.kind === 'pdf').length;
    tagbar.append(el('button', { class: 'chip', type: 'button', onclick: () => { inp.value = 'is:pdf'; run(); } }, 'PDFs ' + nPdf));
    for (const t of tags.slice(0, 20)) tagbar.append(el('button', { class: 'chip', type: 'button', onclick: () => { inp.value = '#' + t.tag; run(); } }, '#' + t.tag + ' ' + t.n));
    let timer = null;
    const run = async () => {
      state.query = inp.value; const q = inp.value.trim().toLowerCase(); results.innerHTML = '';
      if (!q) return;
      let all = await pages.live();
      const tagQ = q.startsWith('#') ? q.slice(1) : null;
      const pdfOnly = /\bis:pdf\b/.test(q);
      if (pdfOnly) { all = all.filter((x) => x.kind === 'pdf'); results.append(el('div', { class: 'formrow' }, el('button', { class: 'btn small primary', type: 'button', onclick: () => $('#file-pdf').click() }, '+ Add PDFs'), el('span', { class: 'sub' }, all.length + ' PDF' + (all.length === 1 ? '' : 's') + ' · they live in their sections like any other page'))); }
      const terms = q.replace(/\bis:pdf\b/, '').trim().split(/\s+/).filter(Boolean);
      const scored = [];
      for (const p of all) {
        if (pdfOnly && !terms.length && !tagQ) { scored.push({ p, raw: textOf(p), score: p.updated || 0, idx: -1 }); continue; }
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
    const kvBuild = el('span', {}, '…'), kvPersist = el('span', {}, '…');
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'This device'),
      el('div', { class: 'kv' }, el('span', {}, 'Name'), el('span', {}, dev)),
      el('div', { class: 'kv' }, el('span', {}, 'Installed as app'), el('span', {}, (navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? 'Yes' : 'No (use Add to Home Screen)')),
      el('div', { class: 'kv' }, el('span', {}, 'Offline cache'), el('span', { id: 'kv-sw' }, navigator.serviceWorker && navigator.serviceWorker.controller ? 'Ready' : 'Not yet; reload once')),
      el('div', { class: 'kv' }, el('span', {}, 'Build'), kvBuild),
      el('div', { class: 'kv' }, el('span', {}, 'Storage kept'), kvPersist),
      el('div', { class: 'kv' }, el('span', {}, 'Version'), el('span', {}, C.version))));
    if (window.caches) caches.keys().then((ks) => { kvBuild.textContent = (ks.filter((x) => x.startsWith('nc-')).sort().pop() || 'none').replace(/^nc-/, ''); }).catch(() => { kvBuild.textContent = '?'; });
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { kvPersist.textContent = p ? 'Yes' : 'Not promised by the browser'; });
    if (g.signedIn) {
      const on = el('div', { class: 'panel' }, el('h2', {}, 'Import from OneNote'),
        el('p', { class: 'rule' }, 'Copies a OneNote notebook into NoteCompanion: sections (section groups become "Group / Section"), pages, images and attachments. Ink comes across as pictures. Safe to run again; pages already imported are skipped.'),
        el('div', { id: 'onenote-list' }, el('button', { class: 'btn', type: 'button', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Loading notebooks…';
          try {
            const nbs = await window.NCOneNote.listNotebooks();
            const localNbs = [...(await notebooks.all()), ...(await notebooks.archived())];
            const allPages = await pages.live();
            const list = el('div', { class: 'list' });
            if (!nbs.length) list.append(el('p', { class: 'sub' }, 'No OneNote notebooks found on this account.'));
            for (const nb of nbs) {
              const local = localNbs.find((x) => x.onenoteId === nb.id);
              const nLocal = local ? allPages.filter((q) => q.notebookId === local.id && q.onenoteId).length : 0;
              const row = el('button', { type: 'button', class: local ? 'imported' : '' }, el('span', { class: 'nbname' }, nb.displayName), local ? el('span', { class: 'sec-count ok' }, '✓ imported · ' + nLocal + ' pages') : el('span', { class: 'sec-count' }, 'not imported'));
              row.addEventListener('click', async () => {
                if (!(await confirm((local ? 'Update "' : 'Import "') + nb.displayName + '"?', local ? 'Pages already imported are skipped; only new OneNote pages are added.' : 'This can take a few minutes for a big notebook. Keep this screen open.', local ? 'Update' : 'Import'))) return;
                row.disabled = true;
                const bar = el('div', { class: 'progress busy' }, el('div', { class: 'progress-fill' }));
                const status = el('p', { class: 'rule' }, 'Counting pages…');
                const stop = el('button', { class: 'btn small', type: 'button', onclick: () => { window.NCOneNote.cancel(); stop.disabled = true; stop.textContent = 'Stopping after this page…'; } }, 'Stop');
                const stopRow = el('div', { class: 'formrow' }, stop);
                row.after(bar, status, stopRow);
                let last = '';
                const prevThrottle = G.onThrottle;
                G.onThrottle = (ms) => { status.textContent = last + ' — Microsoft is rate-limiting, waiting ' + Math.round(ms / 1000) + ' s (resumes by itself)'; };
                try {
                  const r = await window.NCOneNote.importNotebook(nb, (m, done, total) => { last = m; status.textContent = m; if (total) { bar.classList.remove('busy'); bar.firstChild.style.width = Math.max(2, Math.round(done / total * 100)) + '%'; } });
                  bar.classList.remove('busy'); if (!r.stopped) bar.firstChild.style.width = '100%';
                  status.textContent = (r.stopped ? 'Stopped: ' : 'Done: ') + r.count + ' pages imported into "' + r.notebook.name + '" (' + r.sections + ' sections' + (r.skipped ? ', ' + r.skipped + ' already there' : '') + (r.failed ? ', ' + r.failed + ' failed — run again to retry them' : '') + ').';
                  row.replaceChildren(el('span', { class: 'nbname' }, nb.displayName), el('span', { class: 'sec-count ok' }, '✓ imported · ' + (nLocal + r.count) + ' pages'));
                  if (!r.stopped) toast('Notebook added: ' + r.notebook.name, { label: 'Open', fn: () => { state.expanded.add(r.notebook.id); go('#notes'); } });
                  onChanged();
                } catch (err) { bar.classList.remove('busy'); status.textContent = 'Import failed: ' + (err.message || err); console.warn(err); }
                G.onThrottle = prevThrottle;
                stopRow.remove();
                row.disabled = false;
              });
              list.append(row);
            }
            $('#onenote-list').replaceChildren(list);
          } catch (err) {
            e.target.disabled = false; e.target.textContent = 'Show my OneNote notebooks';
            toast(/429/.test(err.message || '') ? 'OneNote is still rate-limiting this account; it can take 30–60 minutes to clear. Use the Word-export route below meanwhile.' : /403|consent|Notes\.Read/i.test(err.message || '') ? 'Sign out and in again to grant OneNote access' : (err.message || 'Could not list notebooks'));
          }
        } }, 'Show my OneNote notebooks')));
      view.append(on);
    }
    // Offline OneNote route: Word exports of sections.
    const docxStatus = el('p', { class: 'rule' }, '');
    const docxBar = el('div', { class: 'progress', hidden: '' }, el('div', { class: 'progress-fill' }));
    const docxInput = el('input', { type: 'file', accept: '.docx,.mht,.mhtml,.zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,message/rfc822,multipart/related,application/zip', multiple: '', hidden: '' });
    const docxDrop = el('div', { class: 'dropzone', onclick: () => docxInput.click() }, el('b', {}, 'Drop OneNote exports here'), el('span', {}, ' or click to choose .mht or .docx files, or a zip of them'));
    const runDocx = async (files) => {
      const picked = [];
      for (const f of files) {
        if (/\.zip$/i.test(f.name)) { try { picked.push(...await window.NCOneNote.unzip(f)); } catch (e) { toast('Could not open ' + f.name + ': ' + e.message); } }
        else picked.push(f);
      }
      files = picked.filter((f) => /\.(docx|mht|mhtml)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (!files.length) { toast('Choose .mht or .docx files exported from OneNote (or a zip of them)'); return; }
      const nbs = await notebooks.all();
      const target = await sheet((box, close) => {
        box.append(el('h2', {}, 'Import ' + files.length + ' section' + (files.length === 1 ? '' : 's') + ' into'), el('div', { class: 'list' },
          ...nbs.map((nb) => el('button', { type: 'button', onclick: () => close(nb) }, nb.name)),
          el('button', { type: 'button', style: 'color: var(--accent)', onclick: async () => { const name = await ask('New notebook', 'Notebook name', files.length === 1 ? '' : files[0].name.replace(/\.(docx|mht|mhtml)$/i, '').split(/ - | – /)[0]); if (name) { const nb = await notebooks.create(name); close(nb); } } }, '+ New notebook')),
          el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel')));
      });
      if (!target) return;
      docxBar.hidden = false; let total = 0;
      for (const [i, f] of files.entries()) {
        const secName = f.name.replace(/\.(docx|mht|mhtml)$/i, '');
        docxStatus.textContent = 'Reading ' + secName + '… (' + (i + 1) + ' of ' + files.length + ')';
        try {
          const prog = (n, of) => { docxBar.firstChild.style.width = Math.round(((i + n / of) / files.length) * 100) + '%'; docxStatus.textContent = secName + ': ' + n + ' / ' + of + ' pages'; };
          const r = /\.docx$/i.test(f.name) ? await window.NCOneNote.importDocxSection(f, target.id, secName, prog) : await window.NCOneNote.importMht(f, target.id, secName, prog);
          total += r.count;
        } catch (err) { console.warn(err); toast('Failed on ' + f.name + ': ' + err.message); }
      }
      docxBar.firstChild.style.width = '100%';
      docxStatus.textContent = 'Done: ' + total + ' pages into "' + target.name + '".';
      state.expanded.add(target.id); onChanged(); toast('Notebook updated: ' + target.name, { label: 'Open', fn: () => go('#notes') });
    };
    docxInput.addEventListener('change', () => { runDocx(docxInput.files); docxInput.value = ''; });
    docxDrop.addEventListener('dragover', (e) => { e.preventDefault(); docxDrop.classList.add('over'); });
    docxDrop.addEventListener('dragleave', () => docxDrop.classList.remove('over'));
    docxDrop.addEventListener('drop', (e) => { e.preventDefault(); docxDrop.classList.remove('over'); runDocx(e.dataTransfer.files); });
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Import from OneNote without the API'),
      el('p', {}, 'If Microsoft is rate-limiting, export from the OneNote desktop app instead. Best: ', el('b', {}, 'File → Export → Section → Single File Web Page (*.mht)'), ' — one file per section, drop them all here at once and each becomes a section of that name. A whole-notebook .mht works too but OneNote drops the section boundaries, so it lands in one section to sort afterwards. Word (.docx) exports are accepted as well. Pages, formatting, tables and images come across; ink and PDF printouts become pictures; attached files are not in the export.'),
      docxDrop, docxInput, docxBar, docxStatus));
    // Clean-up: deleted records linger as tombstones so every device learns of the deletion; purge them when done.
    const purgeStatus = el('p', { class: 'rule' }, '');
    const purgeBtn = el('button', { class: 'btn', type: 'button', onclick: async () => {
      const counts = await Promise.all([window.NCDB.db.pages.where('deleted').equals(1).count(), window.NCDB.db.sections.where('deleted').equals(1).count(), window.NCDB.db.notebooks.where('deleted').equals(1).count(), window.NCDB.db.assets.where('deleted').equals(1).count()]);
      const n = counts.reduce((a, b) => a + b, 0);
      if (!n) { toast('Nothing to purge'); return; }
      if (!(await confirm('Purge ' + n + ' deleted item' + (n === 1 ? '' : 's') + '?', 'They are removed from OneDrive and from every device on its next sync. This cannot be undone.', 'Purge'))) return;
      purgeBtn.disabled = true;
      try { const removed = await S.purgeDeleted((m) => { purgeStatus.textContent = m; }); purgeStatus.textContent = 'Purged ' + removed + ' record' + (removed === 1 ? '' : 's') + '.'; toast('Purged'); onChanged(); }
      catch (err) { purgeStatus.textContent = 'Purge failed: ' + (err.message || err); }
      purgeBtn.disabled = false;
    } }, 'Purge deleted items');
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Clean up'),
      el('p', { class: 'rule' }, 'Deleted pages, sections and files stay in OneDrive as markers so your other devices delete them too. Once everything has synced, purge them to keep the folder small and syncs quick.'),
      el('div', { class: 'formrow' }, purgeBtn), purgeStatus));
    view.append(el('div', { class: 'panel' }, el('h2', {}, 'Backup'),
      el('p', { class: 'rule' }, 'Everything is in your OneDrive folder as plain JSON and files. This also downloads a single JSON file of all notes from this device.'),
      el('div', {}, el('button', { class: 'btn', type: 'button', onclick: async () => { const data = await window.NCDB.exportAll(); await deliver(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'notecompanion-backup-' + isoDay(new Date()) + '.json'); } }, 'Download backup'))));
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Tips'),
      el('ul', {}, el('li', {}, 'Type / in a page for headings, lists, to-dos, tables, callouts, toggles and more.'),
        el('li', {}, 'Tap a section name to open it; the chevron expands it in place. Any section can be shown as a table of its pages and their properties.'),
        el('li', {}, 'Set a notebook as the current rotation and filing offers it first.'),
        el('li', {}, 'Scan in the Inbox cleans up a photo of a document; straightening comes with the PDF phase.'))));
    const gh = await window.NCDrop.config();
    const ghRepo = el('input', { type: 'text', id: 'gh-repo', placeholder: 'owner/repo (private)', value: gh.repo, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const ghToken = el('input', { type: 'password', id: 'gh-token', placeholder: 'GitHub token', value: gh.token, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const ghStatus = el('p', { class: 'rule' }, gh.repo && gh.token ? 'Configured on this device. Captures are picked up on every sync.' : 'Not set up on this device.');
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Instant capture relay'),
      el('p', {}, 'Fastest route from the iPhone Share Sheet: two taps, no browser. A Shortcut drops the item into a private GitHub repo and this app collects it on its next sync. Free; the repo is just a mailbox.'),
      el('div', { class: 'formrow' }, ghRepo, ghToken, el('button', { class: 'btn', type: 'button', onclick: async (e) => {
        await window.NCDrop.setConfig(ghRepo.value, ghToken.value);
        e.target.disabled = true; ghStatus.textContent = 'Checking…';
        try { const name = await window.NCDrop.test(); ghStatus.textContent = 'Connected to ' + name + '. Captures are picked up on every sync.'; S.schedule(300); } catch (err) { ghStatus.textContent = err.message; }
        e.target.disabled = false;
      } }, 'Save and test')),
      ghStatus,
      el('details', {}, el('summary', {}, 'Set-up steps (once)'),
        el('ol', {},
          el('li', {}, 'On github.com create a new ', el('b', {}, 'private'), ' repository, e.g. ', el('code', {}, 'notecompanion-drop'), ', ticking "Add a README".'),
          el('li', {}, 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate. Repository access: only that repo. Permissions: Repository → Contents → Read and write. Expiry: 1 year. Copy the token.'),
          el('li', {}, 'Paste ', el('code', {}, 'yourname/notecompanion-drop'), ' and the token above, then Save and test. Do this on the phone and the laptop (the token stays on each device).'),
          el('li', {}, 'In Shortcuts on the iPhone make a new shortcut: ', el('b', {}, 'Receive'), ' Any input from Share Sheet → ', el('b', {}, 'Base64 Encode'), ' (Shortcut Input) → ', el('b', {}, 'Get Contents of URL'), ' with URL ', el('code', {}, 'https://api.github.com/repos/yourname/notecompanion-drop/contents/inbox/' + '[Current Date]' + '.bin'), ' (insert the Current Date variable, format Custom ', el('code', {}, 'yyyyMMdd-HHmmss'), '), Method PUT, Headers ', el('code', {}, 'Authorization: Bearer <token>'), ' and ', el('code', {}, 'Accept: application/vnd.github+json'), ', Request Body JSON with ', el('code', {}, 'message'), ' = capture and ', el('code', {}, 'content'), ' = the Base64 Encoded text.'),
          el('li', {}, 'Tick "Show in Share Sheet" and name it NoteCompanion. The app works out whether each drop is text, a photo, a PDF or another file.')))));
    view.append(el('div', { class: 'panel help' }, el('h2', {}, 'Other capture routes'),
      el('p', {}, el('b', {}, 'OneDrive drop folder:'), ' in Shortcuts, make a shortcut that receives anything from the Share Sheet, then a ', el('b', {}, 'Save File'), ' action with "Ask Where to Save" off and the destination set to the OneDrive folder ', el('code', {}, 'NoteCompanion/inbox'), '. Text, links, photos and PDFs saved there appear in the Inbox the next time any device syncs, and the dropped file is cleared from OneDrive.'),
      el('p', {}, el('b', {}, 'Instant way (opens Safari):'), ' an "Open URLs" action set to ', el('code', {}, C.redirectUri + '?capture=1&text=[Shortcut Input]'), '. iOS always opens a URL in Safari rather than the home-screen app, so the note lands in the same shared inbox but the app itself does not come to the front.')));
    content.replaceChildren(view); syncNav();
  }

  // ---------- navigation ----------
  function syncNav() {
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.view || ((state.view === 'page' || state.view === 'section' || state.view === 'notebook' || ((state.view === 'pdfs' || state.view === 'apps' || state.view === 'shift' || state.view === 'shop' || state.view === 'tp' || state.view === 'portfolio') && a.closest('.tabbar'))) && a.dataset.nav === 'notes')));
    if (typeof PANE !== 'undefined' && !PANE && document.documentElement.classList.contains('sidebar-collapsed')) sidebar.classList.remove('peek');
    closeSidebar();
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  const openPage = (id) => go('#page/' + id);
  async function route() {
    const h = location.hash || '#inbox';
    if (PANE) { const pid = h.startsWith('#page/') ? h.slice(6) : null; const pg = pid ? await pages.get(pid) : null; announce('navigated', { hash: h, title: pg ? (pg.title || 'Untitled') : h.replace('#', '') }); }
    if (h.startsWith('#page/')) return renderPage(h.slice(6));
    destroyEditor(); state.pageId = null; state.sectionId = null;
    if (h.startsWith('#section/')) return renderSection(h.slice(9));
    if (h.startsWith('#nb/')) return renderNotebook(h.slice(4));
    if (h === '#shift') return renderShift();
    if (h === '#shop') return renderShop();
    if (h === '#tp') return renderTP();
    if (h === '#portfolio') return renderPortfolio();
    if (h === '#notes') return renderNotes();
    if (h === '#pdfs') { state.query = 'is:pdf'; return renderSearch(); }
    if (h === '#apps') return renderApps();
    if (h === '#search') return renderSearch();
    if (h === '#settings') return renderSettings();
    return renderInbox();
  }
  addEventListener('hashchange', route);
  const sidebar = $('#sidebar'), scrim = $('#scrim');
  const closeSidebar = () => { sidebar.classList.remove('open'); scrim.classList.remove('open'); };
  const PANE = location.search.indexOf('pane=1') >= 0;
  const appmenu = $('#appmenu');
  const closeMenu = () => { appmenu.hidden = true; };
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isNarrow()) { sidebar.classList.toggle('open'); scrim.classList.toggle('open'); return; }
    appmenu.hidden = !appmenu.hidden;
    $('#menu-inbox-count').textContent = $('#inbox-count').textContent;
    $('#menu-sidebar').textContent = document.documentElement.classList.contains('sidebar-collapsed') ? 'Pin sidebar open' : 'Collapse sidebar';
    $('#menu-split').textContent = state.split ? 'Close split view' : 'Split view';
  });
  document.addEventListener('click', (e) => { if (!appmenu.hidden && !appmenu.contains(e.target)) closeMenu(); });
  appmenu.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  $('#menu-new-notebook').addEventListener('click', () => { closeMenu(); $('#btn-new-notebook').click(); });
  // Collapsible sidebar: collapsed = hidden until you hover the left edge or press Ctrl+\
  const setSidebar = (collapsed) => { document.documentElement.classList.toggle('sidebar-collapsed', collapsed); sidebar.classList.remove('peek'); try { localStorage.setItem('nc-sidebar', collapsed ? 'collapsed' : 'pinned'); } catch (e) { /* ignore */ } };
  const toggleSidebar = () => setSidebar(!document.documentElement.classList.contains('sidebar-collapsed'));
  $('#btn-sidebar').addEventListener('click', toggleSidebar);
  $('#menu-sidebar').addEventListener('click', () => { closeMenu(); toggleSidebar(); });
  let peekTimer = null;
  $('#hoverzone').addEventListener('mouseenter', () => { clearTimeout(peekTimer); sidebar.classList.add('peek'); });
  sidebar.addEventListener('mouseleave', () => { if (document.documentElement.classList.contains('sidebar-collapsed')) peekTimer = setTimeout(() => sidebar.classList.remove('peek'), 250); });
  sidebar.addEventListener('mouseenter', () => clearTimeout(peekTimer));
  // Split view: a second copy of the app in the right-hand pane, sharing the same local store.
  const pane = $('#pane'), paneframe = $('#paneframe'), splitter = $('#splitter');
  const paneUrl = (hash) => location.pathname + '?pane=1' + (hash || '#notes');
  function openSplit(hash) {
    state.split = hash || state.split || '#notes';
    document.body.classList.add('split'); pane.hidden = false; splitter.hidden = false;
    paneframe.src = paneUrl(state.split);
    $('#panetitle').textContent = 'Split view';
    try { localStorage.setItem('nc-split', state.split); } catch (e) { /* ignore */ }
  }
  function closeSplit() {
    state.split = null; document.body.classList.remove('split'); pane.hidden = true; splitter.hidden = true; paneframe.src = 'about:blank';
    try { localStorage.removeItem('nc-split'); } catch (e) { /* ignore */ }
  }
  $('#menu-split').addEventListener('click', () => { closeMenu(); state.split ? closeSplit() : openSplit(state.pageId ? '#page/' + state.pageId : '#notes'); });
  $('#pane-close').addEventListener('click', closeSplit);
  $('#pane-pick').addEventListener('click', async () => { const t = await pickPage('Show in split view'); if (t) openSplit('#page/' + t.id); });
  $('#pane-swap').addEventListener('click', () => { const mine = location.hash || '#inbox'; const theirs = state.split; openSplit(mine); go(theirs && theirs.startsWith('#') ? theirs : '#notes'); });
  let dragging = false;
  splitter.addEventListener('pointerdown', (e) => { dragging = true; splitter.setPointerCapture(e.pointerId); paneframe.style.pointerEvents = 'none'; });
  splitter.addEventListener('pointermove', (e) => { if (!dragging) return; const w = Math.max(320, Math.min(innerWidth * 0.7, innerWidth - e.clientX)); pane.style.setProperty('--pane-w', w + 'px'); });
  splitter.addEventListener('pointerup', () => { dragging = false; paneframe.style.pointerEvents = ''; });
  // Keep the two halves in step: the pane tells the main window when it changes something, and vice versa.
  const bus = ('BroadcastChannel' in window) ? new BroadcastChannel('notecompanion') : null;
  if (bus) bus.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'changed') { refreshTree(); refreshInboxCount(); if (!PANE) S.schedule(); if (state.view === 'inbox') renderInbox(); }
    if (m.type === 'navigated' && !PANE) { state.split = m.hash; $('#panetitle').textContent = m.title || 'Split view'; try { localStorage.setItem('nc-split', m.hash); } catch (e) { /* ignore */ } }
  };
  const announce = (type, extra) => { if (bus) bus.postMessage(Object.assign({ type }, extra || {})); };
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleSidebar(); } });
  $('#btn-back').addEventListener('click', () => history.back());
  $('#btn-fwd').addEventListener('click', () => history.forward());
  $('#btn-reload').addEventListener('click', () => location.reload());
  const undoTarget = () => (window.NCInk && window.NCInk.active) || (state.editor ? { undo: () => state.editor.execCommand('Undo'), redo: () => state.editor.execCommand('Redo') } : (window.NCPDF && window.NCPDF.active) || null);
  $('#btn-undo').addEventListener('click', () => { const t = undoTarget(); if (t) t.undo(); });
  $('#btn-redo').addEventListener('click', () => { const t = undoTarget(); if (t) t.redo(); });
  const refreshUndoButtons = () => { const on = !!undoTarget(); $('#btn-undo').disabled = !on; $('#btn-redo').disabled = !on; };
  setInterval(refreshUndoButtons, 600);
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
  // Sync panel: the whole story behind the pill, live while it is open.
  let syncPanel = null;
  function syncPanelSheet() {
    sheet((box, close) => {
      const dot = el('span', { class: 'dot' });
      const stateEl = el('span', { id: 'sp-state' }, '');
      const title = el('h2', { class: 'syncpanel-title' }, dot, stateEl);
      const msg = el('p', { class: 'syncpanel-msg', id: 'sp-msg' }, '');
      const bar = el('div', { class: 'progress', id: 'sp-bar' }, el('div', { class: 'progress-fill' }));
      const kv = el('div', { class: 'syncpanel-kv' });
      const paint = (st) => {
        const g = G.state();
        dot.dataset.state = st.state;
        stateEl.textContent = st.state === 'ok' ? 'Synced' : st.state === 'syncing' ? 'Syncing' : st.state === 'offline' ? 'Offline' : st.state === 'signedout' ? 'Not signed in' : st.state === 'error' ? 'Sync problem' : 'Starting';
        msg.textContent = st.message || '';
        const m = /(\d+)\s*\/\s*(\d+)/.exec(st.message || '');
        bar.hidden = st.state !== 'syncing';
        bar.classList.toggle('busy', st.state === 'syncing' && !m);
        bar.firstChild.style.width = m ? Math.max(2, Math.round(+m[1] / +m[2] * 100)) + '%' : (st.state === 'syncing' ? '' : '0%');
        kv.replaceChildren(
          el('div', { class: 'kv' }, el('span', {}, 'Account'), el('span', {}, g.signedIn ? (g.name || 'Signed in') : 'Not signed in')),
          el('div', { class: 'kv' }, el('span', {}, 'Waiting to upload'), el('span', {}, String(st.pending || 0))),
          el('div', { class: 'kv' }, el('span', {}, 'Last synced'), el('span', {}, st.lastSync ? fmtWhen(st.lastSync) : 'Never')),
          el('div', { class: 'kv' }, el('span', {}, 'Connection'), el('span', {}, navigator.onLine ? 'Online' : 'Offline')));
      };
      paint(S.status());
      syncPanel = paint;
      box.append(title, msg, bar, kv, el('div', { class: 'actions' },
        el('a', { class: 'btn', href: '#settings', onclick: () => close() }, 'Settings'),
        G.state().signedIn ? el('button', { class: 'btn primary', type: 'button', onclick: () => { S.run(); } }, 'Sync now') : el('button', { class: 'btn primary', type: 'button', onclick: () => { close(); go('#settings'); } }, 'Sign in'),
        el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
      const stop = () => { syncPanel = null; };
      box.addEventListener('nc-close', stop);
    }).then(() => { syncPanel = null; });
  }
  pill.addEventListener('click', () => syncPanelSheet());
  S.onChange((st) => { showStatus(st); if (syncPanel) syncPanel(st); });
  G.onThrottle = (ms) => { const sec = Math.round(ms / 1000); if (sec >= 5) toast('Microsoft is rate-limiting; waiting ' + sec + ' s before retrying'); };
  G.onChange(() => { if (state.view === 'settings') renderSettings(); S.schedule(300); });

  // Installed-app shortcut (Windows/Android): ?shift=1 opens Shift Companion.
  if (!PANE && /[?&](shift|job)=1/.test(location.search)) { history.replaceState(null, '', location.pathname + '#shift'); }

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && !PANE) {
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
    if (!(await meta.get('groupsMigrated'))) {
      for (const sc of await window.NCDB.db.sections.toArray()) {
        if (!sc.group && sc.name && sc.name.includes(' / ')) { const parts = sc.name.split(' / '); await sections.update(sc.id, { group: parts.slice(0, -1).join(' / '), name: parts[parts.length - 1] }); }
      }
      await meta.set('groupsMigrated', true);
    }
    if (!(await meta.get('importedPropStripped'))) {
      for (const q of await window.NCDB.db.pages.toArray()) if ((q.props || []).some((x) => x.k === 'Imported from')) await pages.update(q.id, { props: q.props.filter((x) => x.k !== 'Imported from') });
      await meta.set('importedPropStripped', true);
    }
    if (PANE) { await refreshTree(); await refreshInboxCount(); await route(); return; }
    await handleURLCapture();
    await refreshTree(); await refreshInboxCount();
    await route();
    try { const sp = localStorage.getItem('nc-split'); if (sp && !isNarrow()) openSplit(sp); } catch (e) { /* ignore */ }
    await G.init();
    await S.init();
    if (G.state().signedIn) S.schedule(600);
    else { const seen = await meta.get('introSeen'); if (!seen) { await meta.set('introSeen', true); toast('Sign in to sync with OneDrive', { label: 'Open settings', fn: () => go('#settings') }); } }
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.view === 'page') renderPage(state.pageId); });
  })();
})();

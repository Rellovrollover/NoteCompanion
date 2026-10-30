// Ink on note pages: a drawing layer over the editor. Strokes are stored on the page as
// { strokes: [{ t: 'pen'|'hl', c, w, pts: [[x, y, p], ...] }] } in CSS pixels relative to the
// editor box, so they sit where they were drawn whatever the text does (like OneNote).
(function () {
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
  const COLOURS = ['#1a1d23', '#d32f2f', '#ef6c00', '#c99700', '#2e7d32', '#1e66d0', '#3f3fb0', '#8e3fbf']; // black, then red orange yellow (golden, so it shows on white) green blue indigo violet
  const COLOUR_NAMES = { '#1a1d23': 'Black', '#d32f2f': 'Red', '#ef6c00': 'Orange', '#c99700': 'Yellow', '#2e7d32': 'Green', '#1e66d0': 'Blue', '#3f3fb0': 'Indigo', '#8e3fbf': 'Violet' };
  const HL_COLOURS = ['#ffe44d', '#9be36d', '#7fd3ff', '#ff9ec4', '#ffb257'];
  // Shares the PDF pen's preferences so the same colour and width follow you between the two.
  const prefs = { tool: 'pen', colour: COLOURS[0], hlColour: HL_COLOURS[0], width: 2, fingerDraws: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}')); } catch (e) { /* ignore */ }
  if (!prefs.palette2 || !COLOURS.includes(prefs.colour)) { prefs.colour = COLOURS[0]; prefs.palette2 = 1; try { localStorage.setItem('nc-pdf-prefs', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}'), { colour: prefs.colour, palette2: 1 }))); } catch (e) { /* ignore */ } }
  const savePrefs = () => { try { const cur = JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}'); localStorage.setItem('nc-pdf-prefs', JSON.stringify(Object.assign(cur, { colour: prefs.colour, hlColour: prefs.hlColour, width: prefs.width, fingerDraws: prefs.fingerDraws, palette2: 1 }))); } catch (e) { /* ignore */ } };
  const I = {
    pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13 7l3 3" stroke="currentColor" stroke-width="1.7"/></svg>',
    hl: '<svg viewBox="0 0 24 24"><path d="M9 17l-3 3H3l4-4M8 16l-1-1 8-8a2 2 0 0 1 3 3l-8 8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 21h16" stroke="currentColor" stroke-width="2.5"/></svg>',
    eraser: '<svg viewBox="0 0 24 24"><path d="M4 15l8-8a2 2 0 0 1 3 0l5 5-7 7H8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 11l5 5M6 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M8 7H4v4M4.5 11a8 8 0 1 1 1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M16 7h4v4M19.5 11a8 8 0 1 0-1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  // Draws a stroke (or, for the pen, just its points from index `from` on — used while it's being drawn).
  function drawStroke(ctx, s, from) {
    const pts = s.pts; if (!pts || !pts.length) return;
    ctx.save();
    ctx.lineCap = s.t === 'hl' ? 'butt' : 'round'; ctx.lineJoin = 'round';
    if (s.t === 'hl') { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; }
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
    const base = s.w * 1.3;
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], base * (s.t === 'hl' ? 4 : 0.6), 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
    if (s.t === 'hl') {
      ctx.lineWidth = base * 7; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke(); ctx.restore(); return;
    }
    for (let i = Math.max(1, from || 1); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const p = ((a[2] || 0.5) + (b[2] || 0.5)) / 2;
      ctx.lineWidth = Math.max(0.7, base * (0.45 + p * 1.1));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }
  const extent = (strokes) => { let b = 0; for (const s of strokes) for (const p of s.pts) if (p[1] > b) b = p[1]; return b; };
  const halfWidth = (s) => (s.t === 'hl' ? s.w * 1.3 * 3.5 : s.w * 1.3 * 0.8);
  const ERASE_SIZES = [[6, 6, 'Small'], [14, 10, 'Medium'], [28, 16, 'Large']];

  // host: the .editor-host box (position: relative). data: page.ink or undefined. onChange(ink) persists.
  // The canvases are the size of the screen, not the note, and follow the scroll (position: sticky): only what's in
  // view is drawn, and the stroke you're drawing has a layer of its own, so long notes stay quick.
  function attach(host, data, onChange, ui) {
    const ink = data && Array.isArray(data.strokes) ? data : { strokes: [] };
    const canvas = el('canvas', { class: 'inklayer' }), liveCv = el('canvas', { class: 'inklive' });
    const view = el('div', { class: 'ink-view' }, canvas, liveCv);
    const wrap = el('div', { class: 'ink-wrap' }, view);
    host.append(wrap);
    host.classList.toggle('has-ink', ink.strokes.length > 0);
    const dpr = Math.min(2, devicePixelRatio || 1);
    let W = 0, Hv = 0, offY = 0, live = null, liveDrawn = 0, active = null, drawing = false, cursor = null, roomFor = 0;
    const undo = [], redo = [];
    const boxes = new WeakMap();
    const boxOf = (s) => { let b = boxes.get(s); if (!b) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of s.pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; } const pad = halfWidth(s) + 2; b = [x0 - pad, y0 - pad, x1 + pad, y1 + pad]; boxes.set(s, b); } return b; };
    let saveT = 0, pending = false;
    const save = () => { host.classList.toggle('has-ink', ink.strokes.length > 0); pending = true; clearTimeout(saveT); saveT = setTimeout(() => { pending = false; onChange({ strokes: ink.strokes }); }, 250); };

    // Line the screen-sized canvases up with the part of the note that's in view.
    function layout() {
      const hr = host.getBoundingClientRect(), vr = view.getBoundingClientRect();
      offY = Math.max(0, vr.top - hr.top);
      const w = Math.round(hr.width), h = Math.round(vr.height);
      if (w !== W || h !== Hv) { W = w; Hv = h; for (const c of [canvas, liveCv]) { c.width = Math.max(1, W * dpr); c.height = Math.max(1, Hv * dpr); c.style.width = W + 'px'; c.style.height = Hv + 'px'; } return true; }
      return false;
    }
    const prep = (c) => { const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, -offY * dpr); return ctx; };
    function paint() {
      layout();
      const ctx = prep(canvas);
      ctx.clearRect(0, offY, W, Hv);
      const top = offY - 4, bot = offY + Hv + 4;
      for (const s of ink.strokes) { const b = boxOf(s); if (b[3] < top || b[1] > bot) continue; drawStroke(ctx, s); }
      paintLive(true);
    }
    function paintLive(full) {
      const ctx = prep(liveCv);
      const pen = live && live.t !== 'hl' && !cursor;
      if (full || !pen) { ctx.clearRect(0, offY, W, Hv); liveDrawn = 0; }
      if (live) { if (live.t === 'hl') drawStroke(ctx, live); else if (live.pts.length > 1) { drawStroke(ctx, live, Math.max(1, liveDrawn)); liveDrawn = live.pts.length - 1; } }
      if (cursor) { ctx.save(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(60,70,85,.75)'; ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], cursor[2], 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore(); }
    }
    let raf = 0;
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; paint(); if (drawing) room(); }); };
    // Room to keep writing: the note grows to fit the ink, and while drawing there's always a screen of blank paper
    // below — scroll towards the bottom and it keeps going.
    function room(more) {
      const vh = window.innerHeight || 800;
      let need = Math.ceil(extent(ink.strokes) + (drawing ? vh * 0.9 : 120));
      if (drawing) { const hr = host.getBoundingClientRect(); if (more || hr.bottom < vh * 1.6) need = Math.max(need, Math.ceil(hr.height + vh)); }
      if (need <= roomFor) return;
      roomFor = need;
      host.style.minHeight = need + 'px';
      if (ui && ui.extend) ui.extend(need);
    }
    const ro = new ResizeObserver(() => schedule());
    ro.observe(host);
    const onScroll = () => schedule();
    addEventListener('scroll', onScroll, { passive: true, capture: true });
    addEventListener('resize', onScroll);
    roomFor = Math.ceil(host.getBoundingClientRect().height);
    paint(); room();

    // ---- toolbar (shown while drawing) ----
    const toolBtns = {};
    // Double-tap the pen (or highlighter) button for the eraser; double-tap the eraser to go back to what you had.
    let lastTap = { k: '', t: 0 }, beforeEraser = 'pen';
    const tapTool = (key) => {
      const now = Date.now(), dbl = lastTap.k === key && now - lastTap.t < 450; lastTap = { k: key, t: now };
      if (dbl && key === prefs.tool && key !== 'eraser') { beforeEraser = key; lastTap = { k: '', t: 0 }; setTool('eraser'); return; }
      if (dbl && key === 'eraser' && prefs.tool === 'eraser') { lastTap = { k: '', t: 0 }; setTool(beforeEraser); return; }
      if (key === 'eraser' && prefs.tool !== 'eraser') beforeEraser = prefs.tool;
      setTool(key);
    };
    const mkTool = (key, label) => { const b = el('button', { class: 'ptool', type: 'button', title: label + (key === 'eraser' ? ' (double-tap to go back)' : ' (double-tap for eraser)'), 'aria-label': label, html: I[key], onclick: () => tapTool(key) }); toolBtns[key] = b; return b; };
    const colourRow = el('div', { class: 'pcolours' }), widthRow = el('div', { class: 'pwidths' }), eraseRow = el('div', { class: 'perase' });
    const redrawColours = () => {
      colourRow.innerHTML = '';
      const list = prefs.tool === 'hl' ? HL_COLOURS : COLOURS;
      const cur = prefs.tool === 'hl' ? prefs.hlColour : prefs.colour;
      for (const c of list) colourRow.append(el('button', { class: 'pcol' + (c === cur ? ' on' : ''), type: 'button', style: '--c:' + c, 'aria-label': COLOUR_NAMES[c] || c, title: COLOUR_NAMES[c] || '', onclick: () => { if (prefs.tool === 'hl') prefs.hlColour = c; else prefs.colour = c; savePrefs(); redrawColours(); } }));
      widthRow.innerHTML = '';
      for (const [w, d, label] of [[1.2, 4, 'Thin'], [2, 7, 'Medium'], [3.5, 11, 'Thick']]) widthRow.append(el('button', { class: 'pw pw-dot' + (prefs.width === w ? ' on' : ''), type: 'button', title: label, 'aria-label': label + ' pen', onclick: () => { prefs.width = w; savePrefs(); redrawColours(); } }, el('span', { class: 'pdot', style: 'width:' + d + 'px;height:' + d + 'px;background:' + (prefs.tool === 'hl' ? prefs.hlColour : prefs.colour) })));
      // Eraser: whole strokes or just the bit you rub over, in three sizes.
      eraseRow.innerHTML = '';
      const mode = prefs.eraseMode === 'area' ? 'area' : 'stroke', size = prefs.eraseSize || 14;
      eraseRow.append(el('div', { class: 'seg perase-mode' }, ...[['stroke', 'Whole stroke'], ['area', 'Part']].map(([k, v]) => el('button', { type: 'button', class: mode === k ? 'on' : '', title: k === 'stroke' ? 'Erase whole strokes you touch' : 'Erase just the part you rub over', onclick: () => { prefs.eraseMode = k; savePrefs(); redrawColours(); } }, v))),
        el('div', { class: 'pwidths' }, ...ERASE_SIZES.map(([r, d, label]) => el('button', { class: 'pw pw-dot' + (size === r ? ' on' : ''), type: 'button', title: label + ' eraser', 'aria-label': label + ' eraser', onclick: () => { prefs.eraseSize = r; savePrefs(); redrawColours(); } }, el('span', { class: 'pdot ring', style: 'width:' + d + 'px;height:' + d + 'px' })))));
      colourRow.hidden = widthRow.hidden = prefs.tool === 'eraser';
      eraseRow.hidden = prefs.tool !== 'eraser';
    };
    const fingerBtn = el('button', { class: 'ptool text' + (prefs.fingerDraws ? ' on' : ''), type: 'button', title: 'Finger draws (off: finger scrolls, Pencil draws)', onclick: () => { prefs.fingerDraws = !prefs.fingerDraws; savePrefs(); fingerBtn.classList.toggle('on', prefs.fingerDraws); applyTouch(); } }, 'Finger');
    const bar = el('div', { class: 'inkbar' },
      el('div', { class: 'pgroup' }, mkTool('pen', 'Pen'), mkTool('hl', 'Highlighter'), mkTool('eraser', 'Eraser')),
      colourRow, widthRow, eraseRow,
      el('div', { class: 'pgroup' }, el('button', { class: 'ptool', type: 'button', title: 'Undo', html: I.undo, onclick: () => doUndo() }), el('button', { class: 'ptool', type: 'button', title: 'Redo', html: I.redo, onclick: () => doRedo() })),
      el('div', { class: 'pgroup' }, fingerBtn),
      el('button', { class: 'ptool done', type: 'button', title: 'Finish drawing', html: I.done + '<span>Done</span>', onclick: () => setDrawing(false) }));
    bar.hidden = true;
    document.body.append(bar);
    function setTool(t) { if (t === 'pan') t = 'pen'; prefs.tool = t; for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === t); redrawColours(); applyTouch(); }
    function applyTouch() { canvas.style.touchAction = liveCv.style.touchAction = drawing && prefs.fingerDraws ? 'none' : 'pan-x pan-y'; }
    function setDrawing(on) {
      drawing = on;
      host.classList.toggle('inking', on);
      bar.hidden = !on;
      if (on) { if (!['pen', 'hl', 'eraser'].includes(prefs.tool)) prefs.tool = 'pen'; setTool(prefs.tool); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); window.NCInk.active = { undo: doUndo, redo: doRedo }; room(); }
      else { window.NCInk.active = null; cursor = null; paintLive(true); }
      if (ui && ui.onMode) ui.onMode(on);
      applyTouch();
    }

    // ---- pointer handling (on the live layer, which sits on top) ----
    const blockStylus = (e) => { if (!drawing) return; for (const t of e.touches) if (t.touchType === 'stylus' || prefs.fingerDraws) { e.preventDefault(); return; } };
    liveCv.addEventListener('touchstart', blockStylus, { passive: false });
    liveCv.addEventListener('touchmove', blockStylus, { passive: false });
    let hostTop = 0, hostLeft = 0;
    const pt = (e) => [Math.round((e.clientX - hostLeft) * 10) / 10, Math.round((e.clientY - hostTop) * 10) / 10, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5];
    const eraseR = () => prefs.eraseSize || 14;
    liveCv.addEventListener('pointerdown', (e) => {
      if (!drawing) return;
      if (e.pointerType === 'touch' && !prefs.fingerDraws) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const hr = host.getBoundingClientRect(); hostTop = hr.top; hostLeft = hr.left; layout();
      const p = pt(e);
      if (prefs.tool === 'eraser') { active = { id: e.pointerId, erase: true, ops: [] }; eraseAt(p); cursor = [p[0], p[1], eraseR()]; paintLive(true); try { liveCv.setPointerCapture(e.pointerId); } catch (err) { /* already released */ } return; }
      live = { t: prefs.tool, c: prefs.tool === 'hl' ? prefs.hlColour : prefs.colour, w: prefs.width, pts: [p] };
      liveDrawn = 0;
      active = { id: e.pointerId }; try { liveCv.setPointerCapture(e.pointerId); } catch (err) { /* already released */ }
    });
    liveCv.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== active.id) return;
      e.preventDefault();
      const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const events = co && co.length ? co : [e];
      if (active.erase) { let hit = false; for (const ev of events) hit = eraseAt(pt(ev)) || hit; const q = pt(e); cursor = [q[0], q[1], eraseR()]; if (hit) paint(); else paintLive(true); return; }
      for (const ev of events) { const p = pt(ev); const last = live.pts[live.pts.length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.6) live.pts.push(p); }
      paintLive(false);
    });
    const finish = (e) => {
      if (!active || e.pointerId !== active.id) return;
      if (!active.erase && live) {
        const s = live; live = null; ink.strokes.push(s); undo.push({ op: 'add', stroke: s }); redo.length = 0;
        drawStroke(prep(canvas), s); paintLive(true); save(); room();
      } else if (active.erase) {
        cursor = null; paintLive(true);
        if (active.ops.length) { undo.push({ op: 'group', ops: active.ops }); redo.length = 0; save(); }
      }
      active = null;
    };
    liveCv.addEventListener('pointerup', finish); liveCv.addEventListener('pointercancel', finish);
    // Whole-stroke eraser takes away any stroke it touches; the part eraser cuts out just what's under it.
    function eraseAt(p) {
      const r = eraseR(); let hit = false;
      for (let k = ink.strokes.length - 1; k >= 0; k--) {
        const s = ink.strokes[k], b = boxOf(s);
        if (p[0] < b[0] - r || p[0] > b[2] + r || p[1] < b[1] - r || p[1] > b[3] + r) continue;
        const reach = r + halfWidth(s);
        const inside = s.pts.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < reach);
        if (!inside.some(Boolean)) continue;
        hit = true;
        if (prefs.eraseMode !== 'area') { ink.strokes.splice(k, 1); active.ops.push({ op: 'remove', stroke: s, index: k }); continue; }
        const parts = []; let cur = null;
        s.pts.forEach((q, i) => { if (inside[i]) { cur = null; return; } if (!cur) { cur = { t: s.t, c: s.c, w: s.w, pts: [] }; parts.push(cur); } cur.pts.push(q); });
        ink.strokes.splice(k, 1, ...parts);
        active.ops.push({ op: 'replace', old: s, news: parts, index: k });
      }
      return hit;
    }
    function apply(a, inverse) {
      if (a.op === 'group') { const ops = inverse ? a.ops.slice().reverse() : a.ops; for (const o of ops) apply(o, inverse); return; }
      if (a.op === 'replace') {
        if (!inverse) { const k = ink.strokes.indexOf(a.old); if (k >= 0) ink.strokes.splice(k, 1, ...a.news); }
        else { for (const n of a.news) { const k = ink.strokes.indexOf(n); if (k >= 0) ink.strokes.splice(k, 1); } ink.strokes.splice(Math.min(a.index, ink.strokes.length), 0, a.old); }
        return;
      }
      const add = (a.op === 'add') !== inverse;
      if (add) ink.strokes.splice(a.index == null ? ink.strokes.length : Math.min(a.index, ink.strokes.length), 0, a.stroke);
      else { const k = ink.strokes.indexOf(a.stroke); if (k >= 0) ink.strokes.splice(k, 1); }
    }
    function doUndo() { const a = undo.pop(); if (!a) return; apply(a, true); redo.push(a); paint(); save(); }
    function doRedo() { const a = redo.pop(); if (!a) return; apply(a, false); undo.push(a); paint(); save(); }
    const keyHandler = (e) => { if (!drawing) return; if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); } if (e.key === 'Escape') setDrawing(false); };
    document.addEventListener('keydown', keyHandler);

    return {
      setDrawing, isDrawing: () => drawing, hasInk: () => ink.strokes.length > 0,
      clear: () => { const all = ink.strokes.splice(0); undo.push({ op: 'group', ops: all.map((s, i) => ({ op: 'remove', stroke: s, index: i })).reverse() }); redo.length = 0; paint(); save(); },
      // Printing a note with handwriting: one full-height canvas for the moment, then back to the quick one.
      printMode: (on) => {
        if (on) { const h = Math.ceil(host.getBoundingClientRect().height), w = Math.ceil(host.getBoundingClientRect().width); const k = Math.min(1.5, Math.sqrt(14e6 / Math.max(1, w * h))); view.classList.add('printing'); canvas.width = Math.max(1, w * k); canvas.height = Math.max(1, h * k); canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; const ctx = canvas.getContext('2d'); ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, w, h); for (const s of ink.strokes) drawStroke(ctx, s); W = 0; }
        else { view.classList.remove('printing'); W = 0; paint(); }
      },
      destroy: () => { ro.disconnect(); removeEventListener('scroll', onScroll, { capture: true }); removeEventListener('resize', onScroll); document.removeEventListener('keydown', keyHandler); clearTimeout(saveT); if (pending) onChange({ strokes: ink.strokes }); bar.remove(); wrap.remove(); host.classList.remove('inking', 'has-ink'); host.style.minHeight = ''; window.NCInk.active = null; }
    };
  }

  // Draw a page's ink onto any canvas context (used by exports).
  function paintOnto(ctx, ink) { for (const s of (ink && ink.strokes) || []) drawStroke(ctx, s); }

  window.NCInk = { attach, paintOnto, active: null, COLOURS, HL_COLOURS };
})();

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
  const COLOURS = ['#1a1d23', '#2f5d8a', '#b03a3a', '#2e7d5b', '#7b3f8c', '#b8651b'];
  const HL_COLOURS = ['#ffe44d', '#9be36d', '#7fd3ff', '#ff9ec4', '#ffb257'];
  // Shares the PDF pen's preferences so the same colour and width follow you between the two.
  const prefs = { tool: 'pen', colour: COLOURS[1], hlColour: HL_COLOURS[0], width: 2, fingerDraws: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}')); } catch (e) { /* ignore */ }
  const savePrefs = () => { try { const cur = JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}'); localStorage.setItem('nc-pdf-prefs', JSON.stringify(Object.assign(cur, { colour: prefs.colour, hlColour: prefs.hlColour, width: prefs.width, fingerDraws: prefs.fingerDraws }))); } catch (e) { /* ignore */ } };
  const I = {
    pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13 7l3 3" stroke="currentColor" stroke-width="1.7"/></svg>',
    hl: '<svg viewBox="0 0 24 24"><path d="M9 17l-3 3H3l4-4M8 16l-1-1 8-8a2 2 0 0 1 3 3l-8 8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 21h16" stroke="currentColor" stroke-width="2.5"/></svg>',
    eraser: '<svg viewBox="0 0 24 24"><path d="M4 15l8-8a2 2 0 0 1 3 0l5 5-7 7H8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 11l5 5M6 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M8 7H4v4M4.5 11a8 8 0 1 1 1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M16 7h4v4M19.5 11a8 8 0 1 0-1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function drawStroke(ctx, s) {
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
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const p = ((a[2] || 0.5) + (b[2] || 0.5)) / 2;
      ctx.lineWidth = Math.max(0.7, base * (0.45 + p * 1.1));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }
  const distToStroke = (s, x, y) => { let m = Infinity; for (const p of s.pts) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < m) m = d; } return m; };
  const extent = (strokes) => { let b = 0; for (const s of strokes) for (const p of s.pts) if (p[1] > b) b = p[1]; return b; };

  // host: the .editor-host box (position: relative). data: page.ink or undefined. onChange(ink) persists.
  function attach(host, data, onChange, ui) {
    const ink = data && Array.isArray(data.strokes) ? data : { strokes: [] };
    const canvas = el('canvas', { class: 'inklayer' });
    host.append(canvas);
    host.classList.toggle('has-ink', ink.strokes.length > 0);
    let dpr = Math.min(2, devicePixelRatio || 1), W = 0, H = 0, live = null, active = null, drawing = false;
    const undo = [], redo = [];
    const save = () => { host.classList.toggle('has-ink', ink.strokes.length > 0); onChange({ strokes: ink.strokes }); };

    function size() {
      const r = host.getBoundingClientRect();
      const need = Math.ceil(extent(ink.strokes) + 120);
      // Make room below the text when ink runs past it.
      host.style.minHeight = need > r.height ? need + 'px' : '';
      const h = Math.max(r.height, need > r.height ? need : 0);
      if (Math.round(r.width) === W && Math.round(h) === H) return;
      W = Math.round(r.width); H = Math.round(h);
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      paint();
    }
    function paint() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      for (const s of ink.strokes) drawStroke(ctx, s);
      if (live) drawStroke(ctx, live);
    }
    const ro = new ResizeObserver(() => size());
    ro.observe(host);
    size();

    // ---- toolbar (shown while drawing) ----
    const toolBtns = {};
    const mkTool = (key, label) => { const b = el('button', { class: 'ptool', type: 'button', title: label, 'aria-label': label, html: I[key], onclick: () => setTool(key) }); toolBtns[key] = b; return b; };
    const colourRow = el('div', { class: 'pcolours' }), widthRow = el('div', { class: 'pwidths' });
    const redrawColours = () => {
      colourRow.innerHTML = '';
      const list = prefs.tool === 'hl' ? HL_COLOURS : COLOURS;
      const cur = prefs.tool === 'hl' ? prefs.hlColour : prefs.colour;
      for (const c of list) colourRow.append(el('button', { class: 'pcol' + (c === cur ? ' on' : ''), type: 'button', style: '--c:' + c, 'aria-label': c, onclick: () => { if (prefs.tool === 'hl') prefs.hlColour = c; else prefs.colour = c; savePrefs(); redrawColours(); } }));
      widthRow.innerHTML = '';
      for (const [w, label] of [[1.2, 'S'], [2, 'M'], [3.5, 'L']]) widthRow.append(el('button', { class: 'pw' + (prefs.width === w ? ' on' : ''), type: 'button', onclick: () => { prefs.width = w; savePrefs(); redrawColours(); } }, label));
      colourRow.hidden = widthRow.hidden = prefs.tool === 'eraser';
    };
    const fingerBtn = el('button', { class: 'ptool text' + (prefs.fingerDraws ? ' on' : ''), type: 'button', title: 'Finger draws (off: finger scrolls, Pencil draws)', onclick: () => { prefs.fingerDraws = !prefs.fingerDraws; savePrefs(); fingerBtn.classList.toggle('on', prefs.fingerDraws); applyTouch(); } }, 'Finger');
    const bar = el('div', { class: 'inkbar' },
      el('div', { class: 'pgroup' }, mkTool('pen', 'Pen'), mkTool('hl', 'Highlighter'), mkTool('eraser', 'Eraser')),
      colourRow, widthRow,
      el('div', { class: 'pgroup' }, el('button', { class: 'ptool', type: 'button', title: 'Undo', html: I.undo, onclick: () => doUndo() }), el('button', { class: 'ptool', type: 'button', title: 'Redo', html: I.redo, onclick: () => doRedo() })),
      el('div', { class: 'pgroup' }, fingerBtn),
      el('button', { class: 'ptool done', type: 'button', title: 'Finish drawing', html: I.done + '<span>Done</span>', onclick: () => setDrawing(false) }));
    bar.hidden = true;
    document.body.append(bar);
    function setTool(t) { if (t === 'pan') t = 'pen'; prefs.tool = t; for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === t); redrawColours(); applyTouch(); }
    function applyTouch() { canvas.style.touchAction = drawing && prefs.fingerDraws ? 'none' : 'pan-x pan-y'; }
    function setDrawing(on) {
      drawing = on;
      host.classList.toggle('inking', on);
      bar.hidden = !on;
      if (on) { if (!['pen', 'hl', 'eraser'].includes(prefs.tool)) prefs.tool = 'pen'; setTool(prefs.tool); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); window.NCInk.active = { undo: doUndo, redo: doRedo }; }
      else { window.NCInk.active = null; }
      if (ui && ui.onMode) ui.onMode(on);
      applyTouch();
    }

    // ---- pointer handling ----
    const blockStylus = (e) => { if (!drawing) return; for (const t of e.touches) if (t.touchType === 'stylus' || prefs.fingerDraws) { e.preventDefault(); return; } };
    canvas.addEventListener('touchstart', blockStylus, { passive: false });
    canvas.addEventListener('touchmove', blockStylus, { passive: false });
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5]; };
    canvas.addEventListener('pointerdown', (e) => {
      if (!drawing) return;
      if (e.pointerType === 'touch' && !prefs.fingerDraws) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const p = pt(e);
      if (prefs.tool === 'eraser') { active = { id: e.pointerId, erase: true }; eraseAt(p); canvas.setPointerCapture(e.pointerId); return; }
      live = { t: prefs.tool, c: prefs.tool === 'hl' ? prefs.hlColour : prefs.colour, w: prefs.width, pts: [p] };
      active = { id: e.pointerId }; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== active.id) return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (active.erase) { for (const ev of events) eraseAt(pt(ev)); return; }
      for (const ev of events) { const p = pt(ev); const last = live.pts[live.pts.length - 1]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.6) live.pts.push(p); }
      paint();
    });
    const finish = (e) => {
      if (!active || e.pointerId !== active.id) return;
      if (!active.erase && live) { const s = live; live = null; ink.strokes.push(s); undo.push({ op: 'add', stroke: s }); redo.length = 0; save(); size(); paint(); }
      else if (active.erased) save();
      active = null;
    };
    canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
    function eraseAt(p) {
      for (let k = ink.strokes.length - 1; k >= 0; k--) {
        const s = ink.strokes[k];
        if (distToStroke(s, p[0], p[1]) < (s.t === 'hl' ? 18 : 9)) { ink.strokes.splice(k, 1); undo.push({ op: 'remove', stroke: s, index: k }); redo.length = 0; active.erased = true; paint(); }
      }
    }
    function apply(a, inverse) {
      const add = (a.op === 'add') !== inverse;
      if (add) ink.strokes.splice(a.index == null ? ink.strokes.length : Math.min(a.index, ink.strokes.length), 0, a.stroke);
      else { const k = ink.strokes.indexOf(a.stroke); if (k >= 0) ink.strokes.splice(k, 1); }
      paint();
    }
    function doUndo() { const a = undo.pop(); if (!a) return; apply(a, true); redo.push(a); save(); }
    function doRedo() { const a = redo.pop(); if (!a) return; apply(a, false); undo.push(a); save(); }
    const keyHandler = (e) => { if (!drawing) return; if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); } if (e.key === 'Escape') setDrawing(false); };
    document.addEventListener('keydown', keyHandler);

    return {
      setDrawing, isDrawing: () => drawing, hasInk: () => ink.strokes.length > 0,
      clear: () => { const all = ink.strokes.splice(0); for (const s of all) undo.push({ op: 'remove', stroke: s, index: 0 }); redo.length = 0; paint(); save(); },
      destroy: () => { ro.disconnect(); document.removeEventListener('keydown', keyHandler); bar.remove(); canvas.remove(); host.classList.remove('inking', 'has-ink'); host.style.minHeight = ''; window.NCInk.active = null; }
    };
  }

  // Draw a page's ink onto any canvas context (used by exports).
  function paintOnto(ctx, ink) { for (const s of (ink && ink.strokes) || []) drawStroke(ctx, s); }

  window.NCInk = { attach, paintOnto, active: null, COLOURS, HL_COLOURS };
})();

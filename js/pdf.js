// PDF library and markup: PDFs are pages of kind 'pdf' whose file lives in the asset store.
// Annotations are stored on the page record as `annots` { pageNo: [stroke] } in normalised
// page coordinates (0..1 of width/height), so they are independent of zoom and device.
(function () {
  const { pages, assets } = window.NCDB;
  const S = window.NCSync;
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

  function lib() {
    return new Promise((resolve, reject) => {
      let n = 0;
      const t = setInterval(() => {
        if (window.pdfjsLib) { clearInterval(t); window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', window.NC_CONFIG.redirectUri).href; resolve(window.pdfjsLib); }
        else if (++n > 200) { clearInterval(t); reject(new Error('PDF engine did not load')); }
      }, 50);
    });
  }
  async function openDoc(assetId) {
    const a = await assets.get(assetId);
    if (!a || !a.blob) throw Object.assign(new Error('This PDF is not on this device yet. Sync and try again.'), { missing: true });
    const pdfjs = await lib();
    const data = await a.blob.arrayBuffer();
    return pdfjs.getDocument({ data, cMapPacked: true }).promise;
  }

  // ---------- import ----------
  async function thumbnail(doc) {
    try {
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 }); const scale = 220 / vp.width;
      const v2 = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.round(v2.width); c.height = Math.round(v2.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }
  async function extractText(doc, limit) {
    let out = '';
    for (let i = 1; i <= Math.min(doc.numPages, 400) && out.length < limit; i++) {
      try { const tc = await (await doc.getPage(i)).getTextContent(); out += tc.items.map((it) => it.str).join(' ') + '\n'; } catch (e) { /* skip */ }
    }
    return out.slice(0, limit);
  }
  // Called after a PDF asset has been stored: fills in page count, thumbnail and searchable text.
  async function enrich(pageId, assetId) {
    try {
      const doc = await openDoc(assetId);
      const patch = { pdfPages: doc.numPages, thumb: await thumbnail(doc), pdfText: await extractText(doc, 300000) };
      await pages.update(pageId, patch); S.schedule();
      doc.destroy();
    } catch (e) { console.warn('pdf enrich failed', e); }
  }

  // ---------- viewer + markup ----------
  const TOOLS = { pan: 'Scroll', pen: 'Pen', hl: 'Highlighter', eraser: 'Eraser' };
  const COLOURS = ['#1a1d23', '#2f5d8a', '#b03a3a', '#2e7d5b', '#7b3f8c', '#b8651b'];
  const HL_COLOURS = ['#ffe44d', '#9be36d', '#7fd3ff', '#ff9ec4', '#ffb257'];
  const prefs = { tool: 'pen', colour: COLOURS[1], hlColour: HL_COLOURS[0], width: 2, fingerDraws: false, zoom: 1 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nc-pdf-prefs') || '{}')); } catch (e) { /* ignore */ }
  const savePrefs = () => { try { localStorage.setItem('nc-pdf-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  function drawStrokes(ctx, strokes, W, H) {
    for (const s of strokes) drawStroke(ctx, s, W, H);
  }
  const SHAPES = new Set(['rect', 'ellipse', 'line', 'arrow']);
  // Word-wrap text into lines that fit `maxW` (canvas px) at the current ctx font.
  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const t = line ? line + ' ' + word : word;
        if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  }
  function textBox(s, W, H) {
    const size = (s.size || 14) * (W / 600);
    const width = (s.w ? s.w * W : W - s.x * W - 8);
    return { x: s.x * W, y: s.y * H, size, width, lineH: size * 1.25 };
  }
  function drawText(ctx, s, W, H) {
    const b = textBox(s, W, H);
    ctx.save();
    ctx.font = '500 ' + b.size + 'px Calibri, Carlito, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = s.c; ctx.textBaseline = 'top';
    const lines = wrapText(ctx, s.text || '', b.width);
    lines.forEach((ln, i) => ctx.fillText(ln, b.x, b.y + i * b.lineH));
    ctx.restore();
    return { x: b.x, y: b.y, w: b.width, h: lines.length * b.lineH };
  }
  function drawShape(ctx, s, W, H) {
    const [a, b] = s.pts; if (!a || !b) return;
    const x0 = a[0] * W, y0 = a[1] * H, x1 = b[0] * W, y1 = b[1] * H;
    ctx.save();
    ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(1, s.w * (W / 600) * 1.2); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    if (s.t === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else if (s.t === 'ellipse') ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    else { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
    ctx.stroke();
    if (s.t === 'arrow') {
      const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.max(8, ctx.lineWidth * 4);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - len * Math.cos(ang - 0.45), y1 - len * Math.sin(ang - 0.45));
      ctx.moveTo(x1, y1); ctx.lineTo(x1 - len * Math.cos(ang + 0.45), y1 - len * Math.sin(ang + 0.45)); ctx.stroke();
    }
    ctx.restore();
  }
  function drawStroke(ctx, s, W, H) {
    if (s.t === 'text') { drawText(ctx, s, W, H); return; }
    if (SHAPES.has(s.t)) { drawShape(ctx, s, W, H); return; }
    const pts = s.pts; if (!pts || pts.length < 1) return;
    ctx.save();
    ctx.lineCap = s.t === 'hl' ? 'butt' : 'round'; ctx.lineJoin = 'round';
    if (s.t === 'hl') { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; }
    ctx.strokeStyle = s.c;
    const base = s.w * (W / 600); // widths are stored relative to a 600px-wide page
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * W, pts[0][1] * H, base * (s.t === 'hl' ? 4 : 0.6), 0, Math.PI * 2); ctx.fillStyle = s.c; ctx.fill(); ctx.restore(); return; }
    if (s.t === 'hl') {
      ctx.lineWidth = base * 7; ctx.beginPath(); ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
      ctx.stroke(); ctx.restore(); return;
    }
    // Pen: pressure-sensitive width, drawn as short segments.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const p = ((a[2] || 0.5) + (b[2] || 0.5)) / 2;
      ctx.lineWidth = Math.max(0.6, base * (0.45 + p * 1.1));
      ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke();
    }
    ctx.restore();
  }
  // Distance (normalised units) from a point to an annotation, for the eraser and for picking text to edit.
  const segDist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0; return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };
  const distToStroke = (s, x, y, W, H) => {
    if (s.t === 'text') {
      const b = textBox(s, W || 600, H || 800); const px = x * (W || 600), py = y * (H || 800);
      const lines = Math.max(1, (s.text || '').split('\n').length);
      const inside = px >= b.x - 4 && px <= b.x + Math.min(b.width, Math.max(60, (s.text || '').length * b.size * 0.55)) + 4 && py >= b.y - 4 && py <= b.y + lines * b.lineH + 4;
      return inside ? 0 : Infinity;
    }
    if (SHAPES.has(s.t)) {
      const [a, b] = s.pts; if (!a || !b) return Infinity;
      if (s.t === 'line' || s.t === 'arrow') return segDist(x, y, a[0], a[1], b[0], b[1]);
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      if (s.t === 'rect') return Math.min(segDist(x, y, x0, y0, x1, y0), segDist(x, y, x1, y0, x1, y1), segDist(x, y, x1, y1, x0, y1), segDist(x, y, x0, y1, x0, y0));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2 || 1e-6, ry = (y1 - y0) / 2 || 1e-6;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry); return Math.abs(d - 1) * Math.min(rx, ry);
    }
    let m = Infinity; for (const p of s.pts) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < m) m = d; } return m;
  };

  async function render(p, host, ui) {
    // host: the element to fill; ui: { toast, menu, queueSave, go } from the app
    host.innerHTML = '';
    const wrap = el('div', { class: 'pdfwrap' });
    const bar = el('div', { class: 'pdfbar' });
    const pagesEl = el('div', { class: 'pdfpages' });
    wrap.append(bar, pagesEl); host.append(wrap);
    let doc;
    try { doc = await openDoc(p.assetId); }
    catch (e) { pagesEl.append(el('p', { class: 'sub', style: 'padding:16px' }, e.message)); return () => {}; }
    const annots = p.annots || {};
    const undo = [], redo = [];
    const pageEls = new Map(); // pageNo -> { div, canvas, overlay, measured, rendered }
    // Measure only the first page up front; the rest take its size until they come near the screen.
    const first = await doc.getPage(1); const fvp = first.getViewport({ scale: 1 });
    const sizes = Array.from({ length: doc.numPages }, () => ({ w: fvp.width, h: fvp.height }));
    let fitScale = 1, scale = 1;
    const dpr = Math.min(doc.numPages > 150 ? 1.5 : 2, devicePixelRatio || 1);
    const save = () => { p.annots = annots; ui.queueSave({ annots }); };

    // Toolbar
    const toolBtns = {};
    const mkTool = (key, label, svg) => { const b = el('button', { class: 'ptool', type: 'button', title: label, 'aria-label': label, html: svg, onclick: () => setTool(key) }); toolBtns[key] = b; return b; };
    const I = {
      pan: '<svg viewBox="0 0 24 24"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-3.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3L4 13.5a1.4 1.4 0 0 1 2.3-1.6L9 14.5V9.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>',
      pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M13 7l3 3" stroke="currentColor" stroke-width="1.7"/></svg>',
      hl: '<svg viewBox="0 0 24 24"><path d="M9 17l-3 3H3l4-4M8 16l-1-1 8-8a2 2 0 0 1 3 3l-8 8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 21h16" stroke="currentColor" stroke-width="2.5"/></svg>',
      eraser: '<svg viewBox="0 0 24 24"><path d="M4 15l8-8a2 2 0 0 1 3 0l5 5-7 7H8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 11l5 5M6 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
      ellipse: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8.5" ry="6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
      arrow: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5M11 5h8v8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      line: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      undo: '<svg viewBox="0 0 24 24"><path d="M8 7H4v4M4.5 11a8 8 0 1 1 1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      redo: '<svg viewBox="0 0 24 24"><path d="M16 7h4v4M19.5 11a8 8 0 1 0-1.6 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };
    const colourRow = el('div', { class: 'pcolours' });
    const widthRow = el('div', { class: 'pwidths' });
    const redrawColours = () => {
      colourRow.innerHTML = '';
      const list = prefs.tool === 'hl' ? HL_COLOURS : COLOURS;
      const cur = prefs.tool === 'hl' ? prefs.hlColour : prefs.colour;
      for (const c of list) colourRow.append(el('button', { class: 'pcol' + (c === cur ? ' on' : ''), type: 'button', style: '--c:' + c, 'aria-label': c, onclick: () => { if (prefs.tool === 'hl') prefs.hlColour = c; else prefs.colour = c; savePrefs(); redrawColours(); } }));
      widthRow.innerHTML = '';
      for (const [w, label] of [[1.2, 'S'], [2, 'M'], [3.5, 'L']]) widthRow.append(el('button', { class: 'pw' + (prefs.width === w ? ' on' : ''), type: 'button', onclick: () => { prefs.width = w; savePrefs(); redrawColours(); } }, label));
      colourRow.hidden = !(prefs.tool !== 'pan' && prefs.tool !== 'eraser');
      widthRow.hidden = !(prefs.tool === 'pen' || prefs.tool === 'hl' || SHAPES.has(prefs.tool));
      sizeRow.hidden = prefs.tool !== 'text';
      sizeRow.innerHTML = '';
      if (prefs.tool === 'text') for (const [sz, label] of [[11, 'S'], [14, 'M'], [20, 'L']]) sizeRow.append(el('button', { class: 'pw' + ((prefs.textSize || 14) === sz ? ' on' : ''), type: 'button', onclick: () => { prefs.textSize = sz; savePrefs(); redrawColours(); } }, label));
    };
    const sizeRow = el('div', { class: 'pwidths' });
    const fingerBtn = el('button', { class: 'ptool text' + (prefs.fingerDraws ? ' on' : ''), type: 'button', title: 'Finger draws (off: finger scrolls, Pencil draws)', onclick: () => { prefs.fingerDraws = !prefs.fingerDraws; savePrefs(); fingerBtn.classList.toggle('on', prefs.fingerDraws); applyTouchAction(); } }, 'Finger');
    const pageLabel = el('span', { class: 'ppage' }, '1 / ' + doc.numPages);
    const undoBtn = el('button', { class: 'ptool', type: 'button', title: 'Undo', html: I.undo, onclick: () => doUndo() });
    const redoBtn = el('button', { class: 'ptool', type: 'button', title: 'Redo', html: I.redo, onclick: () => doRedo() });
    bar.append(
      el('div', { class: 'pgroup' }, mkTool('pan', 'Scroll / select', I.pan), mkTool('pen', 'Pen', I.pen), mkTool('hl', 'Highlighter', I.hl), mkTool('eraser', 'Eraser', I.eraser)),
      el('div', { class: 'pgroup' }, mkTool('text', 'Text box', I.text), mkTool('rect', 'Rectangle', I.rect), mkTool('ellipse', 'Ellipse', I.ellipse), mkTool('arrow', 'Arrow', I.arrow), mkTool('line', 'Line', I.line)),
      colourRow, widthRow, sizeRow,
      el('div', { class: 'pgroup' }, undoBtn, redoBtn),
      el('div', { class: 'pgroup' }, fingerBtn),
      el('span', { class: 'spacer' }),
      el('div', { class: 'pgroup' }, el('button', { class: 'ptool text', type: 'button', onclick: () => setZoom(prefs.zoom / 1.25) }, '−'), el('button', { class: 'ptool text', type: 'button', title: 'Fit width', onclick: () => setZoom(1) }, 'Fit'), el('button', { class: 'ptool text', type: 'button', onclick: () => setZoom(prefs.zoom * 1.25) }, '+')),
      pageLabel);
    function setTool(t) { prefs.tool = t; savePrefs(); for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === t); redrawColours(); applyTouchAction(); }
    function applyTouchAction() { const draw = prefs.tool !== 'pan'; for (const pe of pageEls.values()) if (pe.overlay) pe.overlay.style.touchAction = draw && prefs.fingerDraws ? 'none' : 'pan-x pan-y'; wrap.classList.toggle('drawing', draw); }

    // Pages: canvases exist only for pages near the viewport; everything else is an empty box of the right size.
    const sizePage = (i) => { const sz = sizes[i - 1]; const pe = pageEls.get(i); pe.div.style.width = Math.round(sz.w * scale) + 'px'; pe.div.style.height = Math.round(sz.h * scale) + 'px'; };
    const layout = () => {
      const avail = Math.max(300, pagesEl.clientWidth - 16);
      fitScale = avail / fvp.width;
      scale = fitScale * prefs.zoom;
      for (let i = 1; i <= doc.numPages; i++) { const pe = pageEls.get(i); sizePage(i); pe.rendered = false; releasePage(i); }
      io.disconnect(); for (const pe of pageEls.values()) io.observe(pe.div);
    };
    const releasePage = (i) => {
      const pe = pageEls.get(i);
      if (pe.canvas) { pe.canvas.width = 0; pe.canvas.height = 0; pe.canvas.remove(); pe.canvas = null; }
      if (pe.overlay) { pe.overlay.width = 0; pe.overlay.height = 0; pe.overlay.remove(); pe.overlay = null; }
      pe.rendered = false; pe.active = false;
    };
    const ensureCanvases = (i) => {
      const pe = pageEls.get(i); if (pe.active) return;
      const w = Math.round(sizes[i - 1].w * scale), h = Math.round(sizes[i - 1].h * scale);
      pe.canvas = el('canvas', { class: 'pdfcanvas' }); pe.overlay = el('canvas', { class: 'pdfink' });
      pe.overlay.width = Math.round(w * dpr); pe.overlay.height = Math.round(h * dpr); pe.overlay.style.width = w + 'px'; pe.overlay.style.height = h + 'px';
      pe.div.append(pe.canvas, pe.overlay); attachPointer(i, pe.overlay); pe.active = true;
      applyTouchAction(); paintOverlay(i);
    };
    const paintOverlay = (i) => {
      const pe = pageEls.get(i); if (!pe.overlay) return;
      const ctx = pe.overlay.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pe.overlay.width, pe.overlay.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = pe.overlay.width / dpr, H = pe.overlay.height / dpr;
      drawStrokes(ctx, annots[i] || [], W, H);
      if (pe.live) drawStroke(ctx, pe.live, W, H);
    };
    const renderPageCanvas = async (i) => {
      const pe = pageEls.get(i); if (pe.rendered || pe.rendering) return; pe.rendering = true;
      try {
        const pg = await doc.getPage(i);
        const vp1 = pg.getViewport({ scale: 1 });
        if (Math.abs(vp1.width - sizes[i - 1].w) > 0.5 || Math.abs(vp1.height - sizes[i - 1].h) > 0.5) { sizes[i - 1] = { w: vp1.width, h: vp1.height }; sizePage(i); releasePage(i); }
        ensureCanvases(i);
        if (!pe.canvas) return;
        const vp = pg.getViewport({ scale: scale * dpr });
        pe.canvas.width = Math.round(vp.width); pe.canvas.height = Math.round(vp.height);
        pe.canvas.style.width = Math.round(vp.width / dpr) + 'px'; pe.canvas.style.height = Math.round(vp.height / dpr) + 'px';
        await pg.render({ canvasContext: pe.canvas.getContext('2d'), viewport: vp }).promise;
        pe.rendered = true;
      } catch (e) { /* page may have been torn down */ } finally { pe.rendering = false; }
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const i = +en.target.dataset.page;
        if (en.isIntersecting) renderPageCanvas(i);
        else releasePage(i);
      }
    }, { root: null, rootMargin: '700px 0px' });
    const visIo = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting && en.intersectionRatio > 0.4) pageLabel.textContent = en.target.dataset.page + ' / ' + doc.numPages; }, { threshold: [0.4, 0.6] });
    for (let i = 1; i <= doc.numPages; i++) {
      const div = el('div', { class: 'pdfpage', 'data-page': String(i) });
      pageEls.set(i, { div, canvas: null, overlay: null, rendered: false, active: false });
      pagesEl.append(div); visIo.observe(div);
    }
    layout(); setTool(prefs.tool); redrawColours();
    const onResize = () => layout();
    addEventListener('resize', onResize);
    function setZoom(z) { prefs.zoom = Math.max(0.5, Math.min(4, z)); savePrefs(); layout(); }

    // Ink input
    function attachPointer(i, overlay) {
      let active = null; // { id, stroke }
      // Safari scrolls on Pencil touches as well as fingers. Block scrolling for stylus touches only, so the finger still pans.
      const blockStylus = (e) => { if (prefs.tool === 'pan') return; for (const t of e.touches) if (t.touchType === 'stylus' || prefs.fingerDraws) { e.preventDefault(); return; } };
      overlay.addEventListener('touchstart', blockStylus, { passive: false });
      overlay.addEventListener('touchmove', blockStylus, { passive: false });
      const norm = (e) => { const r = overlay.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5]; };
      overlay.addEventListener('pointerdown', (e) => {
        if (prefs.tool === 'pan') return;
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        const sel = window.getSelection && window.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges();
        if (e.pointerType === 'touch' && !prefs.fingerDraws) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        const pt = norm(e);
        if (prefs.tool === 'eraser') { active = { id: e.pointerId, erase: true }; eraseAt(i, pt); overlay.setPointerCapture(e.pointerId); return; }
        if (prefs.tool === 'text') { editText(i, pt); return; }
        const stroke = SHAPES.has(prefs.tool) ? { t: prefs.tool, c: prefs.colour, w: prefs.width, pts: [pt, pt] } : { t: prefs.tool, c: prefs.tool === 'hl' ? prefs.hlColour : prefs.colour, w: prefs.width, pts: [pt] };
        active = { id: e.pointerId, stroke, shape: SHAPES.has(prefs.tool) }; pageEls.get(i).live = stroke; overlay.setPointerCapture(e.pointerId);
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!active || e.pointerId !== active.id) return;
        e.preventDefault();
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        if (active.erase) { for (const ev of events) eraseAt(i, norm(ev)); return; }
        if (active.shape) { active.stroke.pts[1] = norm(e); paintOverlay(i); return; }
        for (const ev of events) { const pt = norm(ev); const last = active.stroke.pts[active.stroke.pts.length - 1]; if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.0008) active.stroke.pts.push(pt); }
        paintOverlay(i);
      });
      const finish = (e) => {
        if (!active || e.pointerId !== active.id) return;
        const pe = pageEls.get(i);
        if (!active.erase) {
          const s = active.stroke; pe.live = null;
          const tiny = active.shape && Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]) < 0.004;
          if (s.pts.length && !tiny) { (annots[i] = annots[i] || []).push(s); undo.push({ page: i, op: 'add', stroke: s }); redo.length = 0; save(); }
          paintOverlay(i);
        } else if (active.erased) { save(); }
        active = null;
      };
      // Text boxes: tap to place one (or tap an existing one to edit); a textarea floats over the page while typing.
      function editText(pageNo, pt) {
        const pe = pageEls.get(pageNo); if (!pe.overlay) return;
        const W = pe.overlay.width / dpr, H = pe.overlay.height / dpr;
        const list = annots[pageNo] || [];
        let existing = null, index = -1;
        for (let k = list.length - 1; k >= 0; k--) if (list[k].t === 'text' && distToStroke(list[k], pt[0], pt[1], W, H) === 0) { existing = list[k]; index = k; break; }
        const s = existing || { t: 'text', c: prefs.colour, size: prefs.textSize || 14, x: pt[0], y: pt[1], w: Math.min(0.6, 1 - pt[0] - 0.02), text: '' };
        if (existing) { list.splice(index, 1); paintOverlay(pageNo); }
        const b = textBox(s, W, H);
        const ta = el('textarea', { class: 'pdftext', style: 'left:' + b.x + 'px; top:' + b.y + 'px; width:' + b.width + 'px; font-size:' + b.size + 'px; line-height:' + b.lineH + 'px; color:' + s.c, placeholder: 'Type…' });
        ta.value = s.text || '';
        pe.div.append(ta);
        const grow = () => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; };
        ta.addEventListener('input', grow);
        let done = false;
        const commit = () => {
          if (done) return; done = true;
          const text = ta.value.replace(/\s+$/, '');
          ta.remove();
          if (text) {
            const ns = Object.assign({}, s, { text });
            if (existing) { list.splice(index, 0, ns); undo.push({ page: pageNo, op: 'replace', stroke: ns, prev: existing, index }); }
            else { list.push(ns); annots[pageNo] = list; undo.push({ page: pageNo, op: 'add', stroke: ns }); }
            redo.length = 0; save();
          } else if (existing) { undo.push({ page: pageNo, op: 'remove', stroke: existing, index }); redo.length = 0; save(); }
          paintOverlay(pageNo);
        };
        ta.addEventListener('blur', () => setTimeout(commit, 0));
        ta.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ta.value = s.text || ''; ta.blur(); } if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); } ev.stopPropagation(); });
        ta.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        setTimeout(() => { ta.focus(); grow(); }, 0);
      }
      overlay.addEventListener('pointerup', finish); overlay.addEventListener('pointercancel', finish);
      function eraseAt(pageNo, pt) {
        const list = annots[pageNo]; if (!list || !list.length) return;
        const pe = pageEls.get(pageNo); if (!pe.overlay) return; const W = pe.overlay.width / dpr;
        const tol = 10 / W;
        const H = pe.overlay.height / dpr;
        for (let k = list.length - 1; k >= 0; k--) {
          if (distToStroke(list[k], pt[0], pt[1], W, H) < tol * (list[k].t === 'hl' ? 2 : 1)) { const [s] = list.splice(k, 1); undo.push({ page: pageNo, op: 'remove', stroke: s, index: k }); redo.length = 0; active.erased = true; paintOverlay(pageNo); }
        }
      }
    }
    function doUndo() { const a = undo.pop(); if (!a) return; apply(a, true); redo.push(a); save(); }
    function doRedo() { const a = redo.pop(); if (!a) return; apply(a, false); undo.push(a); save(); }
    function apply(a, inverse) {
      const list = annots[a.page] = annots[a.page] || [];
      if (a.op === 'replace') { const cur = inverse ? a.stroke : a.prev, nxt = inverse ? a.prev : a.stroke; const k = list.indexOf(cur); if (k >= 0) list.splice(k, 1, nxt); else list.splice(Math.min(a.index, list.length), 0, nxt); paintOverlay(a.page); return; }
      const add = (a.op === 'add') !== inverse;
      if (add) list.splice(a.index == null ? list.length : a.index, 0, a.stroke); else { const k = list.indexOf(a.stroke); if (k >= 0) list.splice(k, 1); }
      paintOverlay(a.page);
    }
    window.NCPDF.active = { undo: doUndo, redo: doRedo };
    document.addEventListener('keydown', keyHandler);
    function keyHandler(e) { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); } }
    return () => { window.NCPDF.active = null; removeEventListener('resize', onResize); document.removeEventListener('keydown', keyHandler); io.disconnect(); visIo.disconnect(); doc.destroy(); };
  }

  // ---------- export ----------
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
  async function exportAnnotated(p) {
    const a = await assets.get(p.assetId); if (!a || !a.blob) throw new Error('PDF not on this device');
    const { PDFDocument, rgb, BlendMode, StandardFonts } = window.PDFLib;
    const pdf = await PDFDocument.load(await a.blob.arrayBuffer(), { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pgs = pdf.getPages();
    for (const [no, strokes] of Object.entries(p.annots || {})) {
      const page = pgs[+no - 1]; if (!page || !strokes.length) continue;
      const { width: W, height: H } = page.getSize();
      for (const s of strokes) {
        const { r, g, b } = hexToRgb(s.c);
        const base = s.w * (W / 600);
        if (s.t === 'text') {
          const size = (s.size || 14) * (W / 600), lineH = size * 1.25, maxW = s.w ? s.w * W : W - s.x * W - 8;
          const lines = [];
          for (const para of String(s.text || '').split('\n')) { let line = ''; for (const word of para.split(' ')) { const t = line ? line + ' ' + word : word; if (font.widthOfTextAtSize(t, size) > maxW && line) { lines.push(line); line = word; } else line = t; } lines.push(line); }
          lines.forEach((ln, k) => page.drawText(ln.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '?'), { x: s.x * W, y: H - s.y * H - size - k * lineH, size, font, color: rgb(r, g, b) }));
          continue;
        }
        if (SHAPES.has(s.t)) {
          const [p0, p1] = s.pts; if (!p0 || !p1) continue;
          const x0 = p0[0] * W, y0 = H - p0[1] * H, x1 = p1[0] * W, y1 = H - p1[1] * H, lw = Math.max(0.8, base * 1.2), col = rgb(r, g, b);
          if (s.t === 'rect') page.drawRectangle({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), borderColor: col, borderWidth: lw });
          else if (s.t === 'ellipse') page.drawEllipse({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, xScale: Math.abs(x1 - x0) / 2, yScale: Math.abs(y1 - y0) / 2, borderColor: col, borderWidth: lw });
          else {
            page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: lw, color: col, lineCap: 1 });
            if (s.t === 'arrow') { const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.max(8, lw * 4); for (const d of [-0.45, 0.45]) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x1 - len * Math.cos(ang + d), y: y1 - len * Math.sin(ang + d) }, thickness: lw, color: col, lineCap: 1 }); }
          }
          continue;
        }
        if (!s.pts || !s.pts.length) continue;
        const d = s.pts.map((pt, i) => (i ? 'L' : 'M') + (pt[0] * W).toFixed(2) + ' ' + (pt[1] * H).toFixed(2)).join(' ');
        const opts = { borderColor: rgb(r, g, b), borderWidth: s.t === 'hl' ? base * 7 : base, borderLineCap: s.t === 'hl' ? 0 : 1, x: 0, y: H };
        if (s.t === 'hl') { opts.borderOpacity = 0.4; opts.blendMode = BlendMode.Multiply; }
        page.drawSvgPath(d, opts);
      }
    }
    const bytes = await pdf.save();
    return new Blob([bytes], { type: 'application/pdf' });
  }

  window.NCPDF = { enrich, render, exportAnnotated, PAGE_KIND: 'pdf' };
})();

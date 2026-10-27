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
  function drawStroke(ctx, s, W, H) {
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
  const distToStroke = (s, x, y) => { let m = Infinity; for (const p of s.pts) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < m) m = d; } return m; };

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
      colourRow.hidden = widthRow.hidden = !(prefs.tool === 'pen' || prefs.tool === 'hl');
    };
    const fingerBtn = el('button', { class: 'ptool text' + (prefs.fingerDraws ? ' on' : ''), type: 'button', title: 'Finger draws (off: finger scrolls, Pencil draws)', onclick: () => { prefs.fingerDraws = !prefs.fingerDraws; savePrefs(); fingerBtn.classList.toggle('on', prefs.fingerDraws); applyTouchAction(); } }, 'Finger');
    const pageLabel = el('span', { class: 'ppage' }, '1 / ' + doc.numPages);
    const undoBtn = el('button', { class: 'ptool', type: 'button', title: 'Undo', html: I.undo, onclick: () => doUndo() });
    const redoBtn = el('button', { class: 'ptool', type: 'button', title: 'Redo', html: I.redo, onclick: () => doRedo() });
    bar.append(
      el('div', { class: 'pgroup' }, mkTool('pan', 'Scroll / select', I.pan), mkTool('pen', 'Pen', I.pen), mkTool('hl', 'Highlighter', I.hl), mkTool('eraser', 'Eraser', I.eraser)),
      colourRow, widthRow,
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
        if (prefs.tool === 'eraser') { eraseAt(i, pt); active = { id: e.pointerId, erase: true }; overlay.setPointerCapture(e.pointerId); return; }
        const stroke = { t: prefs.tool, c: prefs.tool === 'hl' ? prefs.hlColour : prefs.colour, w: prefs.width, pts: [pt] };
        active = { id: e.pointerId, stroke }; pageEls.get(i).live = stroke; overlay.setPointerCapture(e.pointerId);
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!active || e.pointerId !== active.id) return;
        e.preventDefault();
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        if (active.erase) { for (const ev of events) eraseAt(i, norm(ev)); return; }
        for (const ev of events) { const pt = norm(ev); const last = active.stroke.pts[active.stroke.pts.length - 1]; if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.0008) active.stroke.pts.push(pt); }
        paintOverlay(i);
      });
      const finish = (e) => {
        if (!active || e.pointerId !== active.id) return;
        const pe = pageEls.get(i);
        if (!active.erase) {
          const s = active.stroke; pe.live = null;
          if (s.pts.length) { (annots[i] = annots[i] || []).push(s); undo.push({ page: i, op: 'add', stroke: s }); redo.length = 0; save(); }
          paintOverlay(i);
        } else if (active.erased) { save(); }
        active = null;
      };
      overlay.addEventListener('pointerup', finish); overlay.addEventListener('pointercancel', finish);
      function eraseAt(pageNo, pt) {
        const list = annots[pageNo]; if (!list || !list.length) return;
        const pe = pageEls.get(pageNo); if (!pe.overlay) return; const W = pe.overlay.width / dpr;
        const tol = 10 / W;
        for (let k = list.length - 1; k >= 0; k--) {
          if (distToStroke(list[k], pt[0], pt[1]) < tol * (list[k].t === 'hl' ? 2 : 1)) { const [s] = list.splice(k, 1); undo.push({ page: pageNo, op: 'remove', stroke: s, index: k }); redo.length = 0; active.erased = true; paintOverlay(pageNo); }
        }
      }
    }
    function doUndo() { const a = undo.pop(); if (!a) return; apply(a, true); redo.push(a); save(); }
    function doRedo() { const a = redo.pop(); if (!a) return; apply(a, false); undo.push(a); save(); }
    function apply(a, inverse) {
      const list = annots[a.page] = annots[a.page] || [];
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
    const { PDFDocument, rgb, BlendMode } = window.PDFLib;
    const pdf = await PDFDocument.load(await a.blob.arrayBuffer(), { ignoreEncryption: true });
    const pgs = pdf.getPages();
    for (const [no, strokes] of Object.entries(p.annots || {})) {
      const page = pgs[+no - 1]; if (!page || !strokes.length) continue;
      const { width: W, height: H } = page.getSize();
      for (const s of strokes) {
        if (!s.pts || !s.pts.length) continue;
        const { r, g, b } = hexToRgb(s.c);
        const base = s.w * (W / 600);
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

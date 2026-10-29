// Symbol shortcuts: type a colon code and it turns into the symbol, as with OneNote AutoCorrect.
//   :d: →   :a: ←   :w: ↑   :s: ↓   :alpha: α   :Delta: Δ   :le: ≤ …
// Works in notes (the editor) and in every text box. Your own codes live in one ordinary note,
// "Symbol shortcuts" (a two-column table, Code | Symbol), so they sync to every device and can be
// edited by hand; they add to or override the built-in set below.
(function () {
  const { pages, meta } = window.NCDB;
  const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
  const DEFAULTS = {};
  const add = (group, pairs) => { for (const [code, sym, label] of pairs) DEFAULTS[code] = { sym, group, label: label || '' }; };
  add('Arrows', [['d', '→', 'right (WASD)'], ['a', '←', 'left (WASD)'], ['w', '↑', 'up / increased (WASD)'], ['s', '↓', 'down / decreased (WASD)'],
    ['ad', '↔', 'left-right'], ['ws', '⇅', 'up and down'], ['ud', '↕', 'up-down'], ['dd', '⇒', 'implies'], ['aa', '⇐', 'implied by'], ['iff', '⇔', 'if and only if'],
    ['right', '→'], ['left', '←'], ['up', '↑'], ['down', '↓']]);
  add('Greek', GREEK.map((g, i) => [g, String.fromCodePoint(0x3B1 + i + (i >= 17 ? 1 : 0))]));
  add('Greek capitals', GREEK.map((g, i) => [g[0].toUpperCase() + g.slice(1), String.fromCodePoint(0x391 + i + (i >= 17 ? 1 : 0))]));
  add('Maths', [['le', '≤'], ['<=', '≤'], ['ge', '≥'], ['>=', '≥'], ['ne', '≠'], ['!=', '≠'], ['pm', '±'], ['+-', '±'], ['approx', '≈'], ['~', '≈'], ['x', '×'], ['times', '×'], ['div', '÷'],
    ['inf', '∞'], ['sqrt', '√'], ['deg', '°'], ['therefore', '∴'], ['because', '∵'], ['sum', '∑'], ['prop', '∝'], ['micro', 'µ'], ['permil', '‰']]);
  add('Super & subscript', [['^2', '²'], ['^3', '³'], ['^+', '⁺'], ['^-', '⁻'], ['_2', '₂'], ['_3', '₃'], ['_4', '₄'], ['1/2', '½'], ['1/4', '¼'], ['3/4', '¾']]);
  add('Marks', [['bullet', '•'], ['sq', '▪'], ['tri', '▸'], ['tick', '✓'], ['cross', '✗'], ['star', '★'], ['male', '♂'], ['female', '♀'], ['--', '–'], ['---', '—']]);

  let custom = {}; // code -> symbol, from the note
  let pageId = null, pageUpdated = 0, lastCheck = 0;
  const strip = (c) => String(c || '').trim().replace(/^:+|:+$/g, '');
  function parseNote(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    const out = {};
    for (const tr of d.querySelectorAll('tr')) {
      const cells = [...tr.children].map((c) => (c.textContent || '').trim());
      const code = strip(cells[0]);
      if (!code || /^code$/i.test(code) || cells.length < 2) continue;
      out[code] = cells[1];
    }
    return out;
  }
  async function findPage() {
    if (pageId) { const p = await pages.get(pageId); if (p && !p.deleted) return p; }
    const saved = await meta.get('symbolsPage', null);
    if (saved) { const p = await pages.get(saved); if (p && !p.deleted) { pageId = p.id; return p; } }
    const p = (await pages.live()).find((q) => q.ptype === 'symbols') || null;
    if (p) { pageId = p.id; await meta.set('symbolsPage', p.id); }
    return p;
  }
  async function refresh(force) {
    if (!force && Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    try { const p = await findPage(); if (p && (force || p.updated !== pageUpdated)) { custom = parseNote(p.html); pageUpdated = p.updated; } else if (!p) custom = {}; } catch (e) { /* keep what we had */ }
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function saveCustom(next) {
    const rows = Object.entries(next).sort((a, b) => a[0].localeCompare(b[0]));
    const html = '<p>Your own colon shortcuts for 2nd Brain. Type <b>:code:</b> and it becomes the symbol. These add to (or replace) the built-in ones listed in Settings.</p>' +
      '<table><thead><tr><th>Code</th><th>Symbol</th></tr></thead><tbody>' + (rows.length ? rows.map(([c, s]) => '<tr><td>:' + esc(c) + ':</td><td>' + esc(s) + '</td></tr>').join('') : '<tr><td></td><td></td></tr>') + '</tbody></table>';
    let p = await findPage();
    if (p) await pages.update(p.id, { html });
    else { p = await pages.create({ title: 'Symbol shortcuts', html, ptype: 'symbols', inbox: 0, pinned: 0 }); pageId = p.id; await meta.set('symbolsPage', p.id); }
    custom = Object.assign({}, next); lastCheck = Date.now(); const q = await pages.get(p.id); pageUpdated = q ? q.updated : 0;
    return p;
  }
  function lookup(code) {
    if (code in custom) return custom[code] || null;
    if (DEFAULTS[code]) return DEFAULTS[code].sym;
    const lc = code.toLowerCase();
    for (const k of Object.keys(custom)) if (k.toLowerCase() === lc) return custom[k] || null;
    return DEFAULTS[lc] ? DEFAULTS[lc].sym : null;
  }
  const CODE_AT_END = /(^|[^:]):([^\s:]{1,20}):$/;
  // Given the text before the caret, the symbol to put in and how many characters it replaces.
  function match(before) {
    const m = CODE_AT_END.exec(before); if (!m) return null;
    const sym = lookup(m[2]); if (!sym) return null;
    return { sym, len: m[2].length + 2 };
  }
  function all() {
    const out = Object.entries(DEFAULTS).map(([code, d]) => ({ code, sym: code in custom ? custom[code] : d.sym, group: d.group, label: d.label, mine: code in custom }));
    for (const [code, sym] of Object.entries(custom)) if (!DEFAULTS[code]) out.push({ code, sym, group: 'Yours', label: '', mine: true });
    return out;
  }

  // ---- the note editor (TinyMCE, in its own frame) ----
  function attachEditor(ed) {
    refresh();
    const run = () => {
      const rng = ed.selection.getRng(); if (!rng || !rng.collapsed) return;
      const node = rng.startContainer; if (!node || node.nodeType !== 3) return;
      const hit = match(node.data.slice(0, rng.startOffset)); if (!hit) return;
      const r = ed.dom.createRng(); r.setStart(node, rng.startOffset - hit.len); r.setEnd(node, rng.startOffset);
      ed.undoManager.transact(() => { ed.selection.setRng(r); ed.selection.setContent(esc(hit.sym)); });
      ed.selection.collapse(false);
    };
    ed.on('keyup', (e) => { if (e.key === ':' || e.key === 'Unidentified' || e.keyCode === 229) run(); });
    ed.on('input', (e) => { if (!e.data || e.data.endsWith(':')) run(); });
    ed.on('focus', () => refresh());
    // Typing ":" after a space offers matching codes as you go (":al" → α alpha).
    if (ed.ui && ed.ui.registry && ed.ui.registry.addAutocompleter) {
      ed.ui.registry.addAutocompleter('symbols', {
        trigger: ':', minChars: 1, columns: 1, maxResults: 12,
        fetch: (pattern) => {
          if (/[:\s]/.test(pattern)) return Promise.resolve([]);
          const p = pattern.toLowerCase();
          const list = all().filter((x) => x.sym && x.code.toLowerCase().startsWith(p)).sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code)).slice(0, 12);
          return Promise.resolve(list.map((x) => ({ type: 'autocompleteitem', value: x.sym, text: x.sym + '  :' + x.code + ':' })));
        },
        onAction: (api, rng, value) => { ed.selection.setRng(rng); ed.insertContent(esc(value)); api.hide(); }
      });
    }
  }

  // ---- every ordinary text box in the app ----
  function onInput(e) {
    const t = e.target;
    if (!t || !(t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|)$/i.test(t.getAttribute('type') || ''))) || (t.dataset && t.dataset.nosym)) return;
    if (e.data && !e.data.endsWith(':')) return;
    let pos; try { pos = t.selectionStart; } catch (x) { return; }
    if (pos == null || pos !== t.selectionEnd) return;
    const hit = match(t.value.slice(0, pos)); if (!hit) return;
    t.setRangeText(hit.sym, pos - hit.len, pos, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusin', () => refresh(), true);

  window.NCSymbols = { DEFAULTS, all, lookup, match, refresh, saveCustom, custom: () => Object.assign({}, custom), findPage, attachEditor };
})();

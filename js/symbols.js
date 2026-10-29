// Symbol shortcuts: type a code and it turns into the symbol, exactly as in OneNote AutoCorrect and the
// UKMLAce Table Designer. Colon codes change the moment you type the closing colon (:d: → →, :alpha: → α);
// a few plain ones change as you finish them (--> → →, >> → •). Case doesn't matter unless both cases
// exist (:M: ♂). Ctrl+Z straight after puts back what you typed.
// The base list is the one the Table Designer imported from OneNote; extra built-ins fill gaps without
// changing any of yours. Your own additions live in one ordinary note, "Symbol shortcuts" (a two-column
// table, Type | Becomes), so they sync to every device; they can be swapped with the Designer's shortcuts.json.
(function () {
  const { pages, meta } = window.NCDB;
  const ENTRIES = []; // { key, sym, group, label }
  const seen = new Set();
  const add = (group, pairs) => { for (const [key, sym, label] of pairs) { if (seen.has(key)) continue; seen.add(key); ENTRIES.push({ key, sym, group, label: label || '' }); } };
  // 1) Yours: the Table Designer's list, imported from OneNote. These win over everything else built in.
  add('Your OneNote codes', [[':(+):', '⊕'], [':(m):', 'ⓜ'], [':(p):', '℗'], [':(s):', 'Ⓢ'], [':+-:', '±'], [':+o:', '⊕'], [':-+:', '±'], [':.:', '•'], [':@:', '•'], [':a:', '←'], [':alpha:', 'α'], [':as:', '↲'], [':beta:', 'β'], [':d:', '→'], [':deg:', '°'], [':delta:', 'Δ'], [':deltas:', 'δ'], [':dot:', '•'], [':ds:', '↳'], [':F:', '♀'], [':female:', '♀'], [':gamma:', 'γ'], [':geq:', '≥'], [':kappa:', 'κ'], [':leq:', '≤'], [':M:', '♂'], [':male:', '♂'], [':mu:', 'μ'], [':n:', '✗'], [':nn:', '☒'], [':o+:', '⊕'], [':redflag:', '🚩'], [':red_flag:', '🚩'], [':s:', '↓'], [':sa:', '↲'], [':sd:', '↳'], [':tick:', '✅'], [':trf:', '∴'], [':v.:', 'V̇'], [':w:', '↑'], [':y:', '✓'], [':yy:', '☑']]);
  add('Your OneNote codes (no colons)', [['-->', '→'], ['<--', '←'], ['==>', '⇒'], ['<==', '⇐'], ['<=>', '⇔'], ['>>', '• ']]);
  // 2) Extra built-ins (skipped wherever one of yours already uses the code).
  const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
  add('More arrows', [[':ad:', '↔', 'left-right'], [':ws:', '⇅', 'up and down'], [':ud:', '↕'], [':dd:', '⇒'], [':aa:', '⇐'], [':iff:', '⇔'], [':right:', '→'], [':left:', '←'], [':up:', '↑'], [':down:', '↓']]);
  add('Greek', GREEK.map((g, i) => [':' + g + ':', String.fromCodePoint(0x3B1 + i + (i >= 17 ? 1 : 0))]));
  add('Greek capitals', GREEK.map((g, i) => [':' + g[0].toUpperCase() + g.slice(1) + ':', String.fromCodePoint(0x391 + i + (i >= 17 ? 1 : 0))]));
  add('Maths', [[':le:', '≤'], [':ge:', '≥'], [':ne:', '≠'], [':pm:', '±'], [':approx:', '≈'], [':x:', '×'], [':div:', '÷'], [':inf:', '∞'], [':sqrt:', '√'], [':therefore:', '∴'], [':because:', '∵'], [':sum:', '∑'], [':prop:', '∝'], [':micro:', 'µ'], [':permil:', '‰']]);
  add('Super & subscript', [[':^2:', '²'], [':^3:', '³'], [':^+:', '⁺'], [':^-:', '⁻'], [':_2:', '₂'], [':_3:', '₃'], [':_4:', '₄'], [':1/2:', '½'], [':1/4:', '¼'], [':3/4:', '¾']]);
  add('Marks', [[':bullet:', '•'], [':sq:', '▪'], [':tri:', '▸'], [':cross:', '✗'], [':star:', '★'], [':warn:', '⚠'], [':--:', '–'], [':---:', '—']]);
  const BASE = new Map(ENTRIES.map((e) => [e.key, e.sym]));

  let custom = new Map(); // trigger -> symbol, from the note (overrides the built-ins)
  let pageId = null, pageUpdated = 0, lastCheck = 0;
  const isColon = (k) => k.length > 2 && k.startsWith(':') && k.endsWith(':');
  // What someone types in the "Type" box → the trigger: "d" or ":d:" → ":d:"; "->" stays "->".
  const normalise = (raw) => { const t = String(raw || '').trim(); if (!t) return ''; if (isColon(t)) return t; if (/[A-Za-z0-9]/.test(t)) return ':' + t.replace(/^:+|:+$/g, '') + ':'; return t; };
  function parseNote(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    const out = new Map();
    for (const tr of d.querySelectorAll('tr')) {
      const cells = [...tr.children].map((c) => (c.textContent || '').replace(/ /g, ' '));
      if (cells.length < 2 || /^(code|type)$/i.test(cells[0].trim())) continue;
      const key = normalise(cells[0]); if (!key) continue;
      const sym = cells[1].trim() === '•' && key === '>>' ? '• ' : cells[1].trim();
      out.set(key, sym);
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
    try { const p = await findPage(); if (p && (force || p.updated !== pageUpdated)) { custom = parseNote(p.html); pageUpdated = p.updated; } else if (!p) custom = new Map(); } catch (e) { /* keep what we had */ }
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function saveCustom(next) {
    const rows = [...next.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const html = '<p>Your own typing shortcuts for 2nd Brain. Type the code and it becomes the symbol. These add to, or replace, the built-in ones listed in Settings → Symbol shortcuts.</p>' +
      '<table><thead><tr><th>Type</th><th>Becomes</th></tr></thead><tbody>' + (rows.length ? rows.map(([c, s]) => '<tr><td>' + esc(c) + '</td><td>' + esc(s) + '</td></tr>').join('') : '<tr><td></td><td></td></tr>') + '</tbody></table>';
    let p = await findPage();
    if (p) await pages.update(p.id, { html });
    else { p = await pages.create({ title: 'Symbol shortcuts', html, ptype: 'symbols', inbox: 0, pinned: 0 }); pageId = p.id; await meta.set('symbolsPage', p.id); }
    custom = new Map(next); lastCheck = Date.now(); const q = await pages.get(p.id); pageUpdated = q ? q.updated : 0;
    return p;
  }
  // The current symbol for a trigger, yours first; colon codes fall back to any case.
  function lookup(key) {
    if (custom.has(key)) return custom.get(key) || null;
    if (BASE.has(key)) return BASE.get(key);
    if (!isColon(key)) return null;
    const lk = key.toLowerCase();
    for (const [k, v] of custom) if (k.toLowerCase() === lk) return v || null;
    for (const [k, v] of BASE) if (k.toLowerCase() === lk) return v;
    return null;
  }
  const plainKeys = () => [...new Set([...BASE.keys(), ...custom.keys()])].filter((k) => !isColon(k)).sort((a, b) => b.length - a.length);
  // Given the text before the caret: the symbol and how many characters it replaces.
  function match(before) {
    if (before.endsWith(':')) {
      const m = /:([^:\s]{1,20}):$/.exec(before);
      if (m) { const sym = lookup(m[0]); if (sym) return { sym, len: m[0].length, typed: m[0] }; }
    }
    for (const k of plainKeys()) if (before.endsWith(k)) { const sym = lookup(k); if (sym) return { sym, len: k.length, typed: k }; }
    return null;
  }
  const triggerChars = () => new Set([':', ...plainKeys().map((k) => k.slice(-1))]);
  function all() {
    const out = ENTRIES.map((e) => ({ code: e.key, sym: custom.has(e.key) ? custom.get(e.key) : e.sym, group: e.group, label: e.label, mine: custom.has(e.key), base: true }));
    for (const [code, sym] of custom) if (!BASE.has(code)) out.push({ code, sym, group: 'Added in 2nd Brain', label: '', mine: true, base: false });
    return out;
  }
  // The Table Designer's shortcuts.json: [[type, becomes], …]. Import keeps anything that differs from the built-ins.
  function fromDesigner(list) {
    const next = new Map(custom); let n = 0;
    for (const pair of list || []) { if (!Array.isArray(pair) || !pair[0] || pair[1] == null) continue; const key = normalise(pair[0]); if (!key) continue; if (BASE.get(key) === pair[1] && !custom.has(key)) continue; if (next.get(key) === String(pair[1])) continue; next.set(key, String(pair[1])); n++; }
    return { next, n };
  }
  function toDesigner() { const m = new Map(); for (const e of ENTRIES) if (e.group.startsWith('Your OneNote')) m.set(e.key, e.sym); for (const [k, v] of custom) if (v) m.set(k, v); else m.delete(k); return [...m.entries()]; }

  // ---- the note editor (TinyMCE, in its own frame) ----
  function attachEditor(ed) {
    refresh();
    const run = (typed) => {
      if (typed && !triggerChars().has(typed)) return;
      const rng = ed.selection.getRng(); if (!rng || !rng.collapsed) return;
      const node = rng.startContainer; if (!node || node.nodeType !== 3) return;
      const hit = match(node.data.slice(0, rng.startOffset)); if (!hit) return;
      const r = ed.dom.createRng(); r.setStart(node, rng.startOffset - hit.len); r.setEnd(node, rng.startOffset);
      // Its own undo step: Ctrl+Z straight after brings back what you typed.
      ed.undoManager.transact(() => { ed.selection.setRng(r); ed.selection.setContent(esc(hit.sym).replace(/ $/, '&nbsp;')); });
      ed.selection.collapse(false);
    };
    ed.on('input', (e) => { if (e.inputType && e.inputType !== 'insertText') return; run(e.data ? e.data.slice(-1) : ''); });
    ed.on('keyup', (e) => { if (e.key && e.key.length === 1) run(e.key); });
    ed.on('focus', () => refresh());
    // Typing ":" after a space offers matching codes as you go (":al" → α alpha).
    if (ed.ui && ed.ui.registry && ed.ui.registry.addAutocompleter) {
      ed.ui.registry.addAutocompleter('symbols', {
        trigger: ':', minChars: 1, columns: 1, maxResults: 12,
        fetch: (pattern) => {
          if (/[:\s]/.test(pattern)) return Promise.resolve([]);
          const p = ':' + pattern.toLowerCase();
          const rank = (x) => (x.mine ? 0 : x.group.startsWith('Your') ? 1 : 2);
          const list = all().filter((x) => x.sym && isColon(x.code) && x.code.toLowerCase().startsWith(p)).sort((a, b) => rank(a) - rank(b) || a.code.length - b.code.length || a.code.localeCompare(b.code));
          const best = []; const got = new Set();
          for (const x of list) { const k = x.code.toLowerCase(); if (got.has(k)) continue; got.add(k); best.push(x); }
          return Promise.resolve(best.slice(0, 12).map((x) => ({ type: 'autocompleteitem', value: x.sym, text: x.sym + '  ' + x.code })));
        },
        onAction: (api, rng, value) => { ed.selection.setRng(rng); ed.insertContent(esc(value)); api.hide(); }
      });
    }
  }

  // ---- every ordinary text box in the app ----
  let lastBox = null, busy = false;
  const fire = (t) => { busy = true; try { t.dispatchEvent(new Event('input', { bubbles: true })); } finally { busy = false; } };
  function onInput(e) {
    if (busy) return;
    const t = e.target;
    if (!t || !(t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|)$/i.test(t.getAttribute('type') || ''))) || (t.dataset && t.dataset.nosym)) return;
    if (e.inputType && e.inputType !== 'insertText') return;
    if (e.data && !triggerChars().has(e.data.slice(-1))) return;
    let pos; try { pos = t.selectionStart; } catch (x) { return; }
    if (pos == null || pos !== t.selectionEnd) return;
    const hit = match(t.value.slice(0, pos)); if (!hit) return;
    t.setRangeText(hit.sym, pos - hit.len, pos, 'end');
    lastBox = { el: t, typed: hit.typed, sym: hit.sym, at: Date.now() };
    fire(t);
  }
  // Ctrl+Z straight after a replacement in a text box puts back what you typed.
  function onKey(e) {
    if (!lastBox || !(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'z' && e.key !== 'Z')) return;
    const L = lastBox, t = e.target; lastBox = null;
    if (t !== L.el || Date.now() - L.at > 8000) return;
    const pos = t.selectionStart; if (pos !== t.selectionEnd || !t.value.slice(0, pos).endsWith(L.sym)) return;
    e.preventDefault(); t.setRangeText(L.typed, pos - L.sym.length, pos, 'end'); fire(t);
  }
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', () => refresh(), true);

  window.NCSymbols = { all, lookup, match, refresh, saveCustom, normalise, isColon, base: (k) => BASE.get(k), custom: () => new Map(custom), findPage, attachEditor, fromDesigner, toDesigner };
})();

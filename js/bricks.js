// Bricks: where each LEGO part lives (the orange drawer units D1–D6 and the blue Helmer), plus a 3D viewer for
// Stud.io / LDraw models whose parts list says which drawer each part comes from.
// The layout ships with the app (data/bricks.json); your own changes — parts added or moved, the "moved into the new
// system" ticks and the can't-find list — live on the Bricks tile, so they sync. Part pictures load live from
// Rebrickable by part number (LDraw and BrickLink as fallbacks); nothing is copied into the app.
(function () {
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pref = (k, d) => { try { const v = localStorage.getItem('nc-bk-' + k); return v == null ? d : v; } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('nc-bk-' + k, v); } catch (e) { /* ignore */ } };

  // Core colours (LDraw codes) live in the orange drawers: black, light/dark bluish grey, white, dark green, sand green, tan.
  const CORE = new Set(['0', '71', '72', '15', '288', '378', '19', '16']);
  const CORE_SWATCH = ['#05131D', '#A0A5A9', '#6C6E68', '#F4F4F4', '#184632', '#A0BCAC', '#E4CD9E'];

  const HELMER = [
    { id: 'H6', pos: 'top', title: 'Parts to sort', zones: [['A', 'Parts to sort', 'To sort'], ['B', 'Parts to sort', 'To sort']] },
    { id: 'H5', pos: '2nd down', title: 'WIP builds', halves: true, zones: [['A', 'WIP builds (shallow)', 'WIP builds'], ['B', 'WIP builds (shallow)', 'WIP builds']] },
    { id: 'H4', pos: '3rd down', title: 'Tiles & other', zones: [['A', 'Tiles, small (2 wide or less)', 'Tiles small'], ['B', 'Tiles, large (3 wide or more)', 'Tiles large'], ['C', 'Bars & bar-compatible', 'Bars'], ['D', 'Other', 'Other']] },
    { id: 'H3', pos: '4th down', title: 'Slopes', zones: [['A', 'Slopes, small', 'Slopes small'], ['B', 'Slopes, large', 'Slopes large'], ['C', 'Printed parts', 'Printed'], ['D', 'Curved slopes', 'Curved']] },
    { id: 'H2', pos: '5th down', title: 'Bricks', zones: [['A', 'Bricks, large (3 wide or more)', 'Bricks large'], ['B', 'Bricks, small (2 wide or less)', 'Bricks small'], ['C', 'Bricks modified', 'Modified'], ['D', 'Wedge bricks', 'Wedge']] },
    { id: 'H1', pos: 'bottom', title: 'Plates', zones: [['A', 'Plates, large (3 wide or more)', 'Plates large'], ['B', 'Plates, small (2 wide or less)', 'Plates small'], ['C', 'Plates modified, small', 'Modified'], ['D', 'Wedge plates', 'Wedge']] }
  ];
  const HZ = {}; HELMER.forEach((d) => d.zones.forEach(([z, l]) => { HZ[d.id + '-' + z] = { d, z, l }; }));
  const posText = (p) => (p === 'top' ? 'top drawer' : p === 'bottom' ? 'bottom drawer' : p.replace(' down', ' drawer down'));
  function dims(name) { const m = String(name).match(/(\d+)\s*x\s*(\d+)/i); return m ? [+m[1], +m[2]] : null; }
  // Which Helmer tub a part goes in when it isn't a core colour.
  function helmerFor(e) {
    const d = dims(e.name), w = d ? Math.min(d[0], d[1]) : null, l = d ? Math.max(d[0], d[1]) : null, c = e.cat, large = w != null && w >= 3;
    if (['Plate', 'Round plate'].includes(c)) return large ? 'H1-A' : 'H1-B';
    if (['Large plate', 'Large round plate'].includes(c)) return 'H1-A';
    if (['Wedge plate', 'Large wedge plate'].includes(c)) return 'H1-D';
    if (['Plate modified', 'Clip & handle plate', 'Hinge plate', 'Bracket', 'Jumper', 'Towball plate', 'Click hinge plate', 'Wheel holder plate', 'Turntable', 'Technic plate', 'Vehicle', 'Large plate modified'].includes(c)) return 'H1-C';
    if (c === 'Brick') return large ? 'H2-A' : 'H2-B';
    if (c === 'Large brick') return 'H2-A';
    if (c === 'Wedge brick') return 'H2-D';
    if (['Brick modified', 'Click hinge brick', 'Hinge brick', 'Ball joint', 'Rotation joint', 'Arch', 'Support', 'Panel', 'Fence', 'Large panel', 'Technic brick'].includes(c)) return 'H2-C';
    if (['Slope', 'Slope inverted'].includes(c)) return (w != null && w <= 2 && l <= 2) ? 'H3-A' : 'H3-B';
    if (['Large slope', 'Wedge slope'].includes(c)) return 'H3-B';
    if (c === 'Printed') return 'H3-C';
    if (['Large curved slope', 'Cylinder, cone & dish', 'Windscreen'].includes(c)) return 'H3-D';
    if (['Tile', 'Round tile', 'Tile modified'].includes(c)) return large ? 'H4-B' : 'H4-A';
    if (c === 'Large tile') return 'H4-B';
    if (['Bar', 'Click hinge', 'Towball', 'Flag & sign'].includes(c)) return 'H4-C';
    return 'H4-D';
  }

  const GROUPS = {
    'Plates': ['Plate', 'Round plate', 'Large plate', 'Large round plate'],
    'Plates modified': ['Plate modified', 'Clip & handle plate', 'Hinge plate', 'Click hinge plate', 'Towball plate', 'Wheel holder plate', 'Turntable', 'Jumper', 'Large plate modified', 'Technic plate'],
    'Brackets': ['Bracket'],
    'Wedge plates': ['Wedge plate', 'Large wedge plate'],
    'Bricks': ['Brick', 'Large brick'],
    'Bricks modified & joints': ['Brick modified', 'Click hinge brick', 'Hinge brick', 'Ball joint', 'Rotation joint', 'Support'],
    'Arches & bows': ['Arch'],
    'Panels & fences': ['Panel', 'Fence', 'Large panel'],
    'Slopes': ['Slope', 'Slope inverted', 'Large slope'],
    'Wedges & curves': ['Wedge brick', 'Wedge slope', 'Large curved slope', 'Cylinder, cone & dish'],
    'Tiles': ['Tile', 'Round tile', 'Tile modified', 'Large tile', 'Printed'],
    'Windows, doors & windscreens': ['Window & door', 'Windscreen'],
    'Bars & clips': ['Bar', 'Click hinge', 'Towball', 'Flag & sign'],
    'Minifig & containers': ['Minifig accessory', 'Container'],
    'Vehicle': ['Vehicle'],
    'Technic': ['Technic', 'Technic brick'],
    'Wheels & tracks': ['Wheels & tracks']
  };

  // ---------- data ----------
  let BASE = null, loading = null;
  const S = { units: [], comps: [], byKey: {}, entries: [], pn: {}, byPn: new Map(), byName: new Map() };
  async function loadBase() {
    if (BASE) return BASE;
    if (!loading) loading = fetch('data/bricks.json').then((r) => { if (!r.ok) throw new Error('Couldn’t load the drawer layout (' + r.status + ')'); return r.json(); }).then((d) => { BASE = d; return d; });
    return loading;
  }
  const keyOf = (u, slot) => u + '-' + slot;
  const locShort = (c) => c.u + ' · ' + c.slot;
  const slotLabel = (s) => (s[0] === 'S' ? 'Small ' : 'Medium ') + s.slice(1);
  const pnBase = (p) => String(p || '').toLowerCase().replace(/\.dat$/, '').replace(/(pr|pat|pb|ps|px|p)\d.*$/, '').replace(/[a-z]$/, '');
  function norm(s) {
    return String(s).toLowerCase().replace(/×/g, 'x').replace(/(\d)\s*x\s*(\d)/g, '$1x$2').replace(/(\d)\s*x\s*(\d)/g, '$1x$2').replace(/°/g, '')
      .replace(/[^a-z0-9/.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // The shipped layout with your edits laid over it.
  function build(bk) {
    const ed = (bk && bk.edits) || {};
    S.units = BASE.units;
    S.pn = Object.assign({}, BASE.pn || {});
    S.comps = BASE.comps.map((c, i) => {
      const k = keyOf(c.u, c.slot), e = ed[k];
      const o = Object.assign({}, c, { key: k, i, edited: !!e });
      if (e) { o.cat = e.cat || (e.parts && e.parts.length ? (c.cat === 'Empty' ? 'Other' : c.cat) : 'Empty'); o.alias = e.alias || ''; o.parts = e.parts && e.parts.length ? e.parts.slice() : ['Empty']; Object.assign(S.pn, e.pn || {}); }
      return o;
    });
    S.byKey = Object.fromEntries(S.comps.map((c) => [c.key, c]));
    S.entries = []; S.byPn = new Map(); S.byName = new Map();
    for (const c of S.comps) {
      if (c.cat === 'Empty') continue;
      for (const n of c.parts) {
        const m = S.pn[n]; const pn = m ? (m.pn || m) : '';
        const text = norm(n + ' ' + c.cat + ' ' + (c.alias || '') + ' ' + pn);
        const e = { name: n, cat: c.cat, comp: c, text, words: text.split(' '), pn: String(pn || ''), sure: m ? m.sure !== false : true };
        S.entries.push(e);
        if (e.pn) { for (const p of e.pn.split(/[\s,/]+/).filter(Boolean)) { const k1 = p.toLowerCase(); if (!S.byPn.has(k1)) S.byPn.set(k1, e); const k2 = pnBase(p); if (k2 && !S.byPn.has('~' + k2)) S.byPn.set('~' + k2, e); } }
        const nk = norm(n); if (!S.byName.has(nk)) S.byName.set(nk, e);
      }
    }
  }

  // ---------- search ----------
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const m = a.length, n = b.length; let prev = [...Array(n + 1).keys()];
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
  }
  function tokenScore(t, e) {
    if (e.words.includes(t)) return 3;
    const sw = t.match(/^(\d+)x(\d+)$/); if (sw && e.words.includes(sw[2] + 'x' + sw[1])) return 2.5;
    if (e.text.includes(t)) return 2;
    if (t.length >= 4) { const tol = t.length >= 7 ? 2 : 1; for (const w of e.words) if (w.length >= 3 && lev(t, w) <= tol) return 1; }
    return 0;
  }
  function search(q) {
    const toks = norm(q).split(' ').filter(Boolean); if (!toks.length) return [];
    const out = [];
    for (const e of S.entries) {
      let s = 0, ok = true;
      for (const t of toks) { const ts = tokenScore(t, e); if (!ts) { ok = false; break; } s += ts; }
      if (ok) { if (norm(e.name).startsWith(toks[0])) s += 0.5; if (e.pn && e.pn.toLowerCase() === toks[0]) s += 3; s -= e.name.length / 400; out.push([s, e]); }
    }
    out.sort((a, b) => b[0] - a[0]);
    return out.slice(0, 80).map((x) => x[1]);
  }
  function hl(name, q) {
    const toks = norm(q).split(' ').filter((t) => t.length > 1); let h = esc(name);
    toks.forEach((t) => { const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + ')', 'ig'); h = h.replace(re, '<mark>$1</mark>'); });
    return h;
  }

  // ---------- pictures ----------
  // Rebrickable's LDraw renders by colour (core grey first), then the LDraw library and BrickLink.
  function imgSrcs(pn, colour) {
    const p = encodeURIComponent(String(pn).split(/[\s,/]+/)[0]);
    const cols = [...new Set([colour, '71', '15', '4', '0'].filter((x) => x != null && x !== ''))];
    return [...cols.map((c) => 'https://cdn.rebrickable.com/media/parts/ldraw/' + c + '/' + p + '.png'),
      'https://library.ldraw.org/images/library/official/parts/' + p + '.png', 'https://img.bricklink.com/ItemImage/PL/' + p + '.png'];
  }
  function picFor(pn, cls, colour, title) {
    if (!pn) return el('span', { class: cls + ' bk-ph', title: 'No part number yet' }, '?');
    const [first, ...rest] = imgSrcs(pn, colour);
    const img = el('img', { class: cls, src: first, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', title: title || pn });
    img.addEventListener('error', () => { const n = rest.shift(); if (n) img.src = n; else img.replaceWith(el('span', { class: cls + ' bk-ph', title: 'No picture found for ' + pn }, pn)); });
    return img;
  }
  const pnOf = (name) => { const m = S.pn[name]; return m ? String(m.pn || m) : ''; };
  const pic = (name, cls, colour) => picFor(pnOf(name), cls, colour, name);

  // ---------- the model viewer asks: where does this part go? ----------
  // part: LDraw / Stud.io file name ("3023.dat"), colour: LDraw colour code, desc: its description.
  function where(part, colour, desc) {
    if (!BASE) return null;
    const p = String(part || '').toLowerCase().replace(/\.dat$/, '');
    let e = S.byPn.get(p) || S.byPn.get('~' + pnBase(p)) || null, how = 'number';
    if (!e && desc) { e = S.byName.get(norm(desc)) || null; how = 'name'; }
    if (!e && desc) {
      // "Plate 1 x 2 with Clip Horizontal" vs "Plate 1x2 with clip, horizontal": same words, any order.
      const words = new Set(norm(desc).split(' ').filter((w) => w.length > 1 && !/^(with|and|on|the)$/.test(w)));
      const hit = S.entries.find((x) => { const ws = norm(x.name).split(' ').filter((w) => w.length > 1 && !/^(with|and|on|the)$/.test(w)); return ws.length === words.size && ws.every((w) => words.has(w)); });
      if (hit) { e = hit; how = 'name'; }
    }
    if (!e) return null;
    const core = colour == null || CORE.has(String(colour));
    const hk = core ? null : helmerFor(e);
    return { key: e.comp.key, label: hk || locShort(e.comp), helmer: !!hk, name: e.name, how, sort: hk ? 'Z' + hk : e.comp.u + '-' + e.comp.slot[0] + String(e.comp.slot.slice(1)).padStart(3, '0') };
  }

  // ---------- the screen ----------
  let api = null; // the live screen, so the viewer can jump back to Find
  function render(host, ui) {
    let bk = JSON.parse(JSON.stringify(ui.tile.bk || {}));
    bk.moved = bk.moved || []; bk.log = bk.log || []; bk.edits = bk.edits || {};
    let moved = new Set(bk.moved);
    let tab = ui.tab || pref('tab', 'find');
    let mode = pref('mode', 'search'); // search | browse | log
    let colour = pref('colour', 'core');
    let selected = null; // { comp, name }
    let results = [], cursor = -1, curCat = pref('cat', '') || null;
    const save = async () => { bk.moved = [...moved]; await ui.save(JSON.parse(JSON.stringify(bk))); };

    const tabs = el('div', { class: 'seg bk-tabs', role: 'tablist' });
    const body = el('div', { class: 'bk-body' });
    if (ui.headSlot) { ui.headSlot.replaceChildren(tabs); host.replaceChildren(el('div', { class: 'bk' }, body)); } else host.replaceChildren(el('div', { class: 'bk' }, tabs, body));
    const drawTabs = () => {
      tabs.replaceChildren(...[['find', 'Find a part'], ['models', 'Models']].map(([k, label]) => el('button', { type: 'button', role: 'tab', class: tab === k ? 'on' : '', 'aria-selected': tab === k ? 'true' : 'false', onclick: () => { if (tab !== k) { tab = k; setPref('tab', k); draw(); } } }, label)));
    };

    // ----- Find -----
    let q, resEl, card, panel, modeSeg, mapEl;
    function drawFind() {
      q = el('input', { type: 'search', class: 'bk-q', placeholder: 'Part name or number — e.g. 1x2 jumper, cheese, 3023', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search parts', enterkeyhint: 'search' });
      q.value = pref('q', '');
      const colourSeg = el('div', { class: 'seg bk-colour', role: 'group', 'aria-label': 'Part colour' },
        ...[['core', 'Core colour'], ['other', 'Other colour']].map(([k, label]) => el('button', { type: 'button', class: colour === k ? 'on' : '', 'data-c': k, onclick: () => { colour = k; setPref('colour', k); colourSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === k)); renderPanel(); if (selected) select(selected.comp, selected.name, true); } }, label)));
      modeSeg = el('div', { class: 'seg bk-mode' });
      panel = el('div', { class: 'bk-panel' });
      card = el('div', { class: 'bk-card placeholder' });
      mapEl = el('div', { class: 'bk-map' });
      const swatches = el('div', { class: 'bk-swatches', title: 'Core colours go in the orange drawers; everything else goes in the Helmer' }, ...CORE_SWATCH.map((c) => el('i', { style: 'background:' + c })), el('span', {}, 'core → orange drawers · other → Helmer'));
      const left = el('div', { class: 'bk-left' }, el('div', { class: 'bk-searchrow' }, q), el('div', { class: 'bk-controls' }, modeSeg, colourSeg), swatches, el('div', { class: 'bk-cardslot' }), panel);
      const right = el('div', { class: 'bk-right' }, card, mapEl);
      body.replaceChildren(el('div', { class: 'bk-find' }, left, right));
      // On a phone the card sits just under the search box; on wider screens it heads the right-hand column.
      const placeCard = () => { const narrow = matchMedia('(max-width: 899px)').matches; const slot = body.querySelector('.bk-cardslot'); if (narrow && card.parentNode !== slot) slot.append(card); else if (!narrow && card.parentNode !== right) right.prepend(card); };
      placeCard(); const mq = matchMedia('(max-width: 899px)'); mq.addEventListener ? mq.addEventListener('change', placeCard) : mq.addListener(placeCard);
      q.addEventListener('input', () => { setPref('q', q.value); cursor = -1; if (mode !== 'search' && q.value.trim()) { mode = 'search'; setPref('mode', mode); } renderPanel(); });
      q.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (results.length) pick(Math.min(results.length - 1, cursor + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (results.length) pick(Math.max(0, cursor - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (results.length) pick(cursor < 0 ? 0 : cursor); if (matchMedia('(max-width: 899px)').matches) q.blur(); }
        else if (e.key === 'Escape') { q.value = ''; setPref('q', ''); renderPanel(); }
      });
      drawMap(); renderPanel(); drawCard();
      if (ui.select && S.byKey[ui.select.key]) { const c = S.byKey[ui.select.key]; if (ui.select.other) { colour = 'other'; colourSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === 'other')); } select(c, ui.select.name || null, false); ui.select = null; }
    }
    function drawModes() {
      modeSeg.replaceChildren(...[['search', 'Search'], ['browse', 'Browse'], ['log', 'Can’t find' + (bk.log.length ? ' (' + bk.log.length + ')' : '')]].map(([k, label]) =>
        el('button', { type: 'button', class: mode === k ? 'on' : '', onclick: () => { mode = k; setPref('mode', k); renderPanel(); if (k === 'search') q.focus(); } }, label)));
    }
    function renderPanel() {
      drawModes();
      if (mode === 'browse') return renderBrowse();
      if (mode === 'log') return renderLog();
      const s = q.value.trim();
      results = s ? search(s) : [];
      resEl = el('ul', { class: 'bk-results', role: 'listbox' });
      const total = S.entries.length, comps = S.comps.length;
      const hint = el('p', { class: 'bk-hint' }, s ? (results.length ? results.length + ' match' + (results.length === 1 ? '' : 'es') : 'No matches') : total + ' parts across ' + comps + ' compartments. Tap any compartment on the map to see what lives there.');
      panel.replaceChildren(hint, resEl);
      if (s && !results.length) {
        resEl.append(el('li', { class: 'bk-empty' }, el('b', {}, 'Nothing in the layout matches “' + s + '”.'), ' Try the size (1x2) or a plainer word, or browse by category. New or rare part? Add it to the can’t-find list.',
          el('div', {}, el('button', { class: 'btn small', type: 'button', onclick: async () => { await addLog(s); mode = 'log'; setPref('mode', mode); renderPanel(); } }, 'Add “' + s + '” to can’t find'))));
        return;
      }
      results.forEach((e, i) => {
        const hk = colour === 'other' ? helmerFor(e) : null;
        const li = el('li', { role: 'option', 'data-i': i, onclick: () => pick(i) },
          pic(e.name, 'bk-thumb', colour === 'other' ? '4' : null),
          el('span', { class: 'bk-rname', html: hl(e.name, s) + (e.pn ? ' <span class="bk-pn">' + esc(e.pn) + (e.sure ? '' : '?') + '</span>' : '') }),
          el('span', { class: 'bk-rcat' }, e.cat),
          el('span', { class: 'bk-rloc' + (hk ? ' blue' : '') }, hk || locShort(e.comp)));
        resEl.append(li);
      });
      if (cursor >= 0) pick(cursor, true);
    }
    function pick(i, quiet) {
      cursor = i; const e = results[i]; if (!e) return;
      resEl.querySelectorAll('li').forEach((li, j) => li.setAttribute('aria-selected', j === i ? 'true' : 'false'));
      const li = resEl.querySelector('li[data-i="' + i + '"]'); if (li && !quiet) li.scrollIntoView({ block: 'nearest' });
      select(e.comp, e.name, !!quiet);
    }
    function renderBrowse() {
      const cats = el('div', { class: 'bk-cats' }, ...Object.keys(GROUPS).map((c) => el('button', { type: 'button', class: 'chip' + (curCat === c ? ' on' : ''), onclick: () => { curCat = curCat === c ? null : c; setPref('cat', curCat || ''); renderBrowse(); } }, c)));
      const list = el('div', { class: 'bk-browse' });
      if (curCat) for (const c of S.comps.filter((x) => GROUPS[curCat].includes(x.cat))) {
        const row = el('button', { type: 'button', class: 'bk-group' + (selected && selected.comp === c ? ' on' : ''), onclick: () => { list.querySelectorAll('.bk-group').forEach((x) => x.classList.toggle('on', x === row)); select(c, c.parts.length === 1 ? c.parts[0] : null, false); } },
          el('span', { class: 'bk-gloc' }, locShort(c), el('span', {}, c.cat)),
          el('span', { class: 'bk-gnames' }, c.parts.join(' · ')),
          el('span', { class: 'bk-strip' }, ...c.parts.slice(0, 8).map((n) => pic(n, 'bk-mini'))));
        list.append(row);
      }
      else list.append(el('p', { class: 'bk-hint' }, 'Pick a category to see its compartments, with pictures.'));
      panel.replaceChildren(cats, list);
    }
    async function addLog(t) { t = String(t || '').trim(); if (!t) return; bk.log.push({ t, when: new Date().toISOString().slice(0, 10) }); await save(); }
    function renderLog() {
      drawModes();
      const box = el('textarea', { class: 'bk-logtext', rows: '2', placeholder: 'Describe the part, or paste its number' });
      const add = async () => { const t = box.value; box.value = ''; await addLog(t); renderLog(); };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } });
      const list = el('ul', { class: 'bk-log' });
      bk.log.forEach((x, i) => list.append(el('li', {},
        el('span', {}, x.t, el('small', {}, ' · ' + x.when)),
        el('button', { type: 'button', class: 'btn small', title: 'Put it in a compartment', onclick: () => place(i) }, 'Place…'),
        el('button', { type: 'button', class: 'iconbtn bk-x', 'aria-label': 'Remove', onclick: async () => { bk.log.splice(i, 1); await save(); renderLog(); } }, '×'))));
      panel.replaceChildren(el('div', { class: 'bk-logadd' }, box, el('div', { class: 'toolrow' },
        el('button', { type: 'button', class: 'btn small primary', onclick: add }, 'Add'),
        bk.log.length ? el('button', { type: 'button', class: 'btn small', onclick: async () => { const txt = bk.log.map((x) => '- ' + x.t).join('\n'); try { await navigator.clipboard.writeText(txt); ui.toast('Copied ' + bk.log.length + ' part' + (bk.log.length === 1 ? '' : 's')); } catch (e) { box.value = txt; ui.toast('Copy blocked — the list is in the box to copy by hand'); } } }, 'Copy list') : null)),
      bk.log.length ? list : el('p', { class: 'bk-hint' }, 'Nothing on the list. Parts you can’t find a home for go here; “Place…” puts one in a compartment.'));
    }
    async function place(i) {
      const x = bk.log[i]; if (!x) return;
      const where = await ui.ask('Which compartment for “' + x.t + '”?', 'e.g. D3 S57 or D1 M9', selected ? selected.comp.u + ' ' + selected.comp.slot : '', 'Place');
      if (!where) return;
      const m = where.toUpperCase().replace(/[·\-_]/g, ' ').match(/D\s*([1-6])\s*([SM])\s*(\d+)/);
      const c = m && S.byKey['D' + m[1] + '-' + m[2] + m[3]];
      if (!c) { ui.toast('No compartment “' + where + '” — use the form D3 S57'); return; }
      const [name, pn] = x.t.split('|').map((s) => s.trim());
      setComp(c, { cat: c.cat === 'Empty' ? 'Other' : c.cat, alias: c.alias, parts: [...c.parts.filter((p) => p !== 'Empty'), name], pn: pn ? { [name]: { pn, sure: true } } : {} });
      bk.log.splice(i, 1); await save(); rebuild();
      ui.toast('Placed in ' + locShort(c)); mode = 'log'; renderPanel(); select(S.byKey[c.key], name, false);
    }
    function setComp(c, v) {
      const base = BASE.comps.find((b) => keyOf(b.u, b.slot) === c.key);
      const prev = bk.edits[c.key] || {};
      const pn = Object.assign({}, prev.pn || {}, v.pn || {});
      for (const n of Object.keys(pn)) if (!v.parts.includes(n)) delete pn[n];
      const same = base && base.cat === v.cat && (base.alias || '') === (v.alias || '') && JSON.stringify(base.parts) === JSON.stringify(v.parts) && !Object.keys(pn).length;
      if (same) delete bk.edits[c.key]; else bk.edits[c.key] = { cat: v.cat, alias: v.alias || '', parts: v.parts, pn };
    }
    function rebuild() { build(bk); if (selected) selected.comp = S.byKey[selected.comp.key]; drawMap(); }

    function drawMap() {
      const units = el('div', { class: 'bk-units' });
      for (const u of S.units) {
        const g = el('div', { class: 'bk-grid' });
        for (let i = 1; i <= u.small; i++) g.append(cellFor(u.id + '-S' + i));
        const unit = el('div', { class: 'bk-unit' }, el('span', { class: 'bk-lbl' }, u.id), g);
        if (u.medium) { const m = el('div', { class: 'bk-grid med' }); for (let i = 1; i <= u.medium; i++) m.append(cellFor(u.id + '-M' + i)); unit.append(m); }
        units.append(unit);
      }
      const helmer = el('div', { class: 'bk-helmer' }, el('span', { class: 'bk-lbl' }, 'Helmer'));
      for (const d of HELMER) {
        const qd = el('div', { class: 'bk-tubs' + (d.halves ? ' halves' : '') }, ...d.zones.map(([z, l, sh]) => el('button', { type: 'button', class: 'bk-cell', 'data-hkey': d.id + '-' + z, title: d.id + '-' + z + ' — ' + l }, sh || l)));
        helmer.append(el('div', { class: 'bk-drawer' }, el('div', { class: 'bk-dt' }, el('span', {}, d.id + ' ' + d.title), el('span', {}, d.pos)), qd));
      }
      mapEl.replaceChildren(el('div', { class: 'bk-cabinets' },
        el('div', {}, el('h3', {}, 'Orange drawers — D1 to D3 on top, D4 to D6 below'), units),
        el('div', {}, el('h3', {}, 'Helmer — other colours, from the bottom'), helmer)),
        el('div', { class: 'bk-legend' }, el('span', {}, el('i', { class: 'hit' }), 'found here'), el('span', {}, el('i', { class: 'done' }), 'moved into new system'), el('span', {}, el('i', { class: 'empty' }), 'empty')));
      if (selected) highlight();
    }
    function cellFor(key) {
      const c = S.byKey[key]; if (!c) return el('span', { class: 'bk-cell empty' });
      return el('button', { type: 'button', class: 'bk-cell' + (c.cat === 'Empty' ? ' empty' : '') + (moved.has(key) ? ' done' : ''), 'data-key': key, title: key + (c.cat === 'Empty' ? ' — empty' : ' — ' + c.parts.slice(0, 3).join(', ') + (c.parts.length > 3 ? '…' : '')), onclick: () => select(c, null, true) });
    }
    function highlight() {
      mapEl.querySelectorAll('.hit, .peek').forEach((x) => x.classList.remove('hit', 'peek'));
      if (!selected) return;
      const { comp, name } = selected;
      const entry = name ? S.entries.find((e) => e.comp === comp && e.name === name) : null;
      const hk = colour === 'other' && entry ? helmerFor(entry) : null;
      const ob = mapEl.querySelector('[data-key="' + comp.key + '"]');
      if (hk) { const hb = mapEl.querySelector('[data-hkey="' + hk + '"]'); if (hb) hb.classList.add('hit'); if (ob) ob.classList.add('peek'); }
      else if (ob) ob.classList.add('hit');
    }
    function select(comp, name, fromMap) {
      selected = { comp, name };
      highlight(); drawCard();
      if (!fromMap && matchMedia('(max-width: 899px)').matches) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function drawCard() {
      if (!selected) {
        card.className = 'bk-card placeholder';
        card.replaceChildren(el('div', { class: 'bk-big' }, el('span', { class: 'where' }, 'Drawer —'), el('span', { class: 'slot' }, '—')),
          el('div', { class: 'bk-detail' }, el('h2', {}, 'Nothing selected yet'), el('p', { class: 'bk-cat' }, 'Search or browse, or tap a compartment on the map to see what lives there.')));
        return;
      }
      const { comp, name } = selected;
      const entry = name ? S.entries.find((e) => e.comp === comp && e.name === name) : null;
      const hk = colour === 'other' && entry ? helmerFor(entry) : null;
      const unit = S.units.find((u) => u.id === comp.u) || { title: '' };
      const others = comp.parts.filter((p) => p !== name && p !== 'Empty');
      let big; const detail = el('div', { class: 'bk-detail' });
      const pnLine = (n) => { const pn = pnOf(n); const m = S.pn[n]; return pn ? el('p', { class: 'bk-pnline' }, 'Part ', el('a', { href: 'https://rebrickable.com/parts/' + encodeURIComponent(pn.split(/[\s,/]+/)[0]) + '/', target: '_blank', rel: 'noopener' }, pn), m && m.sure === false ? el('span', { class: 'bk-unsure' }, ' · best guess, check the picture') : null) : el('p', { class: 'bk-pnline muted' }, 'No part number yet — add one with Edit to get a picture.'); };
      if (hk) {
        const z = HZ[hk];
        big = el('div', { class: 'bk-big' }, el('span', { class: 'where' }, 'Helmer, ' + posText(z.d.pos)), el('span', { class: 'slot blue' }, z.d.id + '‑' + z.z), el('span', { class: 'zone' }, z.l));
        detail.append(el('h2', {}, name), el('p', { class: 'bk-cat' }, comp.cat + ' · other colour'), pnLine(name), el('p', { class: 'bk-alt' }, 'In a core colour it goes in ', el('b', {}, locShort(comp)), ' (' + unit.title + ').'));
      } else {
        big = el('div', { class: 'bk-big' }, el('span', { class: 'where' }, 'Drawer ' + comp.u.slice(1)), el('span', { class: 'slot' }, slotLabel(comp.slot)), el('span', { class: 'zone' }, unit.title));
        if (comp.cat === 'Empty') detail.append(el('h2', {}, 'Empty compartment'), el('p', { class: 'bk-cat' }, 'Nothing assigned to ' + locShort(comp) + ' yet.'));
        else if (name) detail.append(el('h2', {}, name), el('p', { class: 'bk-cat' }, comp.cat + (comp.alias ? ' · aka ' + comp.alias : '')), pnLine(name));
        else detail.append(el('h2', {}, comp.cat), el('p', { class: 'bk-cat' }, 'Compartment ' + locShort(comp) + (comp.alias ? ' · aka ' + comp.alias : '')));
        if (others.length || (!name && comp.cat !== 'Empty')) {
          const list = name ? others : comp.parts;
          detail.append(el('div', { class: 'bk-also' }, el('b', {}, name ? 'Also in this compartment' : 'Contents'),
            el('div', { class: 'bk-alsolist' }, ...list.map((n) => el('button', { type: 'button', class: 'bk-alsoitem', onclick: () => select(comp, n, true) }, pic(n, 'bk-mini'), el('span', {}, n))))));
        }
        if (colour === 'other' && comp.cat !== 'Empty' && !name) detail.append(el('p', { class: 'bk-alt' }, 'Pick a part to see its Helmer tub for other colours.'));
      }
      const hero = hk || name ? pic(name, 'bk-hero', hk ? '4' : null) : (comp.cat !== 'Empty' ? pic(comp.parts[0], 'bk-hero') : el('span', { class: 'bk-hero bk-ph' }, 'empty'));
      const mv = el('input', { type: 'checkbox' }); mv.checked = moved.has(comp.key);
      mv.addEventListener('change', async () => { if (mv.checked) moved.add(comp.key); else moved.delete(comp.key); const b = mapEl.querySelector('[data-key="' + comp.key + '"]'); if (b) b.classList.toggle('done', mv.checked); prog.textContent = progText(); await save(); });
      const prog = el('span', { class: 'bk-prog' }, progText());
      card.className = 'bk-card';
      card.replaceChildren(el('div', { class: 'bk-cardtop' }, big, hero), detail,
        hk ? null : el('div', { class: 'bk-actions' },
          el('label', { class: 'bk-moved' }, mv, ' Moved into the new system'), prog,
          el('button', { type: 'button', class: 'btn small', onclick: () => editComp(comp) }, comp.edited ? 'Edit ✎' : 'Edit')));
    }
    function progText() { const total = S.comps.filter((c) => c.cat !== 'Empty').length; const n = [...moved].filter((k) => S.byKey[k] && S.byKey[k].cat !== 'Empty').length; return n + ' of ' + total + ' moved'; }
    async function editComp(comp) {
      const base = BASE.comps.find((b) => keyOf(b.u, b.slot) === comp.key);
      const lines = comp.parts.filter((p) => p !== 'Empty').map((n) => n + (pnOf(n) ? ' | ' + pnOf(n) : '')).join('\n');
      const r = await ui.sheet((box, close) => {
        const cat = el('input', { type: 'text', value: comp.cat === 'Empty' ? '' : comp.cat, placeholder: 'e.g. Slope', list: 'bk-cats' });
        const alias = el('input', { type: 'text', value: comp.alias || '', placeholder: 'Nicknames for search (optional)' });
        const parts = el('textarea', { rows: '7', placeholder: 'One part per line, with its number after a bar:\nPlate 1x2 | 3023' }); parts.value = lines;
        box.append(el('h2', {}, 'Compartment ' + locShort(comp)),
          el('datalist', { id: 'bk-cats' }, ...[...new Set(S.comps.map((c) => c.cat))].filter((c) => c !== 'Empty').sort().map((c) => el('option', { value: c }))),
          el('label', { class: 'pf-field' }, el('span', {}, 'Category'), cat), el('label', { class: 'pf-field' }, el('span', {}, 'Nicknames'), alias),
          el('label', { class: 'pf-field' }, el('span', {}, 'Parts (empty = free compartment)'), parts),
          el('p', { class: 'rule' }, 'The number fetches the picture from Rebrickable. Changes sync to your other devices.'),
          el('div', { class: 'actions' },
            comp.edited && base ? el('button', { class: 'btn', type: 'button', onclick: () => close({ reset: true }) }, 'Undo my changes') : null,
            el('span', { class: 'spacer' }),
            el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
            el('button', { class: 'btn primary', type: 'button', onclick: () => close({ cat: cat.value.trim(), alias: alias.value.trim(), parts: parts.value }) }, 'Save')));
      }, { centre: true });
      if (!r) return;
      if (r.reset) delete bk.edits[comp.key];
      else {
        const rows = r.parts.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [n, p] = l.split('|').map((s) => s.trim()); return { n, p }; }).filter((x) => x.n);
        const pn = {}; for (const x of rows) if (x.p && x.p !== (BASE.pn && BASE.pn[x.n] && String(BASE.pn[x.n].pn || BASE.pn[x.n]))) pn[x.n] = { pn: x.p, sure: true };
        const partsList = rows.map((x) => x.n);
        setComp(comp, { cat: partsList.length ? (r.cat || 'Other') : 'Empty', alias: r.alias, parts: partsList.length ? partsList : ['Empty'], pn });
      }
      await save(); rebuild();
      const c = S.byKey[comp.key]; select(c, c.parts.includes(selected && selected.name) ? selected.name : null, true);
      renderPanel(); ui.toast(r.reset ? 'Back to the original layout for ' + locShort(c) : 'Saved ' + locShort(c));
    }

    // ----- Models -----
    let frame = null;
    function drawModels() {
      frame = el('iframe', { class: 'bk-frame', src: 'bricks/viewer.html', title: 'Model viewer', allow: 'fullscreen' });
      body.replaceChildren(el('div', { class: 'bk-models' }, frame));
      const fit = () => { if (!frame || !frame.isConnected) return; const r = frame.getBoundingClientRect(); const bar = document.querySelector('.tabbar'); const bh = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0; frame.style.height = Math.max(320, innerHeight - r.top - bh - 12) + 'px'; };
      requestAnimationFrame(fit); addEventListener('resize', fit);
    }

    function draw() { drawTabs(); if (tab === 'models') drawModels(); else drawFind(); }
    build(bk); draw();
    api = {
      show(key, other, name) { ui.select = { key, other, name }; tab = 'find'; setPref('tab', 'find'); draw(); window.scrollTo(0, 0); },
      external(nb) { // the tile changed on another device
        bk = JSON.parse(JSON.stringify(nb || {})); bk.moved = bk.moved || []; bk.log = bk.log || []; bk.edits = bk.edits || {}; moved = new Set(bk.moved); build(bk); if (tab === 'find') { drawMap(); renderPanel(); if (selected) { selected.comp = S.byKey[selected.comp.key]; drawCard(); } }
      }
    };
    return { destroy() { api = null; host.innerHTML = ''; } };
  }

  // Search on its own (for the parts list in the viewer and elsewhere).
  window.NCBricks = {
    async load(bk) { await loadBase(); build(bk || {}); return { parts: S.entries.length, compartments: S.comps.length }; },
    render, where, helmerFor, imgSrcs,
    show(key, other, name) { if (api) api.show(key, other, name); },
    stats(bk) { if (!BASE) return null; const m = new Set((bk && bk.moved) || []); const total = BASE.comps.filter((c) => c.cat !== 'Empty').length; return { parts: S.entries.length, moved: [...m].length, total, log: ((bk && bk.log) || []).length }; }
  };
})();

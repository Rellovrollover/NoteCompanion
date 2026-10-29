// Trials & Pearls: a view over the "Trials & Pearls" notebook. Two section groups — Trials and Pearls —
// each with a section per specialty; every page is one trial or one pearl, with its facts as properties.
(function () {
  const { notebooks, sections, pages, meta } = window.NCDB;
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
  const NB = 'Trials & Pearls';
  const prop = (p, k) => { const f = (p.props || []).find((x) => x.k === k); return f ? f.v : ''; };
  const setProp = (props, k, v) => { const list = (props || []).filter((x) => x.k !== k); if (v) list.push({ k, v }); return list; };
  // Paragraphs, list items and cells keep a gap between them so a card never reads "floor.Trial: 65 trialSource: …".
  const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = (html || '').replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|td|th|tr|blockquote)>/gi, ' $&'); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
  const snippetOf = (html, title) => {
    const d = document.createElement('div'); d.innerHTML = (html || '').replace(/<br\s*\/?>/gi, '\u2029');
    const parts = [...d.querySelectorAll('p, li, h1, h2, h3, h4, td, blockquote')].filter((x) => !x.querySelector('p, li, td')).flatMap((x) => x.textContent.split('\u2029')).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (title && parts.length > 1 && parts[0].toLowerCase() === String(title).trim().toLowerCase()) parts.shift();
    if (!parts.length) return textOf(html);
    return parts.reduce((out, t) => !out ? t : out + (/[.!?:;]$/.test(out) ? ' ' : ' · ') + t, '');
  };
  const findingOf = (p) => { const d = document.createElement('div'); d.innerHTML = p.html || ''; const h = [...d.querySelectorAll('h2')].find((x) => /finding/i.test(x.textContent)); const para = h ? h.nextElementSibling : d.querySelector('p'); return para ? para.textContent.trim() : snippetOf(p.html).slice(0, 200); };
  const TRIAL_TEMPLATE = '<h2>Findings</h2><p></p><table><tbody><tr><td><strong>Population</strong></td><td></td></tr><tr><td><strong>Intervention</strong></td><td></td></tr><tr><td><strong>Comparator</strong></td><td></td></tr><tr><td><strong>Outcome</strong></td><td></td></tr></tbody></table><h2>Notes</h2><p></p>';

  async function notebook() { return (await notebooks.all()).find((n) => n.name === NB) || (await notebooks.archived()).find((n) => n.name === NB) || null; }

  // One-off tidy of an older flat import: trial sections into a "Trials" group, the single "Pearls" section
  // split by Category into a "Pearls" group. Idempotent; safe to call on every open.
  async function restructure(nb) {
    const secs = await sections.forNotebook(nb.id);
    let changed = false;
    const pearlsSec = secs.find((s) => s.name === 'Pearls' && !s.group);
    if (pearlsSec) {
      const pgs = await pages.forSection(pearlsSec.id);
      const bySec = new Map();
      for (const p of pgs) {
        const cat = prop(p, 'Category') || 'General';
        let target = bySec.get(cat) || (await sections.forNotebook(nb.id)).find((s) => s.name === cat && s.group === 'Pearls');
        if (!target) { target = await sections.create(nb.id, cat); await sections.update(target.id, { group: 'Pearls', view: 'list' }); target.group = 'Pearls'; }
        bySec.set(cat, target);
        await pages.update(p.id, { sectionId: target.id, ptype: 'pearl' });
      }
      await sections.remove(pearlsSec.id); changed = true;
    }
    // Duplicate specialties within Trials or Pearls fold into one: the same name in any case or spacing
    // ("&" = "and"), or a known alias. The one with the alias's name, else the fuller one, is kept.
    const ALIAS = { Pearls: { 'renal and fluids': 'renal' } };
    const norm = (n) => String(n || '').toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
    for (const group of ['Trials', 'Pearls']) {
      const list = (await sections.forNotebook(nb.id)).filter((s) => s.group === group);
      const names = new Set(list.map((s) => norm(s.name)));
      const byKey = new Map();
      for (const s of list) { let k = norm(s.name); const a = (ALIAS[group] || {})[k]; if (a && names.has(a)) k = a; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); }
      for (const [k, secs] of byKey) {
        if (secs.length < 2) continue;
        const n = new Map(); for (const s of secs) n.set(s.id, (await pages.forSection(s.id)).length);
        secs.sort((a, b) => (norm(b.name) === k) - (norm(a.name) === k) || n.get(b.id) - n.get(a.id));
        for (const s of secs.slice(1)) { await sections.merge(s.id, secs[0].id); changed = true; }
      }
    }
    for (const s of await sections.forNotebook(nb.id)) {
      if (!s.group) { await sections.update(s.id, { group: 'Trials', view: 'table' }); changed = true; for (const p of await pages.forSection(s.id)) if (p.ptype !== 'trial') await pages.update(p.id, { ptype: 'trial' }); }
      else if (s.group === 'Pearls') { for (const p of await pages.forSection(s.id)) if (p.ptype !== 'pearl') await pages.update(p.id, { ptype: 'pearl' }); }
      else if (s.group === 'Trials') { for (const p of await pages.forSection(s.id)) if (p.ptype !== 'trial') await pages.update(p.id, { ptype: 'trial' }); }
    }
    return changed;
  }
  async function sectionFor(nb, group, name) {
    const secs = await sections.forNotebook(nb.id);
    let s = secs.find((x) => x.group === group && x.name === name);
    if (!s) { s = await sections.create(nb.id, name); await sections.update(s.id, { group, view: group === 'Trials' ? 'table' : 'list' }); s.group = group; }
    return s;
  }

  async function render(host, ui) {
    host.innerHTML = '';
    let nb = await notebook();
    if (!nb) { host.append(el('div', { class: 'panel' }, el('p', {}, 'The Trials & Pearls notebook is not on this device yet.'), el('button', { class: 'btn primary', type: 'button', onclick: async () => { host.append(el('p', { class: 'sub' }, 'Importing…')); await ui.importSeed(); render(host, ui); } }, 'Import the starter set (213 trials, 407 pearls)'))); return; }
    if (await restructure(nb)) ui.changed && ui.changed();
    const secs = await sections.forNotebook(nb.id);
    const all = (await pages.live()).filter((p) => p.notebookId === nb.id && p.kind !== 'app');
    const secById = new Map(secs.map((s) => [s.id, s]));
    const items = all.map((p) => Object.assign({ sec: secById.get(p.sectionId) }, p)).filter((p) => p.sec);
    const trials = items.filter((p) => p.sec.group === 'Trials' || p.ptype === 'trial');
    const pearls = items.filter((p) => p.sec.group === 'Pearls' || p.ptype === 'pearl');
    let tab = 'trials', q = '', spec = '', sort = { trials: 'year', pearls: 'added' };
    try { const s = JSON.parse(localStorage.getItem('nc-tp') || '{}'); tab = s.tab || tab; spec = s.spec || ''; if (s.sort) sort = Object.assign(sort, s.sort); } catch (e) { /* ignore */ }
    const remember = () => { try { localStorage.setItem('nc-tp', JSON.stringify({ tab, spec, sort })); } catch (e) { /* ignore */ } };
    const SORTS = {
      trials: [['year', 'Latest year'], ['yearOld', 'Oldest year'], ['added', 'Newest added'], ['edited', 'Recently edited'], ['az', 'A–Z'], ['spec', 'Specialty']],
      pearls: [['added', 'Newest added'], ['edited', 'Recently edited'], ['az', 'A–Z'], ['spec', 'Specialty'], ['oldest', 'Oldest added']]
    };
    const yearOf = (p) => parseInt(prop(p, 'Year'), 10) || 0;
    const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true });
    const sorters = {
      year: (a, b) => yearOf(b) - yearOf(a) || byTitle(a, b),
      yearOld: (a, b) => (yearOf(a) || 9999) - (yearOf(b) || 9999) || byTitle(a, b),
      added: (a, b) => (b.created || 0) - (a.created || 0),
      oldest: (a, b) => (a.created || 0) - (b.created || 0),
      edited: (a, b) => (b.updated || 0) - (a.updated || 0),
      az: byTitle,
      spec: (a, b) => a.sec.name.localeCompare(b.sec.name) || byTitle(a, b)
    };
    const wrap = el('div', { class: 'tp' }); host.append(wrap);
    const draw = () => {
      wrap.innerHTML = '';
      const list = tab === 'trials' ? trials : pearls;
      const specs = [...new Set(list.map((p) => p.sec.name))].sort();
      const seg = el('div', { class: 'seg' },
        el('button', { type: 'button', class: tab === 'trials' ? 'on' : '', onclick: () => { tab = 'trials'; spec = ''; remember(); draw(); } }, 'Trials ', el('span', { class: 'sec-count' }, String(trials.length))),
        el('button', { type: 'button', class: tab === 'pearls' ? 'on' : '', onclick: () => { tab = 'pearls'; spec = ''; remember(); draw(); } }, 'Pearls ', el('span', { class: 'sec-count' }, String(pearls.length))));
      const search = el('input', { class: 'searchbox', type: 'search', placeholder: tab === 'trials' ? 'Search trials, topics, findings…' : 'Search pearls…', value: q });
      search.addEventListener('input', () => { q = search.value; drawBody(); });
      const addBtn = el('button', { class: 'btn small primary', type: 'button', onclick: () => tab === 'trials' ? newTrial() : newPearl() }, tab === 'trials' ? '+ Trial' : '+ Pearl');
      const randomBtn = tab === 'pearls' ? el('button', { class: 'btn small', type: 'button', onclick: () => { const pool = filtered(); if (pool.length) ui.go('#page/' + pool[Math.floor(Math.random() * pool.length)].id); } }, 'Random pearl') : null;
      wrap.append(el('div', { class: 'tp-head' }, seg, el('span', { class: 'spacer' }), randomBtn, addBtn, el('a', { class: 'btn small', href: '#nb/' + nb.id }, 'Notebook')));
      const sortSel = el('select', { class: 'tp-sort', 'aria-label': 'Sort by' }, ...SORTS[tab].map(([k, label]) => el('option', { value: k, selected: sort[tab] === k ? '' : null }, label)));
      sortSel.addEventListener('change', () => { sort[tab] = sortSel.value; remember(); drawBody(); });
      wrap.append(el('div', { class: 'tp-searchrow' }, search, el('label', { class: 'tp-sortwrap' }, el('span', {}, 'Sort'), sortSel)));
      const chips = el('div', { class: 'tagchips' }, el('button', { class: 'chip' + (spec ? '' : ' on'), type: 'button', onclick: () => { spec = ''; remember(); draw(); } }, 'All'), ...specs.map((s) => el('button', { class: 'chip' + (spec === s ? ' on' : ''), type: 'button', onclick: () => { spec = spec === s ? '' : s; remember(); draw(); } }, s + ' ', el('span', { class: 'tp-n' }, String(list.filter((p) => p.sec.name === s).length)))));
      wrap.append(chips);
      const body = el('div', { class: 'tp-body' }); wrap.append(body);
      function filtered() {
        const t = q.trim().toLowerCase();
        return list.filter((p) => (!spec || p.sec.name === spec) && (!t || (p.title || '').toLowerCase().includes(t) || prop(p, 'Topic').toLowerCase().includes(t) || (p.tags || []).join(' ').includes(t) || textOf(p.html).toLowerCase().includes(t)));
      }
      function drawBody() {
        body.innerHTML = '';
        const rows = filtered();
        if (!rows.length) { body.append(el('p', { class: 'sub' }, 'Nothing matches.')); return; }
        if (tab === 'trials') {
          rows.sort(sorters[sort.trials] || sorters.year);
          const table = el('table', { class: 'dbtable tp-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Trial'), el('th', {}, 'Year'), el('th', {}, 'Specialty'), el('th', {}, 'Topic'), el('th', {}, 'Finding'))));
          const tb = el('tbody', {});
          for (const p of rows) tb.append(el('tr', { onclick: () => ui.go('#page/' + p.id) }, el('td', { class: 'tcell' }, el('b', {}, p.title || 'Untitled')), el('td', {}, prop(p, 'Year')), el('td', {}, p.sec.name), el('td', {}, prop(p, 'Topic')), el('td', { class: 'tp-finding' }, findingOf(p))));
          table.append(tb); body.append(el('div', { class: 'dbwrap' }, table));
        } else {
          rows.sort(sorters[sort.pearls] || sorters.added);
          const grid = el('div', { class: 'tp-cards' });
          for (const p of rows) grid.append(el('a', { class: 'tp-card', href: '#page/' + p.id }, el('span', { class: 'tp-card-spec' }, p.sec.name), el('b', {}, p.title || 'Untitled'), el('span', { class: 'tp-card-body' }, snippetOf(p.html, p.title).slice(0, 220))));
          body.append(grid);
        }
      }
      drawBody();
    };
    async function pickSpec(group, title) {
      const names = [...new Set((await sections.forNotebook(nb.id)).filter((s) => s.group === group).map((s) => s.name))].sort();
      return new Promise((resolve) => ui.menu(title, [...names.map((n) => ({ label: n, fn: () => resolve(n) })), { label: '+ New specialty…', accent: true, fn: async () => { const n = await ui.ask('New specialty', 'e.g. Rheumatology'); resolve(n || undefined); } }]).then(() => setTimeout(() => resolve(undefined), 0)));
    }
    async function newTrial() {
      const name = await ui.ask('Trial name', 'e.g. ARISE'); if (!name) return;
      const s = await pickSpec('Trials', 'Specialty'); if (!s) return;
      const year = await ui.ask('Year', 'e.g. 2014'); if (year === undefined) return;
      const topic = await ui.ask('Topic', 'One line: what it asked'); if (topic === undefined) return;
      const sec = await sectionFor(nb, 'Trials', s);
      const p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title: name, html: TRIAL_TEMPLATE, props: [{ k: 'Year', v: year }, { k: 'Topic', v: topic }, { k: 'Category', v: s }], tags: [], ptype: 'trial' });
      ui.changed && ui.changed(); ui.go('#page/' + p.id);
    }
    async function newPearl() {
      const text = await ui.ask('Pearl', 'One line that sticks'); if (!text) return;
      const s = await pickSpec('Pearls', 'Specialty'); if (!s) return;
      const sec = await sectionFor(nb, 'Pearls', s);
      const p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title: text, html: '<p></p>', props: [{ k: 'Category', v: s }], tags: [], ptype: 'pearl' });
      ui.changed && ui.changed(); ui.toast('Pearl added to ' + s);
      pearls.push(Object.assign({ sec }, p)); draw();
    }
    draw();
  }

  window.NCTP = { render, restructure, NB };
})();

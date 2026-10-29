// Logbook: your own record of procedures and experience, separate from the e-portfolio. Everything lives in
// ONE ordinary note — "Logbook" in the Logbook notebook — as two tables (Procedures, Other experience). This
// view reads those tables and writes rows back into them, so the note stays readable and editable by hand.
// Extra procedure types you add are kept on the notebook record so every device offers them.
(function () {
  const { notebooks, sections, pages } = window.NCDB;
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
  const NB = 'Logbook';
  const PROC_CAT = 'Procedure / DOPS';
  const CATS = [PROC_CAT, 'Clinic', 'Theatre / anaesthetics', 'Resus / arrest', 'Transfer', 'Ultrasound', 'Simulation', 'Teaching delivered', 'Other experience'];
  // The procedures IMT and ACCS trainees are asked to evidence, grouped for the picker.
  const PROCS = {
    'Airway & breathing': ['Basic airway manoeuvres & adjuncts', 'Supraglottic airway (LMA/iGel)', 'Tracheal intubation', 'RSI assist', 'NIV / CPAP set-up', 'ABG sampling'],
    'Lines & access': ['Peripheral cannula', 'Intraosseous access', 'Arterial line', 'Central venous catheter', 'Blood cultures (sterile)'],
    'Chest': ['Pleural aspiration', 'Intercostal drain (Seldinger)', 'Intercostal drain (open)', 'Thoracic ultrasound'],
    'Abdomen & GU': ['Abdominal paracentesis (tap)', 'Ascitic drain', 'Nasogastric tube', 'Urinary catheter (male)', 'Urinary catheter (female)'],
    'Cardiac': ['DC cardioversion', 'Temporary pacing (external)', 'Temporary pacing (transvenous)', '12-lead ECG interpretation', 'Echo (focused)'],
    'Neuro': ['Lumbar puncture'],
    'Resus & sedation': ['Lead an arrest / peri-arrest', 'Advanced life support', 'Procedural sedation', 'Trauma primary survey'],
    'MSK & wounds': ['Joint aspiration', 'Joint injection', 'Fracture / dislocation reduction', 'Plaster / splint', 'Wound closure (suture / glue)', 'Fascia iliaca block', 'Nerve block (other)'],
    'ENT & other': ['Nasal packing (epistaxis)', 'Foreign body removal', 'Nail trephine', 'Abscess incision & drainage']
  };
  const SUPERVISION = ['Direct observation without assistance', 'Direct observation with assistance', 'Indirect observation', 'Independent'];
  const OUTCOME = ['Successful', 'Partially successful', 'Unsuccessful', 'Complication'];
  const PROC_COLS = ['Date', 'Procedure', 'Supervision', 'Outcome', 'Setting', 'With', 'Comments'];
  const OTHER_COLS = ['Date', 'Category', 'What', 'Setting', 'With', 'Comments'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDay = (iso) => { const p = String(iso || '').split('-').map(Number); if (p.length !== 3) return iso || ''; return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  // In the note, dates read as 18/10/2026; the view works in ISO.
  const toUK = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : (iso || ''); };
  const fromUK = (s) => {
    s = String(s || '').trim();
    let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
    const d = new Date(s); return isNaN(d) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };

  // ---- note <-> rows ----
  // Tables are recognised by their heading (Procedures / Other experience) and read by column name, so
  // reordering columns or adding one by hand in the note doesn't break anything.
  function parse(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    const rows = []; let current = PROC_CAT;
    const walk = (node) => {
      for (const n of node.children) {
        if (/^H[1-4]$/.test(n.tagName)) { current = /other/i.test(n.textContent) ? 'other' : PROC_CAT; continue; }
        if (n.tagName === 'TABLE') {
          const trs = [...n.querySelectorAll('tr')]; if (!trs.length) continue;
          const head = [...trs[0].children].map((c) => c.textContent.trim().toLowerCase());
          const isOther = current === 'other' || head.includes('category') || head.includes('what');
          for (const tr of trs.slice(1)) {
            const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
            if (!cells.some(Boolean)) continue;
            const get = (name) => { const i = head.indexOf(name); return i >= 0 ? (cells[i] || '') : ''; };
            if (isOther) rows.push({ cat: get('category') || 'Other experience', type: get('what'), date: fromUK(get('date')), supervision: '', outcome: '', setting: get('setting'), with: get('with'), note: get('comments') });
            else rows.push({ cat: PROC_CAT, type: get('procedure'), date: fromUK(get('date')), supervision: get('supervision'), outcome: get('outcome'), setting: get('setting'), with: get('with'), note: get('comments') });
          }
          continue;
        }
        if (n.children && n.children.length) walk(n);
      }
    };
    walk(d);
    return rows;
  }
  const byDate = (a, b) => ((b.date || '') > (a.date || '') ? 1 : (b.date || '') < (a.date || '') ? -1 : 0);
  function serialise(rows) {
    const procs = rows.filter((r) => r.cat === PROC_CAT).sort(byDate);
    const others = rows.filter((r) => r.cat !== PROC_CAT).sort(byDate);
    const table = (cols, list, cellsOf) => '<table><thead><tr>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + (list.length ? list.map((r) => '<tr>' + cellsOf(r).map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') : '<tr>' + cols.map(() => '<td></td>').join('') + '</tr>') + '</tbody></table>';
    return '<h2>Procedures</h2>' + table(PROC_COLS, procs, (r) => [toUK(r.date), r.type, r.supervision, r.outcome, r.setting, r.with, r.note]) +
      '<h2>Other experience</h2>' + table(OTHER_COLS, others, (r) => [toUK(r.date), r.cat, r.type, r.setting, r.with, r.note]);
  }

  // ---- where the note lives ----
  async function notebook() { return (await notebooks.all()).find((n) => n.name === NB) || null; }
  async function ensureNotebook() { let nb = await notebook(); if (!nb) nb = await notebooks.create(NB); return nb; }
  async function findTile() { return (await pages.live()).find((q) => q.kind === 'app' && q.app === 'logbook'); }
  async function logPage(nb) {
    const tile = await findTile();
    let p = tile && tile.pageRef ? await pages.get(tile.pageRef) : null;
    if (p && !p.deleted) return p;
    p = (await pages.live()).find((q) => q.notebookId === nb.id && q.ptype === 'logbook-table');
    if (!p) {
      const secs = await sections.forNotebook(nb.id);
      let sec = secs.find((s) => s.name === 'Log');
      if (!sec) sec = await sections.create(nb.id, 'Log');
      p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title: 'Logbook', html: serialise([]), ptype: 'logbook-table', pinned: 1 });
    }
    if (tile) await pages.update(tile.id, { pageRef: p.id });
    return p;
  }
  // One-off: entries made as separate pages (the first version) are folded into the table and removed.
  async function migrate(nb, page) {
    const old = (await pages.live()).filter((q) => q.notebookId === nb.id && q.ptype === 'logbook');
    if (!old.length) return 0;
    const prop = (p, k) => { const f = (p.props || []).find((x) => x.k === k); return f ? f.v : ''; };
    const text = (h) => { const d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
    const secs = new Map((await sections.forNotebook(nb.id)).map((s) => [s.id, s]));
    const rows = parse(page.html);
    for (const p of old) {
      const sec = secs.get(p.sectionId);
      const cat = sec && CATS.includes(sec.name) ? sec.name : PROC_CAT;
      rows.push({ cat, type: prop(p, 'Type') || (p.title || '').replace(/ — .*$/, ''), date: prop(p, 'Date'), supervision: prop(p, 'Supervision'), outcome: prop(p, 'Outcome'), setting: prop(p, 'Setting'), with: prop(p, 'With'), note: text(p.html) });
    }
    await pages.update(page.id, { html: serialise(rows) });
    page.html = serialise(rows);
    for (const p of old) await pages.remove(p.id);
    // Category sections the old pages lived in are empty now.
    for (const s of secs.values()) { if (s.name === 'Log') continue; if (CATS.includes(s.name) && !(await pages.forSection(s.id)).length) await sections.remove(s.id); }
    return old.length;
  }

  async function render(host, ui) {
    host.innerHTML = '';
    const nb = await ensureNotebook();
    const page = await logPage(nb);
    const moved = await migrate(nb, page);
    if (moved) { ui.changed && ui.changed(); ui.toast && ui.toast('Moved ' + moved + ' entr' + (moved === 1 ? 'y' : 'ies') + ' into the Logbook note'); }
    let rows = parse(page.html);
    const save = async () => { page.html = serialise(rows); await pages.update(page.id, { html: page.html }); ui.changed && ui.changed(); rows = parse(page.html); };
    let tab = 'tally', filterCat = 'All', filterType = '';
    try { const s = JSON.parse(localStorage.getItem('nc-logbook') || '{}'); tab = s.tab || tab; } catch (e) { /* ignore */ }
    const remember = () => { try { localStorage.setItem('nc-logbook', JSON.stringify({ tab })); } catch (e) { /* ignore */ } };
    const wrap = el('div', { class: 'lb' }); host.append(wrap);

    const row = (e) => el('button', { class: 'pf-entry lb-row', type: 'button', onclick: () => form(e) },
      el('span', { class: 'pf-main' },
        el('span', { class: 'pf-date' }, el('b', {}, String(parseInt((e.date || '').split('-')[2], 10) || '')), (e.date || '').split('-')[1] ? new Date(e.date + 'T00:00').toLocaleDateString('en-GB', { month: 'short' }) : ''),
        el('span', { class: 'pf-body' }, el('span', { class: 'pf-tag' + (e.cat === PROC_CAT ? ' core' : '') }, e.cat === PROC_CAT ? (e.supervision || 'Procedure') : e.cat), el('span', { class: 'pf-title' }, e.type || '—'),
          [e.outcome, e.setting, e.with ? 'with ' + e.with : ''].filter(Boolean).length ? el('span', { class: 'sub' }, [e.outcome, e.setting, e.with ? 'with ' + e.with : ''].filter(Boolean).join(' · ')) : null,
          e.note ? el('span', { class: 'sub lb-note' }, e.note) : null)));

    const draw = () => {
      wrap.innerHTML = '';
      wrap.append(el('div', { class: 'pf-tabs-row' },
        el('div', { class: 'seg pf-tabs' }, ...['tally', 'history'].map((t) => el('button', { type: 'button', class: tab === t ? 'on' : '', onclick: () => { tab = t; remember(); draw(); } }, t === 'tally' ? 'Tally' : 'History'))),
        el('span', { class: 'spacer' }),
        el('a', { class: 'btn small', href: '#page/' + page.id, title: 'Open the note the entries live in' }, 'Note'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => form(null) }, '+ Log')));
      const body = el('div', { class: 'pf-body-view' }); wrap.append(body);
      if (tab === 'tally') {
        const procs = rows.filter((e) => e.cat === PROC_CAT);
        const counts = new Map();
        for (const e of procs) { const c = counts.get(e.type) || { n: 0, ind: 0, indirect: 0, dwith: 0, dwithout: 0, last: '' }; c.n++; if (e.supervision === 'Independent') c.ind++; else if (/^indirect/i.test(e.supervision)) c.indirect++; else if (/with assistance/i.test(e.supervision)) c.dwith++; else c.dwithout++; if ((e.date || '') > c.last) c.last = e.date || ''; counts.set(e.type, c); }
        const list = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
        body.append(el('div', { class: 'pf-tally' },
          el('div', { class: 'pf-fig core' }, el('b', {}, String(procs.length)), el('span', {}, 'procedures')),
          el('div', { class: 'pf-fig' }, el('b', {}, String(list.length)), el('span', {}, 'different types')),
          el('div', { class: 'pf-fig non' }, el('b', {}, String(rows.length - procs.length)), el('span', {}, 'other experiences'))));
        if (!list.length) body.append(el('p', { class: 'sub' }, 'Nothing logged yet. Tap + Log to add a procedure or an experience.'));
        else {
          const table = el('table', { class: 'dbtable lb-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Procedure'), el('th', {}, 'Total'), el('th', { title: 'Independent' }, 'Indep.'), el('th', { title: 'Indirect observation' }, 'Indirect'), el('th', { title: 'Direct observation without assistance' }, 'Direct'), el('th', { title: 'Direct observation with assistance' }, 'Assisted'), el('th', {}, 'Last'))));
          const tb = el('tbody', {});
          for (const [type, c] of list) tb.append(el('tr', { onclick: () => { tab = 'history'; filterCat = PROC_CAT; filterType = type; remember(); draw(); } }, el('td', {}, el('b', {}, type)), el('td', {}, String(c.n)), el('td', {}, String(c.ind)), el('td', {}, String(c.indirect)), el('td', {}, String(c.dwithout)), el('td', {}, String(c.dwith)), el('td', {}, fmtDay(c.last))));
          table.append(tb); body.append(el('div', { class: 'dbwrap' }, table));
        }
        const others = rows.filter((e) => e.cat !== PROC_CAT);
        if (others.length) {
          const byCat = new Map(); for (const e of others) byCat.set(e.cat, (byCat.get(e.cat) || 0) + 1);
          body.append(el('h3', { class: 'pf-sub' }, 'Other experience'), el('div', { class: 'tagchips' }, ...[...byCat.entries()].map(([c, n]) => el('button', { class: 'chip', type: 'button', onclick: () => { tab = 'history'; filterCat = c; filterType = ''; remember(); draw(); } }, c + ' ', el('span', { class: 'tp-n' }, String(n))))));
        }
      } else {
        const cats = [...new Set(rows.map((e) => e.cat))].sort((a, b) => (CATS.indexOf(a) + 1 || 99) - (CATS.indexOf(b) + 1 || 99));
        if (filterCat !== 'All' && !cats.includes(filterCat)) filterCat = 'All';
        body.append(el('div', { class: 'tagchips' }, ...['All', ...cats].map((c) => el('button', { class: 'chip' + (filterCat === c ? ' on' : ''), type: 'button', onclick: () => { filterCat = c; filterType = ''; draw(); } }, c))));
        if (filterCat === PROC_CAT) {
          const types = [...new Set(rows.filter((e) => e.cat === PROC_CAT).map((e) => e.type))].sort();
          body.append(el('div', { class: 'tagchips' }, el('button', { class: 'chip' + (filterType ? '' : ' on'), type: 'button', onclick: () => { filterType = ''; draw(); } }, 'Any procedure'), ...types.map((t) => el('button', { class: 'chip' + (filterType === t ? ' on' : ''), type: 'button', onclick: () => { filterType = filterType === t ? '' : t; draw(); } }, t))));
        }
        const shown = rows.filter((e) => (filterCat === 'All' || e.cat === filterCat) && (!filterType || e.type === filterType)).sort(byDate);
        body.append(shown.length ? el('div', { class: 'pf-list' }, ...shown.map(row)) : el('p', { class: 'sub' }, 'Nothing here yet.'));
        if (shown.length) body.append(el('div', { class: 'toolrow' }, el('button', { class: 'btn small', type: 'button', onclick: () => { const text = shown.map((e) => [e.date ? fmtDay(e.date) : '', e.cat === PROC_CAT ? e.type : e.cat + ': ' + e.type, e.supervision, e.outcome, e.setting, e.with ? 'with ' + e.with : '', e.note].filter(Boolean).join(' – ')).join('\n'); navigator.clipboard.writeText(text).then(() => ui.toast('Copied ' + shown.length + ' lines'), () => ui.toast('Could not copy')); } }, 'Copy list')));
      }
    };

    // Add a new entry (entry = null) or edit/delete an existing row.
    function form(entry) {
      const editing = !!entry;
      let cat = entry ? entry.cat : PROC_CAT, type = entry && entry.cat === PROC_CAT ? entry.type : '';
      let supervision = (entry && entry.supervision) || 'Direct observation with assistance', outcome = (entry && entry.outcome) || 'Successful';
      return ui.sheet((box, close) => {
        const date = el('input', { type: 'date', value: (entry && entry.date) || todayISO() });
        const catSel = el('select', {}, ...CATS.concat(cat && !CATS.includes(cat) ? [cat] : []).map((c) => el('option', { value: c }, c)));
        catSel.value = cat;
        const typeSel = el('select', {});
        const typeFree = el('input', { type: 'text', placeholder: 'What was it?', autocomplete: 'off', list: 'lb-recent', value: entry && entry.cat !== PROC_CAT ? entry.type : '' });
        const recent = el('datalist', { id: 'lb-recent' }, ...[...new Set(rows.filter((e) => e.cat !== PROC_CAT).map((e) => e.type))].slice(0, 30).map((t) => el('option', { value: t })));
        const fillTypes = () => {
          typeSel.innerHTML = '';
          typeSel.append(el('option', { value: '' }, 'Choose a procedure…'));
          for (const [grp, items] of Object.entries(PROCS)) typeSel.append(el('optgroup', { label: grp }, ...items.map((t) => el('option', { value: t }, t))));
          const known = new Set(Object.values(PROCS).flat());
          const extra = [...new Set([...((nb.logbook && nb.logbook.types) || []), ...rows.filter((e) => e.cat === PROC_CAT && e.type && !known.has(e.type)).map((e) => e.type)])];
          if (extra.length) typeSel.append(el('optgroup', { label: 'Added by you' }, ...extra.map((t) => el('option', { value: t }, t))));
          typeSel.append(el('option', { value: '__add' }, '+ Add a procedure type…'));
          if (type) typeSel.value = type;
        };
        fillTypes();
        // Adding a type happens inline (a sheet cannot open on top of a sheet).
        const addIn = el('input', { type: 'text', placeholder: 'New procedure type, e.g. Regional block (popliteal)', autocomplete: 'off' });
        const addRow = el('div', { class: 'formrow', hidden: '' }, addIn, el('button', { class: 'btn small', type: 'button', onclick: async () => { const v = addIn.value.trim(); if (!v) return; nb.logbook = nb.logbook || {}; nb.logbook.types = [...new Set([...(nb.logbook.types || []), v])]; await notebooks.update(nb.id, { logbook: nb.logbook }); ui.changed && ui.changed(); type = v; addIn.value = ''; addRow.hidden = true; fillTypes(); } }, 'Add'));
        typeSel.addEventListener('change', () => {
          if (typeSel.value === '__add') { addRow.hidden = false; setTimeout(() => addIn.focus(), 30); typeSel.value = type || ''; return; }
          type = typeSel.value;
        });
        const typeRow = el('div', { class: 'pf-field' }, 'Procedure', typeSel, addRow);
        const freeRow = el('label', { class: 'pf-field' }, 'What', typeFree, recent);
        const pick = (opts, get, set) => { const all = opts.concat(get() && !opts.includes(get()) ? [get()] : []); const sel = el('select', {}, ...all.map((o) => el('option', { value: o }, o))); sel.value = get(); sel.addEventListener('change', () => set(sel.value)); return sel; };
        const supRow = el('label', { class: 'pf-field' }, 'Level of supervision', pick(SUPERVISION, () => supervision, (v) => { supervision = v; }));
        const outRow = el('label', { class: 'pf-field' }, 'Outcome', pick(OUTCOME, () => outcome, (v) => { outcome = v; }));
        const setting = el('input', { type: 'text', placeholder: 'e.g. ITU, ED resus, ward', autocomplete: 'off', value: (entry && entry.setting) || '' });
        const withEl = el('input', { type: 'text', placeholder: 'Supervisor / who you were with (optional)', autocomplete: 'off', value: (entry && entry.with) || '' });
        const note = el('textarea', { rows: '3', placeholder: 'What happened, what you would do differently…' }); note.value = (entry && entry.note) || '';
        const err = el('p', { class: 'danger-note' });
        const syncCat = () => { cat = catSel.value; const proc = cat === PROC_CAT; typeRow.hidden = !proc; freeRow.hidden = proc; supRow.hidden = !proc; outRow.hidden = !proc; };
        catSel.addEventListener('change', syncCat);
        box.append(el('h2', {}, editing ? 'Edit entry' : 'Log an experience'),
          el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Date', date), el('label', { class: 'pf-field' }, 'Category', catSel)),
          typeRow, freeRow, supRow, outRow,
          el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Setting', setting), el('label', { class: 'pf-field' }, 'With', withEl)),
          el('label', { class: 'pf-field' }, 'Comments', note), err,
          el('div', { class: 'actions' },
            editing ? el('button', { class: 'btn danger', type: 'button', onclick: async () => { const i = rows.indexOf(entry); if (i >= 0) rows.splice(i, 1); await save(); close(); ui.toast('Entry deleted'); draw(); } }, 'Delete') : null,
            el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
            el('button', { class: 'btn primary', type: 'button', onclick: async () => {
              const proc = cat === PROC_CAT;
              const what = proc ? type : typeFree.value.trim();
              if (!what) { err.textContent = proc ? 'Choose the procedure.' : 'Say what it was.'; return; }
              const rec = { cat, type: what, date: date.value || todayISO(), supervision: proc ? supervision : '', outcome: proc ? outcome : '', setting: setting.value.trim(), with: withEl.value.trim(), note: note.value.trim().replace(/\s*\n\s*/g, ' ') };
              if (editing) { const i = rows.indexOf(entry); if (i >= 0) rows[i] = rec; else rows.push(rec); } else rows.push(rec);
              await save(); close(); ui.toast(editing ? 'Saved' : 'Logged'); draw();
            } }, 'Save')));
        syncCat();
      });
    }
    draw();
  }

  window.NCLogbook = { render, parse, serialise, NB, CATS, PROCS };
})();

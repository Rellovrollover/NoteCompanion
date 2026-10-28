// Logbook: your own record of procedures and experience, separate from the e-portfolio. A view over the
// "Logbook" notebook — one section per category (Procedure / DOPS, Clinic, Theatre…), every page one entry
// with its facts as properties (Date, Type, Supervision, Outcome, Setting, With). Extra procedure types you
// add are kept on the notebook record so every device offers them.
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
  const CATS = ['Procedure / DOPS', 'Clinic', 'Theatre / anaesthetics', 'Resus / arrest', 'Transfer', 'Ultrasound', 'Simulation', 'Teaching delivered', 'Other experience'];
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
  const prop = (p, k) => { const f = (p.props || []).find((x) => x.k === k); return f ? f.v : ''; };
  const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDay = (iso) => { const p = String(iso || '').split('-').map(Number); if (p.length !== 3) return iso || ''; return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };

  async function notebook() { return (await notebooks.all()).find((n) => n.name === NB) || null; }
  async function ensureNotebook() { let nb = await notebook(); if (!nb) nb = await notebooks.create(NB); return nb; }
  async function sectionFor(nb, cat) {
    const secs = await sections.forNotebook(nb.id);
    let s = secs.find((x) => !x.group && x.name === cat);
    if (!s) { s = await sections.create(nb.id, cat); await sections.update(s.id, { view: 'list' }); }
    return s;
  }
  const allProcs = (nb) => { const extra = (nb.logbook && nb.logbook.types) || []; const out = []; for (const list of Object.values(PROCS)) out.push(...list); return [...new Set(out.concat(extra))]; };

  async function entries(nb) {
    const secs = await sections.forNotebook(nb.id);
    const secById = new Map(secs.map((s) => [s.id, s]));
    const out = [];
    for (const p of (await pages.live()).filter((q) => q.notebookId === nb.id && q.kind !== 'app')) {
      const sec = secById.get(p.sectionId); if (!sec) continue;
      out.push({ id: p.id, cat: sec.name, date: prop(p, 'Date') || '', type: prop(p, 'Type') || p.title || '', supervision: prop(p, 'Supervision'), outcome: prop(p, 'Outcome'), setting: prop(p, 'Setting'), with: prop(p, 'With'), note: textOf(p.html), created: p.created || 0 });
    }
    return out.sort((a, b) => (a.date !== b.date ? ((a.date || '0') < (b.date || '0') ? 1 : -1) : b.created - a.created));
  }

  async function render(host, ui) {
    host.innerHTML = '';
    const nb = await ensureNotebook();
    const list = await entries(nb);
    let tab = 'tally', filterCat = 'All', filterType = '';
    try { const s = JSON.parse(localStorage.getItem('nc-logbook') || '{}'); tab = s.tab || tab; } catch (e) { /* ignore */ }
    const remember = () => { try { localStorage.setItem('nc-logbook', JSON.stringify({ tab })); } catch (e) { /* ignore */ } };
    const wrap = el('div', { class: 'lb' }); host.append(wrap);

    const row = (e) => el('div', { class: 'pf-entry' },
      el('a', { class: 'pf-main', href: '#page/' + e.id },
        el('span', { class: 'pf-date' }, el('b', {}, String(parseInt((e.date || '').split('-')[2], 10) || '')), (e.date || '').split('-')[1] ? new Date(e.date + 'T00:00').toLocaleDateString('en-GB', { month: 'short' }) : ''),
        el('span', { class: 'pf-body' }, el('span', { class: 'pf-tag' + (e.cat === CATS[0] ? ' core' : '') }, e.cat === CATS[0] ? (e.supervision || 'Procedure') : e.cat), el('span', { class: 'pf-title' }, e.type), [e.outcome, e.setting, e.with ? 'with ' + e.with : ''].filter(Boolean).length ? el('span', { class: 'sub' }, [e.outcome, e.setting, e.with ? 'with ' + e.with : ''].filter(Boolean).join(' · ')) : null)));

    const draw = () => {
      wrap.innerHTML = '';
      wrap.append(el('div', { class: 'pf-tabs-row' },
        el('div', { class: 'seg pf-tabs' }, ...['tally', 'history'].map((t) => el('button', { type: 'button', class: tab === t ? 'on' : '', onclick: () => { tab = t; remember(); draw(); } }, t === 'tally' ? 'Tally' : 'History'))),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn primary', type: 'button', onclick: () => form() }, '+ Log')));
      const body = el('div', { class: 'pf-body-view' }); wrap.append(body);
      if (tab === 'tally') {
        const procs = list.filter((e) => e.cat === CATS[0]);
        const counts = new Map();
        for (const e of procs) { const c = counts.get(e.type) || { n: 0, ind: 0, indirect: 0, dwith: 0, dwithout: 0, last: '' }; c.n++; if (e.supervision === 'Independent') c.ind++; else if (/^indirect/i.test(e.supervision)) c.indirect++; else if (/with assistance/i.test(e.supervision)) c.dwith++; else c.dwithout++; if (e.date > c.last) c.last = e.date; counts.set(e.type, c); }
        const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
        body.append(el('div', { class: 'pf-tally' },
          el('div', { class: 'pf-fig core' }, el('b', {}, String(procs.length)), el('span', {}, 'procedures')),
          el('div', { class: 'pf-fig' }, el('b', {}, String(rows.length)), el('span', {}, 'different types')),
          el('div', { class: 'pf-fig non' }, el('b', {}, String(list.length - procs.length)), el('span', {}, 'other experiences'))));
        if (!rows.length) body.append(el('p', { class: 'sub' }, 'Nothing logged yet. Tap + Log to add a procedure or an experience.'));
        else {
          const table = el('table', { class: 'dbtable lb-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Procedure'), el('th', {}, 'Total'), el('th', { title: 'Independent' }, 'Indep.'), el('th', { title: 'Indirect observation' }, 'Indirect'), el('th', { title: 'Direct observation without assistance' }, 'Direct'), el('th', { title: 'Direct observation with assistance' }, 'Assisted'), el('th', {}, 'Last'))));
          const tb = el('tbody', {});
          for (const [type, c] of rows) tb.append(el('tr', { onclick: () => { tab = 'history'; filterCat = CATS[0]; filterType = type; remember(); draw(); } }, el('td', {}, el('b', {}, type)), el('td', {}, String(c.n)), el('td', {}, String(c.ind)), el('td', {}, String(c.indirect)), el('td', {}, String(c.dwithout)), el('td', {}, String(c.dwith)), el('td', {}, fmtDay(c.last))));
          table.append(tb); body.append(el('div', { class: 'dbwrap' }, table));
        }
        const others = list.filter((e) => e.cat !== CATS[0]);
        if (others.length) {
          const byCat = new Map(); for (const e of others) byCat.set(e.cat, (byCat.get(e.cat) || 0) + 1);
          body.append(el('h3', { class: 'pf-sub' }, 'Other experience'), el('div', { class: 'tagchips' }, ...[...byCat.entries()].map(([c, n]) => el('button', { class: 'chip', type: 'button', onclick: () => { tab = 'history'; filterCat = c; filterType = ''; remember(); draw(); } }, c + ' ', el('span', { class: 'tp-n' }, String(n))))));
        }
      } else {
        const present = CATS.filter((c) => list.some((e) => e.cat === c));
        if (filterCat !== 'All' && !present.includes(filterCat)) filterCat = 'All';
        body.append(el('div', { class: 'tagchips' }, ...['All', ...present].map((c) => el('button', { class: 'chip' + (filterCat === c ? ' on' : ''), type: 'button', onclick: () => { filterCat = c; filterType = ''; draw(); } }, c))));
        if (filterCat === CATS[0]) {
          const types = [...new Set(list.filter((e) => e.cat === CATS[0]).map((e) => e.type))].sort();
          body.append(el('div', { class: 'tagchips' }, el('button', { class: 'chip' + (filterType ? '' : ' on'), type: 'button', onclick: () => { filterType = ''; draw(); } }, 'Any procedure'), ...types.map((t) => el('button', { class: 'chip' + (filterType === t ? ' on' : ''), type: 'button', onclick: () => { filterType = filterType === t ? '' : t; draw(); } }, t))));
        }
        const shown = list.filter((e) => (filterCat === 'All' || e.cat === filterCat) && (!filterType || e.type === filterType));
        body.append(shown.length ? el('div', { class: 'pf-list' }, ...shown.map(row)) : el('p', { class: 'sub' }, 'Nothing here yet.'));
        if (shown.length) body.append(el('div', { class: 'toolrow' }, el('button', { class: 'btn small', type: 'button', onclick: () => { const text = shown.map((e) => [e.date ? fmtDay(e.date) : '', e.cat === CATS[0] ? e.type : e.cat + ': ' + e.type, e.supervision, e.outcome, e.setting, e.with ? 'with ' + e.with : ''].filter(Boolean).join(' – ')).join('\n'); navigator.clipboard.writeText(text).then(() => ui.toast('Copied ' + shown.length + ' lines'), () => ui.toast('Could not copy')); } }, 'Copy list'), el('a', { class: 'btn small', href: '#nb/' + nb.id }, 'Notebook')));
      }
    };

    function form() {
      let cat = CATS[0], type = '', supervision = 'Direct observation with assistance', outcome = 'Successful';
      return ui.sheet((box, close) => {
        const date = el('input', { type: 'date', value: todayISO() });
        const catSel = el('select', {}, ...CATS.map((c) => el('option', { value: c }, c)));
        const typeSel = el('select', {});
        const typeFree = el('input', { type: 'text', placeholder: 'What was it?', autocomplete: 'off', list: 'lb-recent' });
        const recent = el('datalist', { id: 'lb-recent' }, ...[...new Set(list.filter((e) => e.cat !== CATS[0]).map((e) => e.type))].slice(0, 30).map((t) => el('option', { value: t })));
        const fillTypes = () => {
          typeSel.innerHTML = '';
          typeSel.append(el('option', { value: '' }, 'Choose a procedure…'));
          for (const [grp, items] of Object.entries(PROCS)) typeSel.append(el('optgroup', { label: grp }, ...items.map((t) => el('option', { value: t }, t))));
          const extra = ((nb.logbook && nb.logbook.types) || []);
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
        const pick = (opts, get, set) => { const sel = el('select', {}, ...opts.map((o) => el('option', { value: o }, o))); sel.value = get(); sel.addEventListener('change', () => set(sel.value)); return sel; };
        const supRow = el('label', { class: 'pf-field' }, 'Level of supervision', pick(SUPERVISION, () => supervision, (v) => { supervision = v; }));
        const outRow = el('label', { class: 'pf-field' }, 'Outcome', pick(OUTCOME, () => outcome, (v) => { outcome = v; }));
        const setting = el('input', { type: 'text', placeholder: 'e.g. ITU, ED resus, ward', autocomplete: 'off' });
        const withEl = el('input', { type: 'text', placeholder: 'Supervisor / who you were with (optional)', autocomplete: 'off' });
        const note = el('textarea', { rows: '3', placeholder: 'What happened, what you would do differently…' });
        const err = el('p', { class: 'danger-note' });
        const syncCat = () => { cat = catSel.value; const proc = cat === CATS[0]; typeRow.hidden = !proc; freeRow.hidden = proc; supRow.hidden = !proc; outRow.hidden = !proc; };
        catSel.addEventListener('change', syncCat);
        box.append(el('h2', {}, 'Log an experience'),
          el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Date', date), el('label', { class: 'pf-field' }, 'Category', catSel)),
          typeRow, freeRow, supRow, outRow,
          el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Setting', setting), el('label', { class: 'pf-field' }, 'With', withEl)),
          el('label', { class: 'pf-field' }, 'Comments', note), err,
          el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', onclick: async () => {
            const proc = cat === CATS[0];
            const what = proc ? type : typeFree.value.trim();
            if (!what) { err.textContent = proc ? 'Choose the procedure.' : 'Say what it was.'; return; }
            const props = [{ k: 'Date', v: date.value || todayISO() }, { k: 'Type', v: what }];
            if (proc) props.push({ k: 'Supervision', v: supervision }, { k: 'Outcome', v: outcome });
            if (setting.value.trim()) props.push({ k: 'Setting', v: setting.value.trim() });
            if (withEl.value.trim()) props.push({ k: 'With', v: withEl.value.trim() });
            const sec = await sectionFor(nb, cat);
            const html = note.value.trim() ? note.value.trim().split(/\n{2,}/).map((para) => '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>').join('') : '<p></p>';
            const p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title: what + (proc ? ' — ' + supervision : ''), html, props, tags: [], ptype: 'logbook' });
            close(); ui.changed && ui.changed();
            list.unshift({ id: p.id, cat, date: date.value || todayISO(), type: what, supervision: proc ? supervision : '', outcome: proc ? outcome : '', setting: setting.value.trim(), with: withEl.value.trim(), note: note.value.trim(), created: p.created });
            list.sort((a, b) => (a.date !== b.date ? ((a.date || '0') < (b.date || '0') ? 1 : -1) : b.created - a.created));
            ui.toast('Logged'); draw();
          } }, 'Save')));
        syncCat();
      });
    }
    draw();
  }

  window.NCLogbook = { render, NB, CATS, PROCS };
})();

// Shift Companion: on-call and ward jobs, kept on this device only (never synced), purged after
// seven days unless a job is kept for learning. Replaces the separate On-call and Ward Companion apps.
(function () {
  const { db, uuid } = window.NCDB;
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
  const DAY = 86400000, KEEP_DAYS = 7;
  const TYPES = ['ATSP', 'Review', 'Bloods', 'Imaging', 'Prescribe', 'Referral', 'Procedure', 'Discharge', 'Family', 'Other'];
  const PRIORITY = { 1: 'Now', 2: 'Soon', 3: 'Routine' };
  const OBS = [['hr', 'HR', 'bpm'], ['bp', 'BP', 'sys/dia'], ['rr', 'RR', '/min'], ['spo2', 'SpO₂', '%'], ['temp', 'Temp', '°C'], ['news', 'NEWS', '']];
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => { const d = new Date(ms), t = new Date(); const sameDay = d.toDateString() === t.toDateString(); return sameDay ? fmtTime(ms) : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + fmtTime(ms); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const prefs = { mode: 'oncall', view: 'queue', showWard: false, locations: [] };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nc-shift') || '{}')); } catch (e) { /* ignore */ }
  const savePrefs = () => { try { localStorage.setItem('nc-shift', JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  async function purge() {
    const cutoff = Date.now() - KEEP_DAYS * DAY;
    const old = await db.shift.where('created').below(cutoff).toArray();
    for (const j of old) if (!j.keep) await db.shift.delete(j.id);
    return old.filter((j) => !j.keep).length;
  }
  const all = () => db.shift.toArray();
  const put = (j) => { j.updated = Date.now(); return db.shift.put(j); };
  const newJob = (mode, type) => ({ id: uuid(), mode, type: type || 'Review', where: '', who: '', reason: '', obs: {}, context: '', plan: '', chase: [], callback: '', priority: 2, status: 'new', keep: false, learn: '', created: Date.now(), updated: Date.now() });

  // ---- main view ----
  async function render(host, ui) {
    host.innerHTML = '';
    const purged = await purge();
    const wrap = el('div', { class: 'shift' });
    host.append(wrap);
    let jobs = await all();
    const draw = async () => {
      jobs = await all();
      wrap.innerHTML = '';
      // Header: mode + views
      const modeSeg = el('div', { class: 'seg' }, ...[['oncall', 'On-call'], ['ward', 'Ward']].map(([k, v]) => el('button', { type: 'button', class: prefs.mode === k ? 'on' : '', onclick: () => { prefs.mode = k; if (k === 'ward' && prefs.view === 'queue') prefs.view = 'ward'; if (k === 'oncall' && prefs.view === 'ward') prefs.view = 'queue'; savePrefs(); draw(); } }, v)));
      const views = prefs.mode === 'oncall' ? [['queue', 'Queue'], ['chase', 'Chase'], ['handover', 'Handover'], ['learning', 'Learning']] : [['ward', 'By bed'], ['chase', 'Chase'], ['handover', 'Handover'], ['learning', 'Learning']];
      const viewSeg = el('div', { class: 'seg' }, ...views.map(([k, v]) => el('button', { type: 'button', class: prefs.view === k ? 'on' : '', onclick: () => { prefs.view = k; savePrefs(); draw(); } }, v)));
      const head = el('div', { class: 'shift-head' }, modeSeg, viewSeg, el('span', { class: 'spacer' }),
        prefs.mode === 'oncall' ? el('label', { class: 'shift-toggle' }, el('input', { type: 'checkbox', checked: prefs.showWard ? '' : null, onchange: (e) => { prefs.showWard = e.target.checked; savePrefs(); draw(); } }), ' include ward jobs') : null,
        el('label', { class: 'shift-toggle', title: 'Jobs sent from the iPhone Shortcut land on the device that has this on' }, el('input', { type: 'checkbox', checked: prefs.onShift ? '' : null, onchange: (e) => { setOnShift(e.target.checked); draw(); } }), ' receive Shortcut jobs here'),
        el('button', { class: 'btn small', type: 'button', onclick: () => endShift() }, 'End shift'));
      wrap.append(head);
      // Quick add row: type chips + one-line entry
      const quick = el('input', { class: 'shift-quick', type: 'text', placeholder: prefs.mode === 'oncall' ? 'Quick job: e.g. 9A ATSP hypotension — Enter' : 'Quick job: e.g. 12 bloods — Enter', autocomplete: 'off' });
      quick.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && quick.value.trim()) { e.preventDefault(); const j = parseQuick(quick.value.trim(), prefs.mode); await put(j); quick.value = ''; draw(); if (ui.toast) ui.toast('Added ' + j.type + (j.where ? ' · ' + j.where : '')); } });
      const chips = el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip', type: 'button', onclick: () => openJob(newJob(prefs.mode, t), true) }, t)));
      wrap.append(el('div', { class: 'shift-add' }, quick, chips));
      // Body
      const visible = jobs.filter((j) => prefs.view === 'learning' ? j.keep : (j.mode === prefs.mode || (prefs.mode === 'oncall' && prefs.showWard && j.mode === 'ward')));
      const open = visible.filter((j) => j.status !== 'done');
      if (prefs.view === 'queue') {
        open.sort((a, b) => a.priority - b.priority || a.created - b.created);
        wrap.append(listOf(open, 'Nothing in the queue.'));
        const done = visible.filter((j) => j.status === 'done').sort((a, b) => b.updated - a.updated);
        if (done.length) { const d = el('details', { class: 'shift-done' }, el('summary', {}, done.length + ' done'), listOf(done, '')); wrap.append(d); }
      } else if (prefs.view === 'ward') {
        const groups = new Map();
        for (const j of open) { const k = (j.where || '—').toUpperCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
        const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!keys.length) wrap.append(el('p', { class: 'sub' }, 'No ward jobs open.'));
        for (const k of keys) { wrap.append(el('h3', { class: 'shift-bed' }, k)); wrap.append(listOf(groups.get(k).sort((a, b) => a.priority - b.priority || a.created - b.created), '')); }
        const done = visible.filter((j) => j.status === 'done').sort((a, b) => b.updated - a.updated);
        if (done.length) { wrap.append(el('details', { class: 'shift-done' }, el('summary', {}, done.length + ' done'), listOf(done, ''))); }
      } else if (prefs.view === 'chase') {
        const rows = [];
        for (const j of open) for (const c of j.chase || []) if (!c.done) rows.push({ j, c });
        if (!rows.length) wrap.append(el('p', { class: 'sub' }, 'Nothing to chase.'));
        const ul = el('div', { class: 'shift-list' });
        for (const { j, c } of rows) ul.append(el('label', { class: 'shift-chase' }, el('input', { type: 'checkbox', onchange: async (e) => { c.done = e.target.checked; await put(j); setTimeout(draw, 250); } }), el('span', { class: 'shift-chase-text' }, c.text), el('span', { class: 'shift-chase-who' }, [j.where, j.who].filter(Boolean).join(' · ') || j.type)));
        wrap.append(ul);
      } else if (prefs.view === 'handover') {
        const text = handoverText(open);
        const ta = el('textarea', { class: 'shift-handover', readonly: '' }); ta.value = text;
        wrap.append(el('div', { class: 'formrow' }, el('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); ui.toast && ui.toast('Copied'); } catch (e) { ta.select(); } } }, 'Copy handover'), el('span', { class: 'sub' }, open.length + ' open job' + (open.length === 1 ? '' : 's'))), ta);
      } else if (prefs.view === 'learning') {
        const kept = jobs.filter((j) => j.keep).sort((a, b) => b.updated - a.updated);
        if (!kept.length) wrap.append(el('p', { class: 'sub' }, 'Nothing kept yet. Open a job and tap "Keep for learning" to hold it past the 7-day purge.'));
        wrap.append(listOf(kept, ''));
      }
      wrap.append(el('p', { class: 'sub shift-foot' }, 'Stays on this device only — not synced, not backed up. Jobs are deleted after ' + KEEP_DAYS + ' days unless kept.' + (purged ? ' Removed ' + purged + ' old job' + (purged === 1 ? '' : 's') + ' just now.' : '')));
    };
    function listOf(list, empty) {
      const ul = el('div', { class: 'shift-list' });
      if (!list.length) { if (empty) ul.append(el('p', { class: 'sub' }, empty)); return ul; }
      for (const j of list) {
        const chaseOpen = (j.chase || []).filter((c) => !c.done).length;
        const obs = OBS.filter(([k]) => j.obs && j.obs[k]).map(([k, label]) => label + ' ' + j.obs[k]).join(' · ');
        ul.append(el('div', { class: 'shift-job p' + j.priority + (j.status === 'done' ? ' done' : '') + (j.status === 'seen' ? ' seen' : ''), onclick: () => openJob(j, false) },
          el('div', { class: 'shift-job-top' },
            el('span', { class: 'shift-type' }, j.type), j.mode === 'ward' && prefs.mode === 'oncall' ? el('span', { class: 'shift-tag' }, 'ward') : null,
            el('b', {}, [j.where, j.who].filter(Boolean).join(' · ') || '—'), el('span', { class: 'spacer' }),
            el('span', { class: 'shift-when' }, fmtDay(j.created)), j.keep ? el('span', { class: 'shift-keep', title: 'Kept for learning' }, '★') : null),
          j.reason ? el('div', { class: 'shift-reason' }, j.reason) : null,
          obs ? el('div', { class: 'shift-obs' }, obs) : null,
          j.plan ? el('div', { class: 'shift-plan' }, j.plan) : null,
          chaseOpen ? el('div', { class: 'shift-chasecount' }, chaseOpen + ' to chase') : null,
          el('div', { class: 'shift-job-actions' },
            j.status !== 'done' ? el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.stopPropagation(); j.status = j.status === 'new' ? 'seen' : 'done'; await put(j); draw(); } }, j.status === 'new' ? 'Seen' : 'Done') : el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.stopPropagation(); j.status = 'seen'; await put(j); draw(); } }, 'Reopen'),
            j.callback ? el('a', { class: 'btn small', href: 'tel:' + j.callback.replace(/\s+/g, ''), onclick: (e) => e.stopPropagation() }, '☎ ' + j.callback) : null)));
      }
      return ul;
    }
    function handoverText(open) {
      const lines = [];
      const byWhere = [...open].sort((a, b) => (a.where || '').localeCompare(b.where || '', undefined, { numeric: true }) || a.priority - b.priority);
      for (const j of byWhere) {
        const chase = (j.chase || []).filter((c) => !c.done).map((c) => c.text);
        lines.push('• ' + [j.where, j.who].filter(Boolean).join(' ') + ' — ' + j.type + (j.reason ? ': ' + j.reason : '') + (j.plan ? '. Plan: ' + j.plan : '') + (chase.length ? '. To chase: ' + chase.join(', ') : '') + (j.priority === 1 ? ' [NOW]' : ''));
      }
      return lines.join('\n') || 'No open jobs.';
    }
    const openJob = (j, isNew) => jobSheet(j, isNew, ui, draw);
    async function endShift() {
      const open = jobs.filter((j) => j.status !== 'done' && j.mode === prefs.mode).length;
      if (!(await ui.confirm('End ' + (prefs.mode === 'oncall' ? 'on-call' : 'ward') + ' shift?', 'Done jobs are cleared now' + (open ? '; ' + open + ' open job' + (open === 1 ? '' : 's') + ' stay for the handover' : '') + '. Kept jobs are never cleared.', 'End shift'))) return;
      for (const j of jobs) if (j.mode === prefs.mode && j.status === 'done' && !j.keep) await db.shift.delete(j.id);
      draw();
    }
    await draw();
    return () => {};
  }

  // ---- job sheet (shared by the main view and the quick-add button) ----
  function jobSheet(j, isNew, ui, after) {
      const copy = JSON.parse(JSON.stringify(j));
      ui.sheet(async (box, close) => {
        const field = (label, input) => el('label', { class: 'shift-field' }, el('span', {}, label), input);
        const txt = (k, ph, opts) => { const i = el(opts && opts.area ? 'textarea' : 'input', Object.assign({ type: 'text', placeholder: ph || '', autocomplete: 'off' }, opts && opts.attrs || {})); i.value = copy[k] || ''; i.addEventListener('input', () => { copy[k] = i.value; }); return i; };
        const typeSel = el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip' + (copy.type === t ? ' on' : ''), type: 'button', onclick: (e) => { copy.type = t; for (const b of e.target.parentNode.children) b.classList.toggle('on', b.textContent === t); } }, t)));
        const modeSeg = el('div', { class: 'seg' }, ...[['oncall', 'On-call'], ['ward', 'Ward']].map(([k, v]) => el('button', { type: 'button', class: copy.mode === k ? 'on' : '', onclick: (e) => { copy.mode = k; for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target); } }, v)));
        const prSeg = el('div', { class: 'seg' }, ...[1, 2, 3].map((p) => el('button', { type: 'button', class: copy.priority === p ? 'on' : '', onclick: (e) => { copy.priority = p; for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target); } }, PRIORITY[p])));
        const whereIn = txt('where', 'Ward / bed, e.g. 9A', { attrs: { list: 'shift-locs' } });
        const locs = el('datalist', { id: 'shift-locs' }, ...prefs.locations.map((l) => el('option', { value: l })));
        const obsRow = el('div', { class: 'shift-obsrow' }, ...OBS.map(([k, label, ph]) => { const i = el('input', { type: 'text', placeholder: ph || label, inputmode: k === 'bp' ? 'text' : 'decimal', 'aria-label': label }); i.value = (copy.obs && copy.obs[k]) || ''; i.addEventListener('input', () => { copy.obs = copy.obs || {}; copy.obs[k] = i.value; }); return el('label', { class: 'shift-obs-field' }, el('span', {}, label), i); }));
        const chaseList = el('div', { class: 'shift-chaselist' });
        const drawChase = () => { chaseList.innerHTML = ''; for (const c of copy.chase || []) chaseList.append(el('label', { class: 'shift-chase' }, el('input', { type: 'checkbox', checked: c.done ? '' : null, onchange: (e) => { c.done = e.target.checked; } }), el('span', { class: 'shift-chase-text' }, c.text), el('button', { class: 'chip', type: 'button', onclick: () => { copy.chase.splice(copy.chase.indexOf(c), 1); drawChase(); } }, '×'))); };
        drawChase();
        const chaseIn = el('input', { type: 'text', placeholder: 'To chase: bloods, CXR, referral… Enter to add', autocomplete: 'off' });
        chaseIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && chaseIn.value.trim()) { e.preventDefault(); (copy.chase = copy.chase || []).push({ text: chaseIn.value.trim(), done: false }); chaseIn.value = ''; drawChase(); } });
        const keepBtn = el('button', { class: 'btn small' + (copy.keep ? ' primary' : ''), type: 'button', onclick: () => { copy.keep = !copy.keep; keepBtn.classList.toggle('primary', copy.keep); keepBtn.textContent = copy.keep ? '★ Kept for learning' : 'Keep for learning'; learnBox.hidden = !copy.keep; } }, copy.keep ? '★ Kept for learning' : 'Keep for learning');
        const learnBox = el('div', { class: 'shift-learn', hidden: copy.keep ? null : '' }, field('What I learned (no identifiers — this bit can go into your notes)', txt('learn', 'The teaching point, what you would do differently, what to read up…', { area: true })),
          el('button', { class: 'btn small', type: 'button', onclick: async () => { if (!copy.learn) { ui.toast && ui.toast('Write the learning point first'); return; } const t = await ui.pickSection('File learning note to'); if (!t) return; await ui.createPage({ notebookId: t.notebookId, sectionId: t.sectionId, title: copy.type + ' — ' + new Date(copy.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), html: '<p><strong>Learning point</strong></p>' + copy.learn.split(/\n+/).map((x) => '<p>' + esc(x) + '</p>').join('') + '<p><em>From a ' + esc(copy.mode === 'oncall' ? 'shift on call' : 'ward shift') + ' · ' + esc(copy.type) + '</em></p>' }); ui.toast && ui.toast('Filed to notes'); } }, 'Write up as a note'));
        box.append(el('h2', {}, isNew ? 'New job' : 'Job'),
          el('div', { class: 'formrow' }, modeSeg, prSeg),
          typeSel, locs,
          el('div', { class: 'shift-two' }, field('Where', whereIn), field('Who (initials)', txt('who', 'e.g. J.T.'))),
          field('Reason / request', txt('reason', copy.type === 'ATSP' ? 'Asked to see patient because…' : 'What needs doing', { attrs: { autofocus: '' } })),
          el('div', { class: 'shift-field' }, el('span', {}, 'Obs'), obsRow),
          field('Context', txt('context', 'PMHx, background, what was tried…', { area: true })),
          field('Impression / plan', txt('plan', 'Your impression and the plan', { area: true })),
          el('div', { class: 'shift-field' }, el('span', {}, 'To chase'), chaseList, chaseIn),
          field('Call back', txt('callback', 'Number / bleep', { attrs: { inputmode: 'tel' } })),
          el('div', { class: 'formrow' }, keepBtn), learnBox,
          el('div', { class: 'actions' },
            isNew ? null : el('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await ui.confirm('Delete this job?')) { await db.shift.delete(copy.id); close(); after && after(); } } }, 'Delete'),
            el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
            el('button', { class: 'btn primary', type: 'button', onclick: async () => { if (copy.where && !prefs.locations.includes(copy.where)) { prefs.locations = [copy.where, ...prefs.locations].slice(0, 30); savePrefs(); } await put(copy); close(); after && after(); } }, 'Save')));
      }, { centre: true });
  }

  // Quick add from anywhere (the bleep button): one line or a type chip.
  function quickSheet(ui, after) {
    ui.sheet((box, close) => {
      const quick = el('input', { class: 'shift-quick', type: 'text', placeholder: 'e.g. 9A ATSP hypotension — Enter', autocomplete: 'off' });
      quick.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && quick.value.trim()) { e.preventDefault(); const j = parseQuick(quick.value.trim(), prefs.mode); await put(j); close(); ui.toast && ui.toast('Added ' + j.type + (j.where ? ' · ' + j.where : '')); after && after(); } });
      box.append(el('h2', {}, 'New ' + (prefs.mode === 'oncall' ? 'on-call' : 'ward') + ' job'), quick,
        el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip', type: 'button', onclick: () => { close(); jobSheet(newJob(prefs.mode, t), true, ui, after); } }, t))),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel')));
    }, { centre: true });
  }
  const onShift = () => !!prefs.onShift;
  const setOnShift = (v) => { prefs.onShift = !!v; savePrefs(); };
  // A one-line job from the iPhone Shortcut (via the capture relay).
  async function addQuick(text) { const j = parseQuick(text, prefs.mode); await put(j); return j; }

  // "9A ATSP hypotension" → where 9A, type ATSP, reason hypotension. Type words are matched case-insensitively.
  function parseQuick(text, mode) {
    const j = newJob(mode, 'Review');
    const words = text.split(/\s+/);
    const typeIx = words.findIndex((w) => TYPES.some((t) => t.toLowerCase() === w.toLowerCase().replace(/[^a-z]/g, '')));
    if (typeIx >= 0) { j.type = TYPES.find((t) => t.toLowerCase() === words[typeIx].toLowerCase().replace(/[^a-z]/g, '')); words.splice(typeIx, 1); }
    if (words.length && /^[A-Za-z]?\d{1,2}[A-Za-z]?$|^(bay|bed|ward)\d*/i.test(words[0])) j.where = words.shift().toUpperCase();
    j.reason = words.join(' ');
    if (/\b(now|urgent|peri.?arrest|unresponsive)\b/i.test(text)) j.priority = 1;
    return j;
  }

  window.NCShift = { render, quickSheet, onShift, setOnShift, addQuick };
})();

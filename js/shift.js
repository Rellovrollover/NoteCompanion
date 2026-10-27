// Shift Companion: on-call and ward jobs, kept on this device only (never synced), purged after
// seven days unless a job is kept for learning. Replaces the separate On-call and Ward Companion apps.
(function () {
  const { db, uuid } = window.NCDB;
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
  // Each job type brings its own picks and stages, as the old On-call and Ward Companions did. ATSP is a Review.
  const TYPEDEF = {
    Review:    { icon: '🩺', hint: 'ATSP / review: obs, SBAR, impression' },
    Bloods:    { icon: '🩸', multi: true, picks: ['U&Es', 'FBC', 'CRP', 'LFTs', 'Bone profile', 'Mg', 'PO₄', 'Coag', 'VBG', 'ABG', 'Lactate', 'Group & Save', 'Troponin', 'Confusion screen', 'Blood cultures', 'HbA1c', 'TFTs', 'Amylase'], custom: 'Other test', stages: ['Not requested', 'Requested', 'Taken', 'Resulted', 'Actioned'] },
    Micro:     { icon: '🔬', picks: ['Blood cultures', 'Wound swab', 'Sputum MC&S', 'Urine MC&S', 'Stool PCR', 'Micro discussion', 'IVOST review'], custom: 'Other', stages: ['Not done', 'In progress', 'Done'] },
    Imaging:   { icon: '🖼', picks: ['XR', 'USS', 'CT', 'MRI', 'Echo', 'Endoscopy', 'ECG', 'Other'], detail: 'Body part / what', indication: true, stages: ['Not requested', 'Requested', 'Vetted', 'Performed', 'Reported', 'Actioned'] },
    Prescribe: { icon: '💊', picks: ['Regular meds review', 'VTE prophylaxis', 'AKI review', 'Laxative', 'Antiemetics', 'IV fluids', 'GKI', 'Antibiotics', 'Analgesia', 'Pharmacy query', 'Other'], crit: ['Steroids', 'Insulin', 'Inhalers', 'Anticoagulation', 'Antiepileptics', "Parkinson's meds", 'Immunosuppressants', 'Other critical med'], stages: ['To do', 'In progress', 'Done'] },
    Referral:  { icon: '📨', picks: ['Medical', 'Surgery', 'Ortho', 'Cardiology', 'Resp', 'Renal', 'Gastro', 'Neurology', 'Haematology', 'Oncology', 'Palliative care', 'ITU', 'DSN', 'Dietician', 'Physio', 'OT', 'SALT'], custom: 'Other team', stages: ['Not done', 'In progress', 'Done'] },
    Procedure: { icon: '💉', picks: ['Cannula', 'Bloods (phleb)', 'Catheter', 'NGT', 'ABG', 'VBG', 'LP', 'Other'], stages: ['To do', 'In progress', 'Done'] },
    Discharge: { icon: '📋', picks: ['Discharge letter', 'TTO', 'TTO not required', 'DN prescription'], stages: ['To do', 'In progress', 'Done'] },
    Family:    { icon: '👪', picks: ['Update given', 'Update needed', 'Collateral history', 'DNACPR discussion', 'Best interests'], stages: ['To do', 'In progress', 'Done'] },
    Other:     { icon: '📝', picks: ['Weight', 'Fluid balance chart', 'Catheter needed', 'BM monitoring', 'Fluid output monitoring'], custom: 'Describe', stages: ['To do', 'In progress', 'Done'] }
  };
  const TYPES = Object.keys(TYPEDEF);
  const TYPE_ALIASES = { atsp: 'Review', review: 'Review', bloods: 'Bloods', blood: 'Bloods', micro: 'Micro', imaging: 'Imaging', xr: 'Imaging', cxr: 'Imaging', ct: 'Imaging', uss: 'Imaging', ecg: 'Imaging', prescribe: 'Prescribe', rx: 'Prescribe', meds: 'Prescribe', referral: 'Referral', refer: 'Referral', procedure: 'Procedure', cannula: 'Procedure', catheter: 'Procedure', discharge: 'Discharge', tto: 'Discharge', family: 'Family', other: 'Other' };
  const FLAGS = ['🔺 Senior review', '↘️ Handed to me', '🔁 Re-review later', '👥 Colleagues aware', '🔬 Results pending', '🌅 Handover'];
  const PRIORITY = { 1: 'Now', 2: 'Soon', 3: 'Routine' };
  const OBS = [['news', 'NEWS', ''], ['hr', 'HR', 'bpm'], ['bp', 'BP', 'sys/dia'], ['rr', 'RR', '/min'], ['spo2', 'SpO₂', '%'], ['temp', 'Temp', '°C']];
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => { const d = new Date(ms), t = new Date(); const sameDay = d.toDateString() === t.toDateString(); return sameDay ? fmtTime(ms) : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + fmtTime(ms); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const typeOf = (j) => TYPEDEF[j.type] ? j.type : (TYPE_ALIASES[String(j.type || '').toLowerCase()] || 'Other');
  const def = (j) => TYPEDEF[typeOf(j)];
  const stageName = (j) => { const d = def(j); return d.stages ? d.stages[Math.min(j.stage || 0, d.stages.length - 1)] : ''; };
  const picksOf = (j) => (j.picks || []).join(', ');

  const prefs = { mode: 'oncall', view: 'queue', showWard: false, locations: [], filter: 'All', custom: {} };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('nc-shift') || '{}')); } catch (e) { /* ignore */ }
  const savePrefs = () => { try { localStorage.setItem('nc-shift', JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  async function purge() {
    const cutoff = Date.now() - KEEP_DAYS * DAY;
    const old = await db.shift.where('created').below(cutoff).toArray();
    for (const j of old) if (!j.keep) await db.shift.delete(j.id);
    return old.filter((j) => !j.keep).length;
  }
  const all = () => db.shift.toArray();
  const put = (j) => { j.updated = Date.now(); j.type = typeOf(j); return db.shift.put(j); };
  const newJob = (mode, type) => ({ id: uuid(), mode, type: TYPEDEF[type] ? type : 'Review', where: '', who: '', ref: '', picks: [], detail: '', indication: '', crit: '', stage: 0, reason: '', obs: {}, context: '', plan: '', chase: [], flags: [], callback: '', priority: 2, status: 'new', keep: false, learn: '', created: Date.now(), updated: Date.now() });

  // One line for the clipboard: who/where, what, where it's up to, plan, what's outstanding.
  function jobLine(j) {
    const d = def(j);
    const head = [j.where, j.who, j.ref ? 'ref ' + j.ref : ''].filter(Boolean).join(' · ');
    let what = typeOf(j);
    if (j.picks && j.picks.length) what += ': ' + picksOf(j);
    if (j.detail) what += ' ' + j.detail;
    if (j.crit) what += ' ⚠ ' + j.crit;
    if (d.stages) what += ' [' + stageName(j) + ']';
    const obs = OBS.filter(([k]) => j.obs && j.obs[k]).map(([k, label]) => label + ' ' + j.obs[k]).join(' ');
    const chase = (j.chase || []).filter((c) => !c.done).map((c) => c.text);
    return [head || '—', what, j.reason, j.indication ? 'for ' + j.indication : '', obs, j.plan ? 'Plan: ' + j.plan : '', chase.length ? 'To chase: ' + chase.join(', ') : '', j.callback ? '☎ ' + j.callback : '', j.priority === 1 ? '[NOW]' : '', (j.flags || []).join(' ')].filter(Boolean).join(' — ');
  }
  async function copyText(text, ui) { try { await navigator.clipboard.writeText(text); ui.toast && ui.toast('Copied'); } catch (e) { ui.toast && ui.toast(text); } }

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
      const modeSeg = el('div', { class: 'seg' }, ...[['oncall', 'On-call'], ['ward', 'Ward']].map(([k, v]) => el('button', { type: 'button', class: prefs.mode === k ? 'on' : '', onclick: () => { prefs.mode = k; if (k === 'ward' && prefs.view === 'queue') prefs.view = 'ward'; if (k === 'oncall' && prefs.view === 'ward') prefs.view = 'queue'; savePrefs(); draw(); } }, v)));
      const views = prefs.mode === 'oncall' ? [['queue', 'Queue'], ['chase', 'Chase'], ['handover', 'Handover'], ['learning', 'Learning']] : [['ward', 'By bed'], ['chase', 'Chase'], ['handover', 'Handover'], ['learning', 'Learning']];
      const viewSeg = el('div', { class: 'seg' }, ...views.map(([k, v]) => el('button', { type: 'button', class: prefs.view === k ? 'on' : '', onclick: () => { prefs.view = k; savePrefs(); draw(); } }, v)));
      wrap.append(el('div', { class: 'shift-head' }, modeSeg, viewSeg, el('span', { class: 'spacer' }),
        prefs.mode === 'oncall' ? el('label', { class: 'shift-toggle' }, el('input', { type: 'checkbox', checked: prefs.showWard ? '' : null, onchange: (e) => { prefs.showWard = e.target.checked; savePrefs(); draw(); } }), ' include ward jobs') : null,
        el('label', { class: 'shift-toggle', title: 'Jobs sent from the iPhone Shortcut land on the device that has this on' }, el('input', { type: 'checkbox', checked: prefs.onShift ? '' : null, onchange: (e) => { setOnShift(e.target.checked); draw(); } }), ' receive Shortcut jobs here'),
        el('button', { class: 'btn small', type: 'button', onclick: () => endShift() }, 'End shift')));
      // Quick add: one line, or a type chip for the full form.
      const quick = el('input', { class: 'shift-quick', type: 'text', placeholder: prefs.mode === 'oncall' ? 'Quick job: e.g. 9A ATSP hypotension — Enter' : 'Quick job: e.g. 12 bloods FBC U&Es — Enter', autocomplete: 'off' });
      quick.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && quick.value.trim()) { e.preventDefault(); const j = parseQuick(quick.value.trim(), prefs.mode); await put(j); quick.value = ''; draw(); if (ui.toast) ui.toast('Added ' + j.type + (j.where ? ' · ' + j.where : '')); } });
      wrap.append(el('div', { class: 'shift-add' }, quick, el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip', type: 'button', onclick: () => openJob(newJob(prefs.mode, t), true) }, TYPEDEF[t].icon + ' ' + t)))));
      // Filter by type
      const visibleAll = jobs.filter((j) => prefs.view === 'learning' ? j.keep : (j.mode === prefs.mode || (prefs.mode === 'oncall' && prefs.showWard && j.mode === 'ward')));
      const present = TYPES.filter((t) => visibleAll.some((j) => typeOf(j) === t));
      if (!present.includes(prefs.filter)) prefs.filter = 'All';
      if (present.length > 1 && prefs.view !== 'handover') wrap.append(el('div', { class: 'tagchips shift-filter' }, ...['All', ...present].map((t) => el('button', { class: 'chip' + (prefs.filter === t ? ' on' : ''), type: 'button', onclick: () => { prefs.filter = t; savePrefs(); draw(); } }, t === 'All' ? 'All' : TYPEDEF[t].icon + ' ' + t, t !== 'All' ? el('span', { class: 'tp-n' }, ' ' + visibleAll.filter((j) => typeOf(j) === t && j.status !== 'done').length) : null))));
      const visible = prefs.filter === 'All' ? visibleAll : visibleAll.filter((j) => typeOf(j) === prefs.filter);
      const open = visible.filter((j) => j.status !== 'done');
      if (prefs.view === 'queue') {
        open.sort((a, b) => a.priority - b.priority || a.created - b.created);
        wrap.append(listOf(open, 'Nothing in the queue.'));
        const done = visible.filter((j) => j.status === 'done').sort((a, b) => b.updated - a.updated);
        if (done.length) wrap.append(el('details', { class: 'shift-done' }, el('summary', {}, done.length + ' done'), listOf(done, '')));
      } else if (prefs.view === 'ward') {
        const groups = new Map();
        for (const j of open) { const k = (j.where || '—').toUpperCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
        const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!keys.length) wrap.append(el('p', { class: 'sub' }, 'No ward jobs open.'));
        for (const k of keys) { wrap.append(el('h3', { class: 'shift-bed' }, k)); wrap.append(listOf(groups.get(k).sort((a, b) => a.priority - b.priority || a.created - b.created), '')); }
        const done = visible.filter((j) => j.status === 'done').sort((a, b) => b.updated - a.updated);
        if (done.length) wrap.append(el('details', { class: 'shift-done' }, el('summary', {}, done.length + ' done'), listOf(done, '')));
      } else if (prefs.view === 'chase') {
        const rows = [];
        for (const j of open) for (const c of j.chase || []) if (!c.done) rows.push({ j, c });
        if (!rows.length) wrap.append(el('p', { class: 'sub' }, 'Nothing to chase.'));
        const ul = el('div', { class: 'shift-list' });
        for (const { j, c } of rows) ul.append(el('label', { class: 'shift-chase' }, el('input', { type: 'checkbox', onchange: async (e) => { c.done = e.target.checked; await put(j); setTimeout(draw, 250); } }), el('span', { class: 'shift-chase-text' }, c.text), el('span', { class: 'shift-chase-who' }, [j.where, j.who].filter(Boolean).join(' · ') || typeOf(j))));
        wrap.append(ul);
      } else if (prefs.view === 'handover') {
        const flagged = open.filter((j) => (j.flags || []).includes('🌅 Handover'));
        let onlyFlagged = flagged.length > 0;
        const ta = el('textarea', { class: 'shift-handover', readonly: '' });
        const refresh = () => { ta.value = handoverText(onlyFlagged ? flagged : open); };
        refresh();
        const toggle = flagged.length ? el('label', { class: 'shift-toggle' }, el('input', { type: 'checkbox', checked: '', onchange: (e) => { onlyFlagged = e.target.checked; refresh(); } }), ' only jobs flagged 🌅 Handover (' + flagged.length + ')') : null;
        wrap.append(el('div', { class: 'formrow' }, el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(ta.value, ui) }, 'Copy handover'), navigator.share ? el('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ text: ta.value }).catch(() => {}) }, 'Share…') : null, el('span', { class: 'sub' }, open.length + ' open job' + (open.length === 1 ? '' : 's'))), toggle, ta);
      } else if (prefs.view === 'learning') {
        const kept = visible.filter((j) => j.keep).sort((a, b) => b.updated - a.updated);
        if (!kept.length) wrap.append(el('p', { class: 'sub' }, 'Nothing kept yet. Open a job and tap "Keep for learning" to hold it past the 7-day purge.'));
        wrap.append(listOf(kept, ''));
      }
      wrap.append(el('p', { class: 'sub shift-foot' }, 'Stays on this device only — not synced, not backed up. Jobs are deleted after ' + KEEP_DAYS + ' days unless kept.' + (purged ? ' Removed ' + purged + ' old job' + (purged === 1 ? '' : 's') + ' just now.' : '')));
    };
    function listOf(list, empty) {
      const ul = el('div', { class: 'shift-list' });
      if (!list.length) { if (empty) ul.append(el('p', { class: 'sub' }, empty)); return ul; }
      for (const j of list) {
        const d = def(j);
        const chaseOpen = (j.chase || []).filter((c) => !c.done).length;
        const obs = OBS.filter(([k]) => j.obs && j.obs[k]).map(([k, label]) => label + ' ' + j.obs[k]).join(' · ');
        const what = [picksOf(j), j.detail, j.crit ? '⚠ ' + j.crit : ''].filter(Boolean).join(' · ');
        ul.append(el('div', { class: 'shift-job p' + j.priority + (j.status === 'done' ? ' done' : '') + (j.status === 'seen' ? ' seen' : ''), onclick: () => openJob(j, false) },
          el('div', { class: 'shift-job-top' },
            el('span', { class: 'shift-type' }, d.icon + ' ' + typeOf(j)), j.mode === 'ward' && prefs.mode === 'oncall' ? el('span', { class: 'shift-tag' }, 'ward') : null,
            el('b', {}, [j.where, j.who].filter(Boolean).join(' · ') || '—'), j.ref ? el('span', { class: 'shift-ref' }, '#' + j.ref) : null, el('span', { class: 'spacer' }),
            el('span', { class: 'shift-when' }, fmtDay(j.created)), j.keep ? el('span', { class: 'shift-keep', title: 'Kept for learning' }, '★') : null),
          what ? el('div', { class: 'shift-what' }, what) : null,
          j.reason ? el('div', { class: 'shift-reason' }, j.reason) : null,
          j.indication ? el('div', { class: 'shift-obs' }, 'For: ' + j.indication) : null,
          obs ? el('div', { class: 'shift-obs' }, obs) : null,
          j.plan ? el('div', { class: 'shift-plan' }, j.plan) : null,
          (j.flags || []).length ? el('div', { class: 'shift-flags' }, ...(j.flags || []).map((f) => el('span', { class: 'shift-tag' }, f))) : null,
          chaseOpen ? el('div', { class: 'shift-chasecount' }, chaseOpen + ' to chase') : null,
          el('div', { class: 'shift-job-actions' },
            // Staged types advance a step per tap; the last step marks the job done.
            d.stages && j.status !== 'done' ? el('button', { class: 'btn small shift-stage', type: 'button', title: 'Tap to move to the next stage', onclick: async (e) => { e.stopPropagation(); if ((j.stage || 0) < d.stages.length - 1) { j.stage = (j.stage || 0) + 1; if (j.status === 'new') j.status = 'seen'; if (j.stage === d.stages.length - 1) j.status = 'done'; } await put(j); draw(); } }, stageName(j) + ' ›') : null,
            j.status !== 'done' ? el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.stopPropagation(); j.status = j.status === 'new' ? 'seen' : 'done'; if (j.status === 'done' && d.stages) j.stage = d.stages.length - 1; await put(j); draw(); } }, j.status === 'new' ? 'Seen' : 'Done') : el('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.stopPropagation(); j.status = 'seen'; if (d.stages) j.stage = Math.max(0, d.stages.length - 2); await put(j); draw(); } }, 'Reopen'),
            el('button', { class: 'btn small', type: 'button', title: 'Copy this job as one line', onclick: (e) => { e.stopPropagation(); copyText(jobLine(j), ui); } }, 'Copy'),
            j.callback ? el('a', { class: 'btn small', href: 'tel:' + j.callback.replace(/\s+/g, ''), onclick: (e) => e.stopPropagation() }, '☎ ' + j.callback) : null)));
      }
      return ul;
    }
    function handoverText(open) {
      const byWhere = [...open].sort((a, b) => a.priority - b.priority || (a.where || '').localeCompare(b.where || '', undefined, { numeric: true }));
      const groups = [[1, '🔴 NOW'], [2, '🟠 SOON'], [3, '🔵 ROUTINE']];
      let txt = 'Handover — ' + new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '\n';
      for (const [p, label] of groups) {
        const list = byWhere.filter((j) => j.priority === p);
        if (!list.length) continue;
        txt += '\n' + label + ' (' + list.length + ')\n' + list.map((j) => '• ' + jobLine(j)).join('\n') + '\n';
      }
      return open.length ? txt.trim() : 'No open jobs.';
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
    const copy = Object.assign(newJob(j.mode, j.type), JSON.parse(JSON.stringify(j)));
    copy.type = typeOf(copy);
    ui.sheet(async (box, close) => {
      const field = (label, input) => el('label', { class: 'shift-field' }, el('span', {}, label), input);
      const txt = (k, ph, opts) => { const i = el(opts && opts.area ? 'textarea' : 'input', Object.assign({ type: 'text', placeholder: ph || '', autocomplete: 'off' }, opts && opts.attrs || {})); i.value = copy[k] || ''; i.addEventListener('input', () => { copy[k] = i.value; }); return i; };
      const seg = (key, options) => { const s = el('div', { class: 'seg' }); for (const [val, label] of options) s.append(el('button', { type: 'button', class: copy[key] === val ? 'on' : '', onclick: () => { copy[key] = val; [...s.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === val)); } }, label)); return s; };
      const modeSeg = seg('mode', [['oncall', 'On-call'], ['ward', 'Ward']]);
      const prSeg = seg('priority', [[1, 'Now'], [2, 'Soon'], [3, 'Routine']]);
      const typeSel = el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip' + (copy.type === t ? ' on' : ''), type: 'button', onclick: () => { if (copy.type !== t) { copy.type = t; copy.picks = []; copy.detail = ''; copy.crit = ''; copy.stage = 0; } [...typeSel.children].forEach((b, i) => b.classList.toggle('on', TYPES[i] === t)); drawTypeBits(); } }, TYPEDEF[t].icon + ' ' + t)));
      // The part of the form that depends on the type.
      const typeBits = el('div', { class: 'shift-typebits' });
      const drawTypeBits = () => {
        typeBits.innerHTML = '';
        const d = TYPEDEF[copy.type];
        if (d.picks) {
          const extra = (prefs.custom && prefs.custom[copy.type]) || [];
          const options = [...d.picks, ...extra.filter((x) => !d.picks.includes(x))];
          const row = el('div', { class: 'shift-chips' });
          const drawPicks = () => { row.innerHTML = ''; for (const o of options) row.append(el('button', { class: 'chip' + (copy.picks.includes(o) ? ' on' : ''), type: 'button', onclick: () => { if (d.multi) { copy.picks = copy.picks.includes(o) ? copy.picks.filter((x) => x !== o) : [...copy.picks, o]; } else copy.picks = copy.picks.includes(o) ? [] : [o]; drawPicks(); } }, o)); };
          drawPicks();
          typeBits.append(el('div', { class: 'shift-field' }, el('span', {}, d.multi ? 'Which' : 'What'), row));
          if (d.custom) { const add = el('input', { type: 'text', placeholder: d.custom + ' — Enter to add', autocomplete: 'off' }); add.addEventListener('keydown', (e) => { if (e.key === 'Enter' && add.value.trim()) { e.preventDefault(); const v = add.value.trim(); if (!options.includes(v)) options.push(v); prefs.custom = prefs.custom || {}; prefs.custom[copy.type] = [...new Set([...(prefs.custom[copy.type] || []), v])].slice(-20); savePrefs(); copy.picks = d.multi ? [...copy.picks, v] : [v]; add.value = ''; drawPicks(); } }); typeBits.append(el('div', { class: 'shift-field' }, add)); }
        }
        if (d.detail) typeBits.append(field(d.detail, txt('detail', 'e.g. chest, pelvis…')));
        if (d.indication) typeBits.append(field('Indication', txt('indication', 'What are you looking for?')));
        if (d.crit) { const row = el('div', { class: 'shift-chips' }); const drawCrit = () => { row.innerHTML = ''; for (const c of d.crit) row.append(el('button', { class: 'chip crit' + (copy.crit === c ? ' on' : ''), type: 'button', onclick: () => { copy.crit = copy.crit === c ? '' : c; drawCrit(); } }, c)); }; drawCrit(); typeBits.append(el('div', { class: 'shift-field' }, el('span', {}, '⚠ Critical medication'), row)); }
        if (d.stages) { const row = el('div', { class: 'seg shift-stages' }); const drawStages = () => { row.innerHTML = ''; d.stages.forEach((s, i) => row.append(el('button', { type: 'button', class: (copy.stage || 0) === i ? 'on' : '', onclick: () => { copy.stage = i; if (i === d.stages.length - 1) copy.status = 'done'; else if (copy.status === 'done') copy.status = 'seen'; drawStages(); } }, s))); }; drawStages(); typeBits.append(el('div', { class: 'shift-field' }, el('span', {}, 'Stage'), row)); }
        if (copy.type === 'Review') {
          const obsRow = el('div', { class: 'shift-obsrow' }, ...OBS.map(([k, label, ph]) => { const i = el('input', { type: 'text', placeholder: ph || label, inputmode: k === 'bp' ? 'text' : 'decimal', 'aria-label': label }); i.value = (copy.obs && copy.obs[k]) || ''; i.addEventListener('input', () => { copy.obs = copy.obs || {}; copy.obs[k] = i.value; }); return el('label', { class: 'shift-obs-field' }, el('span', {}, label), i); }));
          typeBits.append(field('Situation — asked to see because…', txt('reason', 'e.g. hypotension, NEWS 6', { attrs: isNew ? { autofocus: '' } : {} })),
            el('div', { class: 'shift-field' }, el('span', {}, 'Obs'), obsRow),
            field('Background', txt('context', 'PMHx, admission, what was tried…', { area: true })),
            field('Assessment / plan', txt('plan', 'Impression and plan', { area: true })));
        } else {
          typeBits.append(field('Reason / request', txt('reason', 'What and why', { attrs: isNew && !d.picks ? { autofocus: '' } : {} })),
            field('Notes / plan', txt('plan', 'Details, plan, who said what…', { area: true })));
        }
      };
      drawTypeBits();
      const whereIn = txt('where', 'Ward / bed, e.g. 9A', { attrs: { list: 'shift-locs' } });
      const locs = el('datalist', { id: 'shift-locs' }, ...prefs.locations.map((l) => el('option', { value: l })));
      const chaseList = el('div', { class: 'shift-chaselist' });
      const drawChase = () => { chaseList.innerHTML = ''; for (const c of copy.chase || []) chaseList.append(el('label', { class: 'shift-chase' }, el('input', { type: 'checkbox', checked: c.done ? '' : null, onchange: (e) => { c.done = e.target.checked; } }), el('span', { class: 'shift-chase-text' }, c.text), el('button', { class: 'chip', type: 'button', onclick: () => { copy.chase.splice(copy.chase.indexOf(c), 1); drawChase(); } }, '×'))); };
      drawChase();
      const chaseIn = el('input', { type: 'text', placeholder: 'To chase: bloods, CXR, referral… Enter to add', autocomplete: 'off' });
      chaseIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && chaseIn.value.trim()) { e.preventDefault(); (copy.chase = copy.chase || []).push({ text: chaseIn.value.trim(), done: false }); chaseIn.value = ''; drawChase(); } });
      const flagRow = el('div', { class: 'shift-chips' }); const drawFlags = () => { flagRow.innerHTML = ''; for (const f of FLAGS) flagRow.append(el('button', { class: 'chip' + ((copy.flags || []).includes(f) ? ' on' : ''), type: 'button', onclick: () => { copy.flags = (copy.flags || []).includes(f) ? copy.flags.filter((x) => x !== f) : [...(copy.flags || []), f]; drawFlags(); } }, f)); }; drawFlags();
      const keepBtn = el('button', { class: 'btn small' + (copy.keep ? ' primary' : ''), type: 'button', onclick: () => { copy.keep = !copy.keep; keepBtn.classList.toggle('primary', copy.keep); keepBtn.textContent = copy.keep ? '★ Kept for learning' : 'Keep for learning'; learnBox.hidden = !copy.keep; } }, copy.keep ? '★ Kept for learning' : 'Keep for learning');
      const learnBox = el('div', { class: 'shift-learn', hidden: copy.keep ? null : '' }, field('What I learned (no identifiers — this bit can go into your notes)', txt('learn', 'The teaching point, what you would do differently, what to read up…', { area: true })),
        el('button', { class: 'btn small', type: 'button', onclick: async () => { if (!copy.learn) { ui.toast && ui.toast('Write the learning point first'); return; } const t = await ui.pickSection('File learning note to'); if (!t) return; await ui.createPage({ notebookId: t.notebookId, sectionId: t.sectionId, title: copy.type + ' — ' + new Date(copy.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), html: '<p><strong>Learning point</strong></p>' + copy.learn.split(/\n+/).map((x) => '<p>' + esc(x) + '</p>').join('') + '<p><em>From a ' + esc(copy.mode === 'oncall' ? 'shift on call' : 'ward shift') + ' · ' + esc(copy.type) + '</em></p>' }); ui.toast && ui.toast('Filed to notes'); } }, 'Write up as a note'));
      box.append(el('h2', {}, isNew ? 'New job' : 'Job'),
        el('div', { class: 'formrow' }, modeSeg, prSeg),
        typeSel, locs,
        el('div', { class: 'shift-three' }, field('Where', whereIn), field('Who (initials)', txt('who', 'e.g. J.T.')), field('Ref', txt('ref', 'your own number', { attrs: { inputmode: 'numeric' } }))),
        typeBits,
        el('div', { class: 'shift-field' }, el('span', {}, 'To chase'), chaseList, chaseIn),
        el('div', { class: 'shift-field' }, el('span', {}, 'Flags'), flagRow),
        field('Call back', txt('callback', 'Number / bleep', { attrs: { inputmode: 'tel' } })),
        el('div', { class: 'formrow' }, keepBtn, isNew ? null : el('button', { class: 'btn small', type: 'button', onclick: () => copyText(jobLine(copy), ui) }, 'Copy as one line')), learnBox,
        el('div', { class: 'actions' },
          isNew ? null : el('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await ui.confirm('Delete this job?')) { await db.shift.delete(copy.id); close(); after && after(); } } }, 'Delete'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
          el('button', { class: 'btn primary', type: 'button', onclick: async () => { if (copy.where && !prefs.locations.includes(copy.where)) { prefs.locations = [copy.where, ...prefs.locations].slice(0, 30); savePrefs(); } await put(copy); close(); after && after(); } }, 'Save')));
    }, { centre: true });
  }

  // Quick add from anywhere: one line or a type chip.
  function quickSheet(ui, after) {
    ui.sheet((box, close) => {
      const quick = el('input', { class: 'shift-quick', type: 'text', placeholder: 'e.g. 9A ATSP hypotension — Enter', autocomplete: 'off' });
      quick.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && quick.value.trim()) { e.preventDefault(); const j = parseQuick(quick.value.trim(), prefs.mode); await put(j); close(); ui.toast && ui.toast('Added ' + j.type + (j.where ? ' · ' + j.where : '')); after && after(); } });
      box.append(el('h2', {}, 'New ' + (prefs.mode === 'oncall' ? 'on-call' : 'ward') + ' job'), quick,
        el('div', { class: 'shift-chips' }, ...TYPES.map((t) => el('button', { class: 'chip', type: 'button', onclick: () => { close(); jobSheet(newJob(prefs.mode, t), true, ui, after); } }, TYPEDEF[t].icon + ' ' + t))),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel')));
    }, { centre: true });
  }
  const onShift = () => !!prefs.onShift;
  const setOnShift = (v) => { prefs.onShift = !!v; savePrefs(); };
  // A one-line job from the iPhone Shortcut (via the capture relay).
  async function addQuick(text) { const j = parseQuick(text, prefs.mode); await put(j); return j; }

  // "9A ATSP hypotension" → where 9A, type Review, reason hypotension. "12 bloods FBC U&Es" picks the tests too.
  function parseQuick(text, mode) {
    const j = newJob(mode, 'Review');
    const words = text.split(/\s+/);
    const typeIx = words.findIndex((w) => TYPE_ALIASES[w.toLowerCase().replace(/[^a-z]/g, '')]);
    let typeWord = '';
    if (typeIx >= 0) { typeWord = words[typeIx]; j.type = TYPE_ALIASES[typeWord.toLowerCase().replace(/[^a-z]/g, '')]; words.splice(typeIx, 1); }
    if (words.length && /^[A-Za-z]?\d{1,2}[A-Za-z]?$|^(bay|bed|ward)\d*/i.test(words[0])) j.where = words.shift().toUpperCase();
    const d = TYPEDEF[j.type];
    // "CT" or "cannula" named the type and is also one of its picks.
    if (d.picks && typeWord) { const hit = d.picks.find((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '') === typeWord.toLowerCase().replace(/[^a-z0-9]/g, '')); if (hit) j.picks.push(hit); }
    if (d.picks) {
      const rest = [];
      for (const w of words) { const hit = d.picks.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '') === w.toLowerCase().replace(/[^a-z0-9]/g, '')); if (hit && (d.multi || !j.picks.length)) j.picks.push(hit); else rest.push(w); }
      j.reason = rest.join(' ');
    } else j.reason = words.join(' ');
    if (/\b(now|urgent|peri.?arrest|unresponsive)\b/i.test(text)) j.priority = 1;
    return j;
  }

  window.NCShift = { render, quickSheet, onShift, setOnShift, addQuick, jobLine };
})();

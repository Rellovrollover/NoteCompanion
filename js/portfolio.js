// Portfolio log: a view over the "Portfolio" notebook. One section per entry type (Teaching, CBD, Mini-CEX, DOPS,
// Reflection, Audit/QI, Other); every page is one entry with its facts as properties (Date, Kind, Hours, Speaker, With).
// Teaching targets live on the notebook record so every device shares them.
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
  const NB = 'Portfolio';
  const TYPES = [
    ['Teaching', 'Core or non-core hours'], ['CBD', 'Case-based discussion'], ['Mini-CEX', 'Observed encounter'], ['DOPS', 'Observed procedure'],
    ['DCT', 'Developing the Clinical Teacher'], ['TAB', 'Team assessment of behaviour'], ['PSG', 'Placement supervision group'],
    ['Reflection', 'Reflective entry'], ['Audit/QI', 'Project work or data'], ['Other', 'Meetings, PDP, anything else']];
  const QUICK = [0.5, 1, 1.5, 2, 3, 7];
  const prop = (p, k) => { const f = (p.props || []).find((x) => x.k === k); return f ? f.v : ''; };
  const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const slash = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; };
  const fh = (n) => String(Math.round((Number(n) || 0) * 100) / 100);
  const hrs = (n) => fh(n) + (Number(n) === 1 ? ' hr' : ' hrs');
  const fmtLong = (iso) => { const p = String(iso || '').split('-').map(Number); if (p.length !== 3) return iso; return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };

  async function notebook() { return (await notebooks.all()).find((n) => n.name === NB) || null; }
  async function ensureNotebook() { let nb = await notebook(); if (!nb) nb = await notebooks.create(NB); return nb; }
  async function sectionFor(nb, type) {
    const secs = await sections.forNotebook(nb.id);
    let s = secs.find((x) => !x.group && x.name === type);
    if (!s) { s = await sections.create(nb.id, type); await sections.update(s.id, { view: 'list' }); }
    return s;
  }
  // The line the ePortfolio wants.
  const line = (e) => e.type === 'Teaching'
    ? slash(e.date) + ' – Teaching (' + (e.kind === 'Non-core' ? 'Non-core' : 'Core') + ') – ' + hrs(e.hours) + ' – ' + e.title + (e.speaker ? ' (' + e.speaker + ')' : '')
    : slash(e.date) + ' – ' + e.type + ': ' + (e.note || e.title) + (e.with ? ' (with ' + e.with + ')' : '');

  async function entries(nb) {
    const secs = await sections.forNotebook(nb.id);
    const secById = new Map(secs.map((s) => [s.id, s]));
    const out = [];
    for (const p of (await pages.live()).filter((q) => q.notebookId === nb.id && q.kind !== 'app')) {
      const sec = secById.get(p.sectionId); if (!sec) continue;
      const type = sec.name;
      out.push({ id: p.id, type, date: prop(p, 'Date') || '', kind: prop(p, 'Kind') || 'Core', hours: Number(prop(p, 'Hours')) || 0, speaker: prop(p, 'Speaker'), with: prop(p, 'With'), title: p.title || '', note: type === 'Teaching' ? '' : textOf(p.html), created: p.created || 0, eventId: prop(p, 'EventId') });
    }
    return out.sort((a, b) => (a.date !== b.date ? ((a.date || '0') < (b.date || '0') ? 1 : -1) : b.created - a.created));
  }

  async function render(host, ui) {
    host.innerHTML = '';
    const nb = await ensureNotebook();
    const targets = Object.assign({ core: 30, total: 60 }, nb.portfolio || {});
    const list = await entries(nb);
    let tab = 'log', filter = 'All';
    try { const s = JSON.parse(localStorage.getItem('nc-portfolio') || '{}'); tab = s.tab || tab; } catch (e) { /* ignore */ }
    const remember = () => { try { localStorage.setItem('nc-portfolio', JSON.stringify({ tab })); } catch (e) { /* ignore */ } };
    const wrap = el('div', { class: 'pf' }); host.append(wrap);
    const totals = () => { let core = 0, non = 0; for (const e of list) if (e.type === 'Teaching') { if (e.kind === 'Non-core') non += e.hours; else core += e.hours; } return { core: Math.round(core * 100) / 100, non: Math.round(non * 100) / 100, total: Math.round((core + non) * 100) / 100 }; };

    const row = (e) => el('div', { class: 'pf-entry' },
      el('a', { class: 'pf-main', href: '#page/' + e.id },
        el('span', { class: 'pf-date' }, el('b', {}, String(parseInt((e.date || '').split('-')[2], 10) || '')), (e.date || '').split('-')[1] ? new Date(e.date + 'T00:00').toLocaleDateString('en-GB', { month: 'short' }) : ''),
        el('span', { class: 'pf-body' }, el('span', { class: 'pf-tag' + (e.type === 'Teaching' ? (e.kind === 'Non-core' ? ' non' : ' core') : '') }, e.type === 'Teaching' ? (e.kind === 'Non-core' ? 'Non-core teaching' : 'Core teaching') : e.type), el('span', { class: 'pf-title' }, e.title || e.note.slice(0, 120) || 'Untitled')),
        e.type === 'Teaching' ? el('span', { class: 'pf-hrs' }, hrs(e.hours)) : null),
      el('button', { class: 'btn small', type: 'button', title: 'Copy the ePortfolio line', onclick: () => { navigator.clipboard.writeText(line(e)).then(() => ui.toast('Copied'), () => ui.toast(line(e))); } }, 'Copy'));

    const draw = () => {
      wrap.innerHTML = '';
      wrap.append(el('div', { class: 'seg pf-tabs' }, ...['log', 'teaching', 'history'].map((t) => el('button', { type: 'button', class: tab === t ? 'on' : '', onclick: () => { tab = t; remember(); draw(); } }, t === 'log' ? 'Log' : t === 'teaching' ? 'Teaching' : 'History'))));
      const body = el('div', { class: 'pf-body-view' }); wrap.append(body);
      if (tab === 'log') {
        const t = totals();
        body.append(el('div', { class: 'pf-types' }, ...TYPES.map(([name, desc]) => el('button', { type: 'button', class: 'pf-type' + (name === 'Teaching' ? ' teach' : ''), onclick: () => form(name) },
          el('span', { class: 'pf-tl' }, el('b', {}, name === 'Audit/QI' ? 'Audit / QI' : name), el('span', {}, desc)),
          name === 'Teaching' ? el('span', { class: 'pf-mini', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, (_, i) => { const lo = i * Math.max(1, targets.total / 10); return el('i', { class: t.core > lo ? 'f' : t.total > lo ? 'n' : '' }); })) : null))));
        if (window.NCGCal && NCGCal.state().signedIn) {
          const sug = el('div', { class: 'pf-sug' }); body.append(sug);
          NCGCal.teachingCandidates(60).then((evs) => {
            const logged = new Set(list.map((e) => e.eventId).filter(Boolean));
            const open = evs.filter((ev) => !logged.has(ev.id)).reverse().slice(0, 8);
            if (!open.length) return;
            sug.append(el('h3', { class: 'pf-sub' }, 'From your calendar'), el('p', { class: 'sub' }, 'Sessions that look like teaching and are not logged yet.'));
            const ul = el('div', { class: 'pf-list' });
            for (const ev of open) ul.append(el('div', { class: 'pf-entry' }, el('span', { class: 'pf-main' }, el('span', { class: 'pf-date' }, el('b', {}, String(parseInt(ev.start.slice(8, 10), 10))), new Date(ev.start.slice(0, 10) + 'T00:00').toLocaleDateString('en-GB', { month: 'short' })), el('span', { class: 'pf-body' }, el('span', { class: 'pf-title' }, ev.title), el('span', { class: 'sub' }, ev.cal + (ev.allDay ? ' · all day' : ''))), el('span', { class: 'pf-hrs' }, hrs(ev.hours))), el('button', { class: 'btn small primary', type: 'button', onclick: () => form('Teaching', { date: ev.start.slice(0, 10), hours: ev.hours, topic: ev.title, eventId: ev.id }) }, 'Log this')));
            sug.append(ul);
          }).catch((e) => console.warn('calendar suggestions failed', e));
        }
        const recent = list.slice(0, 3);
        if (recent.length) body.append(el('h3', { class: 'pf-sub' }, 'Recent'), el('div', { class: 'pf-list' }, ...recent.map(row)));
      } else if (tab === 'teaching') {
        const t = totals();
        const coreLeft = Math.max(0, targets.core - t.core), totLeft = Math.max(0, targets.total - t.total);
        const remain = coreLeft === 0 && totLeft === 0 ? 'Both targets met.' : coreLeft === 0 ? 'Core target met. ' + hrs(totLeft) + ' still to go overall.' : totLeft === 0 ? 'Total met. ' + hrs(coreLeft) + ' of core still to go.' : hrs(coreLeft) + ' of core and ' + hrs(totLeft) + ' overall still to go.';
        body.append(el('div', { class: 'pf-tally' },
          el('div', { class: 'pf-fig core' }, el('b', {}, fh(t.core)), el('span', {}, 'of ' + targets.core + ' core')),
          el('div', { class: 'pf-fig non' }, el('b', {}, fh(t.non)), el('span', {}, 'non-core')),
          el('div', { class: 'pf-fig' }, el('b', {}, fh(t.total)), el('span', {}, 'of ' + targets.total + ' total'))),
          el('p', { class: 'pf-remain' }, remain));
        const cells = Math.max(10, Math.ceil(targets.total / 10) * 10, Math.ceil(t.total / 10) * 10);
        const chart = el('div', { class: 'pf-chart', role: 'img', 'aria-label': fh(t.core) + ' core and ' + fh(t.non) + ' non-core hours of ' + targets.total });
        for (let r = 0; r < cells / 10; r++) {
          const rowEl = el('div', { class: 'pf-row' });
          for (let c = 0; c < 10; c++) {
            const i = r * 10 + c, cf = Math.min(1, Math.max(0, t.core - i)), tf = Math.min(1, Math.max(0, t.total - i));
            const cell = el('span', { class: 'pf-cell' + (targets.core > 0 && i === targets.core - 1 ? ' mark' : '') });
            if (tf > 0) cell.style.background = 'linear-gradient(to right, var(--pf-core) 0 ' + (cf * 100).toFixed(1) + '%, var(--pf-non) ' + (cf * 100).toFixed(1) + '% ' + (tf * 100).toFixed(1) + '%, var(--raised) ' + (tf * 100).toFixed(1) + '% 100%)';
            rowEl.append(cell);
          }
          rowEl.append(el('em', {}, String((r + 1) * 10)));
          chart.append(rowEl);
        }
        body.append(chart, el('p', { class: 'sub' }, 'Each square is one hour. The dark line marks your core target.'));
        const core = el('input', { type: 'number', min: '0', step: '1', value: String(targets.core), inputmode: 'decimal' });
        const total = el('input', { type: 'number', min: '1', step: '1', value: String(targets.total), inputmode: 'decimal' });
        body.append(el('details', { class: 'pf-targets' }, el('summary', {}, 'Targets'),
          el('div', { class: 'pf-targets-grid' }, el('label', {}, 'Core hours', core), el('label', {}, 'Total hours', total)),
          el('button', { class: 'btn small', type: 'button', onclick: async () => {
            const c = Math.max(0, Math.round(Number(core.value) || 0)), tt = Math.max(1, Math.round(Number(total.value) || 0));
            if (c > tt) { ui.toast("Core can't be more than the total."); return; }
            targets.core = c; targets.total = tt; await notebooks.update(nb.id, { portfolio: { core: c, total: tt } }); ui.changed && ui.changed(); ui.toast('Targets saved'); draw();
          } }, 'Save targets')));
        const sessions = list.filter((e) => e.type === 'Teaching');
        body.append(el('h3', { class: 'pf-sub' }, 'Sessions'), sessions.length ? el('div', { class: 'pf-list' }, ...sessions.map(row)) : el('p', { class: 'sub' }, 'No teaching logged yet.'));
      } else {
        const present = new Set(list.map((e) => e.type));
        const opts = ['All', ...TYPES.map(([n]) => n).filter((n) => present.has(n))];
        if (!opts.includes(filter)) filter = 'All';
        body.append(el('div', { class: 'tagchips' }, ...opts.map((o) => el('button', { class: 'chip' + (filter === o ? ' on' : ''), type: 'button', onclick: () => { filter = o; draw(); } }, o))));
        const shown = list.filter((e) => filter === 'All' || e.type === filter);
        body.append(shown.length ? el('div', { class: 'pf-list' }, ...shown.map(row)) : el('p', { class: 'sub' }, 'Nothing logged yet.'));
        if (shown.length) body.append(el('div', { class: 'toolrow' }, el('button', { class: 'btn small', type: 'button', onclick: () => { const text = shown.map(line).join('\n'); navigator.clipboard.writeText(text).then(() => ui.toast('Copied ' + shown.length + ' lines'), () => ui.toast('Could not copy')); } }, 'Copy all for ePortfolio'), el('a', { class: 'btn small', href: '#nb/' + nb.id }, 'Notebook')));
      }
    };

    // The entry form, as a sheet.
    function form(type, prefill = {}) {
      const teach = type === 'Teaching';
      let kind = prefill.kind || 'Core';
      return ui.sheet((box, close) => {
        const date = el('input', { type: 'date', value: prefill.date || todayISO() });
        const hours = el('input', { type: 'number', step: '0.25', min: '0.25', value: prefill.hours ? fh(prefill.hours) : '1', inputmode: 'decimal', class: 'pf-hours' });
        const quick = el('div', { class: 'tagchips' });
        const syncQuick = () => { quick.innerHTML = ''; for (const q of QUICK) quick.append(el('button', { class: 'chip' + (Number(hours.value) === q ? ' on' : ''), type: 'button', onclick: () => { hours.value = fh(q); syncQuick(); } }, fh(q) + (q === 7 ? ' (day)' : ''))); };
        syncQuick(); hours.addEventListener('input', syncQuick);
        const seg = el('div', { class: 'seg' }, ...['Core', 'Non-core'].map((k) => el('button', { type: 'button', class: k === kind ? 'on' : '', onclick: (e) => { kind = k; [...seg.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, k)));
        const topic = el('input', { type: 'text', placeholder: 'e.g. Sepsis update', autocomplete: 'off', value: prefill.topic || '' });
        const speaker = el('input', { type: 'text', placeholder: 'optional', autocomplete: 'off' });
        const note = el('textarea', { rows: '5', placeholder: 'What happened, and what you took from it' });
        const withEl = el('input', { type: 'text', placeholder: 'optional', autocomplete: 'off' });
        const err = el('p', { class: 'danger-note' });
        box.append(el('h2', {}, type === 'Audit/QI' ? 'Audit / QI' : type), el('label', { class: 'pf-field' }, 'Date', date));
        if (teach) box.append(el('div', { class: 'pf-field' }, 'Teaching type', seg), el('div', { class: 'pf-field' }, 'Hours', el('div', { class: 'pf-stepper' }, el('button', { class: 'btn', type: 'button', onclick: () => { hours.value = fh(Math.max(0.25, (Number(hours.value) || 1) - 0.5)); syncQuick(); } }, '−'), hours, el('button', { class: 'btn', type: 'button', onclick: () => { hours.value = fh((Number(hours.value) || 0) + 0.5); syncQuick(); } }, '+')), quick), el('label', { class: 'pf-field' }, 'Topic', topic), el('label', { class: 'pf-field' }, 'Speaker', speaker));
        else box.append(el('label', { class: 'pf-field' }, 'Note', note), el('label', { class: 'pf-field' }, 'Assessor or supervisor', withEl));
        box.append(err, el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const d = date.value || todayISO();
          let fields;
          if (teach) {
            const h = Math.round((Number(hours.value) || 0) * 100) / 100, t = topic.value.trim();
            if (!(h > 0)) { err.textContent = 'Enter the hours, for example 1.5.'; return; }
            if (!t) { err.textContent = 'Add a topic so you can find this session later.'; return; }
            fields = { title: t, html: speaker.value.trim() ? '<p>Speaker: ' + esc(speaker.value.trim()) + '</p>' : '<p></p>', props: [{ k: 'Date', v: d }, { k: 'Kind', v: kind }, { k: 'Hours', v: fh(h) }].concat(speaker.value.trim() ? [{ k: 'Speaker', v: speaker.value.trim() }] : []).concat(prefill.eventId ? [{ k: 'EventId', v: prefill.eventId }] : []) };
          } else {
            const n = note.value.trim();
            if (!n) { err.textContent = 'Add a short note before saving.'; return; }
            fields = { title: n.split('\n')[0].slice(0, 80), html: n.split(/\n{2,}/).map((para) => '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>').join(''), props: [{ k: 'Date', v: d }].concat(withEl.value.trim() ? [{ k: 'With', v: withEl.value.trim() }] : []) };
          }
          const sec = await sectionFor(nb, type);
          const p = await pages.create(Object.assign({ notebookId: nb.id, sectionId: sec.id, tags: [], ptype: 'portfolio' }, fields));
          close();
          ui.changed && ui.changed();
          const e = { id: p.id, type, date: d, kind, hours: Number(prop(p, 'Hours')) || 0, speaker: prop(p, 'Speaker'), with: prop(p, 'With'), title: p.title, note: teach ? '' : textOf(p.html), created: p.created, eventId: prefill.eventId || '' };
          list.unshift(e); list.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.created - a.created));
          ui.toast('Saved', { label: 'Copy for ePortfolio', fn: () => navigator.clipboard.writeText(line(e)).then(() => ui.toast('Copied')) });
          draw();
        } }, 'Save entry')));
      });
    }
    draw();
  }

  window.NCPortfolio = { render, NB, TYPES };
})();

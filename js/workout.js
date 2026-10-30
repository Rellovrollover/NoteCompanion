// Workout: a gym logger over your own workout notes ("Workout A V2", "Workout B - V2", …).
// It reads the note's main table (exercise rows; a Reps/Sets column; then Start, Pre-Op, Workout 19, 20 … columns)
// and the Instruction Videos table under it. Logging a set of an exercise writes into a new "Workout N" column
// for today, in the same style ("Cable / 7.5kg x 12 / 7.5kg x 12"), so the note stays the record.
(function () {
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayLabel = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // ---------- reading the note ----------
  // A table as a grid, with merged cells repeated so every row has every column; "first" marks the real cell.
  function grid(table) {
    const rows = [...table.rows]; const cells = [];
    rows.forEach((tr, r) => {
      cells[r] = cells[r] || [];
      let c = 0;
      for (const td of tr.cells) {
        while (cells[r][c]) c++;
        const rs = Math.max(1, td.rowSpan || 1), cs = Math.max(1, td.colSpan || 1);
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { cells[r + i] = cells[r + i] || []; cells[r + i][c + j] = { td, first: i === 0 && j === 0 }; }
        c += cs;
      }
    });
    return { rows, cells };
  }
  // A cell's lines (split at line breaks and paragraphs), each with its text and any links in it.
  function lines(node) {
    const out = [{ text: '', links: [] }];
    const cur = () => out[out.length - 1];
    const nl = () => { if (cur().text.trim() || cur().links.length) out.push({ text: '', links: [] }); };
    const walk = (n) => {
      for (const k of n.childNodes) {
        if (k.nodeType === 3) cur().text += k.nodeValue;
        else if (k.nodeType === 1) {
          const t = k.tagName;
          if (t === 'BR') { nl(); continue; }
          if (t === 'A') { const href = k.getAttribute('href') || ''; const txt = k.textContent || ''; cur().text += txt; if (href && !href.startsWith('#')) cur().links.push({ href, text: txt.trim() }); continue; }
          const block = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|TABLE|TR)$/.test(t);
          if (block) nl();
          walk(k);
          if (block) nl();
        }
      }
    };
    walk(node);
    for (const l of out) {
      l.text = l.text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      for (const m of l.text.matchAll(/https?:\/\/[^\s<>"]+/g)) if (!l.links.some((x) => x.href === m[0])) l.links.push({ href: m[0], text: m[0] });
    }
    return out.filter((l) => l.text || l.links.length);
  }
  const cellText = (td) => (td ? lines(td).map((l) => l.text).join(' ').trim() : '');
  const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/s\b/g, '').replace(/\s+/g, ' ').trim();

  function findMain(root) {
    for (const t of root.querySelectorAll('table')) {
      const g = grid(t);
      for (let r = 0; r < Math.min(3, g.rows.length); r++) {
        const heads = (g.cells[r] || []).map((x) => (x ? cellText(x.td) : ''));
        if (heads.length >= 3 && heads.some((h) => /reps|sets/i.test(h))) return { table: t, g, headRow: r, heads };
      }
    }
    return null;
  }
  // Which column today's session goes in: one already dated today; otherwise the first empty "Workout N" column after
  // the last one with numbers in it (you keep a few ready, sometimes with the equipment pre-written); otherwise none
  // (a new column is added at the end).
  function locate(main) {
    const { g, headRow, heads } = main;
    const today = todayLabel();
    const targetCol = Math.max(1, heads.findIndex((h) => /reps|sets/i.test(h)));
    const dated = heads.findIndex((h, c) => c > targetCol && /workout/i.test(h) && h.includes(today));
    if (dated >= 0) return { c: dated, dated: true };
    const hasNumbers = (c) => { for (let r = headRow + 1; r < g.rows.length; r++) { const x = (g.cells[r] || [])[c]; if (x && x.first && /\d/.test(cellText(x.td))) return true; } return false; };
    let lastData = targetCol;
    for (let c = targetCol + 1; c < heads.length; c++) if (hasNumbers(c)) lastData = c;
    for (let c = lastData + 1; c < heads.length; c++) if (/workout\s*\d+/i.test(heads[c])) return { c, dated: false };
    return null;
  }
  // "Cable 7.5kg x 12 7.5kg x 10" → { variant: 'Cable', sets: [{w: 7.5, r: '12'}, {w: 7.5, r: '10'}] }.
  // Copes with "57 x 7", "10kgx12", "22.5kg x 7-8" and the odd "12 x 70kg" written the other way round.
  const PAIR = /(\d+(?:\.\d+)?|\bbw\b|\bbodyweight\b)\s*(kg)?\s*[x×]\s*(\d+(?:\s*-\s*\d+)?)\s*(kg)?/gi;
  function readCell(raw) {
    raw = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!raw) return { raw: '', sets: [], variant: '' };
    const sets = []; let m, first = -1; PAIR.lastIndex = 0;
    while ((m = PAIR.exec(raw))) {
      if (first < 0) first = m.index;
      let w = m[1], r = m[3]; if (m[4] && !m[2] && /^\d/.test(m[1])) { w = m[3]; r = m[1]; }
      sets.push({ w: /^\d/.test(w) ? parseFloat(w) : 'BW', r: r.replace(/\s+/g, '') });
    }
    if (!sets.length) { const kg = raw.match(/(\d+(?:\.\d+)?)\s*kg/i); if (kg) { sets.push({ w: parseFloat(kg[1]), r: '' }); first = kg.index; } }
    const cut = first >= 0 ? first : raw.search(/\d/);
    const variant = (cut < 0 ? raw : raw.slice(0, cut)).replace(/[\s,;:·–-]+$/, '').trim();
    return { raw, sets, variant };
  }
  const setsOf = (target) => { const m = String(target || '').match(/x\s*(\d+)/i); return m ? Math.min(8, +m[1]) : 3; };

  function parse(html) {
    const root = document.createElement('div'); root.innerHTML = html || '';
    const main = findMain(root); if (!main) return null;
    const { g, headRow, heads } = main;
    const targetCol = Math.max(1, heads.findIndex((h) => /reps|sets/i.test(h)));
    const loc = locate(main);
    const cols = [];
    for (let c = targetCol + 1; c < heads.length; c++) { const label = heads[c] || ''; const m = label.match(/workout\s*(\d+)/i); cols.push({ c, label: label || ('Column ' + (c + 1)), n: m ? +m[1] : null, today: !!loc && loc.c === c }); }
    const exercises = [];
    for (let r = headRow + 1; r < g.rows.length; r++) {
      const row = g.cells[r] || [];
      if (!row[0] || !row[0].first) continue;
      const name = cellText(row[0].td); if (!name) continue;
      const target = row[targetCol] && row[targetCol].first ? lines(row[targetCol].td).map((l) => l.text).join(' · ') : '';
      const hist = [];
      let todayEntry = null, planned = '';
      for (const col of cols) {
        const x = row[col.c]; const e = Object.assign({ col }, readCell(x && x.first ? cellText(x.td) : ''));
        // Today's column: numbers in it mean it's logged; just the equipment written in means that's the plan.
        if (col.today) { if (e.sets.length) todayEntry = e; else planned = e.variant || ''; continue; }
        if (e.raw) hist.push(e);
      }
      // "Last time" is the latest column with numbers in it; a column with just the equipment named doesn't count.
      const withSets = hist.filter((e) => e.sets.length);
      const last = withSets[withSets.length - 1] || hist[hist.length - 1] || null;
      const latestVariant = (hist.slice().reverse().find((e) => e.variant) || {}).variant || '';
      exercises.push({ r, name, target, nsets: setsOf(target), hist, last, latestVariant, planned, today: todayEntry, key: norm(name), videos: [] });
    }
    // Instruction videos: any other table, exercise name down the left (once per group), then a variant and its link per line.
    const videos = [];
    for (const t of root.querySelectorAll('table')) {
      if (t === main.table) continue;
      const vg = grid(t); let cur = '';
      vg.rows.forEach((tr, r) => {
        const row = vg.cells[r] || [];
        const nm = row[0] && row[0].first ? cellText(row[0].td) : '';
        if (nm) cur = nm;
        if (!cur) return;
        for (let c = 1; c < row.length; c++) {
          if (!row[c] || !row[c].first) continue;
          for (const l of lines(row[c].td)) {
            let label = l.text; for (const k of l.links) label = label.split(k.text).join(' ');
            label = label.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
            const variant = (label.replace(/\(.*$/, '').trim() || label).replace(/[:\-–]+$/, '').trim();
            if (variant || l.links.length) videos.push({ ex: cur, key: norm(cur), variant, label, links: l.links });
          }
        }
      });
    }
    for (const ex of exercises) {
      let hits = videos.filter((v) => v.key === ex.key);
      if (!hits.length) hits = videos.filter((v) => v.key && ex.key && (ex.key.startsWith(v.key) || v.key.startsWith(ex.key)));
      ex.videos = hits;
    }
    const nums = cols.map((c) => c.n || 0);
    const todayCol = cols.find((c) => c.today) || null;
    const started = !!(loc && loc.dated);
    return { exercises, cols, todayCol, started, next: todayCol && todayCol.n ? todayCol.n : Math.max(0, ...nums) + 1 };
  }

  // ---------- writing today's column ----------
  // Puts cellHtml into this exercise's cell in today's column, adding "Workout N (date)" at the end if needed.
  function writeCell(html, rowIndex, cellHtml) {
    const root = document.createElement('div'); root.innerHTML = html || '';
    const main = findMain(root); if (!main) throw new Error('Workout table not found in the note');
    const today = todayLabel();
    const loc = locate(main);
    let c = loc ? loc.c : -1;
    if (loc && !loc.dated) { const hx = (main.g.cells[main.headRow] || [])[c]; if (hx && hx.first) hx.td.innerHTML = hx.td.innerHTML.replace(/(<br\s*\/?>\s*)+$/i, '') + '<br>' + esc(today); }
    // Rows with fewer cells than the header get empty ones first, so today's entry lands under today's heading.
    const pad = (upto) => { const g0 = grid(main.table); main.g.rows.forEach((tr, r) => { let have = (g0.cells[r] || []).length; while (have < upto) { tr.appendChild(document.createElement('td')); have++; } }); };
    if (c < 0) {
      pad(main.heads.length);
      const n = Math.max(0, ...main.heads.map((h) => { const m = h.match(/workout\s*(\d+)/i); return m ? +m[1] : 0; })) + 1;
      main.g.rows.forEach((tr, r) => {
        const head = r === main.headRow;
        const sample = tr.cells[tr.cells.length - 1];
        const cell = document.createElement(head && sample && sample.tagName === 'TH' ? 'th' : 'td');
        if (head) cell.innerHTML = sample && sample.querySelector('strong, b') ? '<strong>Workout ' + n + '</strong><br>' + esc(today) : 'Workout ' + n + '<br>' + esc(today);
        tr.appendChild(cell);
      });
      const cg = main.table.querySelector('colgroup'); if (cg) cg.appendChild(document.createElement('col'));
      c = main.heads.length;
    }
    else pad(c + 1);
    const g = grid(main.table);
    const x = (g.cells[rowIndex] || [])[c];
    if (x && x.first) x.td.innerHTML = cellHtml;
    return root.innerHTML;
  }
  const fmtW = (w) => { const t = String(w).trim(); return /^\d+(\.\d+)?$/.test(t) ? t + 'kg' : t; };
  const cellFor = (variant, sets) => [variant ? esc(variant) : null, ...sets.map((s) => esc(fmtW(s.w) + (s.r ? ' x ' + s.r : '')))].filter(Boolean).join('<br>');
  const setText = (s) => (s.w !== '' && s.w != null ? fmtW(s.w) : '') + (s.r ? ' × ' + s.r : '');
  const entryText = (e) => [e.variant, e.sets.length ? e.sets.map(setText).join(', ') : (e.variant ? '' : e.raw)].filter(Boolean).join(' · ') || e.raw;

  // ---------- history ----------
  // Best: the heaviest weight actually lifted for reps (a starting weight with no reps only counts if there's nothing else).
  function best(ex) {
    let top = null;
    const all = ex.hist.concat(ex.today ? [ex.today] : []);
    const lifted = all.some((e) => e.sets.some((s) => s.r));
    for (const e of all) for (const s of e.sets.filter((x) => typeof x.w === 'number' && (!lifted || x.r))) {
      const reps = parseInt(s.r, 10) || 0;
      if (!top || s.w > top.s.w || (s.w === top.s.w && reps > (parseInt(top.s.r, 10) || 0))) top = { e, s };
    }
    return top;
  }
  function historySheet(ex, ui) {
    ui.sheet((box, close) => {
      box.classList.add('wk-sheet');
      box.append(el('h2', {}, ex.name), ex.target ? el('p', { class: 'rule' }, ex.target) : null);
      const withLinks = ex.videos.filter((v) => v.links.length), noLink = ex.videos.filter((v) => !v.links.length && v.variant);
      if (withLinks.length) {
        box.append(el('div', { class: 'wk-hlabel' }, 'Videos'), el('div', { class: 'wk-videos' }, ...withLinks.map((v) => v.links.map((k) => el('a', { class: 'wk-video', href: k.href, target: '_blank', rel: 'noopener' }, el('span', { class: 'wk-play', 'aria-hidden': 'true' }, '▶'), el('span', {}, el('b', {}, v.variant || 'Video'), el('small', {}, /^https?:/i.test(k.text) ? k.href.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) : k.text)))))));
      }
      if (noLink.length) box.append(el('p', { class: 'sub wk-novid' }, (withLinks.length ? 'No video yet for: ' : 'No videos in the note yet for: ') + noLink.map((v) => v.variant).join(', ')));
      const all = ex.hist.concat(ex.today ? [ex.today] : []);
      if (!all.length) box.append(el('p', { class: 'sub' }, 'Nothing logged yet.'));
      else {
        const top = best(ex), first = all[0];
        box.append(el('div', { class: 'wk-stats' },
          el('div', {}, el('small', {}, 'Started'), el('b', {}, entryText(first)), el('span', {}, first.col.label)),
          top ? el('div', {}, el('small', {}, 'Best'), el('b', {}, setText(top.s)), el('span', {}, [top.e.variant, top.e.col.today ? 'today' : top.e.col.label].filter(Boolean).join(' · '))) : null));
        box.append(el('div', { class: 'wk-hlabel' }, 'Last ' + Math.min(5, all.length)), el('div', { class: 'wk-recent' }, ...all.slice(-5).reverse().map((e) => el('div', {}, el('span', {}, e.col.today ? 'Today' : e.col.label), el('b', {}, entryText(e))))));
      }
      box.append(el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close')));
    });
  }

  // ---------- the session page ----------
  const EQUIP = ['Dumbbell', 'Barbell', 'Machine', 'Cable', 'Rope', 'Bodyweight', 'Kettlebell', 'Smith machine', 'Band', 'Plate'];
  function session(host, page, ui) {
    let info = parse(page.html);
    host.innerHTML = '';
    if (!info) { host.append(el('p', { class: 'sub' }, 'No workout table found in this note — it needs a table with a Reps/Sets column.')); return { destroy() {} }; }
    const bar = el('div', { class: 'wk-bar' });
    const list = el('div', { class: 'wk-list' });
    host.append(bar, list);
    const drawBar = () => {
      const done = info.exercises.filter((e) => e.today).length;
      bar.replaceChildren(el('b', {}, 'Workout ' + info.next), el('span', {}, todayLabel() + ' · ' + done + ' of ' + info.exercises.length + ' logged'), el('span', { class: 'wk-prog' }, el('i', { style: 'width:' + Math.round(done / Math.max(1, info.exercises.length) * 100) + '%' })));
    };
    const cards = info.exercises.map((ex, i) => card(ex, i));
    list.append(...cards.map((c) => c.node));
    drawBar();
    // Finish: marks the session done, puts it in Google Calendar and makes the other workout next.
    const fin = el('div', { class: 'wk-finish' });
    host.append(fin);
    const drawFin = () => {
      if (ui.finishedToday && ui.finishedToday()) { fin.replaceChildren(el('p', { class: 'wk-finished' }, el('b', {}, '✓ Workout ' + info.next + ' finished'), ui.nextLabel ? el('span', {}, 'Next time: ' + ui.nextLabel()) : null)); return; }
      fin.replaceChildren(el('button', { class: 'btn primary wk-finish-btn', type: 'button', onclick: finish }, 'Finish workout ✓'));
    };
    async function finish() {
      const done = info.exercises.filter((e) => e.today);
      if (!done.length) { ui.toast('Log at least one exercise first'); return; }
      if (done.length < info.exercises.length && !(await ui.confirm('Finish with ' + done.length + ' of ' + info.exercises.length + ' logged?', 'The others stay blank for this session.', 'Finish'))) return;
      const lines = done.map((e) => e.name.replace(/\s*\(.*\)\s*$/, '') + ': ' + entryText(e.today));
      if (ui.finish) await ui.finish({ n: info.next, lines });
      drawFin();
    }
    drawFin();

    function card(ex0, idx) {
      const node = el('section', { class: 'wk-card' });
      let editing = false;
      const draw = () => {
        const ex = info.exercises[idx];
        const last = ex.last;
        const done = !!ex.today && !editing;
        node.className = 'wk-card' + (done ? ' done' : '');
        const head = el('div', { class: 'wk-head' },
          el('button', { type: 'button', class: 'wk-name', title: 'History and videos', onclick: () => historySheet(info.exercises[idx], ui) }, ex.name, ex.videos.some((v) => v.links.length) ? el('span', { class: 'wk-hasvid', 'aria-label': 'has videos' }, '▶') : null),
          el('span', { class: 'wk-tick', 'aria-hidden': 'true' }));
        const sub = el('div', { class: 'wk-sub' }, ex.target ? el('span', { class: 'wk-target' }, ex.target.replace(/\s*rest\s*$/i, '').replace(/·\s*$/, '')) : null,
          last ? el('span', { class: 'wk-last' }, 'Last: ', el('b', {}, entryText(last)), ' · ' + last.col.label) : el('span', { class: 'wk-last' }, 'First time'));
        if (done) {
          node.replaceChildren(head, sub, el('div', { class: 'wk-donebar' }, el('span', {}, entryText(ex.today)), el('button', { type: 'button', class: 'btn small', onclick: () => { editing = true; draw(); } }, 'Change')));
          return;
        }
        // Equipment / variant: the options listed for this exercise in the note, anything used before, then the usual kit.
        const seen = [];
        const addOpt = (v) => { const t = String(v || '').trim(); if (t && !seen.some((x) => x.toLowerCase() === t.toLowerCase())) seen.push(t); };
        ex.videos.forEach((v) => addOpt(v.variant));
        ex.hist.slice().reverse().forEach((e) => addOpt(e.variant));
        const fromNote = seen.length;
        EQUIP.forEach(addOpt);
        const pre = (ex.today && ex.today.variant) || ex.planned || ex.latestVariant || (last && last.variant) || (fromNote ? seen[0] : '');
        addOpt(pre);
        const sel = el('select', { class: 'wk-variant', 'aria-label': 'Equipment' },
          ...seen.map((v, k) => el('option', { value: v, selected: v.toLowerCase() === pre.toLowerCase() ? '' : null, 'data-group': k < fromNote ? 'note' : 'kit' }, v.length > 34 ? v.slice(0, 32).trim() + '…' : v)),
          el('option', { value: '' , selected: pre ? null : '' }, '— none —'), el('option', { value: '__other' }, 'Other…'));
        sel.addEventListener('change', async () => { if (sel.value !== '__other') return; const v = await ui.ask('Equipment', 'e.g. Single arm cable', '', 'Use'); if (v) { const o = el('option', { value: v }, v); sel.insertBefore(o, sel.firstChild); sel.value = v; } else sel.value = pre; });
        // Sets: one row each, with last time's numbers shown faintly in the boxes.
        const n = Math.max(ex.nsets, (ex.today && ex.today.sets.length) || 0, 1);
        const rows = el('div', { class: 'wk-sets' });
        const addRow = (k, wv, rv) => {
          const lastSet = (last && (last.sets[k] || last.sets[last.sets.length - 1])) || null;
          const w = el('input', { class: 'wk-w', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: lastSet && lastSet.w !== '' && lastSet.w != null ? String(lastSet.w) : 'kg', value: wv != null ? String(wv) : '' });
          const r = el('input', { class: 'wk-r', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: lastSet && lastSet.r ? String(lastSet.r) : 'reps', value: rv != null ? String(rv) : '' });
          rows.append(el('div', { class: 'wk-set' }, el('span', { class: 'wk-setn' }, 'Set ' + (k + 1)), w, el('span', { class: 'wk-unit' }, 'kg ×'), r, el('span', { class: 'wk-unit' }, 'reps')));
        };
        for (let k = 0; k < n; k++) { const s = ex.today && ex.today.sets[k]; addRow(k, s ? s.w : null, s ? s.r : null); }
        const fillLast = () => { if (!last || !last.sets.length) { ui.toast('Nothing from last time to copy'); return; } [...rows.children].forEach((row, k) => { const s = last.sets[k] || last.sets[last.sets.length - 1]; const [w, r] = row.querySelectorAll('input'); w.value = s.w != null ? s.w : ''; r.value = s.r || ''; }); };
        const log = async () => {
          const sets = [...rows.children].map((row) => { const [w, r] = row.querySelectorAll('input'); return { w: w.value.trim(), r: r.value.trim() }; }).filter((s) => s.w || s.r);
          if (!sets.length) { ui.toast('Fill in at least one set'); return; }
          const variant = sel.value === '__other' ? '' : sel.value;
          try {
            const html = writeCell(page.html, ex.r, cellFor(variant, sets));
            await ui.save(html);
            page.html = html; info = parse(html); editing = false;
            cards.forEach((c) => c.redrawIfDone && c.redrawIfDone());
            draw(); drawBar();
            ui.toast(ex.name.replace(/\s*\(.*\)\s*$/, '') + ' logged');
          } catch (e) { ui.toast(e.message); }
        };
        node.replaceChildren(head, sub,
          el('div', { class: 'wk-equip' }, el('span', {}, 'Using'), sel),
          rows,
          el('div', { class: 'wk-actions' },
            el('button', { type: 'button', class: 'btn small', onclick: () => { addRow(rows.children.length, null, null); } }, '+ Set'),
            last && last.sets.length ? el('button', { type: 'button', class: 'btn small', onclick: fillLast }, 'Same as last') : null,
            el('span', { class: 'spacer' }),
            el('button', { type: 'button', class: 'btn primary wk-log', onclick: log }, ex.today ? 'Update ✓' : 'Log ✓')));
      };
      draw();
      return { node, redrawIfDone: () => { if (!editing) draw(); } };
    }
    return { destroy() { host.innerHTML = ''; } };
  }

  // ---------- the list of workouts ----------
  // Old versions marked as merged, and sync's "(conflict copy, …)" duplicates, aren't workouts to log into.
  function isWorkout(p) { const t = p.title || ''; return p.ptype !== 'workout-merged' && /workout/i.test(t) && !/\((merged|conflict copy)\b/i.test(t) && /<table/i.test(p.html || '') && !!parse(p.html); }
  // Versions whose columns a note already carries ("V1 Start", "V1 Workout 3"…), i.e. merged in already.
  function carried(p) {
    const r = document.createElement('div'); r.innerHTML = p.html || '';
    const m = findMain(r); const s = new Set();
    if (m) for (const h of m.heads) { const x = String(h || '').trim().match(/^V(\d+)\b/i); if (x) s.add(+x[1]); }
    return s;
  }
  const baseTitle = (t) => String(t || '').replace(/\s*[-–]?\s*\bV\d+\b/i, '').replace(/\s+/g, ' ').trim();
  const versionOf = (t) => { const m = String(t || '').match(/\bV(\d+)\b/i); return m ? +m[1] : 0; };
  const letterOf = (t) => { const m = String(t || '').match(/workout\s*([a-z])\b/i); return m ? m[1].toUpperCase() : ''; };
  // "Workout A V2 (Push, Chest/Shoulders/Triceps)" → "Workout A · Push"
  function shortLabel(t) { const b = baseTitle(t); const m = b.match(/^(.*?)\s*\(([^,)/]+)/); return m ? m[1].trim() + ' · ' + m[2].trim() : b; }
  // Notes for the same workout letter (V1, V2 …), oldest version first.
  // A note that already carries another's version columns stands in for it (merged on another device), so that
  // one drops out and is listed as `merged`; the merged note counts as the newest whatever its title says.
  function groups(list) {
    const by = new Map();
    for (const p of list) { const k = letterOf(p.title) || p.id; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
    return [...by.entries()].map(([letter, arr]) => {
      const has = new Map(arr.map((p) => [p, carried(p)]));
      const merged = arr.filter((q) => arr.some((p) => p !== q && has.get(p).has(versionOf(q.title))));
      const notes = arr.filter((p) => !merged.includes(p));
      notes.sort((a, b) => (has.get(a).size ? 1 : 0) - (has.get(b).size ? 1 : 0) || versionOf(a.title) - versionOf(b.title) || (a.updated || 0) - (b.updated || 0));
      return { letter, notes, merged };
    });
  }

  // ---------- merging an older version's table into the newer note ----------
  // The older note's history columns go in front of the newer note's (so it reads oldest to newest), labelled with
  // its version ("V1 Start", "V1 Workout 3"); exercises are matched by name; ones only in the old note are added at the
  // bottom; instruction videos for exercises the newer note doesn't have are added to its videos table.
  function merge(oldHtml, newHtml, tag) {
    const ro = document.createElement('div'); ro.innerHTML = oldHtml || '';
    const rn = document.createElement('div'); rn.innerHTML = newHtml || '';
    const mo = findMain(ro), mn = findMain(rn);
    if (!mo || !mn) throw new Error('Couldn’t find the workout table in both notes');
    const tO = Math.max(1, mo.heads.findIndex((h) => /reps|sets/i.test(h)));
    const tN = Math.max(1, mn.heads.findIndex((h) => /reps|sets/i.test(h)));
    const oldCols = []; for (let c = tO + 1; c < mo.heads.length; c++) oldCols.push(c);
    const insertAt = (tr, col, cells) => {
      let acc = 0, before = null;
      for (const td of tr.cells) { if (acc >= col) { before = td; break; } acc += td.colSpan || 1; }
      while (!before && acc < col) { tr.appendChild(document.createElement('td')); acc++; }
      for (const c of cells) tr.insertBefore(c, before);
    };
    const oldRows = [];
    for (let r = mo.headRow + 1; r < mo.g.rows.length; r++) { const row = mo.g.cells[r] || []; if (!row[0] || !row[0].first) continue; const name = cellText(row[0].td); if (name) oldRows.push({ name, key: norm(name), row, used: false }); }
    const hs = (mn.g.cells[mn.headRow] || [])[tN];
    const headTag = hs && hs.td.tagName === 'TH' ? 'th' : 'td';
    const strong = !!(hs && hs.td.querySelector('strong, b'));
    const nCells = mn.heads.length;
    mn.g.rows.forEach((tr, r) => {
      const gridRow = mn.g.cells[r] || [];
      let cells;
      if (r === mn.headRow) cells = oldCols.map((c) => { const cell = document.createElement(headTag); const lab = (tag + ' ' + (mo.heads[c] || '')).trim(); cell.innerHTML = strong ? '<strong>' + esc(lab) + '</strong>' : esc(lab); return cell; });
      else {
        const nm = gridRow[0] && gridRow[0].first ? cellText(gridRow[0].td) : '';
        const hit = r > mn.headRow && nm ? oldRows.find((o) => !o.used && o.key === norm(nm)) : null;
        if (hit) hit.used = true;
        cells = oldCols.map((c) => { const cell = document.createElement('td'); const x = hit && hit.row[c]; if (x && x.first) cell.innerHTML = x.td.innerHTML; return cell; });
      }
      insertAt(tr, tN + 1, cells);
    });
    const cg = mn.table.querySelector('colgroup'); if (cg) for (let k = 0; k < oldCols.length; k++) cg.appendChild(document.createElement('col'));
    // Exercises only in the older note go at the bottom.
    const body = mn.table.tBodies[0] || mn.table;
    for (const o of oldRows.filter((x) => !x.used)) {
      const tr = document.createElement('tr');
      for (let c = 0; c <= tN; c++) { const td = document.createElement('td'); if (c === 0) td.innerHTML = o.row[0].td.innerHTML; else if (c === tN && o.row[tO] && o.row[tO].first) td.innerHTML = o.row[tO].td.innerHTML; tr.appendChild(td); }
      for (const c of oldCols) { const td = document.createElement('td'); const x = o.row[c]; if (x && x.first) td.innerHTML = x.td.innerHTML; tr.appendChild(td); }
      for (let c = tN + 1; c < nCells; c++) tr.appendChild(document.createElement('td'));
      body.appendChild(tr);
    }
    // Videos for exercises the newer note doesn't list.
    const vidTables = (root, main) => [...root.querySelectorAll('table')].filter((t) => t !== main.table);
    const groupsOf = (t) => { const g = grid(t); const out = []; let cur = null; g.rows.forEach((tr, r) => { const row = g.cells[r] || []; const nm = row[0] && row[0].first ? cellText(row[0].td) : ''; if (nm) { cur = { key: norm(nm), rows: [] }; out.push(cur); } if (cur) cur.rows.push(tr); }); return out; };
    const newV = vidTables(rn, mn), oldV = vidTables(ro, mo);
    const have = new Set(newV.flatMap((t) => groupsOf(t).map((x) => x.key)));
    for (const t of oldV) {
      const extra = groupsOf(t).filter((x) => x.key && !have.has(x.key));
      if (!extra.length) continue;
      if (newV.length) { const b = newV[0].tBodies[0] || newV[0]; for (const gp of extra) for (const tr of gp.rows) b.appendChild(tr.cloneNode(true)); }
      else { const h = document.createElement('h3'); h.textContent = 'Instruction Videos (' + tag + ')'; rn.append(h, t.cloneNode(true)); }
    }
    return rn.innerHTML;
  }
  function home(host, list, ui) {
    host.innerHTML = '';
    const ws = list.filter(isWorkout).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (!ws.length) { host.append(el('p', { class: 'sub' }, 'No workout notes found yet — a note with "Workout" in its title and a table with a Reps/Sets column shows up here.')); return; }
    host.append(el('div', { class: 'wk-home' }, ...ws.map((p) => {
      const info = parse(p.html);
      const lastN = Math.max(0, ...info.cols.map((c) => c.n || 0));
      return el('a', { class: 'wk-plan', href: '#workout/' + p.id },
        el('b', {}, p.title || 'Untitled'),
        el('span', {}, info.exercises.length + ' exercises · ' + (info.todayCol ? 'today: ' + info.exercises.filter((e) => e.today).length + ' logged' : (lastN ? 'last: Workout ' + lastN : 'not started'))),
        el('span', { class: 'wk-go', 'aria-hidden': 'true' }, '›'));
    })));
  }

  window.NCWorkout = { parse, readCell, writeCell, session, home, isWorkout, merge, groups, shortLabel, baseTitle, versionOf, letterOf };
})();

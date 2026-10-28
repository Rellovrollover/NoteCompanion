// To-do list page type: a focused view over an ordinary note. The page HTML is plain lists under headings
// (<h3>Now</h3><ul><li data-todo>…</li></ul>), so the same page still opens and edits as a normal note.
// Buckets: Now, Today, Next, Someday, Done. Items carry due/priority/added/done dates.
(function () {
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
  const BUCKETS = ['Now', 'Today', 'Next', 'Someday'];
  const HINT = { Now: 'What you are on right now. Everything else waits.', Today: 'Clear this before you stop.', Next: 'This week, roughly.', Someday: 'Parked. Pull one up when there is slack.' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  const today = () => iso(new Date());
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ---- page html <-> items ----
  function parse(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    const items = []; let bucket = 'Today';
    for (const node of d.children) {
      if (/^H[1-4]$/.test(node.tagName)) { const t = node.textContent.trim(); bucket = BUCKETS.includes(t) ? t : (t === 'Done' ? 'Done' : bucket); continue; }
      if (node.tagName !== 'UL' && node.tagName !== 'OL') continue;
      for (const li of node.querySelectorAll(':scope > li')) {
        const text = li.textContent.replace(/\s+/g, ' ').trim(); if (!text) continue;
        const done = li.getAttribute('data-todo') === 'done' || bucket === 'Done';
        items.push({ text, bucket: done ? 'Done' : bucket, done, due: li.getAttribute('data-due') || '', pri: li.getAttribute('data-pri') === '1', added: li.getAttribute('data-added') || today(), doneOn: li.getAttribute('data-done') || '' });
      }
    }
    return items;
  }
  function serialise(items) {
    let out = '';
    for (const b of BUCKETS.concat('Done')) {
      const list = items.filter((i) => i.bucket === b);
      if (!list.length && b !== 'Today' && b !== 'Now') continue;
      out += '<h3>' + b + '</h3><ul>' + list.map((i) => '<li data-todo="' + (i.done ? 'done' : '') + '"' + (i.due ? ' data-due="' + i.due + '"' : '') + (i.pri ? ' data-pri="1"' : '') + (i.added ? ' data-added="' + i.added + '"' : '') + (i.doneOn ? ' data-done="' + i.doneOn + '"' : '') + '>' + esc(i.text) + '</li>').join('') + '</ul>';
    }
    return out;
  }
  // "Call cardiology !! @tomorrow #ward" -> text, priority, due. Day names mean the next one of those.
  function parseQuick(raw) {
    let text = raw.trim(), pri = false, due = '';
    text = text.replace(/\s*!+\s*$/, () => { pri = true; return ''; }).replace(/(^|\s)!(?=\s|$)/g, (m, s) => { pri = true; return s; });
    text = text.replace(/\s*@(\S+)/g, (m, w) => {
      const l = w.toLowerCase(); const t = new Date();
      if (l === 'today' || l === 'tod') due = today();
      else if (l === 'tomorrow' || l === 'tmrw' || l === 'tom') { t.setDate(t.getDate() + 1); due = iso(t); }
      else if (DOW.includes(l.slice(0, 3)) && l.length <= 9) { const want = DOW.indexOf(l.slice(0, 3)); let n = (want - t.getDay() + 7) % 7; if (!n) n = 7; t.setDate(t.getDate() + n); due = iso(t); }
      else if (/^\d{1,2}\/\d{1,2}$/.test(l)) { const [dd, mm] = l.split('/').map(Number); const y = t.getFullYear() + (mm < t.getMonth() + 1 || (mm === t.getMonth() + 1 && dd < t.getDate()) ? 1 : 0); due = iso(new Date(y, mm - 1, dd)); }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(l)) due = l;
      else return m;
      return '';
    }).trim();
    return { text, pri, due };
  }

  function render(host, page, ui) {
    host.innerHTML = '';
    let items = parse(page.html);
    const save = () => ui.save(serialise(items));
    // House rules, applied on every open: anything due by today comes up into Today.
    const t0 = today(); let moved = 0;
    for (const i of items) if (!i.done && (i.bucket === 'Next' || i.bucket === 'Someday') && i.due && i.due <= t0) { i.bucket = 'Today'; moved++; }
    if (moved) save();
    if (window.NCGCal) { const cal = el('div', {}); host.append(cal); NCGCal.strip(cal).catch(() => {}); }
    const wrap = el('div', { class: 'todo' }); host.append(wrap);
    let bucketForNew = 'Today', showDone = false;

    const fmtDue = (due) => { if (!due) return ''; const n = daysBetween(t0, due); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? (-n) + 'd overdue' : n < 7 ? new Date(due + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short' }) : new Date(due + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
    const sortKey = (i) => (i.pri ? 0 : 1) + ':' + (i.due || '9999') + ':' + i.added;

    function itemMenu(i) {
      const idx = items.indexOf(i);
      ui.menu(i.text.length > 50 ? i.text.slice(0, 50) + '…' : i.text, [
        ...BUCKETS.filter((b) => b !== i.bucket).map((b) => ({ label: 'Move to ' + b, fn: () => { i.bucket = b; i.done = false; i.doneOn = ''; save(); draw(); } })),
        { label: i.pri ? 'Clear priority' : 'Make it a priority ⚡', fn: () => { i.pri = !i.pri; save(); draw(); } },
        window.NCGCal && NCGCal.state().signedIn ? { label: 'Put in Google Calendar' + (i.due ? ' (' + fmtDue(i.due) + ')' : ' (today)'), fn: async () => { try { await NCGCal.createEvent({ title: i.text, date: i.due || t0 }); ui.toast('Added to your calendar'); } catch (e) { ui.toast(e.message); } } } : null,
        { label: i.due ? 'Change due date (' + fmtDue(i.due) + ')' : 'Set due date', fn: async () => { const v = await ui.ask('Due', 'today, tomorrow, fri, 3/11 or 2026-11-03', i.due); if (v === undefined) return; const q = parseQuick('x @' + (v || 'none')); i.due = v ? (q.due || '') : ''; save(); draw(); } },
        { label: 'Edit text', fn: async () => { const v = await ui.ask('Edit', '', i.text, 'Save'); if (v) { i.text = v; save(); draw(); } } },
        { label: 'Delete', danger: true, fn: () => { items.splice(idx, 1); save(); draw(); } }
      ]);
    }
    function row(i) {
      const r = el('div', { class: 'todo-item' + (i.done ? ' done' : '') + (i.pri ? ' pri' : '') + (i.due && !i.done && i.due < t0 ? ' late' : '') });
      const box = el('button', { class: 'todo-box', type: 'button', 'aria-label': i.done ? 'Mark not done' : 'Mark done', onclick: () => {
        i.done = !i.done;
        if (i.done) { i.prevBucket = i.bucket; i.bucket = 'Done'; i.doneOn = t0; r.classList.add('popping'); setTimeout(() => { save(); draw(); }, 260); }
        else { i.bucket = i.prevBucket && BUCKETS.includes(i.prevBucket) ? i.prevBucket : 'Today'; i.doneOn = ''; save(); draw(); }
      } });
      const carried = !i.done && i.bucket === 'Today' && i.added && daysBetween(i.added, t0) >= 1 ? daysBetween(i.added, t0) : 0;
      const meta = el('span', { class: 'todo-meta' },
        i.due && !i.done ? el('span', { class: 'todo-due' }, fmtDue(i.due)) : null,
        carried ? el('span', { class: 'todo-carried', title: 'In Today for ' + carried + ' day' + (carried > 1 ? 's' : '') }, 'carried ' + carried + 'd') : null,
        i.done && i.doneOn ? el('span', {}, 'done ' + fmtDue(i.doneOn).replace('today', 'today')) : null);
      const text = el('button', { class: 'todo-text', type: 'button', onclick: () => itemMenu(i) }, i.pri ? el('span', { class: 'todo-bolt' }, '⚡') : null, i.text, meta);
      r.append(box, text);
      return r;
    }
    function draw() {
      wrap.innerHTML = '';
      const open = items.filter((i) => !i.done);
      const doneToday = items.filter((i) => i.done && i.doneOn === t0).length;
      const todayList = open.filter((i) => i.bucket === 'Now' || i.bucket === 'Today');
      const late = open.filter((i) => i.due && i.due < t0).length;
      // Scoreboard
      const total = todayList.length + doneToday;
      const pct = total ? Math.round(doneToday / total * 100) : 0;
      wrap.append(el('div', { class: 'todo-score' },
        el('div', { class: 'todo-score-main' }, el('b', {}, String(todayList.length)), el('span', {}, todayList.length === 1 ? 'to go today' : 'to go today'), el('i', {}), el('b', {}, String(doneToday)), el('span', {}, 'done'), late ? el('span', { class: 'todo-late' }, late + ' overdue') : null),
        el('div', { class: 'todo-bar' }, el('span', { style: 'width:' + pct + '%' })),
        el('div', { class: 'sub' }, total ? (pct === 100 ? 'Clean sheet. Pull something up from Next.' : pct + '% of today done') : 'Nothing lined up. Add the one thing that would make today a win.')));
      // Quick add
      const input = el('input', { class: 'todo-add', type: 'text', placeholder: 'Add a task…  ! = priority, @tomorrow / @fri / @3/11 = due', autocomplete: 'off', enterkeyhint: 'done' });
      const chips = el('div', { class: 'tagchips' }, ...BUCKETS.map((b) => el('button', { class: 'chip' + (bucketForNew === b ? ' on' : ''), type: 'button', onclick: () => { bucketForNew = b; [...chips.children].forEach((c, k) => c.classList.toggle('on', BUCKETS[k] === b)); input.focus(); } }, b)));
      const add = () => {
        const q = parseQuick(input.value); if (!q.text) return;
        items.unshift({ text: q.text, bucket: bucketForNew, done: false, due: q.due, pri: q.pri, added: t0, doneOn: '' });
        save(); draw(); const again = wrap.querySelector('.todo-add'); if (again) again.focus();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      wrap.append(el('div', { class: 'todo-addrow' }, input, el('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add')), chips);
      // Buckets
      for (const b of BUCKETS) {
        const list = open.filter((i) => i.bucket === b).sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
        if (!list.length && b !== 'Now' && b !== 'Today') continue;
        const sec = el('section', { class: 'todo-bucket todo-' + b.toLowerCase() });
        sec.append(el('h3', {}, b, el('span', { class: 'sec-count' }, String(list.length)), b === 'Now' && open.some((i) => i.bucket === 'Today') ? el('button', { class: 'btn small', type: 'button', onclick: () => { const cand = open.filter((i) => i.bucket === 'Today').sort((x, y) => sortKey(x).localeCompare(sortKey(y)))[0]; if (cand) { cand.bucket = 'Now'; save(); draw(); } } }, 'Pull the top one up') : null));
        if (!list.length) sec.append(el('p', { class: 'sub' }, HINT[b]));
        else { const ul = el('div', { class: 'todo-list' }); for (const i of list) ul.append(row(i)); sec.append(ul); }
        wrap.append(sec);
      }
      // Done
      const done = items.filter((i) => i.done).sort((x, y) => (y.doneOn || '').localeCompare(x.doneOn || ''));
      if (done.length) {
        const sec = el('section', { class: 'todo-bucket todo-donelist' });
        sec.append(el('h3', {}, el('button', { class: 'todo-toggle', type: 'button', onclick: () => { showDone = !showDone; draw(); } }, (showDone ? '▾ ' : '▸ ') + 'Done', el('span', { class: 'sec-count' }, String(done.length))),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn small', type: 'button', onclick: async () => { const old = done.filter((i) => i.doneOn && i.doneOn < t0); if (!old.length) { ui.toast('Nothing older than today to sweep'); return; } if (await ui.confirm('Sweep ' + old.length + ' done before today?', 'They come off this page for good.', 'Sweep')) { items = items.filter((i) => !old.includes(i)); save(); draw(); } } }, 'Sweep')));
        if (showDone) { const ul = el('div', { class: 'todo-list' }); for (const i of done) ul.append(row(i)); sec.append(ul); }
        wrap.append(sec);
      }
    }
    draw();
    return { destroy() { host.innerHTML = ''; } };
  }

  window.NCTodo = { render, parse, serialise, parseQuick };
})();

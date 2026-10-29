// To-do list page type: a focused view over an ordinary note. The page HTML is a plain list
// (<h3>To do</h3><ul><li data-todo data-pri="high">…</li></ul>, then <h3>Done</h3>), so the same page
// still opens and edits as a normal note. Each item has a priority — high, medium (the default) or low —
// that tints its row; optional due date ("@tomorrow", "@fri", "@3/11") and added/done dates.
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
  const PRI = ['high', 'med', 'low'];
  const PRI_NAME = { high: 'High', med: 'Medium', low: 'Low' };
  const priOf = (v) => (v === '1' || v === 'high' || v === 'h' ? 'high' : v === 'low' || v === 'l' ? 'low' : 'med');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
  const today = () => iso(new Date());
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ---- page html <-> items (older pages with Now/Today/Next/Someday headings read fine) ----
  function parse(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    const items = []; let doneHead = false;
    for (const node of d.children) {
      if (/^H[1-4]$/.test(node.tagName)) { doneHead = node.textContent.trim() === 'Done'; continue; }
      if (node.tagName !== 'UL' && node.tagName !== 'OL') continue;
      for (const li of node.querySelectorAll(':scope > li')) {
        const text = li.textContent.replace(/\s+/g, ' ').trim(); if (!text) continue;
        const done = li.getAttribute('data-todo') === 'done' || doneHead;
        items.push({ text, done, due: li.getAttribute('data-due') || '', pri: priOf(li.getAttribute('data-pri')), added: li.getAttribute('data-added') || today(), doneOn: li.getAttribute('data-done') || '' });
      }
    }
    return items;
  }
  const li = (i) => '<li data-todo="' + (i.done ? 'done' : '') + '" data-pri="' + i.pri + '"' + (i.due ? ' data-due="' + i.due + '"' : '') + (i.added ? ' data-added="' + i.added + '"' : '') + (i.doneOn ? ' data-done="' + i.doneOn + '"' : '') + '>' + esc(i.text) + '</li>';
  function serialise(items) {
    const open = items.filter((i) => !i.done), done = items.filter((i) => i.done);
    return '<h3>To do</h3><ul>' + open.map(li).join('') + '</ul>' + (done.length ? '<h3>Done</h3><ul>' + done.map(li).join('') + '</ul>' : '');
  }
  // "Call cardiology ! @tomorrow" -> text, high priority, due tomorrow. Day names mean the next one of those.
  function parseQuick(raw) {
    let text = raw.trim(), pri = '', due = '';
    text = text.replace(/\s*!+\s*$/, () => { pri = 'high'; return ''; }).replace(/(^|\s)!(?=\s|$)/g, (m, s) => { pri = 'high'; return s; });
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
    const t0 = today();
    if (window.NCGCal) { const cal = el('div', {}); host.append(cal); NCGCal.strip(cal).catch(() => {}); }
    const wrap = el('div', { class: 'todo' }); host.append(wrap);
    let priForNew = 'med', showDone = false;

    const fmtDue = (due) => { if (!due) return ''; const n = daysBetween(t0, due); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? (-n) + 'd overdue' : n < 7 ? new Date(due + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short' }) : new Date(due + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
    const sortKey = (i) => PRI.indexOf(i.pri) + ':' + (i.due || '9999') + ':' + i.added;

    function itemMenu(i) {
      const idx = items.indexOf(i);
      ui.menu(i.text.length > 50 ? i.text.slice(0, 50) + '…' : i.text, [
        ...PRI.map((p) => ({ label: (i.pri === p ? '✓ ' : '') + PRI_NAME[p] + ' priority', fn: () => { i.pri = p; save(); draw(); } })),
        window.NCGCal && NCGCal.state().signedIn ? { label: 'Put in Google Calendar' + (i.due ? ' (' + fmtDue(i.due) + ')' : ' (today)'), fn: async () => { try { await NCGCal.createEvent({ title: i.text, date: i.due || t0 }); ui.toast('Added to your calendar'); } catch (e) { ui.toast(e.message); } } } : null,
        { label: i.due ? 'Change due date (' + fmtDue(i.due) + ')' : 'Set due date', fn: async () => { const v = await ui.ask('Due', 'today, tomorrow, fri, 3/11 or 2026-11-03', i.due); if (v === undefined) return; const q = parseQuick('x @' + (v || 'none')); i.due = v ? (q.due || '') : ''; save(); draw(); } },
        { label: 'Edit text', fn: async () => { const v = await ui.ask('Edit', '', i.text, 'Save'); if (v) { i.text = v; save(); draw(); } } },
        { label: 'Delete', danger: true, fn: () => removeItem(i) }
      ]);
    }
    // Delete with an Undo, and tick / untick — shared by the menu and the swipes.
    function removeItem(i) {
      const idx = items.indexOf(i); if (idx < 0) return;
      items.splice(idx, 1); save(); draw();
      ui.toast('Deleted ' + (i.text.length > 30 ? i.text.slice(0, 30) + '…' : i.text), { label: 'Undo', fn: () => { items.splice(Math.min(idx, items.length), 0, i); save(); draw(); } });
    }
    function toggleItem(i) { i.done = !i.done; i.doneOn = i.done ? t0 : ''; save(); draw(); }
    // Swipe a row (touch): left = delete, right = done (or back to the list if it was done).
    function swipeable(r, i) {
      const wrap = el('div', { class: 'todo-swipe' }, el('div', { class: 'todo-under done-u' }, i.done ? '↩ Not done' : '✓ Done'), el('div', { class: 'todo-under del-u' }, 'Delete'));
      wrap.append(r);
      let sx = 0, sy = 0, dx = 0, dragging = null, armed = false, moved = false;
      r.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; dragging = null; armed = false; moved = false; }, { passive: true });
      r.addEventListener('touchmove', (e) => {
        const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
        if (dragging === null) { if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { dragging = Math.abs(dx) > Math.abs(dy) * 1.2; if (dragging) { moved = true; r.style.transition = 'none'; } } else return; }
        if (!dragging) return;
        e.preventDefault();
        r.style.transform = 'translateX(' + dx + 'px)';
        wrap.classList.toggle('to-right', dx > 0); wrap.classList.toggle('to-left', dx < 0);
        const now = Math.abs(dx) > r.offsetWidth * 0.3;
        if (now !== armed) { armed = now; wrap.classList.toggle('armed', armed); if (armed && navigator.vibrate) navigator.vibrate(8); }
      }, { passive: false });
      const end = () => {
        if (!dragging) { dragging = null; return; }
        r.style.transition = '';
        const w = r.offsetWidth;
        if (dx < -w * 0.3) { r.style.transform = 'translateX(' + -w + 'px)'; setTimeout(() => removeItem(i), 150); }
        else if (dx > w * 0.3) { r.style.transform = 'translateX(' + w + 'px)'; setTimeout(() => toggleItem(i), 150); }
        else { r.style.transform = ''; wrap.classList.remove('to-left', 'to-right', 'armed'); }
        dragging = null; setTimeout(() => { moved = false; }, 350);
      };
      r.addEventListener('touchend', end); r.addEventListener('touchcancel', end);
      r.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
      return wrap;
    }
    function row(i) {
      const r = el('div', { class: 'todo-item p-' + i.pri + (i.done ? ' done' : '') + (i.due && !i.done && i.due < t0 ? ' late' : '') });
      const box = el('button', { class: 'todo-box', type: 'button', 'aria-label': i.done ? 'Mark not done' : 'Mark done', onclick: () => {
        i.done = !i.done;
        if (i.done) { i.doneOn = t0; r.classList.add('popping'); setTimeout(() => { save(); draw(); }, 260); }
        else { i.doneOn = ''; save(); draw(); }
      } });
      const meta = el('span', { class: 'todo-meta' }, i.due && !i.done ? el('span', { class: 'todo-due' }, fmtDue(i.due)) : null);
      r.append(box, el('button', { class: 'todo-text', type: 'button', onclick: () => itemMenu(i) }, i.text, meta));
      return swipeable(r, i);
    }
    function draw() {
      wrap.innerHTML = '';
      const open = items.filter((i) => !i.done).sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
      const doneToday = items.filter((i) => i.done && i.doneOn === t0).length;
      // Progress through what's on the list today: a bar, nothing else.
      const total = open.length + doneToday;
      wrap.append(el('div', { class: 'todo-bar', title: doneToday + ' of ' + total + ' done today' }, el('span', { style: 'width:' + (total ? Math.round(doneToday / total * 100) : 0) + '%' })));
      // Quick add, with a priority (Medium unless you pick another).
      const input = el('input', { class: 'todo-add', type: 'text', placeholder: 'Add a task…', autocomplete: 'off', enterkeyhint: 'done' });
      const seg = el('div', { class: 'todo-priseg', role: 'group', 'aria-label': 'Priority' }, ...PRI.map((p) => el('button', { type: 'button', class: 'p-' + p + (priForNew === p ? ' on' : ''), 'aria-pressed': priForNew === p ? 'true' : 'false', onclick: () => { priForNew = p; [...seg.children].forEach((c, k) => { c.classList.toggle('on', PRI[k] === p); c.setAttribute('aria-pressed', PRI[k] === p ? 'true' : 'false'); }); input.focus(); } }, PRI_NAME[p])));
      const add = () => {
        const q = parseQuick(input.value); if (!q.text) return;
        items.unshift({ text: q.text, done: false, due: q.due, pri: q.pri || priForNew, added: t0, doneOn: '' });
        priForNew = 'med'; save(); draw(); const again = wrap.querySelector('.todo-add'); if (again) again.focus();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      wrap.append(el('div', { class: 'todo-addrow' }, input, el('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add')), seg);
      if (open.length) { const ul = el('div', { class: 'todo-list' }); for (const i of open) ul.append(row(i)); wrap.append(ul); }
      // Done, folded away.
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

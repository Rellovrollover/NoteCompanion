// Shopping list: a view over an ordinary page in a notebook. The page holds the list as headings and
// to-do items (so it also reads and edits fine as a note); this screen is just a friendlier way to use it.
(function () {
  const { pages, meta } = window.NCDB;
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
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CATS = ['Fresh Produce', 'Tins and Pantry stuff', 'Dairy', 'Meat', 'Bakery', 'Home Baking', 'Alcohol/Drinks', 'Freezer', 'Cleaning', 'Non-Lidl'];
  const STORES = ['Aldi', 'Tesco', 'Other'];
  const KEYS = {
    'Fresh Produce': ['orange', 'apple', 'banana', 'grape', 'berr', 'lemon', 'lime', 'pear', 'plum', 'peach', 'mango', 'melon', 'pineapple', 'avocado', 'tomato', 'cucumber', 'lettuce', 'salad', 'spinach', 'kale', 'greens', 'broccoli', 'cauliflower', 'carrot', 'onion', 'garlic', 'ginger', 'chilli', 'pepper', 'potato', 'mushroom', 'courgette', 'aubergine', 'leek', 'celery', 'coriander', 'parsley', 'basil', 'mint', 'herb', 'fruit', 'veg', 'cabbage', 'sprout', 'beetroot', 'spring onion', 'corn', 'asparagus', 'squash', 'kiwi', 'cherry'],
    'Tins and Pantry stuff': ['tin', 'canned', 'chopped tomato', 'passata', 'bean', 'chickpea', 'lentil', 'pasta', 'spaghetti', 'noodle', 'rice', 'couscous', 'oat', 'porridge', 'cereal', 'granola', 'peanut butter', 'jam', 'honey', 'marmite', 'spread', 'oil', 'olive', 'vinegar', 'soy', 'sauce', 'ketchup', 'mayo', 'mustard', 'stock', 'gravy', 'spice', 'paprika', 'cumin', 'curry', 'salt', 'tea', 'coffee', 'hot chocolate', 'crisps', 'nuts', 'biscuit', 'cracker', 'chocolate', 'sweets', 'soup', 'tuna', 'sweetcorn', 'coconut milk', 'puree', 'pesto', 'popcorn', 'protein bar'],
    'Dairy': ['milk', 'butter', 'cheese', 'cheddar', 'feta', 'mozzarella', 'parmesan', 'halloumi', 'yoghurt', 'yogurt', 'cream', 'egg', 'custard', 'skyr', 'quark'],
    'Meat': ['chicken', 'beef', 'pork', 'lamb', 'mince', 'steak', 'bacon', 'sausage', 'ham', 'turkey', 'salmon', 'cod', 'fish', 'prawn', 'chorizo', 'salami', 'meatball', 'burger', 'gammon', 'tofu', 'quorn'],
    'Bakery': ['bread', 'loaf', 'roll', 'bagel', 'croissant', 'wrap', 'pitta', 'tortilla', 'naan', 'bun', 'brioche', 'crumpet', 'muffin', 'cake', 'doughnut', 'baguette', 'sourdough', 'pastry', 'scone'],
    'Home Baking': ['flour', 'yeast', 'sugar', 'baking powder', 'bicarb', 'icing', 'vanilla', 'cocoa', 'cornflour', 'raisin', 'sultana', 'choc chip', 'sprinkles', 'golden syrup', 'treacle'],
    'Alcohol/Drinks': ['beer', 'lager', 'cider', 'wine', 'prosecco', 'gin', 'vodka', 'rum', 'whisky', 'water', 'sparkling', 'juice', 'squash', 'cordial', 'coke', 'cola', 'lemonade', 'tonic', 'energy drink', 'smoothie', 'oat milk', 'almond milk', 'soya'],
    'Freezer': ['frozen', 'ice cream', 'lolly', 'pizza', 'fish finger', 'chips', 'hash brown', 'waffle', 'garlic bread'],
    'Cleaning': ['washing up', 'bleach', 'sponge', 'cloth', 'kitchen roll', 'toilet roll', 'loo roll', 'bin bag', 'bin liner', 'detergent', 'washing powder', 'washing liquid', 'laundry', 'softener', 'soap', 'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'tissue', 'wipes', 'spray', 'cleaner', 'dishwasher', 'foil', 'cling film', 'baking paper', 'freezer bag', 'razor', 'shower gel', 'hand wash']
  };
  function guessCat(name) { const n = ' ' + name.toLowerCase() + ' '; let best = null, len = 0; for (const c of CATS) for (const k of KEYS[c] || []) if (n.includes(k) && k.length > len) { best = c; len = k.length; } return best || 'Tins and Pantry stuff'; }
  function parseLine(s) {
    let qty = 1, name = s.trim();
    let m = name.match(/^(\d+)\s*[x×]?\s+(.+)$/i); if (m) { qty = +m[1]; name = m[2]; }
    m = name.match(/^(.+?)\s*[x×]\s*(\d+)$/i); if (m) { qty = +m[2]; name = m[1]; }
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6 };
    m = name.match(/^(two|three|four|five|six)\s+(.+)$/i); if (m) { qty = words[m[1].toLowerCase()]; name = m[2]; }
    name = name.replace(/^(a|an|some)\s+/i, '').trim();
    return { name: name.charAt(0).toUpperCase() + name.slice(1), qty };
  }

  // ---- page <-> items ----
  // Page HTML: <h3>Aisle</h3><ul><li data-todo="">Name ×2 <em>note</em></li></ul> … <h2>Elsewhere</h2><h3>Aldi</h3><ul>…</ul>
  function parsePage(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    const items = []; let list = 'lidl', heading = '';
    for (const node of doc.body.firstChild.children) {
      const tag = node.tagName;
      if (tag === 'H2' && /elsewhere/i.test(node.textContent)) { list = 'elsewhere'; heading = 'Aldi'; continue; }
      if (tag === 'H2' && /lidl/i.test(node.textContent)) { list = 'lidl'; heading = ''; continue; }
      if (tag === 'H3' || tag === 'H4') { heading = node.textContent.trim(); continue; }
      if (tag === 'UL' || tag === 'OL') {
        for (const li of node.querySelectorAll(':scope > li')) {
          const em = li.querySelector('em'); const note = em ? em.textContent.trim() : ''; if (em) em.remove();
          let text = li.textContent.replace(/\s+/g, ' ').trim(); let qty = 1;
          const m = text.match(/^(.*?)\s*[×x]\s*(\d+)$/); if (m) { text = m[1].trim(); qty = +m[2]; }
          if (!text) continue;
          const done = li.getAttribute('data-todo') === 'done' || li.classList.contains('done');
          items.push(list === 'lidl' ? { name: text, qty, note, done, list, cat: CATS.includes(heading) ? heading : guessCat(text), store: 'Aldi' } : { name: text, qty, note, done, list, cat: guessCat(text), store: STORES.includes(heading) ? heading : 'Aldi' });
        }
      }
    }
    return items;
  }
  function serialise(items) {
    const li = (r) => '<li data-todo="' + (r.done ? 'done' : '') + '">' + esc(r.name) + ((r.qty || 1) > 1 ? ' ×' + r.qty : '') + (r.note ? ' <em>' + esc(r.note) + '</em>' : '') + '</li>';
    let h = '';
    const lidl = items.filter((i) => i.list !== 'elsewhere'), els = items.filter((i) => i.list === 'elsewhere');
    for (const c of CATS) { const rows = lidl.filter((i) => i.cat === c); if (rows.length) h += '<h3>' + esc(c) + '</h3><ul>' + rows.map(li).join('') + '</ul>'; }
    if (els.length) { h += '<h2>Elsewhere</h2>'; for (const s of STORES) { const rows = els.filter((i) => (i.store || 'Aldi') === s); if (rows.length) h += '<h3>' + esc(s) + '</h3><ul>' + rows.map(li).join('') + '</ul>'; } }
    return h || '<p></p>';
  }

  // ---- which page? kept in meta on each device and on the app tile (synced) ----
  async function findTile() { return (await pages.live()).find((q) => q.kind === 'app' && q.app === 'shop'); }
  async function listPage(ui) {
    const tile = await findTile();
    let id = tile && tile.pageRef;
    let p = id ? await pages.get(id) : null;
    if (p && !p.deleted) return p;
    // First run: pick where the list page lives (or create it), seeded from the HTML app's data if it is here.
    const t = await ui.pickSection('Where should the shopping list page live?'); if (!t) return null;
    let seed = [];
    try { const old = (await pages.live()).find((q) => q.kind === 'app' && /shopping list/i.test(q.title || '') && q.appData && q.appData['ll.items']); if (old) seed = Object.values(JSON.parse(old.appData['ll.items'])).map((d) => ({ name: d.name, qty: d.qty || 1, note: d.note || '', done: !!d.done, list: d.list === 'elsewhere' ? 'elsewhere' : 'lidl', cat: CATS.includes(d.cat) ? d.cat : guessCat(d.name || ''), store: STORES.includes(d.store) ? d.store : 'Aldi' })); } catch (e) { /* ignore */ }
    p = await pages.create({ notebookId: t.notebookId, sectionId: t.sectionId, title: 'Shopping list', html: serialise(seed), pinned: 1 });
    if (tile) await pages.update(tile.id, { pageRef: p.id });
    return p;
  }

  async function render(host, ui) {
    host.innerHTML = '';
    const p = await listPage(ui);
    if (!p) { host.append(el('p', { class: 'sub' }, 'No list page chosen.')); return; }
    let items = parsePage(p.html);
    let view = 'lidl'; try { view = localStorage.getItem('nc-shop-view') || 'lidl'; } catch (e) { /* ignore */ }
    let confirmMove = false, confirmClear = false;
    const wrap = el('div', { class: 'shop' }); host.append(wrap);
    const save = async () => { const html = serialise(items); await pages.update(p.id, { html }); p.html = html; ui.changed && ui.changed(); };
    const draw = () => {
      wrap.innerHTML = '';
      const lidl = items.filter((i) => i.list !== 'elsewhere'), els = items.filter((i) => i.list === 'elsewhere');
      const seg = el('div', { class: 'seg shop-tabs' },
        el('button', { type: 'button', class: view === 'lidl' ? 'on' : '', onclick: () => { view = 'lidl'; try { localStorage.setItem('nc-shop-view', view); } catch (e) { /* ignore */ } draw(); } }, 'Lidl ', el('span', { class: 'sec-count' }, String(lidl.filter((i) => !i.done).length))),
        el('button', { type: 'button', class: view === 'else' ? 'on' : '', onclick: () => { view = 'else'; try { localStorage.setItem('nc-shop-view', view); } catch (e) { /* ignore */ } draw(); } }, 'Elsewhere ', el('span', { class: 'sec-count' }, String(els.filter((i) => !i.done).length))));
      wrap.append(el('div', { class: 'shop-head' }, seg, el('span', { class: 'spacer' }), el('a', { class: 'btn small', href: '#page/' + p.id, title: 'Open the list as a note' }, 'Open as note')));
      // Entry
      const entry = el('input', { class: 'shift-quick', type: 'text', placeholder: 'Add items… e.g. oranges, 2 tins chopped tomatoes', autocomplete: 'off' });
      entry.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && entry.value.trim()) { e.preventDefault(); const parts = entry.value.split(/[\n,;]|\band\b/i).map((s) => s.trim()).filter(Boolean); for (const t of parts) { const q = parseLine(t); if (q.name) items.push({ name: q.name, qty: q.qty, note: '', done: false, list: view === 'else' ? 'elsewhere' : 'lidl', cat: guessCat(q.name), store: 'Aldi' }); } entry.value = ''; await save(); draw(); } });
      wrap.append(el('div', { class: 'shop-add' }, entry, el('p', { class: 'sub' }, 'Enter to add. Several at once with commas; items are sorted by keyword, tap one to change its aisle.')));
      const rowEl = (r, alt) => el('div', { class: 'shop-row' + (r.done ? ' done' : '') },
        el('button', { class: 'shop-tick', type: 'button', 'aria-label': r.done ? 'Untick' : 'Tick', onclick: async () => { r.done = !r.done; confirmMove = false; await save(); draw(); } }, el('span', {})),
        el('button', { class: 'shop-body', type: 'button', onclick: () => editSheet(r) }, el('span', { class: 'shop-name' }, r.name), r.note ? el('span', { class: 'shop-note' }, r.note) : null),
        el('div', { class: 'shop-side' }, alt ? el('button', { class: 'shop-store', type: 'button', onclick: async () => { r.store = STORES[(STORES.indexOf(r.store || 'Aldi') + 1) % STORES.length]; await save(); draw(); } }, r.store || 'Aldi') : null, el('span', { class: 'shop-qty' }, '×' + (r.qty || 1))));
      const group = (title, rows, alt) => { const sec = el('section', { class: 'shop-aisle' }, el('h3', {}, el('span', {}, title), el('span', { class: 'sub' }, rows.filter((x) => !x.done).length + ' of ' + rows.length))); const box = el('div', { class: 'shop-rows' }); for (const r of rows) box.append(rowEl(r, alt)); sec.append(box); return sec; };
      if (view === 'lidl') {
        if (!lidl.length) wrap.append(el('p', { class: 'sub shop-empty' }, 'Nothing on the list yet.'));
        for (const c of CATS) { const rows = lidl.filter((i) => i.cat === c); if (rows.length) wrap.append(group(c, rows, false)); }
        if (lidl.length) {
          const un = lidl.filter((i) => !i.done).length, ticked = lidl.filter((i) => i.done).length;
          wrap.append(el('div', { class: 'shop-actions' },
            el('button', { class: 'btn' + (confirmMove ? ' danger' : ''), type: 'button', disabled: un ? null : '', onclick: async () => { if (!confirmMove) { confirmMove = true; draw(); setTimeout(() => { if (confirmMove) { confirmMove = false; draw(); } }, 4000); return; } confirmMove = false; for (const i of lidl) if (!i.done) { i.list = 'elsewhere'; i.store = i.store || 'Aldi'; } await save(); view = 'else'; draw(); ui.toast('Moved to Elsewhere'); } }, confirmMove ? 'Tap again to confirm' : 'Not found at Lidl → send ' + un + ' unticked to Elsewhere'),
            el('button', { class: 'btn', type: 'button', disabled: ticked ? null : '', onclick: async () => { items = items.filter((i) => !(i.list !== 'elsewhere' && i.done)); await save(); draw(); ui.toast('Cleared ' + ticked); } }, 'Clear ' + ticked + ' ticked (got them)'),
            el('button', { class: 'btn' + (confirmClear ? ' danger' : ''), type: 'button', onclick: async () => { if (!confirmClear) { confirmClear = true; draw(); setTimeout(() => { if (confirmClear) { confirmClear = false; draw(); } }, 4000); return; } confirmClear = false; items = items.filter((i) => i.list === 'elsewhere'); await save(); draw(); ui.toast('List cleared'); } }, confirmClear ? 'Tap again to clear the Lidl list' : 'Clear whole list')));
        }
      } else {
        if (!els.length) wrap.append(el('p', { class: 'sub shop-empty' }, 'Nothing to chase elsewhere. Unticked Lidl items land here after a shop.'));
        for (const s of STORES) { const rows = els.filter((i) => (i.store || 'Aldi') === s); if (rows.length) wrap.append(group(s, rows, true)); }
        if (els.length) {
          const ticked = els.filter((i) => i.done).length;
          wrap.append(el('div', { class: 'shop-actions' },
            el('button', { class: 'btn', type: 'button', disabled: ticked ? null : '', onclick: async () => { items = items.filter((i) => !(i.list === 'elsewhere' && i.done)); await save(); draw(); ui.toast('Cleared ' + ticked); } }, 'Clear ' + ticked + ' ticked (got them)'),
            el('button', { class: 'btn' + (confirmClear ? ' danger' : ''), type: 'button', onclick: async () => { if (!confirmClear) { confirmClear = true; draw(); setTimeout(() => { if (confirmClear) { confirmClear = false; draw(); } }, 4000); return; } confirmClear = false; items = items.filter((i) => i.list !== 'elsewhere'); await save(); draw(); ui.toast('Cleared'); } }, confirmClear ? 'Tap again to clear Elsewhere' : 'Clear whole list')));
        }
      }
      wrap.append(el('p', { class: 'sub shop-foot' }, 'This is the page "' + (p.title || 'Shopping list') + '" in your notebook — edit it there too.'));
    };
    function editSheet(r) {
      ui.sheet((box, close) => {
        const name = el('input', { type: 'text', value: r.name }); const note = el('input', { type: 'text', value: r.note || '', placeholder: 'size, brand, what it is for…' });
        let qty = r.qty || 1; const qv = el('output', {}, String(qty));
        const cat = el('select', {}, ...CATS.map((c) => el('option', { selected: c === r.cat ? '' : null }, c)));
        const storeSeg = el('div', { class: 'shift-chips' }, ...STORES.map((s) => el('button', { class: 'chip' + ((r.store || 'Aldi') === s ? ' on' : ''), type: 'button', onclick: (e) => { r.store = s; for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target); } }, s)));
        const apply = () => { r.name = name.value.trim() || r.name; r.note = note.value.trim(); r.qty = qty; r.cat = cat.value; };
        box.append(el('h2', {}, 'Edit item'),
          el('label', { class: 'shift-field' }, el('span', {}, 'Item'), name),
          el('div', { class: 'shift-two' }, el('label', { class: 'shift-field' }, el('span', {}, 'Quantity'), el('div', { class: 'shop-step' }, el('button', { type: 'button', onclick: () => { qty = Math.max(1, qty - 1); qv.textContent = qty; } }, '−'), qv, el('button', { type: 'button', onclick: () => { qty = Math.min(99, qty + 1); qv.textContent = qty; } }, '+'))), el('label', { class: 'shift-field' }, el('span', {}, 'Aisle'), cat)),
          el('label', { class: 'shift-field' }, el('span', {}, 'Note'), note),
          r.list === 'elsewhere' ? el('div', { class: 'shift-field' }, el('span', {}, 'Try at'), storeSeg) : null,
          el('div', { class: 'actions' },
            el('button', { class: 'btn danger', type: 'button', onclick: async () => { items.splice(items.indexOf(r), 1); close(); await save(); draw(); } }, 'Delete'),
            r.list === 'elsewhere' ? el('button', { class: 'btn', type: 'button', onclick: async () => { apply(); r.list = 'lidl'; r.done = false; close(); await save(); draw(); } }, 'Back to Lidl') : el('button', { class: 'btn', type: 'button', onclick: async () => { apply(); r.list = 'elsewhere'; r.done = false; close(); await save(); draw(); } }, 'Send to Elsewhere'),
            el('button', { class: 'btn primary', type: 'button', onclick: async () => { apply(); close(); await save(); draw(); } }, 'Done')));
      }, { centre: true });
    }
    draw();
  }

  window.NCShop = { render, parsePage, serialise };
})();

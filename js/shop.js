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

  // ---- page <-> lists ----
  // The page keeps every list, newest first, so it reads as a dated record:
  //   <h2>Shopping list · 29 Oct 2026</h2> <h3>Aisle</h3><ul><li data-todo="">Name ×2 <em>note</em></li></ul> …   ← the current list
  //   <h2>Elsewhere</h2> <h3>Aldi</h3><ul>…</ul>                                                               ← not found at Lidl
  //   <hr><h2>Past lists</h2> <h2>List · 22 Oct 2026</h2> …                                                   ← earlier lists, as they were
  // Older pages with no dated heading are read as the current list.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtDate = (iso) => { const p = String(iso || '').split('-').map(Number); return p.length === 3 && p[0] ? p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0] : ''; };
  const dateIn = (t) => { const m = String(t).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/); if (!m) return ''; const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); return mi < 0 ? '' : m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0'); };
  function parseItems(li, mode, heading) {
    const em = li.querySelector('em'); const note = em ? em.textContent.trim() : ''; if (em) em.remove();
    let text = li.textContent.replace(/\s+/g, ' ').trim(); let qty = 1;
    const m = text.match(/^(.*?)\s*[×x]\s*(\d+)$/); if (m) { text = m[1].trim(); qty = +m[2]; }
    if (!text) return null;
    const done = li.getAttribute('data-todo') === 'done' || li.classList.contains('done');
    return mode === 'elsewhere' ? { name: text, qty, note, done, list: 'elsewhere', cat: guessCat(text), store: STORES.includes(heading) ? heading : 'Aldi' }
      : { name: text, qty, note, done, list: 'lidl', cat: CATS.includes(heading) ? heading : guessCat(text), store: 'Aldi' };
  }
  function parseBook(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    const book = { current: { date: '', items: [] }, elsewhere: [], past: [] };
    let mode = 'lidl', target = book.current, heading = '', seenList = false;
    for (const node of doc.body.firstChild.children) {
      const tag = node.tagName;
      if (tag === 'H1' || tag === 'H2') {
        const t = node.textContent.trim();
        if (/elsewhere/i.test(t)) { mode = 'elsewhere'; heading = 'Aldi'; continue; }
        if (/^past lists?$/i.test(t)) { continue; }
        mode = 'lidl'; heading = '';
        if (!seenList) { seenList = true; book.current.date = dateIn(t); target = book.current; if (book.current.items.length) { /* items before any heading stay current */ } continue; }
        target = { date: dateIn(t), items: [] }; book.past.push(target); continue;
      }
      if (tag === 'H3' || tag === 'H4') { heading = node.textContent.trim(); continue; }
      if (tag === 'UL' || tag === 'OL') {
        for (const li of node.querySelectorAll(':scope > li')) { const r = parseItems(li, mode, heading); if (!r) continue; if (mode === 'elsewhere') book.elsewhere.push(r); else target.items.push(r); }
      }
    }
    return book;
  }
  const liOf = (r) => '<li data-todo="' + (r.done ? 'done' : '') + '">' + esc(r.name) + ((r.qty || 1) > 1 ? ' ×' + r.qty : '') + (r.note ? ' <em>' + esc(r.note) + '</em>' : '') + '</li>';
  const aisles = (rows) => { let h = ''; for (const c of CATS) { const r = rows.filter((i) => i.cat === c); if (r.length) h += '<h3>' + esc(c) + '</h3><ul>' + r.map(liOf).join('') + '</ul>'; } const other = rows.filter((i) => !CATS.includes(i.cat)); if (other.length) h += '<h3>Other</h3><ul>' + other.map(liOf).join('') + '</ul>'; return h; };
  function serialiseBook(book) {
    let h = '<h2>Shopping list · ' + (book.current.date ? 'started ' + fmtDate(book.current.date) : 'current') + '</h2>' + (aisles(book.current.items) || '<p>Nothing on it yet.</p>');
    if (book.elsewhere.length) { h += '<h2>Elsewhere</h2>'; for (const s of STORES) { const rows = book.elsewhere.filter((i) => (i.store || 'Aldi') === s); if (rows.length) h += '<h3>' + esc(s) + '</h3><ul>' + rows.map(liOf).join('') + '</ul>'; } }
    if (book.past.length) { h += '<hr><h2>Past lists</h2>'; for (const l of book.past) h += '<h2>List · ' + (fmtDate(l.date) || 'undated') + '</h2>' + (aisles(l.items) || '<p>(empty)</p>'); }
    return h;
  }
  // Kept for anything that still wants the flat view (Lidl list + Elsewhere).
  const parsePage = (html) => { const b = parseBook(html); return b.current.items.concat(b.elsewhere); };
  const serialise = (items) => serialiseBook({ current: { date: todayISO(), items: items.filter((i) => i.list !== 'elsewhere') }, elsewhere: items.filter((i) => i.list === 'elsewhere'), past: [] });

  // ---- which page? kept on the app tile (synced) ----
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

  // Same item however it was typed: case, "of/a/the", plurals.
  const keyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !/^(of|a|an|the|some)$/.test(w)).map((w) => (w.length > 3 ? w.replace(/(es|s)$/, '') : w)).join(' ');
  // ---- speech: "milk eggs and two tins of chopped tomatoes" → separate items ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  // Phrases that are one item even though each word could be one ("orange juice", not orange + juice).
  const COMPOUND = new Set(['orange juice', 'apple juice', 'tomato sauce', 'soy sauce', 'olive oil', 'peanut butter', 'garlic bread', 'ice cream', 'oat milk', 'almond milk', 'coconut milk', 'cream cheese', 'sour cream', 'double cream', 'single cream', 'greek yoghurt', 'greek yogurt', 'fish fingers', 'hash browns', 'baked beans', 'sweet potato', 'sweet potatoes', 'spring onions', 'chicken breast', 'chicken breasts', 'chicken thighs', 'beef mince', 'pork mince', 'chopped tomatoes', 'cherry tomatoes', 'egg noodles', 'rice noodles', 'tomato puree', 'garlic bulb', 'lemon juice', 'lime juice', 'fruit juice', 'apple sauce', 'mint sauce', 'curry paste', 'chocolate milk', 'butter beans', 'kidney beans', 'black beans', 'cheese slices', 'salad bag', 'potato waffles']);
  const MULTI = new Set(Object.values(KEYS).flat().filter((k) => k.includes(' ')));
  function splitSpoken(text, known) {
    const parts = text.split(/[\n,;]+|\s+(?:and|then|also|plus)\s+/i).map((x) => x.trim()).filter(Boolean);
    const out = [];
    const isKnownWord = (w) => { w = w.toLowerCase().replace(/s$/, ''); if (w.length < 3) return false; if (known.has(w) || known.has(w + 's')) return true; for (const c of CATS) for (const k of KEYS[c] || []) if (!k.includes(' ') && (w === k || w === k.replace(/s$/, '') || (k.length > 3 && w.startsWith(k)))) return true; return false; };
    const isPhrase = (ph) => known.has(ph) || COMPOUND.has(ph) || MULTI.has(ph);
    for (const p of parts) {
      const words = p.split(/\s+/);
      // Keep as said: one word, a quantity first ("two tins of…"), or something already on a list.
      if (words.length < 2 || isPhrase(p.toLowerCase()) || /^(\d+|a|an|some|two|three|four|five|six)$/i.test(words[0])) { out.push(p); continue; }
      // Otherwise walk the words: the longest known phrase wins, a known word stands alone, other words
      // ("chopped", "fresh") stick to the item after them.
      const got = []; let pending = [];
      for (let i = 0; i < words.length;) {
        let take = 0;
        for (let n = Math.min(4, words.length - i); n >= 2 && !take; n--) if (isPhrase(words.slice(i, i + n).join(' ').toLowerCase())) take = n;
        if (!take && isKnownWord(words[i])) take = 1;
        if (!take) { pending.push(words[i]); i++; continue; }
        got.push([...pending, ...words.slice(i, i + take)].join(' ')); pending = []; i += take;
      }
      if (pending.length) { if (got.length) got[got.length - 1] += ' ' + pending.join(' '); else got.push(pending.join(' ')); }
      out.push(...got);
    }
    return out;
  }

  async function render(host, ui) {
    host.innerHTML = '';
    const p = await listPage(ui);
    if (!p) { host.append(el('p', { class: 'sub' }, 'No list page chosen.')); return; }
    let book = parseBook(p.html);
    if (!book.current.date) book.current.date = todayISO();
    let view = 'lidl'; try { view = localStorage.getItem('nc-shop-view') || 'lidl'; } catch (e) { /* ignore */ }
    let confirmMove = false, confirmClear = false;
    const wrap = el('div', { class: 'shop' }); host.append(wrap);
    const save = async () => { const html = serialiseBook(book); await pages.update(p.id, { html }); p.html = html; ui.changed && ui.changed(); };
    const cur = () => book.current.items;
    const onList = (name) => cur().some((i) => !i.done && keyOf(i.name) === keyOf(name));
    // Regulars: what you put on lists most often (counted once per list), newest first among ties.
    const regulars = () => {
      const seen = new Map();
      const lists = [book.current, ...book.past];
      lists.forEach((l, age) => { const names = new Set(); for (const i of l.items) { const k = keyOf(i.name); if (names.has(k)) continue; names.add(k); const r = seen.get(k) || { name: i.name, cat: i.cat, n: 0, age }; r.n++; if (age < r.age) { r.age = age; r.cat = i.cat; r.name = i.name; } seen.set(k, r); } });
      for (const i of book.elsewhere) { const k = keyOf(i.name); if (!seen.has(k)) seen.set(k, { name: i.name, cat: i.cat, n: 1, age: 0 }); }
      return [...seen.values()].filter((r) => !onList(r.name)).sort((a, b) => b.n - a.n || a.age - b.age || a.name.localeCompare(b.name));
    };
    const known = () => new Set([...book.current.items, ...book.elsewhere, ...book.past.flatMap((l) => l.items)].map((i) => i.name.toLowerCase()));
    const catFor = (name) => { const k = keyOf(name); for (const l of [book.current, ...book.past]) { const hit = l.items.find((i) => keyOf(i.name) === k); if (hit) return hit.cat; } return guessCat(name); };
    async function addText(text, spoken) {
      const parts = spoken ? splitSpoken(text, known()) : text.split(/[\n,;]|\band\b/i).map((x) => x.trim()).filter(Boolean);
      const added = [], already = [];
      for (const t of parts) {
        const q = parseLine(t); if (!q.name) continue;
        if (view === 'else') { book.elsewhere.push({ name: q.name, qty: q.qty, note: '', done: false, list: 'elsewhere', cat: guessCat(q.name), store: 'Aldi' }); added.push(book.elsewhere[book.elsewhere.length - 1]); continue; }
        const dup = cur().find((i) => keyOf(i.name) === keyOf(q.name));
        if (dup && !dup.done) { already.push(dup.name); continue; }
        if (dup && dup.done) { dup.done = false; dup.qty = q.qty; added.push(dup); continue; }
        const r = { name: q.name, qty: q.qty, note: '', done: false, list: 'lidl', cat: catFor(q.name), store: 'Aldi' };
        cur().push(r); added.push(r);
      }
      if (!added.length && !already.length) return;
      await save(); draw();
      const msg = (added.length ? 'Added ' + added.map((r) => r.name).join(', ') : '') + (already.length ? (added.length ? ' · ' : '') + already.join(', ') + ' already on' : '');
      ui.toast(msg, added.length ? { label: 'Undo', fn: async () => { for (const r of added) { const a = view === 'else' ? book.elsewhere : cur(); const i = a.indexOf(r); if (i >= 0) a.splice(i, 1); } await save(); draw(); } } : undefined);
    }
    let rec = null;
    const draw = () => {
      wrap.innerHTML = '';
      const lidl = cur(), els = book.elsewhere;
      const seg = el('div', { class: 'seg shop-tabs' },
        el('button', { type: 'button', class: view === 'lidl' ? 'on' : '', onclick: () => { view = 'lidl'; try { localStorage.setItem('nc-shop-view', view); } catch (e) { /* ignore */ } draw(); } }, 'Lidl ', el('span', { class: 'sec-count' }, String(lidl.filter((i) => !i.done).length))),
        el('button', { type: 'button', class: view === 'else' ? 'on' : '', onclick: () => { view = 'else'; try { localStorage.setItem('nc-shop-view', view); } catch (e) { /* ignore */ } draw(); } }, 'Elsewhere ', el('span', { class: 'sec-count' }, String(els.filter((i) => !i.done).length))));
      wrap.append(el('div', { class: 'shop-head' }, seg, el('span', { class: 'spacer' }), el('a', { class: 'btn small', href: '#page/' + p.id, title: 'Open the list as a note' }, 'Open as note')));
      // Entry: type (Enter adds; commas for several) or speak.
      const entry = el('input', { class: 'shift-quick', type: 'text', placeholder: view === 'else' ? 'Add something to get elsewhere…' : 'Add items… e.g. milk, 2 tins chopped tomatoes', autocomplete: 'off', enterkeyhint: 'done' });
      entry.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && entry.value.trim()) { e.preventDefault(); const v = entry.value; entry.value = ''; await addText(v, false); const again = wrap.querySelector('.shop-add input'); if (again) again.focus(); } });
      const mic = SR ? el('button', { class: 'shop-mic' + (rec ? ' on' : ''), type: 'button', 'aria-label': 'Speak items', title: 'Speak items — e.g. “milk, eggs and bread”', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>' }) : null;
      // Listening waits for a proper pause before it stops: 2.5 s after you last spoke (7 s to get started),
      // and if the phone's recogniser gives up sooner on its own, it quietly carries on listening. Tap the
      // mic again to finish straight away. Never more than 45 s.
      if (mic) mic.addEventListener('click', () => {
        if (rec) { rec.finish(); return; }
        const PAUSE = 2500, START = 7000, MAX = 45000;
        let said = '', session = '', timer = null, done = false, restarts = 0;
        const began = Date.now();
        const text = () => (said + ' ' + session).replace(/\s+/g, ' ').trim();
        const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => rec && rec.finish(), ms); };
        const close = async () => {
          if (done) return; done = true; clearTimeout(timer);
          rec = null; mic.classList.remove('on'); entry.placeholder = 'Add items… e.g. milk, 2 tins chopped tomatoes';
          const t = text(); entry.value = ''; if (t) await addText(t, true);
        };
        const listen = () => {
          const r = new SR(); r.lang = 'en-GB'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
          session = '';
          // Rebuilt from the whole result list each time, so a phone that repeats results can't double them up.
          r.onresult = (e) => { session = Array.from(e.results).map((x) => x[0].transcript).join(' '); entry.value = text(); arm(PAUSE); };
          r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { done = true; clearTimeout(timer); rec = null; mic.classList.remove('on'); ui.toast('Microphone not allowed — the keyboard mic works too'); } else if (e.error !== 'no-speech' && e.error !== 'aborted') ui.toast('Didn\u2019t catch that'); };
          r.onend = () => {
            said = text(); session = '';
            if (done) return;
            // Stopped by itself before our pause ran out: keep listening (a few times at most).
            if (rec && !rec.stopping && Date.now() - began < MAX && restarts < 6) { restarts++; try { rec.r = listen(); return; } catch (x) { /* fall through */ } }
            close();
          };
          r.start();
          return r;
        };
        try {
          rec = { stopping: false, r: null, finish() { this.stopping = true; clearTimeout(timer); try { this.r.stop(); } catch (x) { close(); } setTimeout(() => close(), 1500); } };
          rec.r = listen(); mic.classList.add('on'); entry.placeholder = 'Listening… say the items, then pause';
          arm(START); setTimeout(() => rec && rec.finish(), MAX);
        } catch (err) { rec = null; ui.toast('Speech isn\u2019t available here — use the keyboard mic'); }
      });
      wrap.append(el('div', { class: 'shop-add' }, el('div', { class: 'shop-entry' }, entry, mic),
        el('p', { class: 'sub' }, (SR ? 'Enter to add, commas for several, or tap the mic and say them (it stops after a pause). ' : 'Enter to add, commas for several; the keyboard mic works for speaking them. ') + 'Swipe an item right when you\u2019ve got it, left to delete.')));
      // Regulars: one tap to add.
      if (view === 'lidl') {
        const regs = regulars();
        if (regs.length) {
          const showAll = wrap.dataset.allRegs === '1';
          const shown = showAll ? regs.slice(0, 40) : regs.slice(0, 12);
          wrap.append(el('div', { class: 'shop-regs' }, el('span', { class: 'shop-regs-label' }, 'Regulars'),
            ...shown.map((r) => el('button', { class: 'chip shop-reg', type: 'button', title: 'On ' + r.n + ' list' + (r.n === 1 ? '' : 's'), onclick: async () => { const item = { name: r.name, qty: 1, note: '', done: false, list: 'lidl', cat: r.cat || guessCat(r.name), store: 'Aldi' }; const dup = cur().find((i) => keyOf(i.name) === keyOf(r.name)); if (dup) dup.done = false; else cur().push(item); await save(); draw(); ui.toast('Added ' + r.name, { label: 'Undo', fn: async () => { if (dup) dup.done = true; else { const i = cur().indexOf(item); if (i >= 0) cur().splice(i, 1); } await save(); draw(); } }); } }, '+ ' + r.name)),
            regs.length > 12 ? el('button', { class: 'chip shop-reg more', type: 'button', onclick: () => { wrap.dataset.allRegs = showAll ? '' : '1'; draw(); } }, showAll ? 'Fewer' : 'More (' + (Math.min(regs.length, 40) - 12) + ')') : null));
        }
      }
      // Swipe a row: right = got it (or put back), left = delete (with Undo).
      const listOf = (r) => (book.elsewhere.includes(r) ? book.elsewhere : cur());
      const removeItem = async (r) => { const a = listOf(r), i = a.indexOf(r); if (i < 0) return; a.splice(i, 1); await save(); draw(); ui.toast('Deleted ' + r.name, { label: 'Undo', fn: async () => { a.splice(Math.min(i, a.length), 0, r); await save(); draw(); } }); };
      const toggleItem = async (r) => { r.done = !r.done; confirmMove = false; await save(); draw(); };
      const swipeRow = (row, r) => {
        const wrap = el('div', { class: 'shop-swipe' }, el('div', { class: 'shop-under got' }, r.done ? '↩ Put back' : '✓ Got it'), el('div', { class: 'shop-under del' }, 'Delete'));
        wrap.append(row);
        let sx = 0, sy = 0, dx = 0, dragging = null, armed = false, moved = false;
        row.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; dragging = null; armed = false; moved = false; }, { passive: true });
        row.addEventListener('touchmove', (e) => {
          const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
          if (dragging === null) { if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { dragging = Math.abs(dx) > Math.abs(dy) * 1.2; if (dragging) { moved = true; row.style.transition = 'none'; } } else return; }
          if (!dragging) return;
          e.preventDefault();
          row.style.transform = 'translateX(' + dx + 'px)';
          wrap.classList.toggle('to-right', dx > 0); wrap.classList.toggle('to-left', dx < 0);
          const now = Math.abs(dx) > row.offsetWidth * 0.3;
          if (now !== armed) { armed = now; wrap.classList.toggle('armed', armed); if (armed && navigator.vibrate) navigator.vibrate(8); }
        }, { passive: false });
        const end = () => {
          if (!dragging) { dragging = null; return; }
          row.style.transition = '';
          const w = row.offsetWidth;
          if (dx < -w * 0.3) { row.style.transform = 'translateX(' + -w + 'px)'; setTimeout(() => removeItem(r), 150); }
          else if (dx > w * 0.3) { row.style.transform = ''; toggleItem(r); }
          else { row.style.transform = ''; wrap.classList.remove('to-left', 'to-right', 'armed'); }
          dragging = null; setTimeout(() => { moved = false; }, 350);
        };
        row.addEventListener('touchend', end); row.addEventListener('touchcancel', end);
        row.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
        return wrap;
      };
      const rowEl = (r, alt) => swipeRow(el('div', { class: 'shop-row' + (r.done ? ' done' : '') },
        el('button', { class: 'shop-tick', type: 'button', 'aria-label': r.done ? 'Untick' : 'Tick', onclick: async () => { r.done = !r.done; confirmMove = false; await save(); draw(); } }, el('span', {})),
        el('button', { class: 'shop-body', type: 'button', onclick: () => editSheet(r) }, el('span', { class: 'shop-name' }, r.name), r.note ? el('span', { class: 'shop-note' }, r.note) : null),
        el('div', { class: 'shop-side' }, alt ? el('button', { class: 'shop-store', type: 'button', onclick: async () => { r.store = STORES[(STORES.indexOf(r.store || 'Aldi') + 1) % STORES.length]; await save(); draw(); } }, r.store || 'Aldi') : null, el('span', { class: 'shop-qty' }, '×' + (r.qty || 1)))), r);
      const group = (title, rows, alt) => { const sec = el('section', { class: 'shop-aisle' }, el('h3', {}, el('span', {}, title), el('span', { class: 'sub' }, rows.filter((x) => !x.done).length + ' of ' + rows.length))); const box = el('div', { class: 'shop-rows' }); for (const r of rows.slice().sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0))) box.append(rowEl(r, alt)); sec.append(box); return sec; };
      if (view === 'lidl') {
        wrap.append(el('div', { class: 'shop-listhead' }, el('b', {}, 'This list'), el('span', { class: 'sub' }, 'started ' + fmtDate(book.current.date))));
        const last = book.past[0];
        const carry = last ? last.items.filter((i) => !i.done && !cur().some((c) => keyOf(c.name) === keyOf(i.name))) : [];
        if (carry.length && lidl.filter((i) => !i.done).length < 40) wrap.append(el('button', { class: 'btn shop-carry', type: 'button', onclick: async () => { for (const i of carry) cur().push(Object.assign({}, i, { done: false })); await save(); draw(); ui.toast('Brought over ' + carry.length + ' from ' + fmtDate(last.date)); } }, 'Bring over ' + carry.length + ' unticked from the ' + fmtDate(last.date) + ' list'));
        if (!lidl.length) wrap.append(el('p', { class: 'sub shop-empty' }, 'Nothing on the list yet.'));
        for (const c of CATS) { const rows = lidl.filter((i) => i.cat === c); if (rows.length) wrap.append(group(c, rows, false)); }
        const other = lidl.filter((i) => !CATS.includes(i.cat)); if (other.length) wrap.append(group('Other', other, false));
        const un = lidl.filter((i) => !i.done).length;
        wrap.append(el('div', { class: 'shop-actions' },
          lidl.length ? el('button', { class: 'btn' + (confirmMove ? ' danger' : ''), type: 'button', disabled: un ? null : '', onclick: async () => { if (!confirmMove) { confirmMove = true; draw(); setTimeout(() => { if (confirmMove) { confirmMove = false; draw(); } }, 4000); return; } confirmMove = false; for (const i of lidl) if (!i.done) book.elsewhere.push(Object.assign({}, i, { list: 'elsewhere', store: 'Aldi' })); book.current.items = lidl.filter((i) => i.done); await save(); view = 'else'; draw(); ui.toast('Moved ' + un + ' to Elsewhere'); } }, confirmMove ? 'Tap again to confirm' : 'Not found at Lidl → send ' + un + ' unticked to Elsewhere') : null,
          el('button', { class: 'btn primary', type: 'button', onclick: () => newList() }, 'Start a new list…')));
        // Past lists, newest first.
        if (book.past.length) {
          const past = el('section', { class: 'shop-past' }, el('h3', { class: 'shop-past-h' }, 'Past lists'));
          book.past.forEach((l) => {
            const un2 = l.items.filter((i) => !i.done);
            const d = el('details', { class: 'shop-pastlist' }, el('summary', {}, el('b', {}, fmtDate(l.date) || 'Undated'), el('span', { class: 'sub' }, l.items.length + ' item' + (l.items.length === 1 ? '' : 's') + (un2.length ? ' · ' + un2.length + ' unticked' : ''))));
            const box = el('div', { class: 'shop-pastbody' });
            for (const c of [...CATS, 'Other']) {
              const rows = l.items.filter((i) => (CATS.includes(i.cat) ? i.cat : 'Other') === c); if (!rows.length) continue;
              box.append(el('div', { class: 'shop-pastaisle' }, c), ...rows.map((i) => el('div', { class: 'shop-pastrow' + (i.done ? ' done' : '') }, el('span', {}, i.name + ((i.qty || 1) > 1 ? ' ×' + i.qty : '')), cur().some((x) => !x.done && keyOf(x.name) === keyOf(i.name)) ? el('span', { class: 'sub' }, 'on list') : el('button', { class: 'btn small', type: 'button', onclick: async () => { cur().push(Object.assign({}, i, { done: false })); await save(); draw(); ui.toast('Added ' + i.name); } }, '+ Add'))));
            }
            box.append(el('div', { class: 'toolrow' },
              un2.length ? el('button', { class: 'btn small', type: 'button', onclick: async () => { let n = 0; for (const i of un2) if (!cur().some((x) => keyOf(x.name) === keyOf(i.name))) { cur().push(Object.assign({}, i, { done: false })); n++; } await save(); draw(); ui.toast('Brought over ' + n); } }, 'Bring over ' + un2.length + ' unticked') : null,
              el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!(await ui.confirm('Delete the ' + (fmtDate(l.date) || 'undated') + ' list?', 'It is removed from the note too.'))) return; book.past.splice(book.past.indexOf(l), 1); await save(); draw(); } }, 'Delete this list')));
            d.append(box); past.append(d);
          });
          wrap.append(past);
        }
      } else {
        if (!els.length) wrap.append(el('p', { class: 'sub shop-empty' }, 'Nothing to chase elsewhere. Unticked Lidl items land here after a shop.'));
        for (const st of STORES) { const rows = els.filter((i) => (i.store || 'Aldi') === st); if (rows.length) wrap.append(group(st, rows, true)); }
        if (els.length) {
          const ticked = els.filter((i) => i.done).length;
          wrap.append(el('div', { class: 'shop-actions' },
            el('button', { class: 'btn', type: 'button', disabled: ticked ? null : '', onclick: async () => { book.elsewhere = els.filter((i) => !i.done); await save(); draw(); ui.toast('Cleared ' + ticked); } }, 'Clear ' + ticked + ' ticked (got them)'),
            el('button', { class: 'btn' + (confirmClear ? ' danger' : ''), type: 'button', onclick: async () => { if (!confirmClear) { confirmClear = true; draw(); setTimeout(() => { if (confirmClear) { confirmClear = false; draw(); } }, 4000); return; } confirmClear = false; book.elsewhere = []; await save(); draw(); ui.toast('Cleared'); } }, confirmClear ? 'Tap again to clear Elsewhere' : 'Clear whole list')));
        }
      }
      wrap.append(el('p', { class: 'sub shop-foot' }, 'This is the page "' + (p.title || 'Shopping list') + '" in your notebook — every list is kept there by date.'));
    };
    // Start a fresh list: the current one is kept (dated) under Past lists; unticked items can come along.
    function newList() {
      const un = cur().filter((i) => !i.done);
      let bring = un.length > 0;
      return ui.sheet((box, close) => {
        const cb = el('input', { type: 'checkbox', checked: bring ? '' : null }); cb.addEventListener('change', () => { bring = cb.checked; });
        box.append(el('h2', {}, 'Start a new list'),
          el('p', { class: 'sub' }, cur().length ? 'The current list (' + cur().length + ' item' + (cur().length === 1 ? '' : 's') + ', started ' + fmtDate(book.current.date) + ') is kept under Past lists in the note.' : 'The current list is empty, so it isn’t kept.'),
          un.length ? el('label', { class: 'fm-toggle' }, cb, el('span', {}, 'Bring over the ' + un.length + ' unticked item' + (un.length === 1 ? '' : 's') + ' (' + un.slice(0, 4).map((i) => i.name).join(', ') + (un.length > 4 ? '…' : '') + ')')) : null,
          el('div', { class: 'actions' },
            el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
            el('button', { class: 'btn primary', type: 'button', onclick: async () => {
              const old = book.current;
              if (old.items.length) book.past.unshift(old);
              book.current = { date: todayISO(), items: bring ? un.map((i) => Object.assign({}, i, { done: false })) : [] };
              close(); await save(); view = 'lidl'; draw(); ui.toast(bring && un.length ? 'New list started with ' + un.length + ' carried over' : 'New list started');
            } }, 'Start new list')));
      }, { centre: true });
    }
    function editSheet(r) {
      ui.sheet((box, close) => {
        const name = el('input', { type: 'text', value: r.name }); const note = el('input', { type: 'text', value: r.note || '', placeholder: 'size, brand, what it is for…' });
        let qty = r.qty || 1; const qv = el('output', {}, String(qty));
        const cat = el('select', {}, ...CATS.map((c) => el('option', { selected: c === r.cat ? '' : null }, c)));
        const storeSeg = el('div', { class: 'shift-chips' }, ...STORES.map((s) => el('button', { class: 'chip' + ((r.store || 'Aldi') === s ? ' on' : ''), type: 'button', onclick: (e) => { r.store = s; for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target); } }, s)));
        const apply = () => { r.name = name.value.trim() || r.name; r.note = note.value.trim(); r.qty = qty; r.cat = cat.value; };
        const inEls = r.list === 'elsewhere';
        box.append(el('h2', {}, 'Edit item'),
          el('label', { class: 'shift-field' }, el('span', {}, 'Item'), name),
          el('div', { class: 'shift-two' }, el('label', { class: 'shift-field' }, el('span', {}, 'Quantity'), el('div', { class: 'shop-step' }, el('button', { type: 'button', onclick: () => { qty = Math.max(1, qty - 1); qv.textContent = qty; } }, '−'), qv, el('button', { type: 'button', onclick: () => { qty = Math.min(99, qty + 1); qv.textContent = qty; } }, '+'))), el('label', { class: 'shift-field' }, el('span', {}, 'Aisle'), cat)),
          el('label', { class: 'shift-field' }, el('span', {}, 'Note'), note),
          inEls ? el('div', { class: 'shift-field' }, el('span', {}, 'Try at'), storeSeg) : null,
          el('div', { class: 'actions' },
            el('button', { class: 'btn danger', type: 'button', onclick: async () => { const a = inEls ? book.elsewhere : cur(); const i = a.indexOf(r); if (i >= 0) a.splice(i, 1); close(); await save(); draw(); } }, 'Delete'),
            inEls ? el('button', { class: 'btn', type: 'button', onclick: async () => { apply(); book.elsewhere.splice(book.elsewhere.indexOf(r), 1); cur().push(Object.assign(r, { list: 'lidl', done: false })); close(); await save(); draw(); } }, 'Back to Lidl')
              : el('button', { class: 'btn', type: 'button', onclick: async () => { apply(); cur().splice(cur().indexOf(r), 1); book.elsewhere.push(Object.assign(r, { list: 'elsewhere', done: false, store: r.store || 'Aldi' })); close(); await save(); draw(); } }, 'Send to Elsewhere'),
            el('button', { class: 'btn primary', type: 'button', onclick: async () => { apply(); close(); await save(); draw(); } }, 'Done')));
      }, { centre: true });
    }
    draw();
  }

  window.NCShop = { render, parsePage, serialise, parseBook, serialiseBook };
})();

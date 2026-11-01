// Amazon: things shared into 2nd Brain from the Amazon app or an Amazon email are filed where they belong.
//  · A product link → the shopping list, Elsewhere › Amazon, with its link (tap it later to go straight back to it).
//  · An order / dispatch email ("Arriving Tuesday") → a to-do on the Organiser due that day, a Google Calendar
//    entry if the calendar is connected, and the matching Amazon item on the shopping list ticked as ordered.
// Anything else carries on into the Inbox as before.
(function () {
  const { pages } = window.NCDB;
  const URL_RE = /\bhttps?:\/\/(?:www\.|smile\.|m\.)?(?:amazon\.(?:co\.uk|com|de|fr|it|es|ca|nl|ie|com\.au)|amzn\.(?:eu|to|com|asia)|a\.co)\/[^\s<>"]+/i;
  const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/;
  const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const label = (s) => new Date(s + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const short = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
  let notify = () => {};

  // ---- dates: "today", "tomorrow", "Tuesday", "4 November", "Nov 4", "Tue, 4 Nov" ----
  function dateIn(s, now = new Date()) {
    s = String(s || '').toLowerCase();
    const day = (n) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return iso(d); };
    const dm = (d, mi) => { const t = new Date(now.getFullYear(), mi, d, 12); if (t < new Date(now.getTime() - 60 * 86400000)) t.setFullYear(t.getFullYear() + 1); return iso(t); };
    let m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
    if (m) return dm(+m[1], MON.indexOf(m[2]));
    m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (m) return dm(+m[2], MON.indexOf(m[1]));
    if (/\btoday\b/.test(s)) return day(0);
    if (/\btomorrow\b/.test(s)) return day(1);
    m = s.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
    if (m) { const want = DOW.findIndex((d) => d.startsWith(m[1])); return day((want - now.getDay() + 7) % 7); }
    return '';
  }
  // The delivery day: only read from the words after "Arriving / Delivery / Expected…", not the order date.
  function deliveryDate(text, now) {
    const re = /(arriving|arrives|now arriving|delivery(?:\s+(?:date|estimate|by))?|estimated delivery|expected(?:\s+delivery)?|out for delivery|delivered|guaranteed delivery)\s*[:\-–]?\s*([^\n]{0,70})/gi;
    let m;
    while ((m = re.exec(text))) {
      const d = dateIn(m[2], now) || (/out for delivery|delivered/i.test(m[1]) ? dateIn('today', now) : '');
      if (d) return { date: d, delivered: /^delivered/i.test(m[1]) };
    }
    return null;
  }
  function itemOf(text) {
    let m = text.match(/\b(?:ordered|dispatched|shipped|delivered|arriving|out for delivery)\s*:\s*["“'‘]?([^"”'’\n]{3,140})/i);
    let name = m ? m[1] : '';
    if (!name) { m = text.match(/["“]([^"”\n]{4,140})["”]/); if (m) name = m[1]; }
    name = name.replace(/\s+/g, ' ').replace(/\.{3}|…/g, '').trim();
    const more = text.match(/\band\s+(\d+)\s+more\s+items?\b/i);
    return name ? short(name, 60) + (more ? ' (+' + more[1] + ' more)' : '') : '';
  }
  // A product's name from the shared text or the link itself.
  function productName(text, url) {
    let t = text.replace(url, ' ').replace(URL_RE, ' ');
    const lines = t.split(/\n+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
      .filter((x) => !/^(check (?:out|this)|i found this|look at this|shop now|see (?:it|this) on amazon|share)\b/i.test(x) && !/^amazon\.[a-z.]+\s*$/i.test(x) && x.length > 2);
    let n = lines[0] || '';
    n = n.replace(/^amazon\.[a-z.]+\s*:\s*/i, '').replace(/\s*:\s*amazon\.[a-z.]+\s*:.*$/i, '').replace(/\s*[|:]\s*amazon\.[a-z.]+.*$/i, '').trim();
    if (/^amazon\.[a-z.]+/i.test(t.trim()) && / : /.test(n)) n = n.replace(/\s:\s[^:]+$/, '');
    if (!n) { const slug = url.match(/amazon\.[a-z.]+\/([^/?#]+)\/(?:dp|gp\/product)\//i); if (slug && !/^dp$/i.test(slug[1])) n = decodeURIComponent(slug[1]).replace(/-/g, ' '); }
    return n ? short(n, 80) : '';
  }

  // ---- where things go ----
  async function shopPage() {
    const tile = (await pages.live()).find((q) => q.kind === 'app' && q.app === 'shop');
    const p = tile && tile.pageRef ? await pages.get(tile.pageRef) : null;
    return p && !p.deleted ? p : null;
  }
  async function organiserPage() {
    const live = await pages.live();
    const tile = live.find((q) => q.kind === 'app' && q.app === 'organiser');
    let p = tile && tile.pageRef ? await pages.get(tile.pageRef) : null;
    if (!p || p.deleted) p = live.find((q) => q.ptype === 'todo' && q.title === 'Organiser') || null;
    return p;
  }
  async function addProduct(name, url) {
    const p = await shopPage(); if (!p || !window.NCShop) return false;
    const S = window.NCShop, book = S.parseBook(p.html);
    const dup = book.elsewhere.find((i) => (url && i.url === url) || (name && S.keyOf(i.name) === S.keyOf(name)));
    const nm = name || 'Amazon item — tap to name it';
    if (dup) { dup.done = false; dup.store = 'Amazon'; if (url) dup.url = url; }
    else book.elsewhere.push({ name: nm, qty: 1, note: '', done: false, url, list: 'elsewhere', cat: S.guessCat(nm), store: 'Amazon' });
    await pages.update(p.id, { html: S.serialiseBook(book) });
    notify(dup ? short(nm, 40) + ' is already on your Amazon list' : 'Added ' + short(nm, 40) + ' to your Amazon list');
    return true;
  }
  // Tick the Amazon list item this order is for (shared words in the name), noting when it's coming.
  async function markOrdered(item, when) {
    const p = await shopPage(); if (!p || !window.NCShop || !item) return '';
    const S = window.NCShop, book = S.parseBook(p.html);
    const words = (x) => new Set(S.keyOf(x).split(' ').filter((w) => w.length > 2));
    const want = words(item);
    let best = null, score = 0;
    for (const r of book.elsewhere) { if (r.store !== 'Amazon' || r.done) continue; const w = words(r.name); let n = 0; for (const x of w) if (want.has(x)) n++; const sc = n / Math.max(1, Math.min(w.size, want.size)); if (n >= 2 && sc > score) { best = r; score = sc; } }
    if (!best || score < 0.5) return '';
    best.done = true; best.note = 'Ordered — ' + when;
    await pages.update(p.id, { html: S.serialiseBook(book) });
    return best.name;
  }
  async function addDelivery(text, d) {
    const item = itemOf(text) || 'Amazon order';
    const order = (text.match(ORDER_RE) || [])[0] || '';
    const when = (d.delivered ? 'delivered ' : 'arriving ') + label(d.date);
    const page = await organiserPage();
    if (!page || !window.NCTodo) return false;
    const T = window.NCTodo, items = T.parse(page.html);
    const line = '📦 Amazon: ' + item + ' — ' + when;
    const same = items.find((i) => !i.done && i.text.startsWith('📦 Amazon: ' + item));
    if (same) { same.text = line; same.due = d.delivered ? '' : d.date; if (d.delivered) { same.done = true; same.doneOn = iso(new Date()); } }
    else if (!d.delivered) items.unshift({ text: line, done: false, due: d.date, pri: 'med', eff: 'quick', added: iso(new Date()), doneOn: '' });
    await pages.update(page.id, { html: T.serialise(items) });
    const ticked = d.delivered ? '' : await markOrdered(item, when);
    let cal = '';
    if (!d.delivered && !same && window.NCGCal && NCGCal.state().signedIn) {
      try { await NCGCal.createEvent({ title: '📦 ' + item, date: d.date, description: 'Amazon delivery' + (order ? ' · order ' + order : '') }); cal = ' and your calendar'; } catch (e) { cal = ''; }
    }
    notify(d.delivered ? 'Ticked off: ' + short(item, 40) + ' delivered' : '📦 ' + short(item, 40) + ' — ' + when + ', on your Organiser' + cal + (ticked ? ' (ticked on the Amazon list)' : ''));
    return true;
  }

  // Shared text in → true if it was filed here (so it doesn't also land in the Inbox).
  async function route(text) {
    text = String(text || '').trim(); if (!text) return false;
    const url = (text.match(URL_RE) || [])[0] || '';
    // Amazon's own emails start "Ordered: …", "Dispatched: …", "Delivered: …" — enough even if the word Amazon isn't in the bit shared.
    const amazonish = /amazon/i.test(text) || ORDER_RE.test(text) || !!url || /^\s*(ordered|dispatched|shipped|delivered|arriving)\s*:\s*["“'‘]/im.test(text);
    if (!amazonish) return false;
    try {
      if (/\b(ordered|dispatched|shipped|arriving|arrives|out for delivery|delivered|delivery|your order)\b/i.test(text)) {
        const d = deliveryDate(text);
        if (d && await addDelivery(text, d)) return true;
      }
      if (url) return await addProduct(productName(text, url), url);
    } catch (e) { console.warn('amazon route failed', e); }
    return false;
  }

  window.NCAmazon = { route, onNotify: (fn) => { notify = fn || (() => {}); }, _test: { dateIn, deliveryDate, itemOf, productName } };
})();

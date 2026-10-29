// FAMUS scan log: supervised thoracic (lung) ultrasound scans towards FAMUS accreditation. Everything lives in
// ONE note, "FAMUS scan log", as a single wide table: the backup, readable and editable by hand. This view is
// the friendlier way in: the FAMUS v1.9 reporting sheet as a form, the Venue Go checklist, PDF and text export.
// The table is read by column name, so reordering or adding columns in the note doesn't break anything.
(function () {
  const { notebooks, sections, pages } = window.NCDB;
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const NB = 'FAMUS';
  const TITLE = 'FAMUS scan log';
  const TARGET = 10; // supervised scans before mentored practice
  const ZONES = [['R-UA', 'Right', 'Upper anterior'], ['R-LA', 'Right', 'Lower anterior'], ['R-PL', 'Right', 'Postero-lateral'],
    ['L-UA', 'Left', 'Upper anterior'], ['L-LA', 'Left', 'Lower anterior'], ['L-PL', 'Left', 'Postero-lateral']];
  const zoneCol = (z) => z[1][0] + ' ' + z[2].toLowerCase(); // "R upper anterior"
  const ITEMS = [['sliding', 'Lung sliding?', 'Sliding'], ['alines', 'A lines present?', 'A-lines'], ['blines', 'B lines present?', 'B-lines'], ['effusion', 'Effusion?', 'Effusion'], ['consol', 'Consolidation / collapse?', 'Consolidation']];
  const CHECKS = {
    before: [['patient', 'Start a new patient', 'Patient icon → enter ID. Everything you store lands in this exam.', 'New patient'],
      ['preset', 'Curvilinear probe + Lung application', 'Lung diagram on screen = right preset.', 'Lung preset'],
      ['clip', 'Clip setting confirmed', 'Config → Imaging: prospective, 6 s. Do a 1 s test clip and play it back.', 'Clip setting'],
      ['depth', 'Depth set', '~12–16 cm for B-lines / consolidation; shallower with linear for the pleura.', 'Depth']],
    during: [['bat', 'Bat sign — pleural line mid-screen, rib shadows either side', '', 'Bat sign'],
      ['still', 'Probe held still for the full countdown', 'Brace on the chest wall. Don’t fan or tilt once Store is pressed.', 'Probe still'],
      ['breathe', 'Patient breathing normally', 'No breath-hold — you want 2–3 respiratory cycles.', 'Breathing normally'],
      ['zonelabel', 'Zone label on the diagram matches the probe position', '', 'Zone label'],
      ['live', 'Stored from LIVE, not frozen', 'Frozen + Store = still. Live + Store = your 6 s loop.', 'Stored from live']],
    after: [['review', 'Played every clip in Review', 'Each one 6 s, pleura central, zone right.', 'Reviewed clips'],
      ['duds', 'Deleted duds', '', 'Deleted duds'], ['end', 'End Exam tapped', '', 'End exam'],
      ['examid', 'Exam ID copied into the box at the top', '', 'Exam ID copied'],
      ['export', 'Exported', 'USB (anonymised) or PACS — whichever your unit uses for trainee review.', 'Exported'],
      ['sent', 'Supervisor told where to find it', '', 'Supervisor told']]
  };
  const CHECK_LIST = Object.values(CHECKS).flat();
  const GROUP_TITLES = { before: 'Before you store anything', during: 'For every clip', after: 'Review and export' };
  const SITE = [['performed', 'Yes (performed)'], ['notperformed', 'Yes (not performed)'], ['no', 'No']];
  const COLS = ['#', 'Date', 'Exam ID', 'Quality', ...ZONES.map(zoneCol), 'Pleural site', 'Comment / conclusion', 'Reflection', 'Questions for supervisor', 'Supervisor comments',
    'Dept scan required', 'Dept scan requested', 'Discussed', 'Signed', 'Probe', 'Clip', 'Checklist'];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const toUK = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : (iso || ''); };
  const fromUK = (s) => {
    s = String(s || '').trim(); if (!s) return '';
    let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
    const d = new Date(s); return isNaN(d) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  const fmtDay = (iso) => { const p = String(iso || '').split('-').map(Number); if (p.length !== 3 || !p[0]) return ''; return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const blank = () => ({ examId: '', date: todayISO(), quality: null, findings: {}, stored: {}, procSite: null, comment: '', reflection: '', questions: '', mentor: '', deptRequired: null, deptRequested: null, discussed: false, signed: false, checks: {}, probe: '', clip: '6 s prospective' });
  const YN = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '');
  const ynOf = (t) => (/^\s*(y|yes|✓|✔)\s*$/i.test(t) ? 'yes' : /^\s*(n|no|✗|✘)\s*$/i.test(t) ? 'no' : null);
  const zonesDone = (s) => ZONES.filter(([k]) => s.findings && s.findings[k] && Object.values(s.findings[k]).some(Boolean)).length;
  const checksDone = (s) => CHECK_LIST.filter(([k]) => (s.checks || {})[k]).length;

  // ---- note <-> scans ----
  const zoneText = (s, k) => {
    const z = (s.findings || {})[k] || {};
    const bits = ITEMS.filter(([ik]) => z[ik]).map(([ik, , short]) => short + ' ' + (z[ik] === 'yes' ? '✓' : '✗'));
    if ((s.stored || {})[k]) bits.push('clip stored');
    return bits.join(' · ');
  };
  const zoneParse = (t) => {
    const z = {};
    for (const [ik, , short] of ITEMS) {
      const m = t.match(new RegExp(short.replace('-', '[- ]?') + '\\s*:?\\s*(✓|✔|✗|✘|yes|no|y|n)(?![a-z])', 'i'));
      if (m) z[ik] = /^(✓|✔|yes|y)$/i.test(m[1]) ? 'yes' : 'no';
    }
    return { z, stored: /clip stored/i.test(t) };
  };
  function cellsOf(s, n) {
    const site = SITE.find(([v]) => v === s.procSite);
    return [String(n), toUK(s.date), s.examId, s.quality || '', ...ZONES.map(([k]) => zoneText(s, k)), site ? site[1] : '', s.comment, s.reflection, s.questions, s.mentor,
      YN(s.deptRequired), YN(s.deptRequested), s.discussed ? 'Yes' : '', s.signed ? 'Yes' : '', s.probe, s.clip,
      CHECK_LIST.filter(([k]) => (s.checks || {})[k]).map((c) => c[3]).join(', ')];
  }
  const byDate = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a._n || 0) - (b._n || 0);
  function serialise(data) {
    const rows = data.scans.slice().sort(byDate);
    const cell = (v) => '<td>' + esc(v).replace(/\n/g, '<br>') + '</td>';
    const body = rows.length ? rows.map((s, i) => '<tr>' + cellsOf(s, i + 1).map(cell).join('') + '</tr>').join('') : '<tr>' + COLS.map(() => '<td></td>').join('') + '</tr>';
    return '<p><strong>Candidate:</strong> ' + esc(data.candidate || '') + '</p>' +
      '<table><thead><tr>' + COLS.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
  }
  const cellText = (td) => {
    const c = td.cloneNode(true);
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p, div, li').forEach((b) => b.append('\n'));
    return (c.textContent || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  function parse(html) {
    const d = document.createElement('div'); d.innerHTML = html || '';
    let candidate = '';
    for (const p of d.querySelectorAll('p')) { const m = (p.textContent || '').match(/^\s*Candidate\s*:\s*(.*)$/i); if (m) { candidate = m[1].trim(); break; } }
    const scans = [];
    for (const table of d.querySelectorAll('table')) {
      const trs = [...table.querySelectorAll('tr')]; if (!trs.length) continue;
      const head = [...trs[0].children].map((c) => c.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
      if (!head.includes('exam id')) continue;
      for (const tr of trs.slice(1)) {
        const cells = [...tr.children].map(cellText);
        if (!cells.some(Boolean)) continue;
        const get = (name) => { const i = head.indexOf(name.toLowerCase()); return i >= 0 ? (cells[i] || '') : ''; };
        const s = blank();
        s.date = fromUK(get('Date')); s.examId = get('Exam ID');
        const q = get('Quality'); s.quality = ['Good', 'Adequate', 'Poor'].find((x) => x.toLowerCase() === q.toLowerCase()) || (q || null);
        for (const z of ZONES) { const r = zoneParse(get(zoneCol(z))); if (Object.keys(r.z).length) s.findings[z[0]] = r.z; if (r.stored) s.stored[z[0]] = true; }
        const site = get('Pleural site').toLowerCase(); s.procSite = /not/.test(site) ? 'notperformed' : /yes|perform/.test(site) ? 'performed' : /^no/.test(site) ? 'no' : null;
        s.comment = get('Comment / conclusion'); s.reflection = get('Reflection'); s.questions = get('Questions for supervisor'); s.mentor = get('Supervisor comments');
        s.deptRequired = ynOf(get('Dept scan required')); s.deptRequested = ynOf(get('Dept scan requested'));
        s.discussed = /^(y|yes|✓|✔)/i.test(get('Discussed')); s.signed = /^(y|yes|✓|✔)/i.test(get('Signed'));
        s.probe = get('Probe'); s.clip = get('Clip');
        const cl = get('Checklist').toLowerCase(); for (const [k, , , short] of CHECK_LIST) if (cl.includes(short.toLowerCase())) s.checks[k] = true;
        s._n = scans.length;
        scans.push(s);
      }
    }
    return { candidate, scans };
  }

  // ---- where the note lives ----
  async function findNotebook() {
    const all = (await notebooks.all()).concat(await notebooks.archived());
    const n = NB.toLowerCase();
    return all.find((x) => x.name.toLowerCase() === n) || all.find((x) => x.name.toLowerCase().startsWith(n)) || all.find((x) => x.name.toLowerCase().includes(n)) || null;
  }
  async function findTile() { return (await pages.live()).find((q) => q.kind === 'app' && q.app === 'famus'); }
  async function logPage() {
    const live = (await pages.live()).filter((q) => q.ptype === 'famus-table');
    const tile = await findTile();
    let p = tile && tile.pageRef ? live.find((q) => q.id === tile.pageRef) : null;
    if (!p) p = live.sort((a, b) => (a.created || 0) - (b.created || 0))[0] || null;
    if (!p) {
      const nb = (await findNotebook()) || (await notebooks.create(NB));
      const secs = await sections.forNotebook(nb.id);
      const sec = secs.find((s) => /scan log/i.test(s.name)) || (await sections.create(nb.id, 'Scan log'));
      p = await pages.create({ notebookId: nb.id, sectionId: sec.id, title: TITLE, html: serialise({ candidate: '', scans: [] }), ptype: 'famus-table', pinned: 1 });
    }
    // A second copy (e.g. one arrived through the capture relay after this device made an empty one) folds in.
    const extras = live.filter((q) => q.id !== p.id);
    if (extras.length) {
      const data = parse(p.html);
      for (const x of extras) { const o = parse(x.html); data.candidate = data.candidate || o.candidate; for (const s of o.scans) if (!data.scans.some((t) => t.examId && t.examId === s.examId && t.date === s.date)) data.scans.push(s); await pages.remove(x.id); }
      p.html = serialise(data); await pages.update(p.id, { html: p.html });
    }
    if (tile && tile.pageRef !== p.id) await pages.update(tile.id, { pageRef: p.id });
    return p;
  }

  // ---- PDF in the FAMUS v1.9 layout (A4, signature lines left blank for ink) ----
  async function buildPdf(s, candidate) {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), ital = await doc.embedFont(StandardFonts.HelveticaOblique);
    const MM = 72 / 25.4, PH = 297, W = 210, M = 16, CW = W - 2 * M;
    let page = doc.addPage([W * MM, PH * MM]); let y = 18;
    const black = rgb(0, 0, 0);
    // The built-in PDF fonts only cover Latin-1, so typographic characters are swapped for plain ones.
    const clean = (t) => String(t == null ? '' : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[✓✔]/g, 'Y').replace(/[✗✘]/g, 'N').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
    const fontOf = (o) => (o.b ? bold : o.i ? ital : font);
    const txt = (t, x, yy, o = {}) => { const f = fontOf(o), size = o.s || 10; t = clean(t); if (!t) return; let xx = x; if (o.al === 'center') xx = x - f.widthOfTextAtSize(t, size) / MM / 2; page.drawText(t, { x: xx * MM, y: (PH - yy) * MM, size, font: f, color: black }); };
    const line = (x1, y1, x2, y2, lw = 0.3) => page.drawLine({ start: { x: x1 * MM, y: (PH - y1) * MM }, end: { x: x2 * MM, y: (PH - y2) * MM }, thickness: lw * MM, color: black });
    const rect = (x, yy, w, h) => { line(x, yy, x + w, yy); line(x + w, yy, x + w, yy + h); line(x + w, yy + h, x, yy + h); line(x, yy + h, x, yy); };
    const split = (t, size, maxW, f = font) => {
      const out = [];
      for (const para of clean(t).split('\n')) { let cur = ''; for (const w of para.split(/\s+/).filter(Boolean)) { const next = cur ? cur + ' ' + w : w; if (cur && f.widthOfTextAtSize(next, size) / MM > maxW) { out.push(cur); cur = w; } else cur = next; } out.push(cur); }
      return out;
    };
    const box = (x, yy, v) => { rect(x, yy - 3, 3.2, 3.2); if (v) { line(x + 0.5, yy - 2.5, x + 2.7, yy - 0.3, 0.5); line(x + 2.7, yy - 2.5, x + 0.5, yy - 0.3, 0.5); } };
    const yn = (x, yy, v) => { txt('Yes', x, yy, { s: 8 }); box(x + 6, yy, v === 'yes'); txt('No', x + 11, yy, { s: 8 }); box(x + 16, yy, v === 'no'); };
    const para = (label, body, minH) => {
      const lines = split(body || '', 9.5, CW - 4); const h = Math.max(minH, lines.length * 4.2 + 5);
      if (y + h + 6 > PH - 12) { page = doc.addPage([W * MM, PH * MM]); y = 20; }
      txt(label, M, y, { b: 1 }); y += 5;
      rect(M, y - 3.5, CW, h); lines.forEach((l, i) => txt(l, M + 2, y + 1 + i * 4.2, { s: 9.5 })); y += h + 3;
    };
    txt('Focused Acute Medicine Ultrasound (FAMUS)', W / 2, y, { b: 1, s: 13, al: 'center' }); y += 6;
    txt('Reporting sheet - thoracic ultrasound', W / 2, y, { s: 11, al: 'center' }); y += 10;
    txt('Candidate name:', M, y, { b: 1 }); txt(candidate || '', M + 32, y); txt('Date:', M + 120, y, { b: 1 }); txt(toUK(s.date), M + 132, y); y += 7;
    txt('Patient identifier:', M, y, { b: 1 }); txt(s.examId || '', M + 32, y); y += 7;
    txt('Image quality:', M, y, { b: 1 }); let qx = M + 40; for (const q of ['Good', 'Adequate', 'Poor']) { box(qx, y, s.quality === q); txt(q, qx + 5, y); qx += 28; } y += 9;
    const cols = [M, M + 14, M + 42, M + 68, M + 94, M + 120, M + 146, M + CW];
    const th = 11; rect(M, y, CW, th);
    for (let i = 2; i < 7; i++) { const cx = (cols[i] + cols[i + 1]) / 2; split(ITEMS[i - 2][1], 8, cols[i + 1] - cols[i] - 2, bold).forEach((l, j) => txt(l, cx, y + 4.5 + j * 3.3, { b: 1, s: 8, al: 'center' })); }
    for (let i = 1; i < 7; i++) line(cols[i], y, cols[i], y + th);
    y += th;
    for (const [k, side, name] of ZONES) {
      const rh = 8; rect(M, y, CW, rh); for (let i = 1; i < 7; i++) line(cols[i], y, cols[i], y + rh);
      txt(side, M + 1.5, y + 5.3, { s: 8.5, b: 1 }); txt(name, cols[1] + 1.5, y + 5.3, { s: 8.5 });
      const z = (s.findings || {})[k] || {}; ITEMS.forEach(([ik], i) => yn(cols[i + 2] + 2.5, y + 5.3, z[ik])); y += rh;
    }
    y += 6;
    txt('Has a suitable site for pleural procedure been identified?', M, y, { b: 1, s: 9.5 }); y += 5.5;
    let px = M + 6; for (const [v, l] of SITE) { box(px, y, s.procSite === v); txt(l, px + 5, y, { s: 9 }); px += 52; } y += 9;
    para('Comment/further details and conclusion of scan:', s.comment, 28);
    para('Candidate reflection on scan (optional):', s.reflection, 18);
    if (s.questions) para('Questions for supervisor:', s.questions, 12);
    para('Mentor/supervisor comments:', s.mentor, 24);
    if (y > 245) { page = doc.addPage([W * MM, PH * MM]); y = 20; }
    txt('Signed (candidate):', M, y, { b: 1 }); line(M + 40, y + 0.5, M + 95, y + 0.5); y += 9;
    txt('Signed to confirm above findings (mentor/supervisor):', M, y, { b: 1 }); line(M + 95, y + 0.5, M + CW, y + 0.5); y += 9;
    txt('Initial to confirm candidate suitable to commence mentored practice (only required once, minimum 10 supervised scans):', M, y, { s: 8.5 }); line(M + CW - 30, y + 3.5, M + CW, y + 3.5); y += 9;
    txt('Is a Departmental scan required?', M, y, { s: 9 }); yn(M + 58, y, s.deptRequired); txt('Requested?', M + 95, y, { s: 9 }); yn(M + 118, y, s.deptRequested); y += 10;
    split('Once completed candidate must maintain logbook of countersigned report sheets. Please remember not to remove patient confidential information from Trust property. Layout after FAMUS reporting sheet v1.9 (Nov 2018).', 7.5, CW, ital).forEach((l, i) => txt(l, M, y + i * 3.2, { s: 7.5, i: 1 }));
    return doc.save();
  }
  function asText(s, candidate) {
    const L = ['FAMUS — Reporting sheet: thoracic ultrasound', 'Candidate: ' + (candidate || '') + '    Date: ' + toUK(s.date), 'Patient identifier: ' + (s.examId || ''), 'Image quality: ' + (s.quality || '—'), '',
      'Zone | Sliding | A lines | B lines | Effusion | Consolidation/collapse'];
    for (const [k, side, name] of ZONES) { const z = (s.findings || {})[k] || {}; L.push(side + ' ' + name + ' | ' + ITEMS.map(([ik]) => YN(z[ik]) || '—').join(' | ')); }
    const site = SITE.find(([v]) => v === s.procSite);
    L.push('', 'Suitable site for pleural procedure identified: ' + (site ? site[1] : '—'), '', 'Comment / conclusion:', s.comment || '', '', 'Candidate reflection:', s.reflection || '');
    if (s.questions) L.push('', 'Questions for supervisor:', s.questions);
    L.push('', 'Mentor/supervisor comments:', s.mentor || '', '', 'Departmental scan required: ' + (YN(s.deptRequired) || '—') + '    Requested: ' + (YN(s.deptRequested) || '—'));
    return L.join('\n');
  }

  // ---- the view ----
  async function render(host, ui) {
    host.innerHTML = '';
    const page = await logPage();
    const data = parse(page.html);
    let timer = null;
    const saveNow = async () => { clearTimeout(timer); timer = null; const html = serialise(data); if (html === page.html) return; page.html = html; await pages.update(page.id, { html }); ui.changed && ui.changed(); };
    const save = () => { clearTimeout(timer); timer = setTimeout(saveNow, 500); };
    window.addEventListener('pagehide', () => { if (timer) saveNow(); }, { once: true });
    const wrap = el('div', { class: 'fm' }); host.append(wrap);
    const numbered = () => { const order = data.scans.slice().sort(byDate); return (s) => order.indexOf(s) + 1; };

    function list() {
      wrap.innerHTML = '';
      const num = numbered();
      const done = data.scans.length, signed = data.scans.filter((s) => s.signed).length;
      wrap.append(el('div', { class: 'pf-tally' },
        el('div', { class: 'pf-fig core' }, el('b', {}, String(done)), el('span', {}, 'of ' + TARGET + ' supervised scans')),
        el('div', { class: 'pf-fig' }, el('b', {}, String(signed)), el('span', {}, 'sheets signed')),
        el('div', { class: 'pf-fig non' }, el('b', {}, String(data.scans.filter((s) => s.discussed && !s.signed).length)), el('span', {}, 'discussed, awaiting sign'))));
      wrap.append(el('div', { class: 'fm-bar' }, el('div', { class: 'fm-bar-fill', style: 'width:' + Math.min(100, Math.round(done / TARGET * 100)) + '%' })));
      const name = el('input', { type: 'text', value: data.candidate || '', placeholder: 'Dr …', autocomplete: 'off' });
      name.addEventListener('input', () => { data.candidate = name.value.trim(); save(); });
      wrap.append(el('div', { class: 'fm-toprow' },
        el('label', { class: 'pf-field fm-cand' }, 'Candidate name (goes on every sheet)', name),
        el('a', { class: 'btn small', href: '#page/' + page.id, title: 'Open the note the scans live in' }, 'Note'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => { const s = blank(); s._n = Date.now(); data.scans.push(s); save(); detail(s); } }, '+ New scan')));
      if (!data.scans.length) wrap.append(el('div', { class: 'fm-empty' }, 'No scans logged yet. Tap ', el('b', {}, '+ New scan'), ' when you’ve got the machine in front of you.'));
      else {
        const box = el('div', { class: 'pf-list' });
        for (const s of data.scans.slice().sort(byDate).reverse()) {
          const z = zonesDone(s);
          box.append(el('button', { class: 'pf-entry fm-card', type: 'button', onclick: () => detail(s) },
            el('span', { class: 'fm-num' + (s.signed ? ' ok' : '') }, '#' + num(s)),
            el('span', { class: 'fm-main' }, el('span', { class: 'fm-id' }, s.examId || 'No exam ID yet'), el('span', { class: 'sub' }, [fmtDay(s.date), s.quality].filter(Boolean).join(' · '))),
            el('span', { class: 'fm-state' + (s.signed ? ' ok' : '') }, s.signed ? 'Signed ✓' : s.discussed ? 'Discussed ✓' : z + '/6 zones')));
        }
        wrap.append(box);
      }
      wrap.append(el('p', { class: 'fm-note' }, 'Minimum ' + TARGET + ' supervised scans before mentored practice. Each one needs a countersigned sheet in your logbook.'));
    }

    function seg(options, get, set, cls) {
      const b = el('div', { class: 'fm-seg' + (cls ? ' ' + cls : '') });
      const paint = () => { for (const x of b.children) x.setAttribute('aria-pressed', x.dataset.v === get() ? 'true' : 'false'); };
      for (const [v, label] of options) b.append(el('button', { type: 'button', 'data-v': v, onclick: () => { set(get() === v ? null : v); paint(); } }, label));
      paint(); return b;
    }

    function detail(s) {
      wrap.innerHTML = '';
      const num = numbered();
      const title = el('h2', { class: 'fm-title' }, s.examId || 'Scan #' + num(s));
      const changed = () => { save(); refresh(); };
      wrap.append(el('div', { class: 'fm-detail-head' }, el('button', { class: 'btn small', type: 'button', onclick: async () => { await saveNow(); list(); } }, '‹ All scans'), title, el('span', { class: 'spacer' }), el('span', { class: 'sub fm-saved' }, '')));
      // identity
      const examId = el('input', { class: 'fm-big', type: 'text', value: s.examId, placeholder: 'Read off the Venue Go', autocomplete: 'off', autocapitalize: 'characters' });
      examId.addEventListener('input', () => { s.examId = examId.value.trim(); title.textContent = s.examId || 'Scan #' + num(s); save(); });
      const date = el('input', { type: 'date', value: s.date || '' }); date.addEventListener('change', () => { s.date = date.value; save(); });
      wrap.append(el('section', { class: 'fm-card-box' },
        el('label', { class: 'pf-field' }, 'Patient identifier (scanner’s auto ID)', examId),
        el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Date', date),
          el('div', { class: 'pf-field' }, 'Image quality', seg([['Good', 'Good'], ['Adequate', 'Adequate'], ['Poor', 'Poor']], () => s.quality, (v) => { s.quality = v; save(); })))));
      // zones
      const zoneCount = el('span', { class: 'fm-count' });
      const zoneHost = el('div', { class: 'fm-zones' });
      const sums = new Map();
      for (const [k, side, name] of ZONES) {
        const sum = el('span', { class: 'fm-zsum' }); sums.set(k, sum);
        const stored = el('input', { type: 'checkbox', checked: (s.stored || {})[k] ? true : null });
        stored.addEventListener('change', () => { s.stored = Object.assign({}, s.stored, { [k]: stored.checked }); if (!stored.checked) delete s.stored[k]; changed(); });
        const body = el('div', { class: 'fm-zbody' }, el('label', { class: 'fm-stored' }, stored, el('span', {}, '6 s clip stored for this zone')),
          ...ITEMS.map(([ik, label]) => el('div', { class: 'fm-row' }, el('span', {}, label), seg([['yes', 'Yes'], ['no', 'No']], () => ((s.findings || {})[k] || {})[ik] || null, (v) => { s.findings = s.findings || {}; s.findings[k] = Object.assign({}, s.findings[k], { [ik]: v }); if (!v) delete s.findings[k][ik]; if (!Object.keys(s.findings[k]).length) delete s.findings[k]; changed(); }))));
        zoneHost.append(el('details', { class: 'fm-zone' }, el('summary', {}, el('span', {}, el('b', {}, side), ' ' + name + ' ', el('span', { class: 'fm-k' }, k)), sum), body));
      }
      wrap.append(el('section', { class: 'fm-group' }, el('div', { class: 'fm-ghead' }, el('h3', {}, 'Findings by zone'), zoneCount), zoneHost,
        el('p', { class: 'fm-note' }, 'Postero-lateral = PLAPS point. Tap a zone to fill it in; leave a cell blank if not assessed.')));
      wrap.append(el('section', { class: 'fm-card-box' }, el('b', {}, 'Suitable site for pleural procedure identified?'), seg(SITE, () => s.procSite, (v) => { s.procSite = v; save(); }, 'wide')));
      // report
      const area = (key, label, ph) => { const t = el('textarea', { rows: '3', placeholder: ph }); t.value = s[key] || ''; t.addEventListener('input', () => { s[key] = t.value; save(); }); return el('label', { class: 'pf-field' }, label, t); };
      const toggle = (key, label) => { const c = el('input', { type: 'checkbox', checked: s[key] ? true : null }); c.addEventListener('change', () => { s[key] = c.checked; save(); }); return el('label', { class: 'fm-toggle' }, c, el('span', {}, label)); };
      wrap.append(el('section', { class: 'fm-group' }, el('div', { class: 'fm-ghead' }, el('h3', {}, 'Report')),
        area('comment', 'Comment, further details and conclusion of scan', 'e.g. effusion type/size, shred sign, dynamic air/fluid bronchograms, overall conclusion'),
        area('reflection', 'Candidate reflection (optional)', 'e.g. how the scan affected management'),
        area('questions', 'Questions for supervisor', 'Not on the official sheet — for the conversation'),
        area('mentor', 'Mentor / supervisor comments', 'Fill in after you’ve talked it through'),
        el('div', { class: 'shift-two' },
          el('div', { class: 'pf-field' }, 'Departmental scan required?', seg([['yes', 'Yes'], ['no', 'No']], () => s.deptRequired, (v) => { s.deptRequired = v; save(); })),
          el('div', { class: 'pf-field' }, 'Requested?', seg([['yes', 'Yes'], ['no', 'No']], () => s.deptRequested, (v) => { s.deptRequested = v; save(); }))),
        toggle('discussed', 'Discussed with supervisor'), toggle('signed', 'Sheet countersigned and in logbook')));
      // Venue Go checklist
      const wfCount = el('span', { class: 'fm-count' });
      const groupCounts = {};
      const fold = el('details', { class: 'fm-fold' }, el('summary', {}, el('span', {}, 'Venue Go workflow checklist'), wfCount));
      const inner = el('div', { class: 'fm-fold-inner' });
      for (const g of Object.keys(CHECKS)) {
        const c = el('span', { class: 'fm-count' }); groupCounts[g] = c;
        inner.append(el('div', { class: 'fm-ghead' }, el('h4', {}, GROUP_TITLES[g]), c));
        for (const [k, t, d] of CHECKS[g]) {
          const cb = el('input', { type: 'checkbox', checked: (s.checks || {})[k] ? true : null });
          cb.addEventListener('change', () => { s.checks = Object.assign({}, s.checks, { [k]: cb.checked }); if (!cb.checked) delete s.checks[k]; changed(); });
          inner.append(el('label', { class: 'fm-check' }, cb, el('div', {}, el('span', { class: 't' }, t), d ? el('span', { class: 'd' }, d) : null)));
        }
      }
      const probe = el('input', { type: 'text', value: s.probe || '', placeholder: 'Curvilinear C1-5', autocomplete: 'off' }); probe.addEventListener('input', () => { s.probe = probe.value.trim(); save(); });
      const clip = el('input', { type: 'text', value: s.clip || '', placeholder: '6 s prospective', autocomplete: 'off' }); clip.addEventListener('input', () => { s.clip = clip.value.trim(); save(); });
      inner.append(el('div', { class: 'shift-two' }, el('label', { class: 'pf-field' }, 'Probe', probe), el('label', { class: 'pf-field' }, 'Clip setting', clip)));
      fold.append(inner); wrap.append(fold);
      // export
      wrap.append(el('section', { class: 'fm-card-box' }, el('div', {}, el('b', {}, 'Reporting sheet'), el('div', { class: 'sub' }, 'A4 PDF in the FAMUS v1.9 layout, signature lines left blank for ink.')),
        el('div', { class: 'toolrow' },
          el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            try {
              await saveNow();
              const bytes = await buildPdf(s, data.candidate);
              const name = 'FAMUS-thoracic-' + (s.examId || s.date || 'scan').replace(/[^\w.-]+/g, '_') + '.pdf';
              const blob = new Blob([bytes], { type: 'application/pdf' });
              const file = typeof File === 'function' ? new File([blob], name, { type: 'application/pdf' }) : null;
              if (file && navigator.canShare && /iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); } catch (err) { if (err && err.name !== 'AbortError') throw err; } }
              else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); ui.toast('PDF saved'); }
            } catch (err) { console.warn(err); ui.toast('Couldn’t make the PDF'); }
            e.target.disabled = false;
          } }, 'Save PDF'),
          el('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard.writeText(asText(s, data.candidate)).then(() => ui.toast('Copied'), () => ui.toast('Could not copy')) }, 'Copy as text'))));
      let armed = false;
      const del = el('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!armed) { armed = true; del.textContent = 'Tap again to delete'; setTimeout(() => { armed = false; del.textContent = 'Delete this scan'; }, 3000); return; }
        data.scans.splice(data.scans.indexOf(s), 1); await saveNow(); ui.toast('Scan deleted'); list();
      } }, 'Delete this scan');
      wrap.append(el('div', { class: 'fm-foot' }, del, el('button', { class: 'btn primary', type: 'button', onclick: async () => { await saveNow(); ui.toast('Saved'); list(); } }, 'Done')));
      function refresh() {
        zoneCount.textContent = zonesDone(s) + '/6';
        wfCount.textContent = checksDone(s) + '/' + CHECK_LIST.length;
        for (const g of Object.keys(CHECKS)) groupCounts[g].textContent = CHECKS[g].filter(([k]) => (s.checks || {})[k]).length + '/' + CHECKS[g].length;
        for (const [k] of ZONES) {
          const z = (s.findings || {})[k] || {}, bits = [];
          if (z.sliding === 'no') bits.push('no sliding'); if (z.blines === 'yes') bits.push('B-lines'); if (z.effusion === 'yes') bits.push('effusion'); if (z.consol === 'yes') bits.push('consolidation');
          if (!bits.length && z.sliding === 'yes' && z.alines === 'yes') bits.push('normal');
          sums.get(k).textContent = (bits.join(', ') || (Object.values(z).some(Boolean) ? 'partly filled' : '')) + ((s.stored || {})[k] ? ' · clip' : '');
        }
      }
      refresh();
      window.scrollTo(0, 0);
    }
    list();
  }

  window.NCFamus = { render, parse, serialise, NB, TITLE };
})();

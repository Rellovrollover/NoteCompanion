// OneNote import through Microsoft Graph: notebooks -> section groups/sections -> pages.
// Page HTML is fetched, images and attachments are downloaded into the asset store,
// absolute-positioned OneNote blocks are flattened into flow, and ink shows as images.
(function () {
  const { notebooks, sections, pages, assets, meta } = window.NCDB;
  const G = window.NCGraph;
  const S = window.NCSync;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // OneNote's API throttles per user; pace requests rather than hammer it.
  const PACE = 500;
  // Graph's OneNote endpoints throttle hard. Within an import we wait as long as it takes rather than failing.
  const PATIENT = { maxAttempts: 40 };
  let cancelled = false;
  function cancel() { cancelled = true; }

  async function listNotebooks() {
    const r = await G.json('/me/onenote/notebooks?$select=id,displayName,lastModifiedDateTime&$orderby=displayName', { maxAttempts: 2 });
    return r.value || [];
  }
  async function pageAll(url) {
    const out = [];
    while (url) { const r = await G.json(url, PATIENT); out.push(...(r.value || [])); url = r['@odata.nextLink'] || null; }
    return out;
  }
  // Returns a flat list of { name, pages: [...] } sections, with section-group names folded into the section name.
  async function sectionsOf(notebookId) {
    const out = [];
    const secs = await pageAll('/me/onenote/notebooks/' + notebookId + '/sections?$select=id,displayName,parentSectionGroup&$expand=parentSectionGroup($select=id,displayName)');
    const groups = await pageAll('/me/onenote/notebooks/' + notebookId + '/sectionGroups?$select=id,displayName,parentSectionGroup&$expand=parentSectionGroup($select=id,displayName)');
    const gName = new Map(groups.map((g) => [g.id, g]));
    const pathOf = (g) => { const parts = []; let cur = g; let guard = 0; while (cur && guard++ < 10) { parts.unshift(cur.displayName); cur = cur.parentSectionGroup && gName.get(cur.parentSectionGroup.id); } return parts.join(' / '); };
    for (const s of secs) out.push({ id: s.id, name: s.displayName, group: s.parentSectionGroup ? pathOf(gName.get(s.parentSectionGroup.id) || s.parentSectionGroup) : '' });
    // Sections nested inside section groups are not returned by the notebook-level call; fetch per group.
    for (const g of groups) {
      const gs = await pageAll('/me/onenote/sectionGroups/' + g.id + '/sections?$select=id,displayName');
      for (const s of gs) if (!out.some((x) => x.id === s.id)) out.push({ id: s.id, name: s.displayName, group: pathOf(g) });
    }
    return out;
  }
  async function pagesOf(sectionId) {
    return pageAll('/me/onenote/sections/' + sectionId + '/pages?$select=id,title,createdDateTime,lastModifiedDateTime,order&$orderby=order&$top=100');
  }

  async function fetchResource(url) {
    const res = await G.call(url, PATIENT);
    if (!res.ok) throw new Error('resource ' + res.status);
    return res.blob();
  }

  // Convert a OneNote page's HTML into NoteCompanion HTML, pulling resources into assets.
  async function convertPage(html, title) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    // Drop the duplicated title element OneNote puts at the top.
    const t = body.querySelector('title'); if (t) t.remove();
    // Fetch every image and attachment before writing anything, so a throttled request fails the page
    // cleanly (it is retried on the next run) instead of leaving a page with holes in it.
    const imgs = [...body.querySelectorAll('img')].map((img) => ({ img, src: img.getAttribute('data-fullres-src') || img.getAttribute('src') }));
    const objs = [...body.querySelectorAll('object')].map((obj) => ({ obj, src: obj.getAttribute('data'), name: obj.getAttribute('data-attachment') || 'attachment' }));
    for (const it of [...imgs, ...objs]) {
      if (!it.src) continue;
      if (cancelled) throw new Error('cancelled');
      await pause(PACE);
      it.blob = await fetchResource(it.src);
    }
    for (const { img, src, blob } of imgs) {
      if (!src) { img.remove(); continue; }
      const name = (img.getAttribute('alt') || 'image').replace(/[^\w.-]+/g, '_').slice(0, 60) + (blob.type.includes('png') ? '.png' : blob.type.includes('gif') ? '.gif' : '.jpg');
      const a = await assets.create(blob, name);
      img.setAttribute('src', 'asset/' + a.id);
      for (const attr of ['data-fullres-src', 'data-fullres-src-type', 'data-src-type', 'data-id', 'width', 'height', 'style']) img.removeAttribute(attr);
    }
    for (const { obj, src, name, blob } of objs) {
      if (!src) { obj.remove(); continue; }
      const a = await assets.create(blob, name);
      const link = doc.createElement('p'); const aEl = doc.createElement('a'); aEl.href = 'asset/' + a.id; aEl.textContent = '📎 ' + name; link.append(aEl); obj.replaceWith(link);
    }
    // Flatten absolute positioning; keep order by top coordinate so columns read sensibly.
    const abs = [...body.querySelectorAll('[style*="position:absolute"], [style*="position: absolute"]')];
    const topOf = (el) => { const m = /top:\s*(-?[\d.]+)px/.exec(el.getAttribute('style') || ''); return m ? +m[1] : 0; };
    abs.sort((a, b) => topOf(a) - topOf(b));
    for (const el of abs) { el.removeAttribute('style'); body.append(el); }
    // Strip OneNote-specific attributes and inline positioning everywhere; keep basic styling.
    for (const el of body.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('data-') || attr.name === 'id' || attr.name === 'lang') el.removeAttribute(attr.name);
        else if (attr.name === 'style') {
          const keep = attr.value.split(';').map((x) => x.trim()).filter((x) => /^(font-weight|font-style|text-decoration|color|background-color|background)\s*:/i.test(x));
          if (keep.length) el.setAttribute('style', keep.join('; ')); else el.removeAttribute('style');
        }
      }
      if (el.tagName === 'SPAN' && !el.attributes.length) { el.replaceWith(...el.childNodes); }
    }
    // Tags (to-do) come through as data-tag which we just stripped; OneNote marks them with ☐/☑ in text sometimes. Leave as is.
    return body.innerHTML.trim();
  }

  async function importNotebook(nb, onProgress) {
    const log = (m) => onProgress && onProgress(m);
    const existingNb = (await notebooks.all()).find((n) => n.onenoteId === nb.id) || (await notebooks.archived()).find((n) => n.onenoteId === nb.id);
    const target = existingNb || await notebooks.create(nb.displayName);
    if (!existingNb) await notebooks.update(target.id, { onenoteId: nb.id });
    cancelled = false;
    // Pages imported earlier with missing images/attachments (from throttled runs) are imported again and replaced.
    const incomplete = /\[(image|attachment) not imported/;
    const existingPages = (await window.NCDB.db.pages.toArray()).filter((q) => q.onenoteId && !q.deleted);
    const doneIds = new Set(existingPages.filter((q) => !incomplete.test(q.html || '')).map((q) => q.onenoteId));
    const redo = new Map(existingPages.filter((q) => incomplete.test(q.html || '')).map((q) => [q.onenoteId, q.id]));
    const secs = await sectionsOf(nb.id);
    // Count first so the progress bar means something.
    const plan = [];
    for (const sec of secs) { try { await pause(PACE); plan.push({ sec, pgs: await pagesOf(sec.id) }); } catch (e) { plan.push({ sec, pgs: [], failed: true }); } }
    const total = plan.reduce((n, x) => n + x.pgs.length, 0);
    let count = 0, skipped = 0, failed = 0, done = 0;
    log('0 / ' + total + ' pages', 0, total);
    for (const { sec, pgs, failed: secFailed } of plan) {
      if (secFailed) { failed++; continue; }
      const existingSecs = await sections.forNotebook(target.id);
      let tsec = existingSecs.find((x) => x.onenoteId === sec.id) || existingSecs.find((x) => x.name === sec.name && (x.group || '') === (sec.group || ''));
      if (!tsec) { tsec = await sections.create(target.id, sec.name); await sections.update(tsec.id, { onenoteId: sec.id, group: sec.group || '' }); }
      for (const pg of pgs) {
        if (cancelled) { log('Stopped at ' + done + ' / ' + total + ' — run again to continue', done, total); return { notebook: target, count, skipped, failed, sections: secs.length, stopped: true }; }
        done++;
        if (doneIds.has(pg.id)) { skipped++; log(done + ' / ' + total + ' · ' + sec.name, done, total); continue; }
        try {
          await pause(PACE);
          const res = await G.call('/me/onenote/pages/' + pg.id + '/content?includeIDs=false', PATIENT);
          if (!res.ok) throw new Error('content ' + res.status);
          const html = await convertPage(await res.text(), pg.title);
          if (redo.has(pg.id)) await pages.update(redo.get(pg.id), { html, sectionId: tsec.id });
          else await pages.create({ notebookId: target.id, sectionId: tsec.id, title: pg.title || 'Untitled', html, onenoteId: pg.id, created: Date.parse(pg.createdDateTime) || Date.now(), updated: Date.parse(pg.lastModifiedDateTime) || Date.now() });
          count++; log(done + ' / ' + total + ' · ' + sec.name + ' · ' + (pg.title || 'Untitled'), done, total);
        } catch (e) { if (cancelled) { done--; continue; } console.warn('page import failed', pg.title, e); failed++; log(done + ' / ' + total + ' · ' + sec.name, done, total); }
      }
    }
    S.schedule();
    return { notebook: target, count, skipped, failed, sections: secs.length };
  }

  // A file called "Group » Section" lands in a section group of that name.
  async function sectionNamed(notebookId, label) {
    const m = /^(.*?)\s*»\s*(.+)$/.exec(label);
    const group = m ? m[1].trim() : '', name = m ? m[2].trim() : label.trim();
    const existing = await sections.forNotebook(notebookId);
    let sec = existing.find((x) => x.name === name && (x.group || '') === group);
    if (!sec) { sec = await sections.create(notebookId, name); if (group) { await sections.update(sec.id, { group }); sec.group = group; } }
    return sec;
  }

  // ---- Offline route: OneNote's File → Export → Section → Word (.docx) ----
  // One .docx per section; pages are separated by page breaks, each starting with its title.
  async function importDocxSection(file, notebookId, sectionName, onProgress) {
    if (!window.mammoth) throw new Error('Word reader not loaded');
    const buf = await file.arrayBuffer();
    const r = await mammoth.convertToHtml({ arrayBuffer: buf }, {
      styleMap: ["br[type='page'] => hr.pb", "p[style-name='Title'] => h1.pt:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh", "p[style-name='Heading 3'] => h4:fresh"],
      convertImage: mammoth.images.imgElement(async (image) => {
        const b = await image.read(); const blob = new Blob([b], { type: image.contentType || 'image/png' });
        const a = await assets.create(blob, 'image.' + ((image.contentType || 'image/png').split('/')[1] || 'png'));
        return { src: 'asset/' + a.id };
      })
    });
    const chunks = r.value.split(/<hr class="pb"\s*\/?>/i).map((c) => c.trim()).filter((c) => c && c.replace(/<[^>]+>/g, '').trim());
    const sec = await sectionNamed(notebookId, sectionName);
    let n = 0;
    for (const chunk of chunks) {
      const doc = new DOMParser().parseFromString('<div>' + chunk + '</div>', 'text/html');
      const root = doc.body.firstChild;
      let title = '';
      const h = root.querySelector('h1.pt');
      if (h) { title = h.textContent.trim(); h.remove(); }
      else { const first = root.querySelector('h2, h3, p'); if (first && first.textContent.trim()) { title = first.textContent.trim().slice(0, 120); first.remove(); } }
      // OneNote puts the page's date and time on the next two lines; drop them when they look like it.
      for (let k = 0; k < 2; k++) { const f = root.firstElementChild; if (f && f.tagName === 'P' && /^(\d{1,2} \w+ \d{4}|\d{1,2}:\d{2})/.test(f.textContent.trim())) f.remove(); else break; }
      const html = root.innerHTML.trim();
      await pages.create({ notebookId, sectionId: sec.id, title: title || 'Untitled', html });
      n++; if (onProgress) onProgress(n, chunks.length);
    }
    S.schedule();
    return { section: sec, count: n };
  }

  // ---- Offline route 2: OneNote's File → Export → Notebook or Section → Single File Web Page (.mht) ----
  // One MIME archive: the page HTML (quoted-printable) plus every image (base64). A notebook export is
  // one long stream of pages with no section markers, so it lands in one section to be sorted afterwards.
  function parseMht(bytes) {
    const latin = new TextDecoder('latin1').decode(bytes);
    const bm = /boundary="?([^"\r\n]+)"?/i.exec(latin.slice(0, 2000));
    if (!bm) throw new Error('Not a .mht file');
    const parts = latin.split('--' + bm[1]).slice(1).filter((x) => !/^--\s*$/.test(x.trim()));
    const out = [];
    for (const part of parts) {
      const sep = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const i = part.indexOf(sep); if (i < 0) continue;
      const head = part.slice(0, i), body = part.slice(i + sep.length);
      const h = (name) => { const m = new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(head); return m ? m[1].trim() : ''; };
      out.push({ location: h('Content-Location'), type: h('Content-Type'), encoding: h('Content-Transfer-Encoding').toLowerCase(), body });
    }
    return out;
  }
  function decodeQP(text) {
    const bin = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function decodeB64(text) {
    const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
    const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  function parseOneNoteDate(dateText, timeText) {
    const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(dateText || ''); if (!m || !(m[2].toLowerCase() in MONTHS)) return null;
    const t = /(\d{1,2}):(\d{2})/.exec(timeText || '');
    return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1], t ? +t[1] : 12, t ? +t[2] : 0).getTime();
  }
  // Tidy one page's OneNote HTML: images → assets, positioned boxes → flow, bold/italic spans → real tags.
  async function cleanMhtPage(root, doc, imageFor) {
    for (const img of [...root.querySelectorAll('img')]) {
      const src = img.getAttribute('src') || '';
      const a = await imageFor(src);
      if (!a) { img.remove(); continue; }
      img.setAttribute('src', 'asset/' + a.id);
      for (const attr of ['width', 'height', 'style', 'border', 'alt']) img.removeAttribute(attr);
    }
    for (const el of [...root.querySelectorAll('*')]) {
      const style = el.getAttribute('style') || '';
      if (el.tagName === 'SPAN') {
        // Wrap in the real tag for each inline style, then drop the span.
        let node = doc.createDocumentFragment(); node.append(...el.childNodes);
        const wrap = (tag) => { const w = doc.createElement(tag); w.append(node); node = w; };
        if (/font-weight:\s*bold/i.test(style)) wrap('strong');
        if (/font-style:\s*italic/i.test(style)) wrap('em');
        if (/text-decoration:\s*underline/i.test(style)) wrap('u');
        if (/text-decoration:\s*line-through/i.test(style)) wrap('s');
        const keep = style.split(';').map((x) => x.trim()).filter((x) => /^(color|background(-color)?)\s*:/i.test(x) && !/:\s*(black|#000000|white|#ffffff|transparent)\s*$/i.test(x));
        if (keep.length) { const w = doc.createElement('span'); w.setAttribute('style', keep.join('; ')); w.append(node); node = w; }
        el.replaceWith(node);
        continue;
      }
      for (const attr of [...el.attributes]) if (!/^(style|href|src|colspan|rowspan|type|start)$/i.test(attr.name)) el.removeAttribute(attr.name);
      const keep = [];
      for (const d of style.split(';').map((x) => x.trim())) {
        const m = /^([\w-]+)\s*:\s*(.+)$/.exec(d); if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === 'color' && !/^(black|#000000)$/i.test(v)) keep.push('color: ' + v);
        else if ((k === 'background' || k === 'background-color') && !/^(white|#ffffff|transparent)$/i.test(v)) keep.push(k + ': ' + v);
        else if (k === 'font-weight' && /bold|[6-9]00/.test(v) && el.tagName === 'P') keep.push('font-weight: bold');
        else if (k === 'font-size' && el.tagName === 'P') { const pt = parseFloat(v); if (pt >= 14) keep.push('font-size: ' + pt + 'pt'); }
        else if (k === 'margin-left' && el.tagName === 'P') { const inch = /in$/.test(v) ? parseFloat(v) : parseFloat(v) / 72; if (inch >= 0.2) keep.push('margin-left: ' + Math.round(inch * 48) + 'px'); }
        else if (k === 'text-decoration' && /underline|line-through/.test(v) && el.tagName === 'P') keep.push('text-decoration: ' + v);
        else if (k === 'text-align' && el.tagName === 'P') keep.push('text-align: ' + v);
      }
      if (keep.length) el.setAttribute('style', keep.join('; ')); else el.removeAttribute('style');
      if (el.tagName === 'TABLE') el.setAttribute('border', '1');
    }
    // OneNote's layout boxes become flow; their contents keep their order.
    for (const div of [...root.querySelectorAll('div')].reverse()) div.replaceWith(...div.childNodes);
    // Empty spacer paragraphs between boxes add nothing on a page that already has a grid.
    for (const pEl of [...root.querySelectorAll('p')]) if (!pEl.textContent.replace(/ /g, '').trim() && !pEl.querySelector('img')) pEl.remove();
    return root.innerHTML.trim();
  }
  async function importMht(file, notebookId, sectionName, onProgress) {
    const parts = parseMht(new Uint8Array(await file.arrayBuffer()));
    const htmlPart = parts.find((x) => /text\/html/i.test(x.type));
    if (!htmlPart) throw new Error('No page content found in ' + file.name);
    const html = htmlPart.encoding === 'quoted-printable' ? decodeQP(htmlPart.body) : htmlPart.encoding === 'base64' ? new TextDecoder().decode(decodeB64(htmlPart.body)) : htmlPart.body;
    const imageParts = new Map(parts.filter((x) => /^image\//i.test(x.type)).map((x) => [x.location.split('/').pop().toLowerCase(), x]));
    const assetCache = new Map();
    const imageFor = async (src) => {
      const key = decodeURIComponent(src.split('/').pop()).toLowerCase();
      if (assetCache.has(key)) return assetCache.get(key);
      const part = imageParts.get(key); if (!part) return null;
      const blob = new Blob([decodeB64(part.body)], { type: part.type.split(';')[0].trim() });
      const a = await assets.create(blob, key); assetCache.set(key, a); return a;
    };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Each page is a top-level box: <div style='direction:ltr;border-width:100%'>.
    const pageDivs = [...doc.body.children].filter((el) => el.tagName === 'DIV');
    if (!pageDivs.length) throw new Error('No pages found in ' + file.name);
    const sec = await sectionNamed(notebookId, sectionName);
    const already = new Set((await window.NCDB.db.pages.toArray()).filter((q) => q.onenoteId && q.onenoteId.startsWith('mht:') && !q.deleted).map((q) => q.onenoteId));
    let n = 0, skipped = 0;
    for (const [idx, pd] of pageDivs.entries()) {
      // Title: the first 20pt paragraph. Date and time: the grey paragraphs that follow it.
      let title = '';
      const tp = [...pd.querySelectorAll('p')].find((pEl) => /font-size:\s*20(\.0)?pt/i.test(pEl.getAttribute('style') || ''));
      if (tp) { title = tp.textContent.replace(/\s+/g, ' ').trim(); tp.remove(); }
      let created = null;
      const grey = [...pd.querySelectorAll('p')].filter((pEl) => /#767676/i.test(pEl.getAttribute('style') || '')).slice(0, 2);
      if (grey.length) { created = parseOneNoteDate(grey[0].textContent, grey[1] ? grey[1].textContent : ''); grey.forEach((g) => g.remove()); }
      if (!title) { const first = [...pd.querySelectorAll('p')].find((pEl) => pEl.textContent.trim()); title = first ? first.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : 'Untitled'; }
      // Position is part of the key: two pages can share a title and a timestamp (a template and its copy).
      const key = 'mht:' + sectionName + ':' + idx + ':' + title + ':' + (created || '');
      if (already.has(key)) { skipped++; if (onProgress) onProgress(n + skipped, pageDivs.length); continue; }
      const body = await cleanMhtPage(pd, doc, imageFor);
      await pages.create({ notebookId, sectionId: sec.id, title, html: body, onenoteId: key, created: created || Date.now(), updated: created || Date.now() });
      already.add(key);
      n++; if (onProgress) onProgress(n + skipped, pageDivs.length);
    }
    S.schedule();
    return { section: sec, count: n, skipped };
  }

  // Minimal .zip reader (stored or deflated entries) so a folder of exports can be dropped in as one file.
  async function unzip(file) {
    const buf = await file.arrayBuffer(); const dv = new DataView(buf); const u8 = new Uint8Array(buf);
    // Find the end-of-central-directory record.
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + elen + clen;
      if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
      const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lelen;
      let data = u8.slice(start, start + csize);
      if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else if (method !== 0) continue;
      out.push(new File([data], name.split('/').pop()));
    }
    return out;
  }

  window.NCOneNote = { cancel, listNotebooks, importNotebook, importDocxSection, importMht, unzip };
})();

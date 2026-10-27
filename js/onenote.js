// OneNote import through Microsoft Graph: notebooks -> section groups/sections -> pages.
// Page HTML is fetched, images and attachments are downloaded into the asset store,
// absolute-positioned OneNote blocks are flattened into flow, and ink shows as images.
(function () {
  const { notebooks, sections, pages, assets, meta } = window.NCDB;
  const G = window.NCGraph;
  const S = window.NCSync;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // OneNote's API throttles per user; pace requests rather than hammer it.
  const PACE = 350;

  async function listNotebooks() {
    const r = await G.json('/me/onenote/notebooks?$select=id,displayName,lastModifiedDateTime&$orderby=displayName');
    return r.value || [];
  }
  async function pageAll(url) {
    const out = [];
    while (url) { const r = await G.json(url); out.push(...(r.value || [])); url = r['@odata.nextLink'] || null; }
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
    const res = await G.call(url);
    if (!res.ok) throw new Error('resource ' + res.status);
    return res.blob();
  }

  // Convert a OneNote page's HTML into NoteCompanion HTML, pulling resources into assets.
  async function convertPage(html, title) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    // Drop the duplicated title element OneNote puts at the top.
    const t = body.querySelector('title'); if (t) t.remove();
    // Images: data-fullres-src is the real image; src is a resource URL needing auth.
    for (const img of [...body.querySelectorAll('img')]) {
      const src = img.getAttribute('data-fullres-src') || img.getAttribute('src');
      if (!src) { img.remove(); continue; }
      try {
        await pause(PACE);
        const blob = await fetchResource(src);
        const name = (img.getAttribute('alt') || 'image').replace(/[^\w.-]+/g, '_').slice(0, 60) + (blob.type.includes('png') ? '.png' : blob.type.includes('gif') ? '.gif' : '.jpg');
        const a = await assets.create(blob, name);
        img.setAttribute('src', 'asset/' + a.id);
        for (const attr of ['data-fullres-src', 'data-fullres-src-type', 'data-src-type', 'data-id', 'width', 'height', 'style']) img.removeAttribute(attr);
      } catch (e) { img.replaceWith(doc.createTextNode('[image not imported]')); }
    }
    // Attached files.
    for (const obj of [...body.querySelectorAll('object')]) {
      const src = obj.getAttribute('data'); const name = obj.getAttribute('data-attachment') || 'attachment';
      try {
        await pause(PACE);
        const blob = await fetchResource(src);
        const a = await assets.create(blob, name);
        const link = doc.createElement('p'); const aEl = doc.createElement('a'); aEl.href = 'asset/' + a.id; aEl.textContent = '📎 ' + name; link.append(aEl); obj.replaceWith(link);
      } catch (e) { obj.replaceWith(doc.createTextNode('[attachment not imported: ' + name + ']')); }
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
    const doneIds = new Set((await window.NCDB.db.pages.toArray()).filter((q) => q.onenoteId).map((q) => q.onenoteId));
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
        done++;
        if (doneIds.has(pg.id)) { skipped++; log(done + ' / ' + total + ' · ' + sec.name, done, total); continue; }
        try {
          await pause(PACE);
          const res = await G.call('/me/onenote/pages/' + pg.id + '/content?includeIDs=false');
          if (!res.ok) throw new Error('content ' + res.status);
          const html = await convertPage(await res.text(), pg.title);
          await pages.create({ notebookId: target.id, sectionId: tsec.id, title: pg.title || 'Untitled', html, onenoteId: pg.id, created: Date.parse(pg.createdDateTime) || Date.now(), props: [{ k: 'Imported from', v: 'OneNote' }] });
          count++; log(done + ' / ' + total + ' · ' + sec.name + ' · ' + (pg.title || 'Untitled'), done, total);
        } catch (e) { console.warn('page import failed', pg.title, e); failed++; log(done + ' / ' + total + ' · ' + sec.name, done, total); }
      }
    }
    S.schedule();
    return { notebook: target, count, skipped, failed, sections: secs.length };
  }

  window.NCOneNote = { listNotebooks, importNotebook };
})();

// Sync engine: OneDrive folder <-> local IndexedDB. Last write wins by `updated`;
// a losing local edit is kept as a conflict copy rather than lost.
(function () {
  const { db, meta, deviceName, notebooks, sections, pages, assets } = window.NCDB;
  const G = window.NCGraph;
  const C = window.NC_CONFIG;
  const KINDS = [['notebooks', db.notebooks], ['sections', db.sections], ['pages', db.pages], ['versions', db.versions]];
  const listeners = new Set();
  let running = false, queued = false, timer = null;
  const status = { state: 'idle', message: '', lastSync: null, pending: 0, error: null };

  function emit() { listeners.forEach((fn) => fn(Object.assign({}, status))); }
  async function setState(state, message, error) {
    status.state = state; status.message = message || ''; status.error = error || null;
    status.pending = await window.NCDB.pendingCount();
    emit();
  }

  const strip = (rec) => { const r = Object.assign({}, rec); delete r.dirty; delete r.etag; delete r.blob; delete r.downloaded; return r; };

  // A record's JSON: straight from the pre-authorised download link the delta handed us when it did
  // (no Graph round-trip, no throttling), otherwise through Graph.
  async function fetchRecord(sub, item) {
    const direct = item['@microsoft.graph.downloadUrl'];
    if (direct) { try { const r = await fetch(direct); if (r.ok) return await r.json(); } catch (e) { /* fall through */ } }
    const res = await G.download(sub, item.name);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) {
      // Say what came back, so a bad file can be recognised rather than guessed at.
      throw new Error('Not JSON (' + (res.headers.get('content-type') || 'no type') + ', ' + text.length + ' chars, ' + (direct ? 'via link' : 'via graph') + '): ' + JSON.stringify(text.slice(0, 90)));
    }
  }
  // Run fn over items with up to `limit` in flight at once.
  async function pool(items, limit, fn) {
    let i = 0; const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) workers.push((async () => { while (i < items.length) await fn(items[i++]); })());
    await Promise.all(workers);
  }

  async function pullJSON(sub, item, table, local) {
    const rec = await fetchRecord(sub, item);
    if (!rec || !rec.id) return;
    if (!local) {
      await table.put(Object.assign(rec, { etag: item.eTag, dirty: 0 }));
      return;
    }
    if (local.dirty) {
      if ((rec.updated || 0) > (local.updated || 0)) {
        // Remote wins; keep the local version as a conflict copy (pages only).
        if (sub === 'pages' && !local.deleted && local.md !== rec.md) {
          const dev = await deviceName();
          await pages.create(Object.assign({}, strip(local), {
            id: window.NCDB.uuid(), title: (local.title || 'Untitled') + ' (conflict copy, ' + dev + ')', created: Date.now()
          }));
        }
        await table.put(Object.assign(rec, { etag: item.eTag, dirty: 0 }));
      } else {
        // Local is newer: take the remote etag so the push below overwrites it.
        await table.update(local.id, { etag: item.eTag });
      }
      return;
    }
    await table.put(Object.assign(rec, { etag: item.eTag, dirty: 0 }));
  }

  const TABLE = { notebooks: db.notebooks, sections: db.sections, pages: db.pages, versions: db.versions };

  // ---- Pull: one delta call tells us every file that changed since last time ----
  const DELTA_SELECT = 'id,name,eTag,size,file,folder,deleted,parentReference,lastModifiedDateTime';
  // Ask for each file's download link too, so records can be fetched without a Graph call each; if this
  // tenant's Graph rejects that in a delta $select, remember and ask without.
  const deltaUrl = (noLinks) => '/me/drive/root:/' + encodeURIComponent(C.driveFolder) + ':/delta?$select=' + DELTA_SELECT + (noLinks ? '' : ',@microsoft.graph.downloadUrl') + '&$top=500';
  // Resumable: each delta page is applied (records downloaded) before its continuation link is saved, so a sync
  // that dies halfway — the phone locking, a lost signal, a rate-limit storm — carries on from that page next time
  // instead of listing the whole folder again.
  async function pullChanges(progress, opts = {}) {
    let url = await meta.get('deltaLink', null);
    let first = !url, fromPack = false;
    // A fresh device starts from the snapshot pack (one download) and then asks only for what changed since.
    if (!url && !opts.noPack) { const dl = await applyPack(progress); if (dl) { url = dl; fromPack = true; first = false; } }
    if (!url) url = deltaUrl(await meta.get('deltaNoLinks', false));
    const totals = { seen: 0, failed: 0, why: '' };
    while (url) {
      let page;
      try { page = await G.json(url); }
      catch (e) {
        if (e.status === 410 || e.status === 404) { await meta.set('deltaLink', null); if (!first) return pullChanges(progress, { noPack: fromPack }); }
        if (e.status === 400 && first && !totals.seen && !(await meta.get('deltaNoLinks', false))) { await meta.set('deltaNoLinks', true); return pullChanges(progress, opts); }
        throw e;
      }
      const changed = { notebooks: [], sections: [], pages: [], versions: [], assets: [], inbox: [] };
      for (const it of page.value || []) {
        totals.seen++;
        if (it.deleted && it.name) {
          // A file removed on OneDrive (by a purge on another device): drop our own tombstone for it, never a live record.
          const parent = (it.parentReference && it.parentReference.path) || ''; const sub = decodeURIComponent(parent.split('/').pop() || '');
          const kind = KINDS.find(([k]) => k === sub); const id = it.name.replace(/\.json$/, '').split('__')[0];
          if (kind) { const loc = await kind[1].get(id); if (loc && loc.deleted) await kind[1].delete(id); }
          else if (sub === 'assets') { const loc = await db.assets.get(id); if (loc && loc.deleted) await db.assets.delete(id); }
          continue;
        }
        if (!it.file || it.deleted) continue;
        const parent = (it.parentReference && it.parentReference.path) || '';
        const sub = decodeURIComponent(parent.split('/').pop() || '');
        if (changed[sub]) changed[sub].push(it);
      }
      if (progress) progress('Checking OneDrive… ' + totals.seen + ' items');
      await applyChanges(changed, progress, totals);
      url = page['@odata.nextLink'] || null;
      const keep = page['@odata.deltaLink'] || url;
      if (keep) await meta.set('deltaLink', keep);
    }
    return totals;
  }

  // ---- Snapshot pack: every live record in one compressed file, plus the change-position it was taken at ----
  const PACK_SUB = 'snapshot', PACK_GZ = 'pack.json.gz', PACK_JSON = 'pack.json', PACK_MIN_GAP = 20 * 60 * 1000;
  const PHONE = /iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const packRec = (r) => { const o = Object.assign({}, r); delete o.dirty; delete o.blob; return o; };
  async function latestChange() {
    let t = 0;
    for (const [, table] of KINDS) { const r = await table.orderBy('updated').last(); if (r && r.updated > t) t = r.updated; }
    const a = await db.assets.orderBy('updated').last(); if (a && a.updated > t) t = a.updated;
    return t;
  }
  async function buildPack(progress) {
    const deltaLink = await meta.get('deltaLink', null);
    if (!deltaLink || !/delta/.test(deltaLink) || /token=latest/.test(deltaLink) || !deltaLink.includes('token=')) return false;
    const pending = await window.NCDB.pendingCount(); if (pending) return false;
    const built = await meta.get('packBuilt', 0);
    if (Date.now() - built < PACK_MIN_GAP) return false;
    const changedAt = await latestChange();
    if (changedAt <= built) return false;
    if (progress) progress('Writing snapshot for other devices…');
    const pack = { v: 1, built: Date.now(), deltaLink, notebooks: [], sections: [], pages: [], versions: [], assets: [] };
    for (const [sub, table] of KINDS) {
      const live = await table.where('deleted').equals(0).toArray();
      if (sub === 'versions') {
        // History is the bulk of the record count; a fresh device gets the newest few per page.
        const byPage = new Map();
        for (const v of live) { if (!byPage.has(v.pageId)) byPage.set(v.pageId, []); byPage.get(v.pageId).push(v); }
        for (const list of byPage.values()) { list.sort((a, b) => (b.updated || 0) - (a.updated || 0)); for (const v of list.slice(0, 5)) pack.versions.push(packRec(v)); }
      } else pack[sub] = live.map(packRec);
    }
    for (const a of await db.assets.where('deleted').equals(0).toArray()) pack.assets.push(Object.assign(packRec(a), { downloaded: 0 }));
    const json = JSON.stringify(pack);
    let blob = new Blob([json], { type: 'application/json' }), name = PACK_JSON, mime = 'application/json';
    if (typeof CompressionStream === 'function') {
      try { blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob(); name = PACK_GZ; mime = 'application/gzip'; } catch (e) { blob = new Blob([json], { type: 'application/json' }); }
    }
    await G.upload(PACK_SUB, name, blob, mime);
    if (name === PACK_GZ) { try { await G.remove(PACK_SUB, PACK_JSON); } catch (e) { /* none */ } }
    await meta.set('packBuilt', pack.built);
    return true;
  }
  async function applyPack(progress) {
    let pack = null;
    try {
      if (progress) progress('Fetching snapshot…');
      let res = null, gz = true;
      try { res = await G.download(PACK_SUB, PACK_GZ); } catch (e) { if (e.status !== 404) throw e; }
      if (!res) { gz = false; try { res = await G.download(PACK_SUB, PACK_JSON); } catch (e) { if (e.status !== 404) throw e; } }
      if (!res) return null;
      let text;
      if (gz) { if (typeof DecompressionStream !== 'function') return null; text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text(); }
      else text = await res.text();
      pack = JSON.parse(text);
    } catch (e) { console.warn('snapshot unusable', e); return null; }
    if (!pack || pack.v !== 1 || !pack.deltaLink) return null;
    const total = pack.notebooks.length + pack.sections.length + pack.pages.length + pack.versions.length + pack.assets.length;
    let n = 0;
    for (const [sub, table] of KINDS) {
      const list = pack[sub] || [];
      for (let i = 0; i < list.length; i += 200) {
        const slice = list.slice(i, i + 200);
        const keep = [];
        for (const r of slice) { const loc = await table.get(r.id); if (loc && (loc.dirty || (loc.updated || 0) > (r.updated || 0))) continue; keep.push(Object.assign(r, { dirty: 0 })); }
        if (keep.length) await table.bulkPut(keep);
        n += slice.length;
        if (progress) progress('Loading snapshot… ' + n + '/' + total);
      }
    }
    for (const a of pack.assets) { const loc = await db.assets.get(a.id); if (loc) continue; await db.assets.put(Object.assign(a, { blob: null, dirty: 0, downloaded: 0 })); }
    if (progress) progress('Snapshot loaded (' + pack.pages.length + ' pages, taken ' + new Date(pack.built).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '); checking for changes since…');
    await meta.set('deltaLink', pack.deltaLink);
    return pack.deltaLink;
  }

  async function applyChanges(changed, progress, totals) {
    for (const sub of ['notebooks', 'sections', 'pages', 'versions']) {
      const table = TABLE[sub];
      // Only what we don't already have at this etag; a few in flight at once, progress on every one.
      const todo = [];
      let empty = 0;
      for (const item of changed[sub]) {
        const loc = await table.get(item.name.replace(/\.json$/, ''));
        // A zero-byte file (a batched upload Graph never wrote) is not worth a request; a device holding the real
        // record re-uploads it, and the new etag brings it down next time.
        if (item.size === 0) { empty++; if (loc && !loc.deleted && !loc.dirty) await table.update(loc.id, { dirty: 1 }); continue; }
        if (!(loc && loc.etag === item.eTag)) todo.push([item, loc]);
      }
      if (empty) { totals.empty = (totals.empty || 0) + empty; }
      if (!todo.length) continue;
      let done = 0, failed = 0, why = ''; const total = todo.length;
      if (progress) progress('Downloading ' + sub + '… 0/' + total);
      await pool(todo, 4, async ([item, loc]) => {
        try { await pullJSON(sub, item, table, loc); } catch (e) { failed++; if (!why) why = ((e && e.name) || 'Error') + ': ' + ((e && e.message) || String(e)) + ' @ ' + String((e && e.stack) || '').split('\n').filter((l) => /\.js:\d+/.test(l)).slice(0, 3).map((l) => l.replace(/https?:\/\/[^ ]*\//, '').trim()).join(' < '); console.warn('pull failed', sub, item.name, e); }
        done++;
        if (progress) progress('Downloading ' + sub + '… ' + done + '/' + total + (failed ? ' (' + failed + ' failed: ' + why.slice(0, 260) + ')' : ''));
      });
      if (failed) { totals.failed += failed; totals.why = totals.why || why; }
    }
    // Files (images, PDFs) after the records, with progress — a page of the listing can be mostly these.
    if (changed.assets.length) {
      let n = 0; const total = changed.assets.length;
      if (progress) progress('Downloading files… 0/' + total);
      await pool(changed.assets, 4, async (item) => { await pullAsset(item); n++; if (progress) progress('Downloading files… ' + n + '/' + total); });
    }
    for (const item of changed.inbox) await importDrop(item);
  }

  // Phones fetch small files during sync and the rest when a page that needs them is opened.
  const autoLimit = () => (PHONE ? 1.5 * 1024 * 1024 : C.autoDownloadLimit);
  async function pullAsset(item) {
    const id = item.name.split('__')[0];
    const loc = await db.assets.get(id);
    if (loc && loc.deleted) return;
    if (loc && loc.etag === item.eTag && (loc.downloaded || item.size > autoLimit())) return;
    const name = item.name.split('__').slice(1).join('__') || 'file';
    const mime = (item.file && item.file.mimeType) || 'application/octet-stream';
    const when = Date.parse(item.lastModifiedDateTime) || Date.now();
    if (item.size > autoLimit()) {
      await db.assets.put({ id, name, mime, size: item.size, blob: (loc && loc.blob) || null, created: (loc && loc.created) || when, updated: when, deleted: 0, dirty: 0, etag: item.eTag, downloaded: loc && loc.blob ? 1 : 0 });
      return;
    }
    if (loc && loc.dirty && loc.blob) { await db.assets.update(id, { etag: item.eTag }); return; } // ours is newer and will be pushed
    try {
      let res = null;
      if (item['@microsoft.graph.downloadUrl']) { try { res = await fetch(item['@microsoft.graph.downloadUrl']); if (!res.ok) res = null; } catch (e) { res = null; } }
      if (!res) res = await G.download('assets', item.name);
      const blob = await res.blob();
      await db.assets.put({ id, name, mime: blob.type || mime, size: blob.size, blob, created: (loc && loc.created) || when, updated: when, deleted: 0, dirty: 0, etag: item.eTag, downloaded: 1 });
    } catch (e) { console.warn('asset pull failed', id, e); }
  }

  // ---- Push: only records flagged dirty ----
  // One PUT per record, a few in flight at once. (Batched PUTs were tried: Graph stored some of those bodies
  // in a form Safari could not parse, so records go up one file at a time, exactly as written.)
  async function pushKind(sub, table, progress) {
    const dirty = (await table.where('dirty').equals(1).toArray()).filter((rec) => { if (rec.deleted && !rec.etag) { table.update(rec.id, { dirty: 0 }); return false; } return true; });
    if (!dirty.length) return;
    let done = 0; const total = dirty.length;
    const report = () => { if (progress && total > 3) progress('Uploading ' + sub + '… ' + done + '/' + total); };
    report();
    let firstErr = null;
    await pool(dirty, 4, async (rec) => {
      if (firstErr) return;
      try {
        const body = JSON.stringify(strip(rec));
        const item = await G.upload(sub, rec.id + '.json', body, 'application/json');
        await table.update(rec.id, { etag: item ? item.eTag : null, dirty: 0 }); done++; report();
      } catch (e) { console.warn('push failed', sub, rec.id, e); firstErr = e; }
    });
    if (firstErr) throw firstErr;
  }
  // One-off: find zero-byte record files on OneDrive and re-upload them from this device where it holds the record.
  async function repairEmpty(progress) {
    if ((await meta.get('repairEmpty', '')) === 'v1') return 0;
    let n = 0;
    for (const [sub, table] of KINDS) {
      if (progress) progress('Checking OneDrive for empty ' + sub + '…');
      const items = await G.list(sub);
      for (const it of items) {
        if (it.size !== 0) continue;
        const loc = await table.get(it.name.replace(/\.json$/, ''));
        if (loc && !loc.deleted && !loc.dirty) { await table.update(loc.id, { dirty: 1 }); n++; }
      }
    }
    await meta.set('repairEmpty', 'v1');
    status.pending = await window.NCDB.pendingCount(); emit();
    return n;
  }
  // Mark every live record on this device for upload again, overwriting the copies on OneDrive.
  async function reuploadAll() {
    let n = 0;
    for (const [, table] of KINDS) n += await table.where('deleted').equals(0).modify({ dirty: 1 });
    status.pending = await window.NCDB.pendingCount(); emit();
    return n;
  }
  async function pushAssets(progress) {
    const dirty = await db.assets.where('dirty').equals(1).toArray();
    let done = 0;
    for (const rec of dirty) {
      if (progress && dirty.length > 1) progress('Uploading files… ' + done + '/' + dirty.length); done++;
      try {
        if (rec.deleted) { if (rec.etag) { try { await G.remove('assets', assetName(rec)); } catch (e) { /* may already be gone */ } } await db.assets.update(rec.id, { dirty: 0 }); }
        else if (rec.blob) { const item = await G.upload('assets', assetName(rec), rec.blob, rec.mime); await db.assets.update(rec.id, { etag: item ? item.eTag : null, dirty: 0 }); }
        else await db.assets.update(rec.id, { dirty: 0 });
      } catch (e) { console.warn('asset push failed', rec.id, e); throw e; }
    }
  }

  const assetName = (a) => a.id + '__' + (a.name || 'file').replace(/[\\/:*?"<>|]/g, '_');

  // Anything dropped into NoteCompanion/inbox on OneDrive (e.g. by an iOS Shortcut) becomes a capture.
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function importDrop(it) {
    try {
      const res = await G.download('inbox', it.name);
      const mime = (it.file && it.file.mimeType) || '';
      const isText = /^text\//.test(mime) || /\.(txt|md|markdown)$/i.test(it.name) || mime === 'application/json';
      if (isText) {
        const text = (await res.text()).trim();
        if (text) await pages.create({ inbox: 1, kind: 'text', title: text.split('\n')[0].slice(0, 60), html: text.split(/\n{2,}/).map((para) => '<p>' + escapeHtml(para).replace(/\n/g, '<br>') + '</p>').join('') });
      } else {
        const blob = await res.blob();
        const a = await assets.create(new File([blob], it.name, { type: blob.type || mime || 'application/octet-stream' }), it.name);
        const isPdf = /pdf/.test(mime) || /\.pdf$/i.test(it.name);
        const isImg = /^image\//.test(mime) || /\.(jpe?g|png|heic|webp|gif)$/i.test(it.name);
        const p = await pages.create({ inbox: 1, kind: isPdf ? 'pdf' : isImg ? 'image' : 'file', title: it.name.replace(/\.\w+$/, ''), assetId: a.id, annots: isPdf ? {} : undefined,
          html: isPdf ? '' : isImg ? '<p><img src="asset/' + a.id + '" alt="' + escapeHtml(it.name) + '"></p>' : '<p><a href="asset/' + a.id + '">📎 ' + escapeHtml(it.name) + '</a></p>' });
        if (isPdf && window.NCPDF) window.NCPDF.enrich(p.id, a.id);
      }
      await G.remove('inbox', it.name);
    } catch (e) { console.warn('inbox drop failed', it.name, e); }
  }

  async function run() {
    if (running) { queued = true; return; }
    if (!navigator.onLine) { await setState('offline', 'Offline; changes are saved on this device'); return; }
    if (!G.state().signedIn) { await setState('signedout', 'Not signed in to OneDrive'); return; }
    running = true;
    try {
      await setState('syncing', 'Syncing with OneDrive');
      if ((await meta.get('foldersReady')) !== 'v4') {
        await G.ensureFolders(['notebooks', 'sections', 'pages', 'assets', 'versions', 'inbox', PACK_SUB]);
        await meta.set('foldersReady', 'v4');
      }
      // Push first so our edits are on OneDrive before we read the delta (which then echoes them back with matching etags).
      let base = 'Syncing with OneDrive', pulled = null;
      const prog = (m) => { base = m; status.message = m; emit(); };
      // While Microsoft rate-limits us, say so in the pill instead of looking stuck.
      const prevThrottle = G.onThrottle;
      G.onThrottle = (ms) => { status.message = base + ' — Microsoft is rate-limiting, waiting ' + Math.round(ms / 1000) + ' s'; emit(); if (prevThrottle) prevThrottle(ms); };
      try {
      try { const fixed = await repairEmpty(prog); if (fixed) prog('Re-uploading ' + fixed + ' records that were empty on OneDrive…'); } catch (e) { console.warn('repair check failed', e); }
      for (const [sub, table] of KINDS) await pushKind(sub, table, prog);
      await pushAssets(prog);
      pulled = await pullChanges(prog);
      } finally { G.onThrottle = prevThrottle; }
      try { const got = await pullMail(prog); if (got) { listeners.forEach((fn) => fn(Object.assign({ dropped: got }, status))); } } catch (e) { console.warn('mail pull failed', e); status.mailNote = e && e.status === 403 ? 'Mail access not granted yet' : ('Mail check failed: ' + (e.message || e)); }
      try { if (window.NCDrop) { status.message = 'Checking capture relay…'; emit(); const n = await window.NCDrop.pull(); if (n) { status.message = 'Captured ' + n + ' from the relay'; emit(); listeners.forEach((fn) => fn(Object.assign({ dropped: n }, status))); } } } catch (e) { console.warn('drop pull failed', e); }
      // Anything that arrived while pushing/pulling.
      for (const [sub, table] of KINDS) await pushKind(sub, table, prog);
      status.lastSync = Date.now();
      await meta.set('lastSync', status.lastSync);
      // Laptops/desktops refresh the snapshot other devices bootstrap from; phones don't spend their data on it.
      if (!PHONE && !(pulled && pulled.failed)) { try { await buildPack(prog); } catch (e) { console.warn('snapshot build failed', e); } }
      if (pulled && pulled.failed) await setState('error', pulled.failed + ' items could not be downloaded (' + pulled.why.slice(0, 300) + '); will retry', new Error(pulled.why));
      else if (pulled && pulled.empty) await setState('ok', 'Synced — ' + pulled.empty + ' records are empty on OneDrive; they arrive once another device re-uploads them');
      else await setState('ok', 'Synced');
    } catch (e) {
      console.warn('sync failed', e);
      const msg = e && e.status === 401 ? 'Sign-in expired; sign in again' : (e && e.message) || 'Sync failed';
      await setState('error', msg, e);
    } finally {
      running = false;
      if (queued) { queued = false; setTimeout(run, 1500); }
    }
  }

  // Remove every deleted record from OneDrive and this device. Other devices drop their copies on their next pull.
  async function purgeDeleted(progress) {
    if (!navigator.onLine) throw new Error('Offline');
    if (!G.state().signedIn) throw new Error('Not signed in');
    const enc = encodeURIComponent;
    let removed = 0;
    const livePages = new Set((await db.pages.where('deleted').equals(0).toArray()).map((p) => p.id));
    for (const [sub, table] of KINDS) {
      let gone = await table.where('deleted').equals(1).toArray();
      if (sub === 'versions') gone = gone.concat((await table.where('deleted').equals(0).toArray()).filter((v) => !livePages.has(v.pageId)));
      for (let i = 0; i < gone.length; i += 20) {
        const group = gone.slice(i, i + 20);
        if (progress) progress('Purging ' + sub + '… ' + Math.min(i + group.length, gone.length) + '/' + gone.length);
        const withFile = group.filter((r) => r.etag);
        if (withFile.length) {
          const res = await G.call('/$batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: withFile.map((r, k) => ({ id: String(k), method: 'DELETE', url: '/me/drive/root:/' + enc(C.driveFolder) + '/' + enc(sub) + '/' + enc(r.id + '.json') })) }) });
          if (!res.ok) throw new Error('Purge failed (' + res.status + ')');
        }
        for (const r of group) { await table.delete(r.id); removed++; }
      }
    }
    const goneAssets = await db.assets.where('deleted').equals(1).toArray();
    for (const [i, a] of goneAssets.entries()) {
      if (progress) progress('Purging files… ' + (i + 1) + '/' + goneAssets.length);
      if (a.etag) { try { await G.remove('assets', assetName(a)); } catch (e) { /* already gone */ } }
      await db.assets.delete(a.id); removed++;
    }
    status.pending = await window.NCDB.pendingCount(); emit();
    return removed;
  }

  // Fetch one file that sync skipped (too big for this device's auto-download). Returns true when it is now local.
  const fetching = new Map();
  async function fetchAsset(id) {
    const a = await db.assets.get(id);
    if (!a || a.deleted) return false;
    if (a.blob) return true;
    if (!navigator.onLine || !G.state().signedIn) return false;
    if (fetching.has(id)) return fetching.get(id);
    const job = (async () => {
      try {
        const res = await G.download('assets', assetName(a));
        const blob = await res.blob();
        await db.assets.update(id, { blob, size: blob.size, mime: blob.type || a.mime, downloaded: 1 });
        return true;
      } catch (e) { console.warn('asset fetch failed', id, e); return false; } finally { fetching.delete(id); }
    })();
    fetching.set(id, job);
    return job;
  }

  // ---- Email → to-do: unread messages in the Outlook folder "2nd Brain" become items on the to-do list ----
  const MAIL_FOLDER = '2nd Brain';
  async function pullMail(progress) {
    if (!(await meta.get('mailTodos', false))) return 0;
    if (!G.hasScope('Mail.ReadWrite')) return 0;
    let folderId = await meta.get('mailFolderId', '');
    if (!folderId) {
      const res = await G.json('/me/mailFolders?$top=200&$select=id,displayName');
      const f = (res.value || []).find((x) => (x.displayName || '').toLowerCase() === MAIL_FOLDER.toLowerCase());
      if (!f) { status.mailNote = 'No "' + MAIL_FOLDER + '" folder in your Outlook yet'; return 0; }
      folderId = f.id; await meta.set('mailFolderId', folderId);
    }
    let res;
    try { res = await G.json('/me/mailFolders/' + folderId + '/messages?$filter=isRead eq false&$top=50&$select=id,subject,from,webLink,receivedDateTime,bodyPreview'); }
    catch (e) { if (e.status === 404) { await meta.set('mailFolderId', ''); return 0; } throw e; }
    const msgs = res.value || [];
    if (!msgs.length) { status.mailNote = ''; return 0; }
    if (progress) progress('Adding ' + msgs.length + ' email' + (msgs.length === 1 ? '' : 's') + ' to the to-do list…');
    let n = 0;
    for (const m of msgs) {
      const who = m.from && m.from.emailAddress ? (m.from.emailAddress.name || m.from.emailAddress.address) : '';
      const text = (m.subject || '(no subject)').replace(/^(re|fw|fwd):\s*/i, '') + (who ? ' — ' + who : '');
      const ok = window.NCDrop && await window.NCDrop.addTodo(text, { link: m.webLink || '' });
      if (ok) { n++; try { await G.call('/me/messages/' + m.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isRead: true }) }); } catch (e) { console.warn('could not mark read', e); } }
    }
    status.mailNote = '';
    return n;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay == null ? 4000 : delay);
  }

  async function init() {
    status.lastSync = await meta.get('lastSync', null);
    status.pending = await window.NCDB.pendingCount();
    emit();
    addEventListener('online', () => schedule(500));
    addEventListener('offline', () => setState('offline', 'Offline; changes are saved on this device'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(800); });
    setInterval(() => { if (!document.hidden && navigator.onLine) run(); }, 5 * 60 * 1000);
  }

  async function resetDelta() { await meta.set('deltaLink', null); }
  window.NCSync = { init, run, schedule, resetDelta, purgeDeleted, fetchAsset, buildPack, reuploadAll, pullMail, onChange: (fn) => listeners.add(fn), status: () => Object.assign({}, status) };
})();

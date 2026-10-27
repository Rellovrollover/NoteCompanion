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
    return res.json();
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
  async function pullChanges(progress) {
    let url = await meta.get('deltaLink', null);
    const first = !url;
    if (!url) url = deltaUrl(await meta.get('deltaNoLinks', false));
    const totals = { seen: 0, failed: 0, why: '' };
    while (url) {
      let page;
      try { page = await G.json(url); }
      catch (e) {
        if (e.status === 410 || e.status === 404) { await meta.set('deltaLink', null); if (!first) return pullChanges(progress); }
        if (e.status === 400 && first && !totals.seen && !(await meta.get('deltaNoLinks', false))) { await meta.set('deltaNoLinks', true); return pullChanges(progress); }
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

  async function applyChanges(changed, progress, totals) {
    for (const sub of ['notebooks', 'sections', 'pages', 'versions']) {
      const table = TABLE[sub];
      // Only what we don't already have at this etag; a few in flight at once, progress on every one.
      const todo = [];
      for (const item of changed[sub]) { const loc = await table.get(item.name.replace(/\.json$/, '')); if (!(loc && loc.etag === item.eTag)) todo.push([item, loc]); }
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
    let n = 0;
    for (const item of changed.assets) { n++; if (progress) progress('Downloading files… ' + n + '/' + changed.assets.length + (item.size ? ' (' + (item.size > 1048576 ? (item.size / 1048576).toFixed(1) + ' MB' : Math.round(item.size / 1024) + ' KB') + ')' : '')); await pullAsset(item); }
    for (const item of changed.inbox) await importDrop(item);
  }

  async function pullAsset(item) {
    const id = item.name.split('__')[0];
    const loc = await db.assets.get(id);
    if (loc && loc.deleted) return;
    if (loc && loc.etag === item.eTag && (loc.downloaded || item.size > C.autoDownloadLimit)) return;
    const name = item.name.split('__').slice(1).join('__') || 'file';
    const mime = (item.file && item.file.mimeType) || 'application/octet-stream';
    const when = Date.parse(item.lastModifiedDateTime) || Date.now();
    if (item.size > C.autoDownloadLimit) {
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
  // Small JSON records go up twenty at a time through Graph's $batch; big ones one by one.
  const BATCH_MAX = 20, BATCH_BYTES = 3 * 1024 * 1024;
  async function pushKind(sub, table, progress) {
    const dirty = (await table.where('dirty').equals(1).toArray()).filter((rec) => { if (rec.deleted && !rec.etag) { table.update(rec.id, { dirty: 0 }); return false; } return true; });
    if (!dirty.length) return;
    let done = 0; const total = dirty.length;
    const report = () => { if (progress && total > 3) progress('Uploading ' + sub + '… ' + done + '/' + total); };
    report();
    const enc = (s) => encodeURIComponent(s);
    let i = 0;
    while (i < dirty.length) {
      // Gather a batch under the size cap.
      const group = []; let bytes = 0;
      while (i < dirty.length && group.length < BATCH_MAX) {
        const rec = dirty[i]; const body = JSON.stringify(strip(rec)); const size = body.length;
        if (group.length && bytes + size > BATCH_BYTES) break;
        group.push({ rec, body }); bytes += size; i++;
        if (size > BATCH_BYTES) break;
      }
      let batched = false;
      if (group.length > 1) {
        try {
          const res = await G.call('/$batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: group.map((g, k) => ({ id: String(k), method: 'PUT', url: '/me/drive/root:/' + enc(C.driveFolder) + '/' + enc(sub) + '/' + enc(g.rec.id + '.json') + ':/content', headers: { 'Content-Type': 'application/json' }, body: JSON.parse(g.body) })) }) });
          if (res.ok) {
            const out = await res.json(); const byId = new Map((out.responses || []).map((r) => [r.id, r]));
            const failed = [];
            for (const [k, g] of group.entries()) { const r = byId.get(String(k)); if (r && r.status >= 200 && r.status < 300) { await table.update(g.rec.id, { etag: r.body && r.body.eTag || null, dirty: 0 }); done++; } else failed.push(g); }
            report();
            if (failed.length) { for (const g of failed) { const item = await G.upload(sub, g.rec.id + '.json', g.body, 'application/json'); await table.update(g.rec.id, { etag: item ? item.eTag : null, dirty: 0 }); done++; report(); } }
            batched = true;
          }
        } catch (e) { console.warn('batch push failed, falling back', e); }
      }
      if (!batched) {
        for (const g of group) {
          try {
            const item = await G.upload(sub, g.rec.id + '.json', g.body, 'application/json');
            await table.update(g.rec.id, { etag: item ? item.eTag : null, dirty: 0 }); done++; report();
          } catch (e) { console.warn('push failed', sub, g.rec.id, e); throw e; }
        }
      }
    }
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
      if ((await meta.get('foldersReady')) !== 'v3') {
        await G.ensureFolders(['notebooks', 'sections', 'pages', 'assets', 'versions', 'inbox']);
        await meta.set('foldersReady', 'v3');
      }
      // Push first so our edits are on OneDrive before we read the delta (which then echoes them back with matching etags).
      let base = 'Syncing with OneDrive', pulled = null;
      const prog = (m) => { base = m; status.message = m; emit(); };
      // While Microsoft rate-limits us, say so in the pill instead of looking stuck.
      const prevThrottle = G.onThrottle;
      G.onThrottle = (ms) => { status.message = base + ' — Microsoft is rate-limiting, waiting ' + Math.round(ms / 1000) + ' s'; emit(); if (prevThrottle) prevThrottle(ms); };
      try {
      for (const [sub, table] of KINDS) await pushKind(sub, table, prog);
      await pushAssets(prog);
      pulled = await pullChanges(prog);
      } finally { G.onThrottle = prevThrottle; }
      try { if (window.NCDrop) { status.message = 'Checking capture relay…'; emit(); const n = await window.NCDrop.pull(); if (n) { status.message = 'Captured ' + n + ' from the relay'; emit(); listeners.forEach((fn) => fn(Object.assign({ dropped: n }, status))); } } } catch (e) { console.warn('drop pull failed', e); }
      // Anything that arrived while pushing/pulling.
      for (const [sub, table] of KINDS) await pushKind(sub, table, prog);
      status.lastSync = Date.now();
      await meta.set('lastSync', status.lastSync);
      if (pulled && pulled.failed) await setState('error', pulled.failed + ' items could not be downloaded (' + pulled.why.slice(0, 300) + '); will retry', new Error(pulled.why));
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
  window.NCSync = { init, run, schedule, resetDelta, purgeDeleted, onChange: (fn) => listeners.add(fn), status: () => Object.assign({}, status) };
})();

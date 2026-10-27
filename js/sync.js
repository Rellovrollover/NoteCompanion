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

  async function pullJSON(sub, item, table, local) {
    const res = await G.download(sub, item.name);
    const rec = await res.json();
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
  async function pullChanges(progress) {
    let url = await meta.get('deltaLink', null);
    const first = !url;
    if (!url) url = '/me/drive/root:/' + encodeURIComponent(C.driveFolder) + ':/delta?$select=id,name,eTag,size,file,folder,deleted,parentReference,lastModifiedDateTime&$top=500';
    const changed = { notebooks: [], sections: [], pages: [], versions: [], assets: [], inbox: [] };
    let deltaLink = null, seen = 0;
    while (url) {
      let page;
      try { page = await G.json(url); }
      catch (e) { if (e.status === 410 || e.status === 404) { await meta.set('deltaLink', null); if (!first) return pullChanges(progress); } throw e; }
      for (const it of page.value || []) {
        seen++;
        if (!it.file || it.deleted) continue;
        const parent = (it.parentReference && it.parentReference.path) || '';
        const sub = decodeURIComponent(parent.split('/').pop() || '');
        if (changed[sub]) changed[sub].push(it);
      }
      if (progress && seen) progress('Checking OneDrive… ' + seen + ' items');
      url = page['@odata.nextLink'] || null;
      if (page['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];
    }
    // Apply JSON records.
    for (const sub of ['notebooks', 'sections', 'pages', 'versions']) {
      const table = TABLE[sub]; let n = 0;
      for (const item of changed[sub]) {
        const id = item.name.replace(/\.json$/, '');
        const loc = await table.get(id);
        if (loc && loc.etag === item.eTag) continue;
        try { await pullJSON(sub, item, table, loc); n++; } catch (e) { console.warn('pull failed', sub, id, e); }
        if (progress && n % 20 === 0) progress('Downloading ' + sub + '… ' + n + '/' + changed[sub].length);
      }
    }
    // Apply assets.
    for (const item of changed.assets) await pullAsset(item);
    // Inbox drops.
    for (const item of changed.inbox) await importDrop(item);
    if (deltaLink) await meta.set('deltaLink', deltaLink);
    return changed;
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
      const res = await G.download('assets', item.name);
      const blob = await res.blob();
      await db.assets.put({ id, name, mime: blob.type || mime, size: blob.size, blob, created: (loc && loc.created) || when, updated: when, deleted: 0, dirty: 0, etag: item.eTag, downloaded: 1 });
    } catch (e) { console.warn('asset pull failed', id, e); }
  }

  // ---- Push: only records flagged dirty ----
  async function pushKind(sub, table) {
    const dirty = await table.where('dirty').equals(1).toArray();
    for (const rec of dirty) {
      if (rec.deleted && !rec.etag) { await table.update(rec.id, { dirty: 0 }); continue; } // never reached OneDrive
      try {
        const item = await G.upload(sub, rec.id + '.json', JSON.stringify(strip(rec)), 'application/json');
        await table.update(rec.id, { etag: item ? item.eTag : null, dirty: 0 });
      } catch (e) { console.warn('push failed', sub, rec.id, e); throw e; }
    }
  }
  async function pushAssets() {
    const dirty = await db.assets.where('dirty').equals(1).toArray();
    for (const rec of dirty) {
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
      for (const [sub, table] of KINDS) await pushKind(sub, table);
      await pushAssets();
      await pullChanges((m) => { status.message = m; emit(); });
      try { if (window.NCDrop) { const n = await window.NCDrop.pull(); if (n) listeners.forEach((fn) => fn(Object.assign({ dropped: n }, status))); } } catch (e) { console.warn('drop pull failed', e); }
      // Anything that arrived while pushing/pulling.
      for (const [sub, table] of KINDS) await pushKind(sub, table);
      status.lastSync = Date.now();
      await meta.set('lastSync', status.lastSync);
      await setState('ok', 'Synced');
    } catch (e) {
      console.warn('sync failed', e);
      const msg = e && e.status === 401 ? 'Sign-in expired; sign in again' : (e && e.message) || 'Sync failed';
      await setState('error', msg, e);
    } finally {
      running = false;
      if (queued) { queued = false; setTimeout(run, 1500); }
    }
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
  window.NCSync = { init, run, schedule, resetDelta, onChange: (fn) => listeners.add(fn), status: () => Object.assign({}, status) };
})();

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

  async function syncKind(sub, table) {
    const remote = await G.list(sub);
    const byId = new Map(remote.map((it) => [it.name.replace(/\.json$/, ''), it]));
    const local = await table.toArray();
    const localById = new Map(local.map((r) => [r.id, r]));
    // Pull anything new or changed on OneDrive.
    for (const [id, item] of byId) {
      const loc = localById.get(id);
      if (!loc || loc.etag !== item.eTag) {
        try { await pullJSON(sub, item, table, loc); } catch (e) { console.warn('pull failed', sub, id, e); }
      }
    }
    // Push local changes.
    for (const rec of local) {
      if (!rec.dirty) continue;
      const fresh = await table.get(rec.id);
      if (!fresh || !fresh.dirty) continue;
      if (fresh.deleted && !byId.has(rec.id) && !fresh.etag) { await table.update(rec.id, { dirty: 0 }); continue; }
      try {
        const body = JSON.stringify(strip(fresh));
        const item = await G.upload(sub, rec.id + '.json', body, 'application/json');
        await table.update(rec.id, { etag: item ? item.eTag : null, dirty: 0 });
      } catch (e) { console.warn('push failed', sub, rec.id, e); throw e; }
    }
  }

  const assetName = (a) => a.id + '__' + (a.name || 'file').replace(/[\\/:*?"<>|]/g, '_');

  async function syncAssets() {
    const remote = await G.list('assets');
    const byId = new Map(remote.map((it) => [it.name.split('__')[0], it]));
    const local = await db.assets.toArray();
    const localById = new Map(local.map((r) => [r.id, r]));
    for (const [id, item] of byId) {
      const loc = localById.get(id);
      if (loc && loc.deleted) continue;
      if (!loc || (!loc.downloaded && item.size <= C.autoDownloadLimit)) {
        const name = item.name.split('__').slice(1).join('__') || 'file';
        const mime = (item.file && item.file.mimeType) || 'application/octet-stream';
        if (item.size > C.autoDownloadLimit) {
          await db.assets.put({ id, name, mime, size: item.size, blob: null, created: Date.parse(item.lastModifiedDateTime) || Date.now(), updated: Date.parse(item.lastModifiedDateTime) || Date.now(), deleted: 0, dirty: 0, etag: item.eTag, downloaded: 0 });
          continue;
        }
        try {
          const res = await G.download('assets', item.name);
          const blob = await res.blob();
          await db.assets.put({ id, name, mime: blob.type || mime, size: blob.size, blob, created: (loc && loc.created) || Date.now(), updated: Date.parse(item.lastModifiedDateTime) || Date.now(), deleted: 0, dirty: 0, etag: item.eTag, downloaded: 1 });
        } catch (e) { console.warn('asset pull failed', id, e); }
      }
    }
    for (const rec of local) {
      if (!rec.dirty) continue;
      try {
        if (rec.deleted) {
          if (byId.has(rec.id)) await G.remove('assets', byId.get(rec.id).name);
          await db.assets.update(rec.id, { dirty: 0 });
        } else if (rec.blob) {
          const item = await G.upload('assets', assetName(rec), rec.blob, rec.mime);
          await db.assets.update(rec.id, { etag: item ? item.eTag : null, dirty: 0 });
        }
      } catch (e) { console.warn('asset push failed', rec.id, e); throw e; }
    }
  }

  // Anything dropped into NoteCompanion/inbox on OneDrive (e.g. by an iOS Shortcut) becomes a capture.
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function syncDropbox() {
    let items = [];
    try { items = await G.list('inbox'); } catch (e) { return; }
    let n = 0;
    for (const it of items) {
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
        await G.remove('inbox', it.name); n++;
      } catch (e) { console.warn('inbox drop failed', it.name, e); }
    }
    if (n) listeners.forEach((fn) => fn(Object.assign({ dropped: n }, status)));
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
      await syncDropbox();
      for (const [sub, table] of KINDS) await syncKind(sub, table);
      await syncAssets();
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

  window.NCSync = { init, run, schedule, onChange: (fn) => listeners.add(fn), status: () => Object.assign({}, status) };
})();

// Local store: every device keeps a complete copy in IndexedDB. Records carry
// `updated` (ms since epoch, the merge key), `dirty` (1 = not yet uploaded) and
// `etag` (the OneDrive version last seen for this record).
(function () {
  const db = new Dexie('notecompanion');
  db.version(1).stores({
    notebooks: 'id, updated, deleted, dirty, order',
    sections: 'id, notebookId, updated, deleted, dirty, order',
    pages: 'id, sectionId, notebookId, inbox, updated, deleted, dirty, title, *tags',
    assets: 'id, updated, deleted, dirty',
    meta: 'key'
  });

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));
  const now = () => Date.now();

  const meta = {
    async get(key, fallback) { const r = await db.meta.get(key); return r ? r.value : fallback; },
    async set(key, value) { await db.meta.put({ key, value }); }
  };

  async function deviceName() {
    let d = await meta.get('device');
    if (!d) {
      const ua = navigator.userAgent;
      const kind = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
        : /iPhone/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device';
      d = kind + '-' + Math.random().toString(36).slice(2, 6);
      await meta.set('device', d);
    }
    return d;
  }

  const stamp = (rec) => Object.assign(rec, { updated: now(), dirty: 1 });

  const notebooks = {
    all: () => db.notebooks.where('deleted').equals(0).sortBy('order'),
    get: (id) => db.notebooks.get(id),
    async create(name) {
      const order = (await db.notebooks.count()) + 1;
      const rec = { id: uuid(), name, order, created: now(), deleted: 0, etag: null };
      await db.notebooks.put(stamp(rec)); return rec;
    },
    async update(id, patch) { await db.notebooks.update(id, stamp(Object.assign({}, patch))); },
    async remove(id) {
      const secs = await db.sections.where('notebookId').equals(id).toArray();
      for (const s of secs) await sections.remove(s.id);
      await db.notebooks.update(id, stamp({ deleted: 1 }));
    }
  };

  const sections = {
    forNotebook: (notebookId) => db.sections.where('notebookId').equals(notebookId).and((s) => !s.deleted).sortBy('order'),
    get: (id) => db.sections.get(id),
    async create(notebookId, name) {
      const order = (await db.sections.where('notebookId').equals(notebookId).count()) + 1;
      const rec = { id: uuid(), notebookId, name, order, created: now(), deleted: 0, etag: null };
      await db.sections.put(stamp(rec)); return rec;
    },
    async update(id, patch) { await db.sections.update(id, stamp(Object.assign({}, patch))); },
    async remove(id) {
      const pgs = await db.pages.where('sectionId').equals(id).toArray();
      for (const p of pgs) if (!p.deleted) await pages.remove(p.id);
      await db.sections.update(id, stamp({ deleted: 1 }));
    }
  };

  const pages = {
    get: (id) => db.pages.get(id),
    inbox: () => db.pages.where('inbox').equals(1).and((p) => !p.deleted).reverse().sortBy('updated'),
    forSection: (sectionId) => db.pages.where('sectionId').equals(sectionId).and((p) => !p.deleted).sortBy('title'),
    live: () => db.pages.where('deleted').equals(0).toArray(),
    recent: (n) => db.pages.where('deleted').equals(0).reverse().sortBy('updated').then((a) => a.slice(0, n)),
    byTitle: async (title) => (await db.pages.where('title').equalsIgnoreCase(title).and((p) => !p.deleted).first()),
    async create(fields) {
      const rec = Object.assign({
        id: uuid(), notebookId: null, sectionId: null, inbox: 0, title: '', md: '', mode: 'wysiwyg',
        tags: [], kind: 'note', assetId: null, pinned: 0, created: now(), deleted: 0, etag: null
      }, fields);
      await db.pages.put(stamp(rec)); return rec;
    },
    async update(id, patch) { await db.pages.update(id, stamp(Object.assign({}, patch))); },
    async remove(id) {
      const p = await db.pages.get(id);
      if (p && p.assetId) await assets.remove(p.assetId);
      await db.pages.update(id, stamp({ deleted: 1 }));
    },
    async tags() {
      const all = await pages.live(); const set = new Map();
      for (const p of all) for (const t of (p.tags || [])) set.set(t, (set.get(t) || 0) + 1);
      return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ tag: t, n }));
    }
  };

  const assets = {
    get: (id) => db.assets.get(id),
    async create(blob, name) {
      const rec = { id: uuid(), name: name || 'file', mime: blob.type || 'application/octet-stream', size: blob.size, blob, created: now(), deleted: 0, etag: null, downloaded: 1 };
      await db.assets.put(stamp(rec)); return rec;
    },
    async remove(id) { await db.assets.update(id, stamp({ deleted: 1, blob: null })); }
  };

  async function pendingCount() {
    const [a, b, c, d] = await Promise.all([db.notebooks.where('dirty').equals(1).count(), db.sections.where('dirty').equals(1).count(), db.pages.where('dirty').equals(1).count(), db.assets.where('dirty').equals(1).count()]);
    return a + b + c + d;
  }

  async function exportAll() {
    const [nb, sc, pg] = await Promise.all([db.notebooks.toArray(), db.sections.toArray(), db.pages.toArray()]);
    return { exported: new Date().toISOString(), notebooks: nb, sections: sc, pages: pg };
  }

  window.NCDB = { db, uuid, now, meta, deviceName, notebooks, sections, pages, assets, pendingCount, exportAll };
})();

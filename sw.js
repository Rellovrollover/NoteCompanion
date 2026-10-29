// NoteCompanion service worker.
// 1. Caches the app shell so it opens with no connection.
// 2. Serves local assets (images, audio, files) from IndexedDB at ./asset/<id>,
//    so markdown can reference them with a plain relative URL on every device.
const VERSION = 'nc-2026-10-31s';
// Big libraries live in their own cache that only changes when they do, so an app update downloads just
// the app's own files (a few hundred KB), not every library again.
const VENDOR = 'nc-vendor-1';
const APP_FILES = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/config.js', './js/db.js', './js/graph.js', './js/sync.js', './js/pdf.js', './js/ink.js', './js/scan.js', './js/shift.js', './js/shop.js', './js/tp.js', './js/portfolio.js', './js/todo.js', './js/logbook.js', './js/famus.js', './js/symbols.js', './js/gcal.js', './js/onenote.js', './js/drop.js', './js/app.js',
  './icons/brain-180.png', './icons/brain-192.png', './icons/brain-512.png'
];
const VENDOR_FILES = [
  './vendor/pdf-lib.min.js', './vendor/mammoth.min.js', './vendor/supabase.js', './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  ...['400-normal', '400-italic', '700-normal', '700-italic'].map((v) => './vendor/fonts/carlito-latin-' + v + '.woff2'),
  './vendor/dexie.min.js', './vendor/msal-browser.min.js', './vendor/marked.js', './vendor/turndown.js',
  './vendor/tinymce/tinymce.min.js', './vendor/tinymce/themes/silver/theme.min.js', './vendor/tinymce/models/dom/model.min.js', './vendor/tinymce/icons/default/icons.min.js',
  './vendor/tinymce/skins/ui/oxide/skin.min.css', './vendor/tinymce/skins/ui/oxide/content.min.css', './vendor/tinymce/skins/ui/oxide-dark/skin.min.css', './vendor/tinymce/skins/ui/oxide-dark/content.min.css',
  './vendor/tinymce/skins/content/default/content.min.css', './vendor/tinymce/skins/content/dark/content.min.css',
  ...['lists', 'advlist', 'table', 'link', 'image', 'autolink', 'autoresize', 'searchreplace', 'codesample', 'quickbars', 'accordion'].map((p) => './vendor/tinymce/plugins/' + p + '/plugin.min.js')
];
const BASE = new URL('./', self.location).pathname;
const isVendor = (url) => url.pathname.startsWith(BASE + 'vendor/');

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(VERSION)).addAll(APP_FILES);
    // Libraries: only fetch the ones this device doesn't already have.
    const vc = await caches.open(VENDOR);
    for (const f of VENDOR_FILES) { if (!(await vc.match(f))) { try { await vc.add(f); } catch (err) { /* fetched on first use instead */ } } }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function readAsset(id) {
  return new Promise((resolve) => {
    const req = indexedDB.open('notecompanion');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) { db.close(); resolve(null); return; }
      const tx = db.transaction('assets', 'readonly');
      const get = tx.objectStore('assets').get(id);
      get.onsuccess = () => { db.close(); resolve(get.result || null); };
      get.onerror = () => { db.close(); resolve(null); };
    };
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Graph, login or CDNs

  const assetMatch = url.pathname.startsWith(BASE + 'asset/') ? url.pathname.slice((BASE + 'asset/').length) : null;
  if (assetMatch) {
    e.respondWith(readAsset(assetMatch).then((a) => {
      if (!a || !a.blob || a.deleted) return new Response('Asset not on this device yet', { status: 404 });
      return new Response(a.blob, { headers: { 'Content-Type': a.mime || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="' + (a.name || 'file').replace(/"/g, '') + '"' } });
    }));
    return;
  }

  // The page itself: network first so an update shows up, but if the network fails or answers with an
  // error (offline, or GitHub's "rate limit exceeded" page) the saved copy opens instead.
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const saved = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || (await cache.match('./'));
      try {
        const res = await fetch(req);
        if (res && res.ok) { cache.put(req, res.clone()); return res; }
        return saved || res;
      } catch (err) { return saved || Response.error(); }
    }));
    return;
  }
  // Everything else: from the saved copy, with no re-download on every use. A new build brings new copies.
  e.respondWith((async () => {
    const name = isVendor(url) ? VENDOR : VERSION;
    const cache = await caches.open(name);
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) { return Response.error(); }
  })());
});

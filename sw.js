// NoteCompanion service worker.
// 1. Caches the app shell so it opens with no connection.
// 2. Serves local assets (images, audio, files) from IndexedDB at ./asset/<id>,
//    so markdown can reference them with a plain relative URL on every device.
const VERSION = 'nc-2026-10-29e';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/config.js', './js/db.js', './js/graph.js', './js/sync.js', './js/pdf.js', './js/ink.js', './js/scan.js', './js/shift.js', './js/shop.js', './js/tp.js', './js/onenote.js', './js/drop.js', './js/app.js',
  './vendor/pdf-lib.min.js', './vendor/mammoth.min.js', './vendor/supabase.js', './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  ...['400-normal', '400-italic', '700-normal', '700-italic'].map((v) => './vendor/fonts/carlito-latin-' + v + '.woff2'),
  './vendor/dexie.min.js', './vendor/msal-browser.min.js', './vendor/marked.js', './vendor/turndown.js',
  './vendor/tinymce/tinymce.min.js', './vendor/tinymce/themes/silver/theme.min.js', './vendor/tinymce/models/dom/model.min.js', './vendor/tinymce/icons/default/icons.min.js',
  './vendor/tinymce/skins/ui/oxide/skin.min.css', './vendor/tinymce/skins/ui/oxide/content.min.css', './vendor/tinymce/skins/ui/oxide-dark/skin.min.css', './vendor/tinymce/skins/ui/oxide-dark/content.min.css',
  './vendor/tinymce/skins/content/default/content.min.css', './vendor/tinymce/skins/content/dark/content.min.css',
  ...['lists', 'advlist', 'table', 'link', 'image', 'autolink', 'autoresize', 'searchreplace', 'codesample', 'quickbars', 'accordion'].map((p) => './vendor/tinymce/plugins/' + p + '/plugin.min.js'),
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];
const BASE = new URL('./', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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

  // App shell. Only this version's cache is consulted (never an older one that is still being cleared).
  // The page itself is fetched network-first so a stale shell can't outlive an update; everything else cache-first.
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(req, { ignoreSearch: true }).then((hit) => {
    const fetching = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    if (req.mode === 'navigate') return fetching.then((res) => res || hit);
    return hit || fetching;
  })));
});

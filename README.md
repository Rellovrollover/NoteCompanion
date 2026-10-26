# NoteCompanion

A notes app that replaces OneNote for one person: quick captures, notebooks of rich-text or Markdown pages, and (later) a PDF library with pen markup. It runs as a home-screen web app on iPhone, iPad and Windows, works fully offline, and syncs through a `NoteCompanion` folder in the owner's own OneDrive.

Live at https://rellovrollover.github.io/notecompanion/

## How it works

- **Local first.** Every device keeps a complete copy in IndexedDB (`js/db.js`). Edits are saved locally, then pushed when online.
- **Sync.** `js/sync.js` lists the OneDrive folder, pulls anything with a new eTag, pushes anything marked dirty. Last write wins by `updated`; a losing local edit is kept as a conflict copy.
- **Sign-in.** `js/graph.js` uses MSAL (public client, PKCE) against the Azure app registration whose client ID is in `js/config.js`. Scopes: `User.Read`, `Files.ReadWrite`.
- **Assets.** Images, audio and files live in IndexedDB and in `NoteCompanion/assets` on OneDrive. The service worker serves them at `./asset/<id>`, so Markdown references them with a plain relative URL that works on every device.
- **Editor.** TinyMCE 7 (self-hosted in `vendor/tinymce`, GPL build) with the OneNote-style text tools: fonts, sizes, colours, highlight, alignment, tables, to-do items, images, page links. Pages are stored as HTML; `marked` converts any older Markdown pages on first open and `turndown` produces the Markdown export.

## OneDrive layout

```
NoteCompanion/
  notebooks/<id>.json
  sections/<id>.json
  pages/<id>.json
  assets/<id>__<filename>
```

## Updating

Push to `main`; GitHub Pages serves the root. Bump `VERSION` in `sw.js` on every deploy so installed copies pick up the new files (they show an "Updated — Reload" prompt).

No patient-identifiable data goes in this app.

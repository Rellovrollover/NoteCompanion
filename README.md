# NoteCompanion

A notes app that replaces OneNote for one person: quick captures, notebooks of rich-text or Markdown pages, and (later) a PDF library with pen markup. It runs as a home-screen web app on iPhone, iPad and Windows, works fully offline, and syncs through a `NoteCompanion` folder in the owner's own OneDrive.

Live at https://rellovrollover.github.io/notecompanion/

## How it works

- **Local first.** Every device keeps a complete copy in IndexedDB (`js/db.js`). Edits are saved locally, then pushed when online.
- **Sync.** `js/sync.js` lists the OneDrive folder, pulls anything with a new eTag, pushes anything marked dirty. Last write wins by `updated`; a losing local edit is kept as a conflict copy.
- **Sign-in.** `js/graph.js` uses MSAL (public client, PKCE) against the Azure app registration whose client ID is in `js/config.js`. Scopes: `User.Read`, `Files.ReadWrite`.
- **Assets.** Images, audio and files live in IndexedDB and in `NoteCompanion/assets` on OneDrive. The service worker serves them at `./asset/<id>`, so Markdown references them with a plain relative URL that works on every device.
- **Editor.** Toast UI Editor (bundled in `vendor/`), switchable per page between rich text and Markdown. Pages are stored as Markdown.

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

## Rebuilding the editor bundle

```
npm i @toast-ui/editor@3.2.2 esbuild@0.21.5
echo 'import Editor from "@toast-ui/editor"; window.toastui = { Editor };' > entry.js
npx esbuild entry.js --bundle --minify --format=iife --target=es2018 --outfile=vendor/toastui-editor.js
```

No patient-identifiable data goes in this app.

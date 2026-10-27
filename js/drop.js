// Quick-capture relay through a private GitHub repo. An iOS Shortcut PUTs a file into
// <repo>/inbox via the GitHub API (no browser, no prompts); the app pulls it on sync,
// turns it into an Inbox capture, and deletes it from the repo.
(function () {
  const { pages, assets, meta } = window.NCDB;
  const API = 'https://api.github.com';
  async function config() { return { repo: (await meta.get('ghRepo', '')) || '', token: (await meta.get('ghToken', '')) || '' }; }
  async function setConfig(repo, token) { await meta.set('ghRepo', repo.trim()); await meta.set('ghToken', token.trim()); }
  const hdrs = (token) => ({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

  function sniff(bytes, name) {
    const b = bytes;
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length > 11 && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (b.length > 11 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return /\.mov$/i.test(name) ? 'video/quicktime' : (/\.m4a$/i.test(name) ? 'audio/mp4' : 'image/heic');
    const ext = (name.match(/\.(\w+)$/) || [])[1];
    if (ext && /^(txt|md|markdown|json)$/i.test(ext)) return 'text/plain';
    // Looks like text if it decodes cleanly with no control bytes.
    let printable = 0; const n = Math.min(b.length, 512);
    for (let i = 0; i < n; i++) { const c = b[i]; if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || c >= 128) printable++; }
    return n && printable / n > 0.95 ? 'text/plain' : 'application/octet-stream';
  }
  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function pull() {
    const { repo, token } = await config();
    if (!repo || !token) return 0;
    const res = await fetch(API + '/repos/' + repo + '/contents/inbox', { headers: hdrs(token) });
    if (res.status === 404) return 0; // folder not created yet
    if (!res.ok) throw new Error('GitHub ' + res.status);
    const items = (await res.json()).filter((it) => it.type === 'file');
    let n = 0;
    for (const it of items) {
      try {
        // Raw media type works for any size (the JSON form stops at 1 MB, which photos exceed).
        const r = await fetch(API + '/repos/' + repo + '/contents/' + encodeURIComponent('inbox/' + it.name).replace(/%2F/g, '/'), { headers: Object.assign(hdrs(token), { Accept: 'application/vnd.github.raw+json' }) });
        if (!r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        // Delete first so two devices can't both import it; whoever deletes wins.
        const del = await fetch(API + '/repos/' + repo + '/contents/' + encodeURIComponent('inbox/' + it.name).replace(/%2F/g, '/'), { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, hdrs(token)), body: JSON.stringify({ message: 'captured', sha: it.sha }) });
        if (!del.ok) continue;
        if (!bytes.length) continue; // a test run of the Shortcut with no input uploads an empty file
        const mime = sniff(bytes, it.name);
        const base = it.name.replace(/\.\w+$/, '').replace(/^\d{8}-\d{6}-?/, '') || 'Capture';
        // "<Name>.app.html" installs straight into the Apps hub, replacing a tile of the same name.
        if (/\.app\.html?$/i.test(it.name)) {
          const title = it.name.replace(/\.app\.html?$/i, '').replace(/^\d{8}-\d{6}-?/, '');
          const a = await assets.create(new File([bytes], title + '.html', { type: 'text/html' }), title + '.html');
          const existing = (await pages.live()).find((q) => q.kind === 'app' && !q.deleted && (q.title || '').toLowerCase() === title.toLowerCase());
          if (existing) { if (existing.assetId) await assets.remove(existing.assetId); await pages.update(existing.id, { assetId: a.id, url: '' }); }
          else await pages.create({ kind: 'app', inbox: 0, title, url: '', assetId: a.id, html: '<p>Runs inside NoteCompanion.</p>' });
          n++; continue;
        }
        if (mime === 'text/plain') {
          const text = new TextDecoder().decode(bytes).trim();
          if (text) await pages.create({ inbox: 1, kind: 'text', title: text.split('\n')[0].slice(0, 60), html: text.split(/\n{2,}/).map((para) => '<p>' + escapeHtml(para).replace(/\n/g, '<br>') + '</p>').join('') });
        } else {
          const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : mime === 'image/heic' ? 'heic' : mime === 'audio/mp4' ? 'm4a' : mime === 'video/quicktime' ? 'mov' : 'bin';
          const name = /\.\w+$/.test(it.name) ? it.name : it.name + '.' + ext;
          const a = await assets.create(new File([bytes], name, { type: mime }), name);
          const isPdf = mime === 'application/pdf', isImg = mime.startsWith('image/');
          const p = await pages.create({ inbox: 1, kind: isPdf ? 'pdf' : isImg ? 'image' : 'file', title: base, assetId: a.id, annots: isPdf ? {} : undefined,
            html: isPdf ? '' : isImg ? '<p><img src="asset/' + a.id + '" alt="' + escapeHtml(name) + '"></p>' : '<p><a href="asset/' + a.id + '">📎 ' + escapeHtml(name) + '</a></p>' });
          if (isPdf && window.NCPDF) window.NCPDF.enrich(p.id, a.id);
        }
        n++;
      } catch (e) { console.warn('drop import failed', it.name, e); }
    }
    return n;
  }

  async function test() {
    const { repo, token } = await config();
    if (!repo || !token) throw new Error('Enter the repo and token first');
    const res = await fetch(API + '/repos/' + repo, { headers: hdrs(token) });
    if (res.status === 404) throw new Error('Repo not found (check owner/name and that the token can access it)');
    if (res.status === 401) throw new Error('Token rejected');
    if (!res.ok) throw new Error('GitHub ' + res.status);
    const j = await res.json();
    if (!j.private) throw new Error('That repo is public. Use a private one so captures stay private.');
    return j.full_name;
  }

  window.NCDrop = { config, setConfig, pull, test };
})();

// Microsoft sign-in (MSAL) and the handful of Graph calls the sync engine needs.
(function () {
  const C = window.NC_CONFIG;
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  let pca = null;
  let account = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state()));

  function state() { return { signedIn: !!account, name: account ? (account.name || account.username) : null, available: !!pca }; }

  async function init() {
    if (!window.msal) return state();
    try {
      pca = new msal.PublicClientApplication({
        auth: { clientId: C.clientId, authority: C.authority, redirectUri: C.redirectUri, postLogoutRedirectUri: C.redirectUri, navigateToLoginRequestUrl: false },
        cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: true },
        system: { allowRedirectInIframe: false }
      });
      const result = await pca.handleRedirectPromise();
      if (result && result.account) account = result.account;
      if (!account) {
        const accounts = pca.getAllAccounts();
        if (accounts.length) account = accounts[0];
      }
      if (account) pca.setActiveAccount(account);
    } catch (e) {
      console.warn('MSAL init failed', e);
      pca = null;
    }
    emit();
    return state();
  }

  // Scopes added later (mail access, when the user turns it on) are remembered so silent token renewals include them.
  const extraScopes = () => { try { return JSON.parse(localStorage.getItem('nc-extra-scopes') || '[]'); } catch (e) { return []; } };
  const scopes = () => [...new Set([...C.graphScopes, ...extraScopes()])];
  async function signIn() {
    if (!pca) throw new Error('Sign-in is not available on this page.');
    await pca.loginRedirect({ scopes: scopes(), prompt: 'select_account' });
  }
  // Ask the user to grant more permissions (redirects through Microsoft and back).
  async function requestScopes(more) {
    if (!pca || !account) throw Object.assign(new Error('Not signed in'), { code: 'nosession' });
    const next = [...new Set([...extraScopes(), ...more])];
    localStorage.setItem('nc-extra-scopes', JSON.stringify(next));
    await pca.acquireTokenRedirect({ scopes: scopes(), account });
  }
  function hasScope(scope) { return extraScopes().includes(scope); }

  async function signOut() {
    if (!pca || !account) return;
    const acct = account; account = null; emit();
    try { await pca.logoutRedirect({ account: acct }); } catch (e) { console.warn(e); }
  }

  async function token() {
    if (!pca || !account) throw Object.assign(new Error('Not signed in'), { code: 'nosession' });
    try {
      const r = await pca.acquireTokenSilent({ scopes: scopes(), account });
      return r.accessToken;
    } catch (e) {
      if (window.msal && e instanceof msal.InteractionRequiredAuthError) {
        await pca.acquireTokenRedirect({ scopes: scopes(), account });
      }
      throw e;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function call(path, opts = {}, attempt = 0) {
    const t = await token();
    const headers = Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {});
    const res = await fetch(path.startsWith('http') ? path : GRAPH + path, Object.assign({}, opts, { headers }));
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < (opts.maxAttempts == null ? 6 : opts.maxAttempts)) {
      // Honour Retry-After; OneNote throttles hard, so back off generously.
      const ra = parseInt(res.headers.get('Retry-After') || '', 10);
      const wait = Math.min(120, (isNaN(ra) ? Math.pow(2, attempt) * 2 : ra + 1)) * 1000;
      if (window.NCGraph && window.NCGraph.onThrottle) window.NCGraph.onThrottle(wait);
      await sleep(wait);
      return call(path, opts, attempt + 1);
    }
    return res;
  }

  async function json(path, opts) {
    const res = await call(path, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error('Graph ' + res.status + ' on ' + path + ': ' + text.slice(0, 200)), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  const enc = (s) => encodeURIComponent(s);
  const rootPath = () => '/me/drive/root:/' + enc(C.driveFolder);
  const itemPath = (sub, name) => rootPath() + '/' + enc(sub) + (name ? '/' + enc(name) : '');

  async function ensureFolders(subs) {
    // Create the root folder, then each subfolder; 409 means it already exists.
    const mk = async (parent, name) => {
      const res = await call(parent + '/children', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
      });
      if (!res.ok && res.status !== 409) throw new Error('Could not create folder ' + name + ' (' + res.status + ')');
    };
    await mk('/me/drive/root', C.driveFolder);
    for (const s of subs) await mk(rootPath() + ':', s);
  }

  async function list(sub) {
    const out = [];
    let url = itemPath(sub) + ':/children?$select=id,name,eTag,lastModifiedDateTime,size,file&$top=999';
    while (url) {
      const page = await json(url);
      for (const it of page.value || []) if (it.file) out.push(it);
      url = page['@odata.nextLink'] || null;
    }
    return out;
  }

  // Fetch a file's bytes. Ask for its pre-authorised download link and fetch that plainly (no bearer token),
  // rather than following /content's cross-origin redirect: Safari carries the Authorization header through
  // the redirect and the download host refuses it, so on iPhone every /content download failed.
  async function download(sub, name) {
    let url = null;
    try {
      const meta = await json(itemPath(sub, name) + '?$select=id,size,@microsoft.graph.downloadUrl');
      url = meta && meta['@microsoft.graph.downloadUrl'];
    } catch (e) { if (e.status === 404) throw Object.assign(new Error('Download failed 404'), { status: 404 }); }
    if (url) {
      const r = await fetch(url);
      if (r.ok) return r;
    }
    const res = await call(itemPath(sub, name) + ':/content');
    if (!res.ok) throw Object.assign(new Error('Download failed ' + res.status), { status: res.status });
    return res;
  }

  async function uploadSmall(sub, name, body, mime) {
    return json(itemPath(sub, name) + ':/content', { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body });
  }

  async function uploadLarge(sub, name, blob) {
    const session = await json(itemPath(sub, name) + ':/createUploadSession', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
    });
    const chunk = 10 * 1024 * 1024; // multiple of 320 KiB as Graph requires
    let start = 0, last = null;
    while (start < blob.size) {
      const end = Math.min(start + chunk, blob.size);
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + blob.size },
        body: blob.slice(start, end)
      });
      if (!res.ok) throw new Error('Chunk upload failed ' + res.status);
      last = await res.json().catch(() => null);
      start = end;
    }
    return last;
  }

  function upload(sub, name, body, mime) {
    const size = body.size !== undefined ? body.size : (body.length || 0);
    return size > 4 * 1024 * 1024 ? uploadLarge(sub, name, body) : uploadSmall(sub, name, body, mime);
  }

  async function remove(sub, name) {
    const res = await call(itemPath(sub, name), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('Delete failed ' + res.status);
  }

  window.NCGraph = { init, signIn, signOut, state, onChange: (fn) => listeners.add(fn), ensureFolders, list, download, upload, remove, json, call, requestScopes, hasScope };
})();

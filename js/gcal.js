// Google Calendar: sign in with Google (authorisation code + PKCE, refresh token kept on this device), read the
// next day or two of events for the Today strip, suggest teaching sessions to the Portfolio log, and put to-dos
// in the calendar. Dormant until a Client ID and secret are pasted into Settings.
(function () {
  const { meta } = window.NCDB;
  const C = window.NC_CONFIG;
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth', TOKEN = 'https://oauth2.googleapis.com/token', API = 'https://www.googleapis.com/calendar/v3';
  const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
  const KEY = 'nc-gcal';
  const TEACH_WORDS = ['teaching', 'grand round', 'sim', 'simulation', 'course', 'm&m', 'journal club', 'lecture', 'tutorial', 'seminar', 'workshop', 'mdt', 'cpd', 'webinar', 'conference', 'study day'];
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state()));
  async function config() { return { clientId: (await meta.get('gcalClientId', '')) || '', secret: (await meta.get('gcalSecret', '')) || '', words: (await meta.get('gcalTeachWords', '')) || TEACH_WORDS.join(', '), strip: await meta.get('gcalStrip', true) }; }
  function state() { const s = load(); return { signedIn: !!s.refresh, email: s.email || '', expires: s.exp || 0 }; }

  // ---- sign-in (redirect out to Google and back to the app's own address) ----
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function signIn() {
    const { clientId } = await config();
    if (!clientId) throw new Error('Paste the Google Client ID first');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem('nc-gcal-verifier', verifier);
    sessionStorage.setItem('nc-gcal-return', location.hash || '#settings');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: C.redirectUri, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state: 'gcal', include_granted_scopes: 'true' });
    location.href = AUTH + '?' + q.toString();
  }
  // Called once at start-up: finishes a sign-in if Google just sent us back with a code.
  async function init() {
    const qs = new URLSearchParams(location.search);
    if (qs.get('state') !== 'gcal') return false;
    const code = qs.get('code'), err = qs.get('error');
    const back = sessionStorage.getItem('nc-gcal-return') || '#settings';
    history.replaceState(null, '', C.redirectUri + back);
    if (err || !code) { save(Object.assign(load(), { lastError: err || 'no code' })); emit(); return false; }
    const verifier = sessionStorage.getItem('nc-gcal-verifier') || '';
    const { clientId, secret } = await config();
    const res = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: C.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) { save(Object.assign(load(), { lastError: (j.error_description || j.error || res.status) })); emit(); return false; }
    const s = { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000, refresh: j.refresh_token || load().refresh || '', lastError: '' };
    save(s);
    try { const me = await api('/users/me/calendarList/primary'); s.email = me.id || ''; save(s); } catch (e) { /* fine */ }
    emit();
    return true;
  }
  function signOut() { const s = load(); if (s.access) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(s.refresh || s.access), { method: 'POST' }).catch(() => {}); localStorage.removeItem(KEY); emit(); }
  async function token() {
    const s = load();
    if (s.access && s.exp > Date.now()) return s.access;
    if (!s.refresh) throw Object.assign(new Error('Not signed in to Google'), { code: 'nosession' });
    const { clientId, secret } = await config();
    const res = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: secret, refresh_token: s.refresh, grant_type: 'refresh_token' }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) { if (j.error === 'invalid_grant') { localStorage.removeItem(KEY); emit(); throw Object.assign(new Error('Google sign-in has lapsed; sign in again in Settings'), { code: 'nosession' }); } throw new Error('Google token refresh failed (' + (j.error || res.status) + ')'); }
    s.access = j.access_token; s.exp = Date.now() + (j.expires_in || 3600) * 1000 - 60000; save(s);
    return s.access;
  }
  async function api(path, opts = {}) {
    const t = await token();
    const res = await fetch(API + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + t }, opts.headers || {}) }));
    if (!res.ok) { const text = await res.text().catch(() => ''); throw Object.assign(new Error('Google ' + res.status + ': ' + text.slice(0, 160)), { status: res.status }); }
    return res.status === 204 ? null : res.json();
  }

  // ---- events ----
  const iso = (d) => d.toISOString();
  const dayOf = (ev) => (typeof ev.start === 'string' ? ev.start : (ev.start.date || ev.start.dateTime || '')).slice(0, 10);
  async function calendars() {
    const r = await api('/users/me/calendarList?minAccessRole=reader&showHidden=false');
    return (r.items || []).filter((c) => c.selected !== false);
  }
  // Events between two instants from every selected calendar, flattened and sorted.
  async function events(from, to) {
    const cals = await calendars();
    const out = [];
    for (const c of cals.slice(0, 12)) {
      const q = new URLSearchParams({ timeMin: iso(from), timeMax: iso(to), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
      const r = await api('/calendars/' + encodeURIComponent(c.id) + '/events?' + q.toString());
      for (const ev of r.items || []) if (ev.status !== 'cancelled' && ev.start) out.push({ id: ev.id, cal: c.summary, color: c.backgroundColor || '', title: ev.summary || '(no title)', allDay: !!ev.start.date, start: ev.start.dateTime || ev.start.date, end: ev.end && (ev.end.dateTime || ev.end.date) || '', link: ev.htmlLink || '', location: ev.location || '' });
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out;
  }
  // Today strip data: now until the end of tomorrow; cached for offline and to spare the API.
  async function upcoming(force) {
    const cached = await meta.get('gcalCache', null);
    if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.events;
    if (!navigator.onLine || !state().signedIn) return cached ? cached.events : [];
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 2);
    try { const evs = await events(from, to); await meta.set('gcalCache', { at: Date.now(), events: evs }); return evs; }
    catch (e) { console.warn('calendar fetch failed', e); return cached ? cached.events : []; }
  }
  // Past events that look like teaching, for the Portfolio log to offer.
  async function teachingCandidates(days) {
    if (!state().signedIn || !navigator.onLine) return [];
    const { words } = await config();
    const list = words.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const to = new Date(); const from = new Date(); from.setDate(from.getDate() - (days || 60));
    const evs = await events(from, to);
    return evs.filter((ev) => !ev.allDay || true).filter((ev) => { const t = (ev.title + ' ' + ev.location).toLowerCase(); return list.some((w) => t.includes(w)); }).map((ev) => Object.assign(ev, { hours: ev.allDay ? 7 : Math.max(0.25, Math.round(((new Date(ev.end) - new Date(ev.start)) / 3600000) * 4) / 4) }));
  }
  async function createEvent({ title, date, start, end, description }) {
    const body = { summary: title, description: description || '' };
    if (start) { body.start = { dateTime: start }; body.end = { dateTime: end || new Date(new Date(start).getTime() + 3600000).toISOString() }; }
    else { const next = new Date(date + 'T00:00'); next.setDate(next.getDate() + 1); body.start = { date }; body.end = { date: next.toISOString().slice(0, 10) }; }
    return api('/calendars/primary/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ---- Today strip ----
  const fmtT = (s) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  async function strip(host) {
    const { strip: on } = await config();
    if (!on || !state().signedIn) return;
    const box = el('div', { class: 'gcal-strip' }); host.append(box);
    const draw = (evs) => {
      box.innerHTML = '';
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const now = Date.now();
      const show = evs.filter((ev) => dayOf(ev) >= today && (ev.allDay || !ev.end || new Date(ev.end) > now)).slice(0, 8);
      if (!show.length) { box.append(el('span', { class: 'gcal-empty' }, 'Nothing in the calendar today or tomorrow')); return; }
      let lastDay = '';
      for (const ev of show) {
        const d = dayOf(ev);
        if (d !== lastDay) { box.append(el('span', { class: 'gcal-day' }, d === today ? 'Today' : d === tomorrow ? 'Tomorrow' : new Date(d + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short' }))); lastDay = d; }
        box.append(el('a', { class: 'gcal-ev', href: ev.link || '#', target: ev.link ? '_blank' : null, rel: 'noopener', title: ev.cal }, el('i', { style: ev.color ? 'background:' + ev.color : '' }), el('b', {}, ev.allDay ? 'all day' : fmtT(ev.start)), ' ', ev.title));
      }
    };
    draw(await upcoming(false));
    upcoming(true).then((evs) => { if (box.isConnected) draw(evs); });
  }

  window.NCGCal = { init, signIn, signOut, state, config, onChange: (fn) => listeners.add(fn), upcoming, teachingCandidates, createEvent, strip, TEACH_WORDS };
})();

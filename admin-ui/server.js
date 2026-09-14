#!/usr/bin/env node
/**
 * unifi-allowlist admin UI
 *
 * A small web page for managing players without the command line. Runs on your LAN
 * (the same container as the agent is a fine home) and talks to the Worker's /admin
 * API with ADMIN_KEY, so the key never reaches a browser.
 *
 * It has its own sign-in: one password, hashed with scrypt, and a signed session
 * cookie. A LAN is not a trust boundary; anyone who can reach this port still has
 * to know the password. Put it behind Caddy or Tailscale if you want TLS.
 *
 * No dependencies. Node 20 or newer.
 *
 *   node server.js --config /etc/unifi-allowlist/admin-ui.json
 *   node set-password.js --config /etc/unifi-allowlist/admin-ui.json   # first run
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

/* ------------------------------------------------------------------ config */

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1] || args[args.indexOf('-c') + 1] || '/etc/unifi-allowlist/admin-ui.json';

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const cfg = {
    listen: raw.listen || '0.0.0.0',
    port: Number(raw.port) || 8080,
    workerUrl: String(raw.workerUrl || '').replace(/\/+$/, ''),
    adminKey: raw.adminKey || '',
    sessionSecret: raw.sessionSecret || '',
    passwordHash: raw.passwordHash || '',
    sessionHours: Math.max(1, Number(raw.sessionHours) || 12),
    // Set true when a reverse proxy terminates TLS in front of this, so cookies get the Secure flag.
    behindTls: !!raw.behindTls,
    siteName: raw.siteName || 'Allow-list admin',
  };
  const missing = [];
  if (!cfg.workerUrl) missing.push('workerUrl');
  if (!cfg.adminKey || cfg.adminKey.startsWith('PASTE_')) missing.push('adminKey');
  if (!cfg.sessionSecret || cfg.sessionSecret.startsWith('PASTE_')) missing.push('sessionSecret');
  if (missing.length) {
    console.error(`admin-ui: config ${configPath} is missing ${missing.join(', ')}`);
    process.exit(1);
  }
  return cfg;
}

const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------ passwords */

function verifyPassword(password, stored) {
  // scrypt$N$r$p$salt$hash, all base64url. Written by set-password.js.
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), want.length, { N: +N, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ------------------------------------------------------------- sessions */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (msg) => b64u(crypto.createHmac('sha256', cfg.sessionSecret).update(msg).digest());

function issueSession() {
  const exp = Date.now() + cfg.sessionHours * 3600 * 1000;
  const nonce = b64u(crypto.randomBytes(16));
  const body = `${exp}.${nonce}`;
  return `${body}.${hmac('session:' + body)}`;
}

function readSession(req) {
  const m = /(?:^|;\s*)ui=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const [exp, nonce, sig] = parts;
  const expect = hmac(`session:${exp}.${nonce}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (Number(exp) < Date.now()) return null;
  return { nonce, csrf: hmac('csrf:' + nonce) };
}

function cookieHeader(value, maxAge) {
  const bits = [`ui=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (cfg.behindTls) bits.push('Secure');
  return bits.join('; ');
}

/* ------------------------------------------------------ login throttling */

const attempts = new Map(); // ip -> { n, resetAt }
function throttled(ip) {
  const a = attempts.get(ip);
  if (a && a.resetAt > Date.now() && a.n >= 5) return true;
  return false;
}
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) attempts.set(ip, { n: 1, resetAt: Date.now() + 5 * 60 * 1000 });
  else a.n++;
}

/* --------------------------------------------------------- worker client */

async function api(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(cfg.workerUrl + path, {
      method,
      headers: { authorization: `Bearer ${cfg.adminKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: 'bad_response' }; }
    if (!res.ok) throw new Error(data.error === 'unauthorized' ? 'The Worker rejected ADMIN_KEY (401): check adminKey in the config.' : `Worker answered ${res.status}: ${data.error || text.slice(0, 120)}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

/* ----------------------------------------------------------------- html */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (ts) => {
  if (!ts) return 'never';
  const d = Math.floor(Date.now() / 1000) - Number(ts);
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 172800) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
};
const when = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5c6470;--line:#e2e5ea;--accent:#2f6fed;--accent-fg:#fff;--warn:#8a5a00;--warn-bg:#fff6e0;--ok:#1d6b3a;--ok-bg:#e7f6ec;--bad:#b3261e;--bad-bg:#fde8e6}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaee;--muted:#9aa2b1;--line:#272b33;--accent:#5b8dff;--accent-fg:#0b0d11;--warn:#f0c168;--warn-bg:#2a230f;--ok:#7fd89f;--ok-bg:#10301c;--bad:#ff8a80;--bad-bg:#3a1512}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:62rem;margin:0 auto;padding:2rem 1.25rem 4rem}header{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:1.25rem}
h1{font-size:1.35rem;margin:0}nav a{color:var(--muted);margin-left:1rem}nav a.on{color:var(--fg);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem;margin:0 0 1rem}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem .55rem;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}td.num{white-space:nowrap}
code,.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:.92em}
input[type=text],input[type=password]{width:100%;padding:.55rem .65rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:.45rem .8rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--bad-bg);color:var(--bad)}
form.inline{display:inline}.actions form{display:inline-block;margin:0 .15rem .25rem 0}
.pill{display:inline-block;font-size:.72rem;font-weight:700;padding:.1rem .5rem;border-radius:999px}.on{background:var(--ok-bg);color:var(--ok)}.off{background:var(--bad-bg);color:var(--bad)}
.muted{color:var(--muted)}.warn{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:.7rem .9rem}.err{background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:.7rem .9rem}
.grid{display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:.6rem;align-items:end}label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:.2rem}
.linkbox{font-family:ui-monospace,Consolas,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.8rem;user-select:all}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
`;

function layout(title, body, { session = null, tab = '' } = {}) {
  const nav = session
    ? `<nav><a class="${tab === 'players' ? 'on' : ''}" href="/">Players</a><a class="${tab === 'audit' ? 'on' : ''}" href="/audit">Audit</a>
       <form class="inline" method="POST" action="/logout"><input type="hidden" name="csrf" value="${esc(session.csrf)}"><button class="ghost" type="submit">Sign out</button></form></nav>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — ${esc(cfg.siteName)}</title><style>${STYLE}</style></head>
<body><main><header><h1>${esc(cfg.siteName)}</h1>${nav}</header>${body}</main></body></html>`;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(html);
}
const redirect = (res, to, headers = {}) => { res.writeHead(303, { location: to, 'cache-control': 'no-store', ...headers }); res.end(); };

/* ---------------------------------------------------------------- pages */

function loginPage(msg = '') {
  return layout('Sign in', `<div class="card" style="max-width:24rem;margin:3rem auto">
    <h2 style="margin-top:0">Sign in</h2>${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <form method="POST" action="/login"><label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" autofocus required>
    <p style="margin-top:1rem"><button type="submit">Sign in</button></p></form></div>`);
}

function playersPage(session, players, flash) {
  const rows = players.map((p) => `<tr>
    <td><strong>${esc(p.name)}</strong><br><span class="muted mono">${esc(p.slug)}</span></td>
    <td class="mono">${p.ip4 ? esc(p.ip4) : '<span class="muted">—</span>'}</td>
    <td class="num muted" title="${esc(when(p.ip4_seen))}">${esc(ago(p.ip4_seen))}</td>
    <td>${p.enabled ? '<span class="pill on">enabled</span>' : '<span class="pill off">disabled</span>'}${p.has_link ? '' : ' <span class="muted">no link</span>'}${p.discord_id ? ' <span class="muted">discord</span>' : ''}</td>
    <td class="actions">
      ${act(session, p.slug, 'rotate', 'New link', 'ghost')}
      ${p.enabled ? act(session, p.slug, 'disable', 'Disable', 'ghost') : act(session, p.slug, 'enable', 'Enable', 'ghost')}
      ${act(session, p.slug, 'delete', 'Delete', 'danger', true)}
    </td></tr>`).join('');
  return layout('Players', `
    ${flash ? `<p class="${flash.kind === 'ok' ? 'warn' : 'err'}">${esc(flash.text)}</p>` : ''}
    <div class="card"><h2 style="margin:0 0 .75rem;font-size:1.05rem">Add a player</h2>
      <form method="POST" action="/players" class="grid"><input type="hidden" name="csrf" value="${esc(session.csrf)}">
        <div><label for="slug">Short name (for the link)</label><input id="slug" type="text" name="slug" pattern="[A-Za-z0-9-]{1,32}" required placeholder="steve"></div>
        <div><label for="name">Display name</label><input id="name" type="text" name="name" maxlength="64" placeholder="Steve"></div>
        <div><label for="note">Note (optional)</label><input id="note" type="text" name="note" maxlength="200" placeholder="Discord: steve#1234"></div>
        <div><button type="submit">Create link</button></div></form>
      <p class="muted" style="margin:.75rem 0 0">The link is shown once, on the next page. Send it privately; whoever holds it can claim that slot.</p></div>
    <div class="card"><table><thead><tr><th>Player</th><th>Allowed IPv4</th><th>Refreshed</th><th>State</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No players yet.</td></tr>'}</tbody></table></div>`, { session, tab: 'players' });
}

function act(session, slug, action, label, cls, confirm = false) {
  return `<form method="POST" action="/players/${encodeURIComponent(slug)}/${action}"><input type="hidden" name="csrf" value="${esc(session.csrf)}">
    ${confirm ? `<label style="display:inline;font-size:.8rem"><input type="checkbox" name="sure" value="1"> sure</label> ` : ''}<button class="${cls}" type="submit">${label}</button></form>`;
}

function linkPage(session, title, slug, url, note) {
  return layout(title, `<div class="card"><h2 style="margin-top:0">${esc(title)}</h2>
    <p>Send this to <strong>${esc(slug)}</strong>. It is shown only now; if it is lost, make a new one.</p>
    <p class="linkbox">${esc(url)}</p>${note ? `<p class="muted">${esc(note)}</p>` : ''}
    <p><a href="/">Back to players</a></p></div>`, { session, tab: 'players' });
}

function auditPage(session, rows) {
  const tr = rows.map((a) => `<tr><td class="num muted">${esc(when(a.ts))}</td><td><span class="mono">${esc(a.slug || '')}</span></td><td>${esc(a.event)}</td>
    <td class="mono">${esc(a.old_ip || '')}${a.old_ip && a.new_ip ? ' → ' : ''}${esc(a.new_ip || '')}</td><td>${esc(a.country || '')}</td><td class="muted">${esc(a.via || '')}</td>
    <td class="muted" title="${esc(a.ua || '')}">${esc((a.ua || '').slice(0, 40))}${(a.ua || '').length > 40 ? '…' : ''}</td></tr>`).join('');
  return layout('Audit', `<div class="card"><table><thead><tr><th>When</th><th>Player</th><th>Event</th><th>Address</th><th>Country</th><th>Via</th><th>Browser</th></tr></thead>
    <tbody>${tr || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`, { session, tab: 'audit' });
}

/* -------------------------------------------------------------- server */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on('error', reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || '?';

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const session = readSession(req);
  const ip = clientIp(req);

  if (!cfg.passwordHash) {
    return send(res, 503, layout('Not set up', `<div class="card"><p class="warn">No password set. On the host run:<br><code>node set-password.js --config ${esc(configPath)}</code> and restart this service.</p></div>`));
  }

  if (path === '/login') {
    if (req.method === 'GET') return session ? redirect(res, '/') : send(res, 200, loginPage());
    if (req.method === 'POST') {
      if (throttled(ip)) return send(res, 429, loginPage('Too many attempts. Wait five minutes.'));
      const body = await readBody(req);
      if (verifyPassword(String(body.password || ''), cfg.passwordHash)) {
        log(`sign-in from ${ip}`);
        return redirect(res, '/', { 'set-cookie': cookieHeader(issueSession(), cfg.sessionHours * 3600) });
      }
      noteFailure(ip);
      log(`failed sign-in from ${ip}`);
      return send(res, 401, loginPage('Wrong password.'));
    }
  }

  if (!session) return redirect(res, '/login');

  // Every state change is a POST carrying the session's CSRF token.
  let body = {};
  if (req.method === 'POST') {
    body = await readBody(req);
    if (body.csrf !== session.csrf) return send(res, 403, layout('Refused', `<div class="card"><p class="err">That form was stale. Go back and try again.</p></div>`, { session }));
  }

  if (path === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'set-cookie': cookieHeader('', 0) });

  try {
    if (path === '/' && req.method === 'GET') {
      const { players } = await api('GET', '/admin/players');
      const f = url.searchParams.get('ok') ? { kind: 'ok', text: url.searchParams.get('ok') } : url.searchParams.get('err') ? { kind: 'err', text: url.searchParams.get('err') } : null;
      return send(res, 200, playersPage(session, players || [], f));
    }
    if (path === '/audit' && req.method === 'GET') {
      const { audit } = await api('GET', '/admin/audit?limit=200');
      return send(res, 200, auditPage(session, audit || []));
    }
    if (path === '/players' && req.method === 'POST') {
      const r = await api('POST', '/admin/players', { slug: body.slug, name: body.name || body.slug, note: body.note || undefined });
      return send(res, 201, linkPage(session, 'Player created', r.slug, r.url, body.note));
    }
    const m = /^\/players\/([a-z0-9-]{1,32})\/(rotate|enable|disable|delete)$/.exec(path);
    if (m && req.method === 'POST') {
      const [, slug, action] = m;
      if (action === 'delete') {
        if (body.sure !== '1') return redirect(res, '/?err=' + encodeURIComponent(`Tick "sure" to delete ${slug}.`));
        await api('DELETE', `/admin/players/${slug}`);
        return redirect(res, '/?ok=' + encodeURIComponent(`Deleted ${slug}.`));
      }
      const r = await api('POST', `/admin/players/${slug}/${action}`);
      if (action === 'rotate') return send(res, 200, linkPage(session, 'New link issued', slug, r.url, 'The old link stopped working the moment this one was made.'));
      return redirect(res, '/?ok=' + encodeURIComponent(`${slug} ${action}d.`));
    }
    return send(res, 404, layout('Not found', `<div class="card"><p>Not found. <a href="/">Players</a></p></div>`, { session }));
  } catch (err) {
    log(`error: ${err.message}`);
    return send(res, 502, layout('Problem', `<div class="card"><p class="err">${esc(err.message)}</p><p><a href="/">Back</a></p></div>`, { session }));
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`unhandled: ${err.stack || err}`);
    if (!res.headersSent) send(res, 500, layout('Problem', `<div class="card"><p class="err">Something broke.</p></div>`));
  });
});
server.listen(cfg.port, cfg.listen, () => log(`admin-ui listening on http://${cfg.listen}:${cfg.port} → ${cfg.workerUrl}${cfg.passwordHash ? '' : ' (no password set yet)'}`));

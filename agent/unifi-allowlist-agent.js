#!/usr/bin/env node
/**
 * unifi-allowlist agent
 *
 * Runs inside your network. Polls the Worker for the current set of verified
 * player addresses and writes them into a UniFi firewall address-group. Nothing
 * inbound is required, so the controller stays off the internet.
 *
 * Usage:
 *   unifi-allowlist-agent [--config PATH] [--once] [--dry-run]
 *   unifi-allowlist-agent --list-groups     # find your group's _id during setup
 *   unifi-allowlist-agent --show-state      # dump what the Worker is serving
 *
 * No npm dependencies, on purpose: node:https only.
 */

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const DEFAULT_CONFIG = '/etc/unifi-allowlist/config.json';

/* ---------------------------------------------------------------- logging */

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.warn(new Date().toISOString(), 'WARN', ...a);
// Discord webhook URLs only, plus a loopback address so the alert path can be tested against a local listener.
const WEBHOOK_OK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/|^http:\/\/127\.0\.0\.1(:\d+)?\//;
const fail = (...a) => console.error(new Date().toISOString(), 'ERROR', ...a);

/* ------------------------------------------------------------------ config */

function loadConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`can't read config at ${file}: ${err.message}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config at ${file} is not valid JSON: ${err.message}`);
  }

  const missing = [];
  if (!cfg.workerUrl) missing.push('workerUrl');
  if (!cfg.agentKey) missing.push('agentKey');
  if (!cfg.unifi || !cfg.unifi.host) missing.push('unifi.host');
  if (!cfg.unifi || !cfg.unifi.username) missing.push('unifi.username');
  if (!cfg.unifi || !cfg.unifi.password) missing.push('unifi.password');
  if (missing.length) throw new Error(`config is missing: ${missing.join(', ')}`);

  return {
    workerUrl: String(cfg.workerUrl).replace(/\/+$/, ''),
    agentKey: cfg.agentKey,
    pollSeconds: Math.max(15, Number(cfg.pollSeconds) || 60),
    staticAllow: Array.isArray(cfg.staticAllow) ? cfg.staticAllow : [],
    // Refuse to write a list shorter than this. Stops a bad upstream response
    // from emptying the group and locking everyone out (yourself included).
    minEntries: cfg.minEntries == null ? 1 : Math.max(0, Number(cfg.minEntries)),
    dryRun: !!cfg.dryRun,
    // Optional Discord webhook. One message per sync that changed the group, and one when syncing keeps failing.
    alerts: {
      webhook: typeof cfg.discordWebhook === 'string' && WEBHOOK_OK.test(cfg.discordWebhook) ? cfg.discordWebhook : null,
      onAdded: !cfg.alerts || cfg.alerts.added !== false,
      onRemoved: !cfg.alerts || cfg.alerts.removed !== false,
      onFailure: !cfg.alerts || cfg.alerts.failures !== false,
      failureThreshold: Math.max(1, Number(cfg.alerts && cfg.alerts.failureThreshold) || 5),
      mention: cfg.alerts && typeof cfg.alerts.mention === 'string' ? cfg.alerts.mention : '',
    },
    unifi: {
      host: String(cfg.unifi.host).replace(/\/+$/, ''),
      site: cfg.unifi.site || 'default',
      username: cfg.unifi.username,
      password: cfg.unifi.password,
      unifiOs: cfg.unifi.unifiOs !== false, // UDM / Cloud Key gen2+ / UniFi OS host
      insecureTls: cfg.unifi.insecureTls !== false, // controllers ship self-signed certs
      tlsFingerprint256: cfg.unifi.tlsFingerprint256 || null,
      groupIdV4: cfg.unifi.groupIdV4 || null,
      groupIdV6: cfg.unifi.groupIdV6 || null,
    },
  };
}

/* -------------------------------------------------------------- http (raw) */

function httpsRequest(target, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        rejectUnauthorized: opts.rejectUnauthorized !== false,
        timeout: opts.timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );

    if (opts.pin) {
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const cert = socket.getPeerCertificate();
          const got = String((cert && cert.fingerprint256) || '').replace(/:/g, '').toLowerCase();
          const want = String(opts.pin).replace(/:/g, '').toLowerCase();
          if (got !== want) req.destroy(new Error(`TLS fingerprint mismatch (got ${got})`));
        });
      });
    }

    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ------------------------------------------------------------ unifi client */

class UnifiClient {
  constructor(u) {
    this.u = u;
    this.cookies = new Map();
    this.csrf = null;
  }

  get prefix() {
    return this.u.unifiOs ? '/proxy/network' : '';
  }

  get tls() {
    return { rejectUnauthorized: !this.u.insecureTls, pin: this.u.tlsFingerprint256 };
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(headers) {
    for (const line of headers['set-cookie'] || []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (headers['x-csrf-token']) this.csrf = headers['x-csrf-token'];
    else if (this.cookies.has('TOKEN')) {
      const fromJwt = csrfFromJwt(this.cookies.get('TOKEN'));
      if (fromJwt) this.csrf = fromJwt;
    }
  }

  async login() {
    this.cookies.clear();
    this.csrf = null;

    const p = this.u.unifiOs ? '/api/auth/login' : '/api/login';
    const res = await httpsRequest(this.u.host + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: this.u.username, password: this.u.password, remember: true }),
      ...this.tls,
    });

    if (res.status === 499) {
      throw new Error('controller wants 2FA; use a local-only account without MFA for the agent');
    }
    if (res.status !== 200) {
      throw new Error(`login failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
    }

    this.absorb(res.headers);
    if (this.cookies.size === 0) throw new Error('login returned no session cookie');
  }

  async request(method, apiPath, payload, allowRetry = true) {
    const headers = {
      accept: 'application/json',
      cookie: this.cookieHeader(),
    };
    if (payload) headers['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;

    const res = await httpsRequest(this.u.host + this.prefix + apiPath, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      ...this.tls,
    });

    this.absorb(res.headers);

    // Sessions expire; log back in once and replay.
    if ((res.status === 401 || res.status === 403) && allowRetry) {
      await this.login();
      return this.request(method, apiPath, payload, false);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* non-JSON error pages fall through to the status check */
    }

    if (res.status !== 200) {
      const detail = (parsed && parsed.meta && parsed.meta.msg) || res.body.slice(0, 200);
      throw new Error(`${method} ${apiPath} → HTTP ${res.status}: ${detail}`);
    }
    if (parsed && parsed.meta && parsed.meta.rc && parsed.meta.rc !== 'ok') {
      throw new Error(`${method} ${apiPath} → ${parsed.meta.rc}: ${parsed.meta.msg || 'unknown error'}`);
    }

    return parsed ? parsed.data : null;
  }

  listGroups() {
    return this.request('GET', `/api/s/${this.u.site}/rest/firewallgroup`);
  }

  async getGroup(id) {
    const data = await this.request('GET', `/api/s/${this.u.site}/rest/firewallgroup/${id}`);
    if (!data || !data.length) throw new Error(`firewall group ${id} not found`);
    return data[0];
  }

  putGroup(group) {
    return this.request('PUT', `/api/s/${this.u.site}/rest/firewallgroup/${group._id}`, group);
  }
}

/** UniFi OS puts the CSRF token inside the TOKEN cookie's JWT payload. */
function csrfFromJwt(jwt) {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).csrfToken || null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- worker */

async function fetchState(cfg) {
  const res = await fetch(`${cfg.workerUrl}/agent/state`, {
    headers: { authorization: `Bearer ${cfg.agentKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error('Worker rejected AGENT_KEY (401); check agentKey in config');
  if (!res.ok) throw new Error(`Worker returned HTTP ${res.status}`);
  return res.json();
}

/* -------------------------------------------------------------- addresses */

const V4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const V6 = /^[0-9a-f:]+(\/\d{1,3})?$/i;

function validFor(family, addr) {
  const s = String(addr).trim();
  if (family === 4) {
    if (!V4.test(s)) return false;
    return s.split('/')[0].split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  return V6.test(s) && s.includes(':');
}

function buildDesired(entries, staticAllow, family, who = new Map()) {
  const out = new Set();
  for (const e of entries || []) {
    if (validFor(family, e.ip)) {
      const ip = String(e.ip).trim();
      out.add(ip);
      who.set(ip, [...(who.get(ip) || []), e.slug].filter(Boolean));
    } else warn(`skipping malformed address from Worker: ${e.slug}=${e.ip}`);
  }
  for (const s of staticAllow || []) {
    if (validFor(family, s)) {
      const ip = String(s).trim();
      out.add(ip);
      who.set(ip, [...(who.get(ip) || []), 'static']);
    }
  }
  return [...out].sort();
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------------------------------------------- sync */

async function syncGroup(client, groupId, desired, label, cfg) {
  if (!groupId) return null;

  if (desired.length < cfg.minEntries) {
    warn(
      `${label}: refusing to write ${desired.length} entries (minEntries=${cfg.minEntries}). ` +
        `Leaving the group as-is. Lower minEntries if that is what you want.`
    );
    return null;
  }

  const group = await client.getGroup(groupId);
  const current = [...(group.group_members || [])].sort();

  if (sameSet(current, desired)) return null;

  const added = desired.filter((x) => !current.includes(x));
  const removed = current.filter((x) => !desired.includes(x));
  log(`${label}: ${current.length} → ${desired.length} members` +
      (added.length ? ` (+${added.join(', ')})` : '') +
      (removed.length ? ` (-${removed.join(', ')})` : ''));

  if (cfg.dryRun) {
    log(`${label}: dry run, not writing`);
    return null;
  }

  // UniFi replaces the whole object, so send it back intact with new members.
  await client.putGroup({ ...group, group_members: desired });
  log(`${label}: updated "${group.name}"`);
  return { added, removed, groupName: group.name };
}

/* --------------------------------------------------------------- alerts */

/** Posts to the Discord webhook. Never throws; a post that fails is logged and dropped. */
async function discord(cfg, content) {
  if (!cfg.alerts.webhook) return;
  try {
    const res = await fetch(cfg.alerts.webhook, {
      method: 'POST',
      // Discord sits behind Cloudflare, which rejects requests without a real User-Agent.
      headers: { 'content-type': 'application/json', 'user-agent': 'unifi-allowlist-agent (+https://github.com/AussieH/unifi-allowlist)' },
      body: JSON.stringify({ username: 'unifi-allowlist', content: content.slice(0, 1900), allowed_mentions: { parse: ['users', 'roles'] } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) warn(`discord webhook answered HTTP ${res.status}`);
  } catch (err) {
    warn(`discord webhook failed: ${err.message}`);
  }
}

const names = (who, ip) => (who.get(ip) || []).join(', ') || 'unknown';

/** One message per sync that changed a group: who was added, who was removed. */
function changeMessage(label, change, who, cfg) {
  const lines = [];
  if (cfg.alerts.onAdded && change.added.length) {
    lines.push(`✅ **Added**: ` + change.added.map((ip) => `\`${ip}\` (${names(who, ip)})`).join(', '));
  }
  if (cfg.alerts.onRemoved && change.removed.length) {
    lines.push(`⌛ **Removed**: ` + change.removed.map((ip) => `\`${ip}\` (${names(who, ip)})`).join(', ') + ' (expired, disabled or replaced)');
  }
  if (!lines.length) return null;
  return `**Allow-list ${label}** · ${change.groupName}\n` + lines.join('\n');
}

async function syncOnce(cfg) {
  const state = await fetchState(cfg);

  const staticV4 = cfg.staticAllow.filter((s) => validFor(4, s));
  const staticV6 = cfg.staticAllow.filter((s) => validFor(6, s));
  const who = new Map(); // ip -> player slugs, for the alerts; removed addresses keep the last name we saw
  for (const [ip, slugs] of lastWho) who.set(ip, slugs);
  const desired4 = buildDesired(state.v4, staticV4, 4, who);
  const desired6 = buildDesired(state.v6, staticV6, 6, who);

  const client = new UnifiClient(cfg.unifi);
  await client.login();

  const c4 = await syncGroup(client, cfg.unifi.groupIdV4, desired4, 'IPv4', cfg);
  if (c4) { const m = changeMessage('IPv4', c4, who, cfg); if (m) await discord(cfg, m); }
  if (cfg.unifi.groupIdV6 && state.allow_ipv6) {
    const c6 = await syncGroup(client, cfg.unifi.groupIdV6, desired6, 'IPv6', cfg);
    if (c6) { const m = changeMessage('IPv6', c6, who, cfg); if (m) await discord(cfg, m); }
  }
  lastWho = who;
}

/** Names seen on the previous sync, so a removal can still say whose address it was. */
let lastWho = new Map();

/* -------------------------------------------------------------------- cli */

function parseArgs(argv) {
  const args = { config: process.env.UNIFI_ALLOWLIST_CONFIG || DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--list-groups') args.listGroups = true;
    else if (a === '--show-state') args.showState = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `unifi-allowlist agent

  --config, -c PATH   config file (default ${DEFAULT_CONFIG})
  --once              sync once and exit
  --dry-run           report what would change, write nothing
  --list-groups       list UniFi firewall groups and their IDs, then exit
  --show-state        print what the Worker is currently serving, then exit
  --help, -h          this text
`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(path.resolve(args.config));
  } catch (err) {
    fail(err.message);
    process.exit(2);
  }
  if (args.dryRun) cfg.dryRun = true;

  // One-shot modes are used interactively during setup, so a failure should read
  // as a sentence, not a stack trace. Set DEBUG=1 to see the full error.
  if (args.showState || args.listGroups || args.once) {
    try {
      if (args.showState) {
        console.log(JSON.stringify(await fetchState(cfg), null, 2));
      } else if (args.listGroups) {
        const client = new UnifiClient(cfg.unifi);
        await client.login();
        for (const g of await client.listGroups()) {
          console.log(
            `${g._id}  ${String(g.group_type).padEnd(20)} ${g.name}  (${(g.group_members || []).length} members)`
          );
        }
      } else {
        await syncOnce(cfg);
      }
    } catch (err) {
      fail(process.env.DEBUG ? err.stack : err.message);
      process.exit(1);
    }
    return;
  }

  log(`started, polling ${cfg.workerUrl} every ${cfg.pollSeconds}s${cfg.dryRun ? ' (dry run)' : ''}`);

  let failures = 0;
  let alerted = false;
  for (;;) {
    try {
      await syncOnce(cfg);
      if (failures) log(`recovered after ${failures} failed attempt(s)`);
      if (alerted) await discord(cfg, `✅ **Allow-list agent recovered** after ${failures} failed sync${failures === 1 ? '' : 's'}.`);
      failures = 0;
      alerted = false;
    } catch (err) {
      failures++;
      // Log the first few failures, then back off; a controller reboot shouldn't
      // fill the journal.
      if (failures <= 3 || failures % 20 === 0) fail(`sync failed (${failures}): ${err.message}`);
      if (cfg.alerts.onFailure && !alerted && failures >= cfg.alerts.failureThreshold) {
        alerted = true;
        await discord(cfg, `⚠️ **Allow-list agent cannot sync**: ${failures} failures in a row. Last error: ${err.message}${cfg.alerts.mention ? ' ' + cfg.alerts.mention : ''}`);
      }
    }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

main().catch((err) => {
  fail(process.env.DEBUG ? err.stack || err : err.message || err);
  process.exit(1);
});

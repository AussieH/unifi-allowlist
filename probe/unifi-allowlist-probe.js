#!/usr/bin/env node
/**
 * unifi-allowlist IPv4 probe
 *
 * A browser whose network prefers IPv6 reaches the Worker over IPv6, but the game
 * connects over IPv4. This tiny service runs on an IPv4-only host that is NOT behind
 * Cloudflare (DNS-only A record, no AAAA), so the only way a browser can reach it is
 * over IPv4. It signs the address the request came from:
 *
 *   GET /v4?n=<nonce from the claim page>
 *     -> { ip, n, ts, sig }   sig = HMAC-SHA256(probeKey, "ip4|ip|n|ts"), base64url
 *
 * The claim page posts that receipt back to the Worker, which checks the signature and
 * records `ip`. It proves exactly what a direct IPv4 visit would: the browser is sending
 * packets from that address. The probe stores nothing.
 *
 * It listens on loopback only, behind a TLS proxy (Caddy) that passes the real peer
 * address in a header the client cannot set (see probe/Caddyfile.example).
 *
 * No npm dependencies, on purpose.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const CONFIG = process.env.UNIFI_ALLOWLIST_PROBE_CONFIG || '/etc/unifi-allowlist/probe.json';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const NONCE = /^[A-Za-z0-9_.-]{10,200}$/;

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!cfg.probeKey || String(cfg.probeKey).length < 32) throw new Error('probeKey missing or shorter than 32 characters');
  if (!Array.isArray(cfg.allowedOrigins) || !cfg.allowedOrigins.length) throw new Error('allowedOrigins must list the Worker origin(s)');
  return {
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || 8089,
    probeKey: String(cfg.probeKey),
    allowedOrigins: cfg.allowedOrigins.map((o) => String(o).replace(/\/+$/, '')),
    ipHeader: String(cfg.ipHeader || 'x-allowlist-peer').toLowerCase(),
    perMinute: Math.max(5, Number(cfg.perMinute) || 30),
  };
}

const cfg = loadConfig();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (msg) => b64url(crypto.createHmac('sha256', cfg.probeKey).update(msg).digest());

/** Fixed one-minute buckets per address; a probe is pressed a handful of times a month. */
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function limited(ip) {
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > cfg.perMinute;
}

function send(res, status, body, origin) {
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://probe');
  const origin = cfg.allowedOrigins.includes(req.headers.origin) ? req.headers.origin : null;

  if (req.method !== 'GET') return send(res, 405, { error: 'method' }, origin);
  if (url.pathname === '/healthz') return send(res, 200, { ok: true }, null);
  if (url.pathname !== '/v4') return send(res, 404, { error: 'not_found' }, origin);

  const ip = String(req.headers[cfg.ipHeader] || '').trim();
  if (!ip) {
    log('no peer header: the proxy in front is not setting', cfg.ipHeader);
    return send(res, 500, { error: 'misconfigured' }, origin);
  }
  if (!IPV4.test(ip)) return send(res, 422, { error: 'not_ipv4' }, origin);
  if (limited(ip)) return send(res, 429, { error: 'slow_down' }, origin);

  const n = url.searchParams.get('n') || '';
  if (!NONCE.test(n)) return send(res, 400, { error: 'bad_nonce' }, origin);

  const ts = Math.floor(Date.now() / 1000);
  send(res, 200, { ip, n, ts, sig: sign(`ip4|${ip}|${n}|${ts}`) }, origin);
});

server.listen(cfg.port, cfg.host, () => log(`probe listening on ${cfg.host}:${cfg.port}`));

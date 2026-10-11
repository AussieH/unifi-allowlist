/** Small helpers shared across the Worker. No dependencies. */

export const nowSec = () => Math.floor(Date.now() / 1000);

export const ipFamily = (ip) => (String(ip).includes(':') ? 6 : 4);

/**
 * A public, unicast IPv4 address in plain dotted-quad form, or null. Used for admin overrides, where the address is
 * typed by a person: anything private, loopback, link-local, CGNAT, multicast or reserved could never be the source
 * address a player's game connects from, so it is refused rather than stored.
 */
export function publicIpv4(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n, i) => n > 255 || (m[i + 1].length > 1 && m[i + 1][0] === '0'))) return null;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return null;          // this-net, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return null;                       // CGNAT 100.64/10
  if (a === 169 && b === 254) return null;                                 // link-local
  if (a === 172 && b >= 16 && b <= 31) return null;                        // private
  if (a === 192 && b === 168) return null;                                 // private
  if (a === 192 && b === 0 && o[2] === 2) return null;                     // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return null;                    // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return null;                  // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return null;                   // TEST-NET-3
  return o.join('.');
}

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    '0.0.0.0'
  );
}

export const normaliseSlug = (s) =>
  String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').slice(0, 32);

export function randomToken(bytes = 24) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256, returned base64url. Used to sign session cookies and OAuth state. */
export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

export function constantTimeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Fails closed: an unset secret never authorises anything. */
export function authorised(request, expected) {
  if (!expected) return false;
  const got = bearerToken(request);
  return got != null && constantTimeEqual(got, expected);
}

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function ago(ts) {
  if (!ts) return 'never';
  const d = nowSec() - Number(ts);
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} minutes ago`;
  if (d < 172800) return `${Math.round(d / 3600)} hours ago`;
  return `${Math.round(d / 86400)} days ago`;
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge = 0, secure = true } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...headers } });
}

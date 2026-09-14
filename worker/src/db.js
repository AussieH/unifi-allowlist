/** Every D1 query lives here, so the rest of the Worker never writes SQL. */

import { nowSec, normaliseSlug } from './util.js';

export const getPlayer = (env, slug) =>
  env.DB.prepare('SELECT * FROM players WHERE slug = ?').bind(normaliseSlug(slug)).first();

export const getPlayerByTokenHash = (env, hash) =>
  env.DB.prepare('SELECT * FROM players WHERE token_hash = ?').bind(hash).first();

export const getPlayerByDiscordId = (env, discordId) =>
  env.DB.prepare('SELECT * FROM players WHERE discord_id = ?').bind(String(discordId)).first();

export async function listPlayers(env) {
  const { results } = await env.DB.prepare(
    `SELECT slug, name, discord_id, ip4, ip4_seen, ip6, ip6_seen, note, enabled, created_at,
            CASE WHEN token_hash IS NULL THEN 0 ELSE 1 END AS has_link
       FROM players ORDER BY slug`
  ).all();
  return results || [];
}

export async function createPlayer(env, { slug, name, tokenHash = null, discordId = null, note = null }) {
  await env.DB.prepare(
    `INSERT INTO players (slug, name, token_hash, discord_id, note, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(normaliseSlug(slug), name, tokenHash, discordId, note, nowSec())
    .run();
  return getPlayer(env, slug);
}

/** Finds a free slug by appending -2, -3, … when the preferred one is taken. */
export async function uniqueSlug(env, preferred, fallback = 'player') {
  const base = normaliseSlug(preferred) || fallback;
  if (!(await getPlayer(env, base))) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (!(await getPlayer(env, candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 32);
}

export function setTokenHash(env, slug, hash) {
  return env.DB.prepare('UPDATE players SET token_hash = ? WHERE slug = ?')
    .bind(hash, normaliseSlug(slug))
    .run();
}

export function setEnabled(env, slug, enabled) {
  return env.DB.prepare('UPDATE players SET enabled = ? WHERE slug = ?')
    .bind(enabled ? 1 : 0, normaliseSlug(slug))
    .run();
}

export function setDisplayName(env, slug, name) {
  return env.DB.prepare('UPDATE players SET name = ? WHERE slug = ?')
    .bind(name, normaliseSlug(slug))
    .run();
}

export function deletePlayer(env, slug) {
  return env.DB.prepare('DELETE FROM players WHERE slug = ?').bind(normaliseSlug(slug)).run();
}

export function recordIp(env, slug, ip, family) {
  const cols = family === 4 ? 'ip4 = ?, ip4_seen = ?' : 'ip6 = ?, ip6_seen = ?';
  return env.DB.prepare(`UPDATE players SET ${cols} WHERE slug = ?`)
    .bind(ip, nowSec(), normaliseSlug(slug))
    .run();
}

/** Players whose entry is still within the TTL, split by address family. */
export async function activeAddresses(env, { ttlDays, allowIpv6 }) {
  const cutoff = nowSec() - ttlDays * 86400;
  const { results } = await env.DB.prepare(
    `SELECT slug, name, ip4, ip4_seen, ip6, ip6_seen
       FROM players WHERE enabled = 1 ORDER BY slug`
  ).all();

  const v4 = [];
  const v6 = [];
  for (const r of results || []) {
    if (r.ip4 && r.ip4_seen > cutoff) v4.push({ slug: r.slug, ip: r.ip4, seen: r.ip4_seen });
    if (allowIpv6 && r.ip6 && r.ip6_seen > cutoff) v6.push({ slug: r.slug, ip: r.ip6, seen: r.ip6_seen });
  }
  return { v4, v6 };
}

export function audit(env, e) {
  return env.DB.prepare(
    'INSERT INTO audit (ts, slug, event, old_ip, new_ip, country, ua, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      nowSec(),
      e.slug || null,
      e.event,
      e.oldIp || null,
      e.newIp || null,
      e.country || null,
      (e.ua || '').slice(0, 200) || null,
      e.via || null
    )
    .run();
}

export async function recentAudit(env, limit = 100) {
  const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all();
  return results || [];
}

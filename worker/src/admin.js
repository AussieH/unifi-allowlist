/**
 * Admin API. Bearer ADMIN_KEY on every route.
 *
 *   GET    /admin/players
 *   POST   /admin/players                    {slug, name?, note?}  → issues a link
 *   POST   /admin/players/:slug/rotate       → new link, old one dies
 *   POST   /admin/players/:slug/enable
 *   POST   /admin/players/:slug/disable
 *   DELETE /admin/players/:slug
 *   GET    /admin/audit?limit=100
 *
 * scripts/admin.sh wraps these in a friendlier CLI.
 */

import {
  audit,
  createPlayer,
  deletePlayer,
  getPlayer,
  listPlayers,
  recentAudit,
  setEnabled,
  setTokenHash,
} from './db.js';
import { authorised, json, normaliseSlug, randomToken, readJson, sha256hex } from './util.js';

export async function handleAdmin(request, env, seg) {
  if (!authorised(request, env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);

  const origin = new URL(request.url).origin;
  const method = request.method;

  if (seg[0] === 'players' && seg.length === 1) {
    if (method === 'GET') return json({ players: await listPlayers(env) });
    if (method === 'POST') return create(request, env, origin);
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (seg[0] === 'players' && seg.length === 2 && method === 'DELETE') {
    const slug = normaliseSlug(seg[1]);
    const res = await deletePlayer(env, slug);
    if (!res.meta || res.meta.changes === 0) return json({ error: 'not_found' }, 404);
    await audit(env, { slug, event: 'deleted', via: 'admin' });
    return json({ slug, deleted: true });
  }

  if (seg[0] === 'players' && seg.length === 3 && method === 'POST') {
    return playerAction(env, origin, normaliseSlug(seg[1]), seg[2]);
  }

  if (seg[0] === 'audit' && method === 'GET') {
    const raw = parseInt(new URL(request.url).searchParams.get('limit') || '100', 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? raw : 100));
    return json({ audit: await recentAudit(env, limit) });
  }

  return json({ error: 'not_found' }, 404);
}

async function create(request, env, origin) {
  const body = await readJson(request);
  const slug = normaliseSlug(body.slug || body.name || '');
  if (!slug) {
    return json({ error: 'bad_slug', detail: 'slug must contain at least one of [a-z0-9-]' }, 400);
  }
  if (await getPlayer(env, slug)) return json({ error: 'slug_taken' }, 409);

  const name = String(body.name || slug).slice(0, 64);
  const token = randomToken();

  await createPlayer(env, {
    slug,
    name,
    tokenHash: await sha256hex(token),
    note: body.note ? String(body.note).slice(0, 200) : null,
  });
  await audit(env, { slug, event: 'created', via: 'admin' });

  // The only time the plaintext token is ever visible. Not recoverable later.
  return json({ slug, name, url: `${origin}/u/${slug}/${token}` }, 201);
}

async function playerAction(env, origin, slug, action) {
  const player = await getPlayer(env, slug);
  if (!player) return json({ error: 'not_found' }, 404);

  if (action === 'rotate') {
    const token = randomToken();
    await setTokenHash(env, slug, await sha256hex(token));
    await audit(env, { slug, event: 'rotated', via: 'admin' });
    return json({ slug, url: `${origin}/u/${slug}/${token}` });
  }

  if (action === 'enable' || action === 'disable') {
    const on = action === 'enable';
    await setEnabled(env, slug, on);
    await audit(env, { slug, event: `${action}d`, via: 'admin' });
    return json({ slug, enabled: on });
  }

  return json({ error: 'unknown_action', detail: 'expected rotate, enable or disable' }, 400);
}

/**
 * Auth provider: per-player secret link.
 *
 *   GET|POST /u/:slug/:token
 *
 * The token is a 192-bit random string; only its SHA-256 is stored, so a dump of
 * the database does not hand out working links. Unknown slug, wrong token and
 * disabled account all return the same page, so probing reveals nothing.
 */

import { handleClaim } from '../claim.js';
import { getPlayer } from '../db.js';
import { page } from '../ui.js';
import { constantTimeEqual, sha256hex } from '../util.js';

export async function handleTokenRoute(request, env, slug, token) {
  const player = await getPlayer(env, slug);
  if (!player || !player.enabled || !player.token_hash) return deadLink(env);

  const hash = await sha256hex(token);
  if (!constantTimeEqual(hash, player.token_hash)) return deadLink(env);

  return handleClaim(request, env, player, 'token');
}

function deadLink(env) {
  return page(env, 404, 'Link not recognised', `
    <p class="lead">This link isn't valid, or access has been withdrawn.</p>
    <p class="muted">Ask an admin to issue you a new one.</p>`);
}


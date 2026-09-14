/**
 * unifi-allowlist: Cloudflare Worker
 *
 * Self-service IP allow-listing for a UniFi firewall group. A player opens their
 * page, presses one button, and the address recorded is the source address of
 * that request, so nobody can authorise an address they aren't connecting from.
 *
 * The LAN-side agent polls GET /agent/state and pushes the result into UniFi,
 * which means the controller never needs to be reachable from the internet.
 *
 * Routes:
 *   /                          landing page
 *   /healthz                   liveness probe
 *   /u/:slug/:token            secret-link provider
 *   /auth/discord[/callback]   Discord OAuth provider
 *   /auth/logout               clear session
 *   /me                        claim page for the signed-in Discord user
 *   /agent/state               Bearer AGENT_KEY — the desired allow list
 *   /admin/*                   Bearer ADMIN_KEY — player management
 *
 * With ALLOWED_COUNTRIES set, everything except /healthz and /agent/state answers 451 from elsewhere.
 */

import { handleAdmin } from './admin.js';
import { handleCallback, loginRedirect, logout, sessionSlug } from './auth/discord.js';
import { handleTokenRoute } from './auth/token.js';
import { handleClaim } from './claim.js';
import { config } from './config.js';
import { activeAddresses, getPlayer } from './db.js';
import { notFoundPage, page } from './ui.js';
import { authorised, esc, json, nowSec, redirect } from './util.js';

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('unhandled', err && err.stack ? err.stack : err);
      const wantsJson = new URL(request.url).pathname.startsWith('/a');
      return wantsJson
        ? json({ error: 'internal_error' }, 500)
        : page(env, 500, 'Something broke', `<p class="lead">That didn't work. Try again shortly.</p>`);
    }
  },
};

async function route(request, env) {
  const c = config(env);
  const url = new URL(request.url);
  const seg = url.pathname.split('/').filter(Boolean);

  if (seg[0] === 'healthz') return json({ ok: true, ts: nowSec() });

  const agentFeed = seg[0] === 'agent' && seg[1] === 'state';
  if (c.allowedCountries.length && !agentFeed) {
    const country = (request.cf && request.cf.country) || '';
    if (!c.allowedCountries.includes(country)) {
      return seg[0] === 'admin'
        ? json({ error: 'region_blocked' }, 451)
        : page(env, 451, 'Not available here', `
          <p class="lead">This page is only served in ${esc(c.allowedCountries.join(', '))}.</p>
          <p class="muted">If you are travelling, wait until you are home: the address you allow-list has to be the one you play from anyway.</p>`);
    }
  }

  if (seg.length === 0) return landing(env, c);

  if (seg[0] === 'agent' && seg[1] === 'state' && seg.length === 2) {
    return agentState(request, env, c);
  }

  if (seg[0] === 'admin') return handleAdmin(request, env, seg.slice(1));

  // Provider: secret link
  if (seg[0] === 'u' && seg.length === 3) {
    if (!c.tokenEnabled) return notFoundPage(env);
    return handleTokenRoute(request, env, seg[1], seg[2]);
  }

  // Provider: Discord
  if (seg[0] === 'auth' && seg[1] === 'discord') {
    if (!c.discordEnabled) return notFoundPage(env);
    if (seg[2] === 'callback') return handleCallback(request, env);
    if (seg.length === 2) return loginRedirect(request, env);
    return notFoundPage(env);
  }
  if (seg[0] === 'auth' && seg[1] === 'logout') return logout(env);

  if (seg[0] === 'me' && seg.length === 1) return me(request, env, c);

  return notFoundPage(env);
}

/* -------------------------------------------------------------- discord /me */

async function me(request, env, c) {
  if (!c.discordEnabled) return notFoundPage(env);

  const slug = await sessionSlug(request, env);
  if (!slug) return redirect('/auth/discord');

  const player = await getPlayer(env, slug);
  if (!player) return redirect('/auth/logout');
  if (!player.enabled) {
    return page(env, 403, 'Access withdrawn', `
      <p class="lead">Your access has been switched off by an admin.</p>
      <p class="muted">Ask them to turn it back on.</p>`);
  }

  return handleClaim(request, env, player, 'discord', { signOutUrl: '/auth/logout' });
}

/* ------------------------------------------------------------------- agent */

async function agentState(request, env, c) {
  if (!authorised(request, env.AGENT_KEY)) return json({ error: 'unauthorized' }, 401);

  const { v4, v6 } = await activeAddresses(env, c);
  return json({ generated_at: nowSec(), ttl_days: c.ttlDays, allow_ipv6: c.allowIpv6, v4, v6 });
}

/* ----------------------------------------------------------------- landing */

function landing(env, c) {
  const discord = c.discordEnabled
    ? `<p><a class="btn btn-discord" href="/auth/discord">Sign in with Discord</a></p>`
    : '';

  const linkNote = c.tokenEnabled
    ? `<p class="muted">If you were given a personal link (it looks like <code>/u/yourname/…</code>),
         open that instead and press the button on it.</p>`
    : '';

  return page(env, 200, c.siteName, `
    <p class="lead">Keep your access working when your home IP address changes.</p>
    ${discord}
    ${linkNote}
    ${!c.discordEnabled && !c.tokenEnabled
      ? `<p class="warn">No sign-in method is enabled. Set <code>AUTH_PROVIDERS</code> in the Worker config.</p>`
      : ''}
    <p class="muted" style="margin-top:1.5rem">Lost your way in? Ask an admin.</p>`);
}


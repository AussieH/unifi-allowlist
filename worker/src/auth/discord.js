/**
 * Auth provider: Discord OAuth2.
 *
 *   GET /auth/discord           → bounce to Discord's consent screen
 *   GET /auth/discord/callback  → exchange code, check guild membership, set session
 *   GET /auth/logout            → clear session
 *
 * Membership is checked with the `guilds.members.read` scope against the user's
 * own access token, so this needs no bot and no bot token, just the OAuth app.
 * With DISCORD_GUILD_ID set, only members of that server can claim a slot; add
 * DISCORD_ROLE_IDS to narrow it further to specific roles.
 */

import { config } from '../config.js';
import { audit, createPlayer, getPlayerByDiscordId, setDisplayName, uniqueSlug } from '../db.js';
import { page } from '../ui.js';
import {
  b64url,
  b64urlDecode,
  constantTimeEqual,
  cookie,
  hmac,
  nowSec,
  parseCookies,
  randomToken,
  redirect,
} from '../util.js';

const API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'ual_session';
const STATE_COOKIE = 'ual_oauth_state';

/* --------------------------------------------------------------- entry points */

export function loginRedirect(request, env) {
  const c = config(env);
  if (!c.discord.clientId || !c.discord.clientSecret) {
    return page(env, 500, 'Not configured', `<p class="lead">Discord sign-in isn't set up on this server.</p>`);
  }

  const state = randomToken(16);
  const url = new URL(`${API.replace('/api/v10', '')}/oauth2/authorize`);
  url.searchParams.set('client_id', c.discord.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri(request, env));
  url.searchParams.set('scope', scopes(c));
  url.searchParams.set('state', state);

  return redirect(url.toString(), {
    'set-cookie': cookie(STATE_COOKIE, state, { maxAge: 600 }),
  });
}

export async function handleCallback(request, env) {
  const c = config(env);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error')) {
    return page(env, 400, 'Sign-in cancelled', `<p class="lead">You didn't approve the sign-in, so nothing happened.</p>`);
  }

  const expected = parseCookies(request)[STATE_COOKIE];
  if (!code || !state || !expected || !constantTimeEqual(state, expected)) {
    return page(env, 400, 'Sign-in failed', `
      <p class="lead">That sign-in couldn't be verified.</p>
      <p class="muted">Start again from the beginning rather than reusing an old link.</p>`);
  }

  let token;
  try {
    token = await exchangeCode(c, code, redirectUri(request, env));
  } catch (err) {
    console.error('discord token exchange failed', err);
    return page(env, 502, 'Sign-in failed', `<p class="lead">Discord didn't accept the sign-in. Try again in a moment.</p>`);
  }

  const user = await api('/users/@me', token);
  if (!user || !user.id) {
    return page(env, 502, 'Sign-in failed', `<p class="lead">Discord didn't return your account details.</p>`);
  }

  if (c.discord.guildId) {
    const verdict = await checkMembership(c, token);
    if (!verdict.ok) return membershipDenied(env, verdict.reason);
  }

  const displayName = user.global_name || user.username || `discord-${user.id}`;
  let player = await getPlayerByDiscordId(env, user.id);

  if (!player) {
    const slug = await uniqueSlug(env, user.username || displayName, `discord-${user.id}`);
    player = await createPlayer(env, { slug, name: displayName, discordId: String(user.id) });
    await audit(env, { slug, event: 'created', via: 'discord' });
  } else if (player.name !== displayName) {
    await setDisplayName(env, player.slug, displayName);
  }

  if (!player.enabled) {
    return page(env, 403, 'Access withdrawn', `
      <p class="lead">Your access has been switched off by an admin.</p>
      <p class="muted">Ask them to re-enable it.</p>`);
  }

  return redirect('/me', {
    'set-cookie': await newSessionCookie(c, player.slug),
  });
}

export function logout(env) {
  return redirect('/', { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
}

/* ------------------------------------------------------------------ sessions */

/** Returns the signed-in player's slug, or null. */
export async function sessionSlug(request, env) {
  const c = config(env);
  if (!c.sessionSecret) return null;

  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;

  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;

  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!constantTimeEqual(sig, await hmac(c.sessionSecret, body))) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < nowSec()) return null;
    return payload.sub || null;
  } catch {
    return null;
  }
}

async function newSessionCookie(c, slug) {
  const payload = { sub: slug, exp: nowSec() + c.sessionTtl };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(c.sessionSecret, body);
  return cookie(SESSION_COOKIE, `${body}.${sig}`, { maxAge: c.sessionTtl });
}

/* ------------------------------------------------------------ discord calls */

function scopes(c) {
  return c.discord.guildId ? 'identify guilds.members.read' : 'identify';
}

function redirectUri(request, env) {
  return env.DISCORD_REDIRECT_URI || `${new URL(request.url).origin}/auth/discord/callback`;
}

async function exchangeCode(c, code, uri) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.discord.clientId,
      client_secret: c.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: uri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('no access_token in response');
  return data.access_token;
}

async function api(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

async function checkMembership(c, token) {
  const member = await api(`/users/@me/guilds/${c.discord.guildId}/member`, token);
  if (!member) return { ok: false, reason: 'not_member' };
  if (c.discord.roleIds.length) {
    const roles = member.roles || [];
    if (!c.discord.roleIds.some((r) => roles.includes(r))) return { ok: false, reason: 'missing_role' };
  }
  return { ok: true };
}

function membershipDenied(env, reason) {
  const detail =
    reason === 'missing_role'
      ? `You're in the server, but you don't have the role that grants server access.`
      : `You need to be a member of the Discord server to get access.`;
  return page(env, 403, 'Not eligible', `
    <p class="lead">${detail}</p>
    <p class="muted">Ask an admin if you think that's wrong.</p>`);
}

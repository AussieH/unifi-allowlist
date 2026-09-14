/**
 * The claim flow, shared by every auth provider.
 *
 * A provider's only job is to answer "which player is this?". Once it has, the
 * IP written down here is the source address of the request itself. There is
 * no input field, so a player cannot authorise an address they aren't using.
 */

import { config } from './config.js';
import { audit, getPlayer, recordIp } from './db.js';
import { page } from './ui.js';
import { ago, clientIp, esc, ipFamily } from './util.js';

/**
 * @param {Request} request
 * @param {object} player  row from `players`
 * @param {string} via     provider name, recorded in the audit log
 * @param {object} opts    { signOutUrl }
 */
export async function handleClaim(request, env, player, via, opts = {}) {
  const c = config(env);
  const ip = clientIp(request);
  const fam = ipFamily(ip);
  const usable = fam === 4 || c.allowIpv6;

  if (!usable) {
    await audit(env, { slug: player.slug, event: 'claim_rejected', newIp: ip, via });
    return ipv6Page(env, player, ip);
  }

  if (request.method === 'POST') {
    const oldIp = fam === 4 ? player.ip4 : player.ip6;
    await recordIp(env, player.slug, ip, fam);
    await audit(env, {
      slug: player.slug,
      event: 'claim',
      oldIp,
      newIp: ip,
      country: (request.cf && request.cf.country) || null,
      ua: request.headers.get('user-agent'),
      via,
    });
    return donePage(env, ip, opts);
  }

  return confirmPage(env, player, ip, fam, c, opts);
}

function confirmPage(env, player, ip, fam, c, opts) {
  const current = fam === 4 ? player.ip4 : player.ip6;
  const seen = fam === 4 ? player.ip4_seen : player.ip6_seen;
  const unchanged = current === ip;

  return page(env, 200, `Hello, ${player.name}`, `
    <p class="lead">We can see you're connecting from:</p>
    <div class="ipbox">
      <span class="iplabel">Your current address</span>
      <span class="ip">${esc(ip)}</span>
    </div>
    ${current
      ? `<p class="muted">Your allow-list entry is <code>${esc(current)}</code>, set ${esc(ago(seen))}.</p>`
      : `<p class="muted">You don't have an entry yet.</p>`}
    ${unchanged
      ? `<p>That already matches. Pressing the button refreshes it so it doesn't expire
           after ${c.ttlDays} days of no visits.</p>`
      : `<p>Press the button to replace your old entry with this address.</p>`}
    <form method="POST">
      <button type="submit">${unchanged ? 'Refresh my access' : 'Authorise this address'}</button>
    </form>
    <p class="warn">Only do this from the computer and network you actually play from.
      On mobile data, a VPN, or someone else's Wi-Fi you'll allow the wrong address
      and have to come back and fix it.</p>
    ${opts.signOutUrl ? `<p class="muted" style="margin-top:1rem"><a href="${esc(opts.signOutUrl)}">Sign out</a></p>` : ''}`);
}

function donePage(env, ip, opts) {
  return page(env, 200, 'Access updated', `
    <p class="lead">Done. You're on the list.</p>
    <div class="ipbox">
      <span class="iplabel">Allowed address</span>
      <span class="ip">${esc(ip)}</span>
    </div>
    <p>It takes up to a minute or two to reach the firewall. If a connection still
       fails after that, wait a moment and try again.</p>
    <p class="muted"><strong>Bookmark this page.</strong> Next time your address changes,
       open it and press the button. That's the whole routine.</p>
    ${opts.signOutUrl ? `<p class="muted"><a href="${esc(opts.signOutUrl)}">Sign out</a></p>` : ''}`);
}

function ipv6Page(env, player, ip) {
  return page(env, 200, 'You’re on IPv6', `
    <p class="lead">You're connected over IPv6 (<code>${esc(ip)}</code>).</p>
    <p>Game clients on this network almost certainly connect over IPv4, so saving this
       address wouldn't get you in. Your existing IPv4 entry has been left untouched.</p>
    <p class="muted">Disable IPv6 for this browser or device and reload, or try another
       network. If IPv6 is all you have, tell an admin; they can turn on IPv6 support
       server-side.</p>
    ${player.ip4
      ? `<p class="muted">Currently allowed for you: <code>${esc(player.ip4)}</code>
           (set ${esc(ago(player.ip4_seen))}).</p>`
      : ''}`);
}

/** Re-reads the row so callers always act on fresh data. */
export const refresh = (env, slug) => getPlayer(env, slug);

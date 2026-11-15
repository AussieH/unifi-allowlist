/**
 * The claim flow, shared by every auth provider.
 *
 * A provider's only job is to answer "which player is this?". Once it has, the
 * IP written down here is the source address of the request itself. There is
 * no input field, so a player cannot authorise an address they aren't using.
 *
 * With the IPv4 probe configured (IP4_PROBE_URL + IP4_PROBE_KEY, see docs/IPV6.md),
 * the page also asks an IPv4-only endpoint for a signed receipt of the IPv4
 * address the browser reaches it from. That receipt is the same proof, just
 * collected over IPv4, so a browser that prefers IPv6 still claims the address
 * the game will actually connect from.
 */

import { config } from './config.js';
import { audit, getPlayer, recordIp } from './db.js';
import { page } from './ui.js';
import { ago, b64url, clientIp, constantTimeEqual, esc, hmac, ipFamily, nowSec } from './util.js';

/** How long a probe nonce and its receipt stay valid, in seconds. */
const PROBE_WINDOW = 600;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * @param {Request} request
 * @param {object} player  row from `players`
 * @param {string} via     provider name, recorded in the audit log
 * @param {object} opts    { signOutUrl }
 */
export async function handleClaim(request, env, player, via, opts = {}) {
  const c = config(env);
  const seen = clientIp(request);
  const seenFam = ipFamily(seen);

  if (request.method === 'POST') {
    let ip = seen;
    let fam = seenFam;
    let how = via;

    if (c.ip4ProbeEnabled) {
      const form = await readForm(request);
      if (form.r_sig) {
        const v4 = await verifyReceipt(c, player.slug, form);
        if (!v4) {
          await audit(env, { slug: player.slug, event: 'claim_rejected', newIp: seen, via: `${via}+ip4probe(bad receipt)` });
          return badReceiptPage(env);
        }
        ip = v4;
        fam = 4;
        how = `${via}+ip4probe`;
      }
    }

    if (fam !== 4 && !c.allowIpv6) {
      await audit(env, { slug: player.slug, event: 'claim_rejected', newIp: seen, via });
      return ipv6Page(env, player, seen);
    }

    const oldIp = fam === 4 ? player.ip4 : player.ip6;
    await recordIp(env, player.slug, ip, fam);
    await audit(env, {
      slug: player.slug,
      event: 'claim',
      oldIp,
      newIp: ip,
      country: (request.cf && request.cf.country) || null,
      ua: request.headers.get('user-agent'),
      via: how,
    });
    return donePage(env, ip, opts);
  }

  if (c.ip4ProbeEnabled) return probePage(env, player, seen, seenFam, c, opts);

  if (seenFam !== 4 && !c.allowIpv6) {
    await audit(env, { slug: player.slug, event: 'claim_rejected', newIp: seen, via });
    return ipv6Page(env, player, seen);
  }
  return confirmPage(env, player, seen, seenFam, c, opts);
}

/* ------------------------------------------------------------------ probe */

/** A nonce tied to this player and this moment: `ts.rand.mac`. */
async function makeNonce(c, slug) {
  const ts = nowSec();
  const rand = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const mac = await hmac(c.ip4Probe.key, `n|${slug}|${ts}|${rand}`);
  return `${ts}.${rand}.${mac}`;
}

/** Returns the receipt's IPv4 address if the nonce and the receipt both check out, else null. */
async function verifyReceipt(c, slug, form) {
  const { n, r_ip: ip, r_ts: tsRaw, r_sig: sig } = form;
  if (!n || !ip || !tsRaw || !sig || !IPV4.test(ip)) return null;

  const parts = String(n).split('.');
  if (parts.length !== 3) return null;
  const [nts, rand, mac] = parts;
  const now = nowSec();
  if (!/^\d+$/.test(nts) || now - Number(nts) > PROBE_WINDOW || Number(nts) > now + 60) return null;
  if (!constantTimeEqual(mac, await hmac(c.ip4Probe.key, `n|${slug}|${nts}|${rand}`))) return null;

  if (!/^\d+$/.test(tsRaw)) return null;
  const ts = Number(tsRaw);
  if (now - ts > PROBE_WINDOW || ts > now + 60 || ts < Number(nts) - 60) return null;
  if (!constantTimeEqual(sig, await hmac(c.ip4Probe.key, `ip4|${ip}|${n}|${ts}`))) return null;

  return ip;
}

async function readForm(request) {
  try {
    const f = await request.formData();
    const out = {};
    for (const k of ['n', 'r_ip', 'r_ts', 'r_sig']) {
      const v = f.get(k);
      if (typeof v === 'string' && v.length <= 300) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function probePage(env, player, seen, seenFam, c, opts) {
  return makeNonce(c, player.slug).then((nonce) => {
    const scriptNonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
    const probeOrigin = new URL(c.ip4Probe.url).origin;
    const current = player.ip4;
    const fallbackOk = seenFam === 4; // without a receipt, a plain IPv4 visit still works the old way

    const body = `
    <p class="lead">We can see you're connecting from:</p>
    <div class="ipbox">
      <span class="iplabel">Your IPv4 address</span>
      <span class="ip" id="ip">${fallbackOk ? esc(seen) : 'checking…'}</span>
    </div>
    ${current
      ? `<p class="muted">Your allow-list entry is <code>${esc(current)}</code>, set ${esc(ago(player.ip4_seen))}.</p>`
      : `<p class="muted">You don't have an entry yet.</p>`}
    <p id="msg">Press the button to allow this address. If it already matches, pressing it
       refreshes your entry so it doesn't expire after ${c.ttlDays} days of no visits.</p>
    <form method="POST" id="f">
      <input type="hidden" name="n" value="${esc(nonce)}">
      <input type="hidden" name="r_ip" id="r_ip">
      <input type="hidden" name="r_ts" id="r_ts">
      <input type="hidden" name="r_sig" id="r_sig">
      <button type="submit" id="go"${fallbackOk ? '' : ' disabled'}>Authorise this address</button>
    </form>
    <p class="warn">Only do this from the computer and network you actually play from.
      On mobile data, a VPN, or someone else's Wi-Fi you'll allow the wrong address
      and have to come back and fix it.</p>
    ${opts.signOutUrl ? `<p class="muted" style="margin-top:1rem"><a href="${esc(opts.signOutUrl)}">Sign out</a></p>` : ''}
    <script nonce="${scriptNonce}">
    (function () {
      var n = ${JSON.stringify(nonce)}, fallbackOk = ${fallbackOk ? 'true' : 'false'};
      var $ = function (id) { return document.getElementById(id); };
      fetch(${JSON.stringify(c.ip4Probe.url)} + '?n=' + encodeURIComponent(n), { credentials: 'omit', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (!d || d.n !== n || !d.ip || !d.sig) throw new Error('bad answer');
          $('r_ip').value = d.ip; $('r_ts').value = d.ts; $('r_sig').value = d.sig;
          $('ip').textContent = d.ip;
          $('go').disabled = false;
        })
        .catch(function () {
          if (fallbackOk) return;
          $('ip').textContent = 'none found';
          $('msg').textContent = 'We could not find an IPv4 address for this connection, and game servers ' +
            'here only accept IPv4. Try another network, or tell an admin.';
        });
    })();
    </script>`;

    return page(env, 200, `Hello, ${player.name}`, body, {
      'content-security-policy':
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; ` +
        `connect-src ${probeOrigin}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
  });
}

/* ------------------------------------------------------------------ pages */

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

function badReceiptPage(env) {
  return page(env, 400, 'That took too long', `
    <p class="lead">The address check on this page expired or didn't match.</p>
    <p class="muted">Go back, reload the page, and press the button again.</p>`);
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

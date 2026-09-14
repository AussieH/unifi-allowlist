# Security notes

## Reporting a vulnerability

Open a GitHub security advisory on the repository rather than a public issue.

## What this project actually guarantees

**An address on the list is an address someone was connecting from.** The IP recorded is
the source address of the HTTP request, observed at Cloudflare's edge. There is no input
field. A player cannot allow-list an address they do not control.

**It does not guarantee the address belongs to only that player.** Behind CGNAT, a shared
office link, or a VPN exit, allow-listing one person allows everyone else on that address
as well. That is a property of IP allow-lists, not a defect here.

**It is not authentication.** It narrows who can reach a port. It does nothing about
vulnerabilities in whatever is listening on that port.

## Trust boundaries

| Secret | Held by | Exposure if leaked |
| --- | --- | --- |
| `ADMIN_KEY` | You | Full control of the player list |
| `AGENT_KEY` | The LAN agent | Read-only view of the current allow list |
| `SESSION_SECRET` | Worker only | Forged Discord sessions |
| `DISCORD_CLIENT_SECRET` | Worker only | Impersonation of your OAuth app |
| Player link token | One player | That player's slot, until rotated |
| UniFi password | Agent config | Control of your controller |

Link tokens are 192 bits of CSPRNG output, stored only as SHA-256. A database dump does
not yield working links. They are bearer tokens, so anyone holding one can claim that
slot, which is why `admin.sh rotate` exists.

The UniFi password sits in `/etc/unifi-allowlist/config.json` at mode 0640, readable only
by the service user. It should be a **local-only, non-MFA admin** scoped to the site, not
your Ubiquiti SSO account. That is the credential to be careful with.

## Hardening worth doing

- **Set `DISCORD_GUILD_ID`** if you enable the Discord provider. Without it, sign-in is
  open to every Discord account in the world.
- **Verify the controller's certificate.** If the controller has a real certificate for a hostname,
  point `unifi.host` at that hostname and set `insecureTls` to false. Otherwise pin it with
  `unifi.tlsFingerprint256`. See [SETUP.md](SETUP.md).
- **Put your own address in `staticAllow`** so a failure cannot lock you out of your own
  network.
- **Keep `minEntries` at 1 or higher** so a bad upstream response cannot empty the group.
- **Consider Cloudflare Access** in front of `/admin/*` if you want a second factor there.

## Design choices

- Unknown slug, wrong token and disabled account all return one identical page, so probing
  reveals nothing about who exists.
- Token and key comparisons are length-checked and constant-time.
- Admin and agent authentication fail closed: an unset secret authorises nothing.
- Claims are `POST`, so a prefetched or link-previewed URL cannot silently change an entry.
- The agent makes only outbound connections and needs no port forward. The controller is
  never reachable from the internet on account of this project.
- Pages send `no-store`, `noindex`, `x-frame-options: DENY` and `referrer-policy:
  no-referrer`. The last one matters, because in token mode the URL itself is the secret.

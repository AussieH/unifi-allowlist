# unifi-allowlist

Self-service IP allow-listing for UniFi, for people who run game servers for their friends.

If you gate your servers with a UniFi firewall rule instead of opening them to the world,
every friend on a dynamic IP becomes your problem: their ISP rotates their address, they
can't connect, and you end up editing a firewall group by hand at eleven at night.

This gives each player a page with one button on it. They press it and they're back in.

```
Player's browser ──── HTTPS ────► Cloudflare Worker ──► D1 (who is allowed, from where)
                                        ▲
                                        │ polls every 60s, outbound only
                                  LAN agent (systemd)
                                        │
                                        ▼
                                  UniFi controller ──► firewall address-group
```

Your controller is never exposed to the internet. The agent only makes outbound requests.

## How it verifies the address

There is no field to type an IP into. The address recorded is the source address of the
request that pressed the button: `CF-Connecting-IP`, as seen at Cloudflare's edge.

To put an address on the list, you have to be sending packets from it. Nobody can
allow-list an address they don't control, including by accident, including on purpose.

Identity is a separate question, and that's what the auth providers below are for:
knowing *whose* entry to replace, so each person holds exactly one slot forever rather
than the group growing a new entry every time somebody's ISP has a wobble.

## Two ways in

Enable either or both with `AUTH_PROVIDERS`.

**`token`: per-player secret links.** You run `admin.sh add steve`, get back a URL like
`https://allow.example.com/u/steve/kJ8x…`, and send it to them once. They bookmark it.
Nothing to sign into, works on any device, no third-party dependency. It's a bearer
token, so anyone they forward it to can claim their slot. Rotate it if that happens.

**`discord`: sign in with Discord.** They hit the site, press *Sign in with Discord*,
and land on their page. Set `DISCORD_GUILD_ID` and only members of your server can claim
a slot; add `DISCORD_ROLE_IDS` and only members with the right role can. Nothing to hand
out, nothing to leak, and revoking someone in Discord revokes their access here. Needs an
OAuth app, but no bot and no bot token, because membership is checked through the
`guilds.members.read` scope on the player's own token. Setup: [docs/DISCORD.md](docs/DISCORD.md).

Running both is fine and often best: Discord for the regulars, a link for the one friend
who isn't in your server.

## Quick start

Roughly twenty minutes end to end. Full detail in [docs/SETUP.md](docs/SETUP.md).

### 1. The Worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create unifi-allowlist        # paste the id into wrangler.toml
npx wrangler d1 execute unifi-allowlist --remote --file=./schema.sql

npx wrangler secret put ADMIN_KEY             # openssl rand -base64 32
npx wrangler secret put AGENT_KEY             # openssl rand -base64 32
npx wrangler deploy
```

Point a hostname at it (`[[routes]]` in `wrangler.toml`) so player links stay stable.

### 2. UniFi

Create a **local-only admin account** with no MFA for the agent, and a firewall
address-group (Settings → Profiles → Firewall Groups) holding whatever you want as a
starting point. Reference that group from your existing allow rule. From here on the
rule never changes; only the group's contents do.

### 3. The agent

On a small LXC or VM inside your network ([docs/PROXMOX.md](docs/PROXMOX.md) has the Proxmox steps):

```bash
sudo ./agent/install.sh
sudoedit /etc/unifi-allowlist/config.json     # workerUrl, agentKey, unifi.*
```

Find the group's ID, dry-run it, then start:

```bash
node /opt/unifi-allowlist/unifi-allowlist-agent.js --list-groups
node /opt/unifi-allowlist/unifi-allowlist-agent.js --once --dry-run
sudo systemctl enable --now unifi-allowlist-agent
```

### 4. Add a player

```bash
export WORKER_URL=https://allow.example.com ADMIN_KEY=…
./scripts/admin.sh add steve "Steve"
```

Send them the URL it prints. It is shown once and can't be recovered; rotate it if it's lost.

## Configuration

**Worker** (`wrangler.toml` vars, secrets via `wrangler secret put`)

| Setting | Default | Notes |
| --- | --- | --- |
| `SITE_NAME` | `Game Servers` | Shown on the pages |
| `TTL_DAYS` | `30` | Entries not refreshed in this long stop being served |
| `ALLOW_IPV6` | `false` | See [docs/IPV6.md](docs/IPV6.md) |
| `ALLOWED_COUNTRIES` | (all) | e.g. `US,CA`: pages and admin API answer 451 from anywhere else; `/healthz` and the agent feed are exempt |
| `AUTH_PROVIDERS` | `token` | `token`, `discord`, or `token,discord` |
| `DISCORD_CLIENT_ID` | — | Discord provider |
| `DISCORD_GUILD_ID` | — | Restrict to one server. Strongly recommended |
| `DISCORD_ROLE_IDS` | — | Optional comma-separated role gate |
| `SESSION_TTL_SECONDS` | `86400` | Discord session lifetime |
| `ADMIN_KEY` 🔒 | — | Bearer token for `/admin/*` |
| `AGENT_KEY` 🔒 | — | Bearer token for `/agent/state` |
| `SESSION_SECRET` 🔒 | — | Signs Discord session cookies |
| `DISCORD_CLIENT_SECRET` 🔒 | — | Discord provider |

**Agent** (`/etc/unifi-allowlist/config.json`): see
[`agent/config.example.json`](agent/config.example.json), which documents each key inline.
Two settings matter more than the rest:

- `staticAllow`: addresses always kept in the group no matter what the Worker says.
  Put your own address here so a mistake can't lock you out.
- `minEntries`: the agent refuses to write a member list shorter than this. Stops a bad
  upstream response from emptying the group.
- `discordWebhook`: optional. A message in your Discord channel whenever an address is added
  or drops off (expired, disabled or replaced), and when syncing keeps failing. See
  [docs/ALERTS.md](docs/ALERTS.md).

## Operating it

Prefer a page to a terminal? `admin-ui/` is a small LAN web UI for the same things, with its
own sign-in: see [docs/ADMIN-UI.md](docs/ADMIN-UI.md).

```bash
./scripts/admin.sh list             # who's on the list and from where
./scripts/admin.sh rotate steve     # new link, old one dies instantly
./scripts/admin.sh disable steve    # revoke without deleting history
./scripts/admin.sh audit 50         # every claim, with country and timestamp
journalctl -u unifi-allowlist-agent -f
```

Every claim, rotation and admin change is written to an append-only `audit` table with
the old address, the new one, and the country Cloudflare saw the request from.

## Things to know before you rely on it

- **CGNAT.** Some ISPs put many customers behind one address. Allow-listing such a player
  allows their neighbours too. That's how IP allow-lists work; this tool can't change it.
- **IPv6.** If a player's browser reaches the Worker over IPv6 while their game client
  connects over IPv4, the address captured would be useless. The Worker detects this,
  refuses the claim, and explains it rather than overwriting a working entry. See
  [docs/IPV6.md](docs/IPV6.md) for the clean fix.
- **Propagation.** Up to `pollSeconds` (default 60) plus however long UniFi takes to apply
  the group. Tell players to wait a minute.
- **An allow-list is not authentication.** It reduces exposure; it does not make an
  unpatched game server safe. Keep the servers updated.

If per-player network access matters more to you than convenience, consider
[Tailscale](https://tailscale.com/) or [Headscale](https://github.com/juanfont/headscale)
instead; an overlay network makes dynamic addresses irrelevant. This project exists for
the case where you want players connecting to a normal public game server with no client
software at all.

## Layout

```
worker/          Cloudflare Worker: pages, auth providers, admin API, agent feed
  src/auth/      One file per auth provider; adding another is a small, contained job
agent/           Node service for your LAN. Zero dependencies, node:https only
admin-ui/        Optional LAN web page for managing players. Zero dependencies
scripts/         admin.sh, a curl wrapper for the admin API
docs/            Setup, Cloudflare and Proxmox details, Discord, IPv6, alerts, admin UI, security notes
```

## Contributing

Issues and PRs welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). New auth providers are
the most obvious place to extend this: a provider only has to answer "which player is
this?" and hand the row to `handleClaim()`.

## License

MIT. See [LICENSE](LICENSE).

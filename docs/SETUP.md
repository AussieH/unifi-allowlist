# Setup

Everything here assumes you already have a UniFi firewall rule that permits your game
server ports from a firewall group, and denies them otherwise. If you don't, build that
first and confirm it works with your own address hard-coded; this project only ever
edits the contents of that group.

## Prerequisites

- A Cloudflare account (the free plan is enough) and a domain on it.
- `npx wrangler`; no global install needed.
- A UniFi controller: UDM/UDR/UDM-Pro, Cloud Key gen2+, or self-hosted.
- Somewhere inside your network to run a small Node service: an LXC container, a VM, a
  Raspberry Pi. Node 20 or newer.

## 1. Cloudflare Worker

### What you need on the Cloudflare side

- A Cloudflare account. The free plan covers everything here: Workers, D1 and a custom domain.
- A domain whose DNS is on Cloudflare (an "active" zone in the dashboard). The Worker gets a
  subdomain of it, e.g. `allow.example.com`. If your domain is registered elsewhere, add it to
  Cloudflare and point its nameservers at the ones Cloudflare gives you; the Worker can be
  deployed before that finishes, but the hostname will not resolve until it does.

### Sign wrangler in

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npx wrangler login          # opens a browser; approve access for your account
npx wrangler whoami         # should print your account
```

`wrangler.toml` is gitignored on purpose: it ends up holding your database id and hostname.

### Database

```bash
npx wrangler d1 create unifi-allowlist
```

Copy the `database_id` it prints into `wrangler.toml`, then load the schema:

```bash
npx wrangler d1 execute unifi-allowlist --remote --file=./schema.sql
```

### Secrets

Two random keys: one for you (the admin API and the admin UI), one for the agent. Generate them
and hand them to Cloudflare; they are stored encrypted and never appear in `wrangler.toml`.

```bash
openssl rand -base64 32 | tee ~/.unifi-allowlist-admin-key | npx wrangler secret put ADMIN_KEY
openssl rand -base64 32 | tee ~/.unifi-allowlist-agent-key | npx wrangler secret put AGENT_KEY
chmod 600 ~/.unifi-allowlist-*-key
```

Keep those two files somewhere sensible; you will paste the agent key into the agent's config
and the admin key into `admin.env` (step 4). `SESSION_SECRET` and `DISCORD_CLIENT_SECRET`
are only needed for the Discord provider, see [DISCORD.md](DISCORD.md).

### Settings and the hostname

In `wrangler.toml`:

```toml
[vars]
SITE_NAME = "Game Servers"       # shown on the pages
TTL_DAYS = "30"                  # entries not refreshed in this long stop being served
AUTH_PROVIDERS = "token"         # token, discord, or token,discord
ALLOWED_COUNTRIES = ""           # e.g. "US,CA" to refuse the pages from anywhere else

[[routes]]
pattern = "allow.example.com"
custom_domain = true
```

`custom_domain = true` makes Cloudflare create the DNS record and the certificate itself; there
is nothing to add in the DNS tab. `workers_dev = false` in the example keeps the Worker off the
`*.workers.dev` hostname, so the custom domain is the only way in.

### Deploy and check

```bash
npx wrangler deploy
curl https://allow.example.com/healthz          # {"ok":true,...}
curl -i https://allow.example.com/admin/players # 401 without the key
```

The Worker's logs are in the dashboard under Workers & Pages, or live with
`npx wrangler tail`. Redeploying is `npx wrangler deploy` again; secrets survive redeploys.

## 2. UniFi

### A local admin for the agent

Do **not** give the agent your Ubiquiti SSO login. In the UniFi OS control panel →
Admins → Add Admin, create a **Local Access Only** admin with no MFA. Give it whatever
the least-privileged role is that can still edit firewall groups on your version. On
most, that means a full Site Admin for the site in question.

Save the username and password for the agent config.

> If login fails with HTTP 499, the account still has MFA attached. The agent can't
> answer an MFA prompt; use a local-only account without it.

### The firewall group

Settings → Profiles → Firewall Groups → Create New Group.

- Type: **IPv4 Address/Subnet**
- Name: something obvious, e.g. `players-dynamic`
- Members: add your own address for now, so the group is never empty

Reference this group from the allow rule on your game server ports. Confirm the rule
works before going further. From now on the rule stays untouched; only the group's
members change.

## 3. The agent

On the machine inside your network (for a Proxmox LXC, see [PROXMOX.md](PROXMOX.md)):

```bash
git clone https://github.com/AussieH/unifi-allowlist.git
cd unifi-allowlist
sudo ./agent/install.sh
```

Edit `/etc/unifi-allowlist/config.json`:

- `workerUrl`: `https://allow.example.com`
- `agentKey`: the `AGENT_KEY` value from step 1
- `unifi.host`: e.g. `https://192.168.1.1`
- `unifi.username` / `unifi.password`: the local admin
- `unifi.unifiOs`: `true` for UDM/Cloud Key gen2+, `false` for a self-hosted controller
- `staticAllow`: put your own address here; it's your way back in if anything goes wrong

Find the group ID and put it in `unifi.groupIdV4`:

```bash
sudo -u unifi-allowlist node /opt/unifi-allowlist/unifi-allowlist-agent.js \
  -c /etc/unifi-allowlist/config.json --list-groups
```

> Minimal container images (the Proxmox Debian template, for one) ship without `sudo`. Either
> `apt-get install sudo` or swap `sudo -u unifi-allowlist` for `runuser -u unifi-allowlist --`
> in these commands.

Check the Worker end of the link, then dry-run the whole thing:

```bash
… --show-state
… --once --dry-run
```

A dry run prints exactly what it would add and remove. When that looks right:

```bash
sudo systemctl enable --now unifi-allowlist-agent
journalctl -u unifi-allowlist-agent -f
```

### Verifying the controller certificate (recommended)

UniFi ships a self-signed certificate, so `insecureTls` defaults to `true`. If your console has a
real certificate for a hostname (a Let's Encrypt one, say), the cleanest fix is to set `unifi.host`
to that hostname and `insecureTls` to `false`; then renewals need nothing from you. Otherwise pin
the fingerprint, which costs one command:

```bash
echo | openssl s_client -connect 192.168.1.1:443 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

Or, without openssl: put any nonsense in `tlsFingerprint256` and run `--once`. The
mismatch error prints the fingerprint it actually saw, which you can then paste in.

Put the hex string in `unifi.tlsFingerprint256`. The agent then refuses to talk to
anything else, even on your own network. Re-pin whenever you replace the certificate.

## 4. Add players

```bash
mkdir -p ~/.config/unifi-allowlist
cat > ~/.config/unifi-allowlist/admin.env <<'EOF'
WORKER_URL=https://allow.example.com
ADMIN_KEY=…
EOF
chmod 600 ~/.config/unifi-allowlist/admin.env

./scripts/admin.sh add steve "Steve"
```

Send Steve the URL. Tell him two things: bookmark it, and only press the button from the
computer he plays on.

For Discord sign-in instead of links, see [DISCORD.md](DISCORD.md).

## Troubleshooting

**`Worker rejected AGENT_KEY (401)`**: `agentKey` doesn't match the `AGENT_KEY` secret.
Re-run `wrangler secret put AGENT_KEY` and paste the same value into the config.

**`login failed (HTTP 401)`**: wrong credentials, or the account isn't local-only.

**`login failed (HTTP 499)`**: MFA is on the account. Use one without it.

**`firewall group … not found`**: wrong `groupIdV4`, or the group is on a different site.
Re-run `--list-groups`; check `unifi.site` matches the site name in your controller URL.

**Group isn't changing**: check `minEntries` isn't blocking a small list, and that the
agent isn't in `dryRun`. `journalctl -u unifi-allowlist-agent -n 50` will say which.

**Player sees "You're on IPv6"**: expected and handled; see [IPV6.md](IPV6.md).

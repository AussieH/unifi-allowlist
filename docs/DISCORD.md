# Discord sign-in

With this provider a player opens the site, presses *Sign in with Discord*, and lands on
their claim page. There is nothing to hand out and nothing to leak, and removing someone
from your Discord server removes their access here.

It uses OAuth2 only: **no bot, no bot token, no gateway connection**. Membership and
roles are read through the `guilds.members.read` scope against the player's own access
token, which is the least-privilege way to ask "is this person in my server?".

## Create the OAuth application

1. <https://discord.com/developers/applications> → **New Application**. Name it something
   your players will recognise, since they'll see it on the consent screen.
2. **OAuth2** → **Redirects** → add exactly:

   ```
   https://allow.example.com/auth/discord/callback
   ```

   Substitute your own hostname. It must match character for character.
3. Copy the **Client ID**, and reset/copy the **Client Secret**.

## Find your guild and role IDs

In Discord: User Settings → Advanced → **Developer Mode** on. Then right-click your
server → *Copy Server ID*, and right-click a role in Server Settings → Roles →
*Copy Role ID*.

## Configure the Worker

In `wrangler.toml`:

```toml
[vars]
AUTH_PROVIDERS = "discord"            # or "token,discord" to keep links working too
DISCORD_CLIENT_ID = "000000000000000000"
DISCORD_GUILD_ID  = "000000000000000000"
# DISCORD_ROLE_IDS = "111111111111111111,222222222222222222"
```

Secrets:

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler deploy
```

> **Set `DISCORD_GUILD_ID`.** Without it, any Discord account in existence can sign in and
> claim a slot in your firewall group. The Worker will run without it, but you almost
> certainly don't want that.

## What a player sees

1. `https://allow.example.com` → *Sign in with Discord*
2. Discord's consent screen, asking for their username and their membership in your server
3. Their claim page, with their current address and one button

On first sign-in a player row is created automatically, keyed to their Discord user ID.
The slug comes from their username, de-duplicated if it's taken. Their display name
follows their Discord name on each sign-in.

Sessions are signed cookies (HMAC-SHA256, `HttpOnly`, `Secure`, `SameSite=Lax`) lasting
`SESSION_TTL_SECONDS`, default 24 hours. Nothing from Discord is stored beyond the user
ID and display name; no access token, no refresh token.

## Revoking access

- **Remove or demote them in Discord.** Takes effect at their next sign-in. Their existing
  allow-list entry stays until it hits `TTL_DAYS`, so remove it now if it matters:
  `./scripts/admin.sh disable <slug>`.
- **Immediately:** `./scripts/admin.sh disable <slug>`. Their session stops working and
  the agent drops them from the group on its next poll.

Membership is re-checked at sign-in, not on every page load. With the default 24-hour
session, someone kicked from your server keeps their page for at most a day. Shorten
`SESSION_TTL_SECONDS` if that bothers you.

## Running both providers

```toml
AUTH_PROVIDERS = "token,discord"
```

They're independent. A player created by `admin.sh add` has a link and no Discord ID; a
player created by signing in has a Discord ID and no link. Nothing currently merges the
two; if someone needs both, give them the link and let them use it.

## Troubleshooting

**`Invalid OAuth2 redirect_uri`**: the redirect in the Discord app doesn't exactly match
your Worker's origin plus `/auth/discord/callback`. Watch for `http` vs `https`, a
trailing slash, or `www.`.

**"That sign-in couldn't be verified"**: the state cookie was missing or stale, usually
from reusing an old callback URL or a browser blocking cookies. Start from the site root.

**Everyone gets "Not eligible"**: `DISCORD_GUILD_ID` is wrong, or it's a server the
players aren't actually in. Double-check with Developer Mode on.

**Roles never match**: role IDs are per-server; make sure they came from the same guild
as `DISCORD_GUILD_ID`, and that they're role IDs rather than role names.

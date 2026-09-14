# Contributing

Bug reports, fixes and new auth providers are all welcome.

## Getting set up

The Worker runs locally against a local D1:

```bash
cd worker
cp wrangler.toml.example wrangler.toml    # database_id can stay a placeholder for local work
npx wrangler d1 execute unifi-allowlist --local --file=./schema.sql
npx wrangler dev
```

Put development secrets in `worker/.dev.vars` (gitignored):

```
ADMIN_KEY=dev-admin
AGENT_KEY=dev-agent
SESSION_SECRET=dev-session
```

`CF-Connecting-IP` is absent under `wrangler dev`, so the Worker falls back to
`X-Forwarded-For`. Set it by hand to exercise the flow:

```bash
curl -H 'X-Forwarded-For: 203.0.113.42' http://localhost:8787/u/test/TOKEN
```

The agent has no dependencies and no build step:

```bash
node agent/unifi-allowlist-agent.js -c ./my-test-config.json --once --dry-run
```

## Adding an auth provider

A provider answers one question, *which player is this?*, and hands the row
to `handleClaim()`. IP capture, IPv6 handling, auditing and the UI are all shared and
should not be duplicated.

1. Add `worker/src/auth/<name>.js` exporting a handler.
2. Route it in `worker/src/index.js`, gated on the provider appearing in `AUTH_PROVIDERS`.
3. Read its settings in `worker/src/config.js`.
4. Call `handleClaim(request, env, player, '<name>')`. The provider name lands in the audit
   log's `via` column.
5. Document it under `docs/`, and add its settings to the config table in the README.

`worker/src/auth/token.js` is about thirty lines and is the one to copy.

## House style

- Plain JavaScript. No build step, no framework, no runtime dependencies. This has to stay
  easy to read and easy to audit, because it edits a firewall.
- Two-space indent, single quotes, semicolons. Match what is already there.
- Comment the *why*, not the *what*. Most existing comments explain a UniFi quirk or a
  security decision; that is the bar.
- User-facing copy is plain English aimed at someone's non-technical friend, not at you.

## Pull requests

Say what problem it solves and how you tested it, including which UniFi version and
hardware, since the API varies between them. Anything touching the firewall write path
should say what you saw in a `--dry-run` before and after.

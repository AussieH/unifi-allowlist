# Discord alerts

The agent can post to a Discord channel webhook. The agent is the component that knows what
actually reached the firewall, so that is where the alerts come from.

## What you get

- **Added**: after a sync that put an address into the group, e.g. `203.0.113.9` (steve)
- **Removed**: after a sync that took one out, e.g. `203.0.113.9` (steve) (expired, disabled
  or replaced). The agent sees the outcome, not the cause. The audit log (`admin.sh audit`,
  or the admin UI) has the why.
- **Cannot sync**: once, after `failureThreshold` consecutive failures (default 5, so about
  ten minutes at the default poll interval), with the last error. Followed by one
  **recovered** note when it works again.

One message per sync, however many addresses changed. Nothing is posted for a sync that
changes nothing, and dry runs never post.

## Set it up

1. In Discord: channel, *Edit channel*, *Integrations*, *Webhooks*, *New webhook*, copy the URL.
2. Put it in the agent config and restart the agent:

```json
"discordWebhook": "https://discord.com/api/webhooks/...",
"alerts": { "added": true, "removed": true, "failures": true, "failureThreshold": 5, "mention": "" }
```

`mention` is prepended to failure alerts only. `<@123456789012345678>` pings a user,
`<@&...>` a role.

## Notes

- Anyone holding the webhook URL can post to that channel. It lives in `config.json` (mode
  640) and nowhere else. Don't paste it into chats or commits; Discord can regenerate it if
  it leaks.
- Only `https://discord.com/api/webhooks/...` (or `discordapp.com`) URLs are accepted, plus
  `http://127.0.0.1:...` for testing against a local listener. Anything else is ignored and
  no alerts are sent.
- Posts carry an explicit `User-Agent`. Discord is fronted by Cloudflare, which rejects
  requests without one.
- A failed post is logged as a warning and dropped. Alerts never block or fail a sync.
- Names on a *Removed* message come from the previous sync, so after a restart the first
  removal may say "unknown".

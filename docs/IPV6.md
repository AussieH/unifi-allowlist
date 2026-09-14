# IPv6

## The problem

Cloudflare serves proxied hostnames over both IPv4 and IPv6. If a player's browser prefers
IPv6, the Worker sees an IPv6 address, while their game client, connecting to a server
that is almost certainly IPv4-only, comes from a completely different IPv4 address.

Writing that IPv6 address into the allow list would achieve nothing, and overwriting a
working IPv4 entry with it would actively break their access.

## What the Worker does by default

With `ALLOW_IPV6 = "false"` (the default), a claim arriving over IPv6 is **refused**. The
player gets a page explaining what happened, and their existing IPv4 entry is left exactly
as it was. Nothing breaks; they just have to come back over IPv4.

The refusal is recorded in the audit log as `claim_rejected`, so you can see whether this
is happening to people and how often.

## Fixing it properly

**Turn off IPv6 for the zone.** Cloudflare dashboard → your domain → Network → **IPv6
Compatibility** → off. Proxied records then answer with A records only, browsers have no
choice in the matter, and the problem disappears entirely.

It is a zone-wide setting, so if that domain also serves things that want IPv6, put the
Worker on a separate domain instead.

If the toggle is not available on your plan, the fallback is asking affected players to
disable IPv6 on the device or use another network. In practice it is a small minority.

## Supporting IPv6 for real

If your game servers accept IPv6 and you want both families allow-listed:

1. In UniFi, create a second firewall group of type **IPv6 Address/Subnet** and reference
   it from the same rule, or a parallel one.
2. Set `ALLOW_IPV6 = "true"` in `wrangler.toml` and redeploy.
3. Put the new group's ID in the agent's `unifi.groupIdV6`, then restart the agent.

The two families are tracked in separate columns per player, so a visit over one never
clobbers the other. A player who visits over both ends up allow-listed on both.

Be aware that residential IPv6 prefixes rotate too, and privacy extensions change the low
bits of a device's address regularly, so a single /128 can stop matching even while the
prefix is stable. If you hit that, allow-listing the player's /64 by hand through
`staticAllow` is more reliable than anything automatic here.

# Changelog

## Unreleased

- **IPv4 probe** (`probe/`): a tiny IPv4-only service that signs the address a browser reaches
  it from, so players whose browser prefers IPv6 can still claim their IPv4 address. The Worker
  uses it when `IP4_PROBE_URL` and the `IP4_PROBE_KEY` secret are set. See docs/IPV6.md.
- **nftables mode for the agent**: with an `nftables` block in the config (instead of `unifi`),
  the agent keeps local nftables sets in sync, for an internet-facing edge host or VPS in front
  of the game server. Writes are one atomic flush-and-add, and a set emptied by a reboot or a
  ruleset reload is refilled on the next poll. Unit: `agent/systemd/unifi-allowlist-agent-nftables.service`.
- **`EDGE_AGENT_KEY`**: a second agent key whose feed carries addresses only, no player names,
  for agents on hosts you'd rather not trust with the roster.

## 0.1.0

First public release.

- Cloudflare Worker with D1: player pages, token and Discord sign-in, admin API, agent feed,
  audit log, optional country allow-list.
- LAN agent (Node, no dependencies) that syncs the list into a UniFi firewall address-group,
  with `staticAllow`, `minEntries`, TLS verification or pinning, and Discord alerts for added
  and removed addresses and for repeated sync failures.
- Admin UI (Node, no dependencies) with its own password, CSRF protection and login throttling.
- `scripts/admin.sh` for the command line.
- Installers and hardened systemd units for the agent and the UI.
- Docs for setup, Cloudflare, Proxmox, Discord, IPv6, alerts, the admin UI and security.

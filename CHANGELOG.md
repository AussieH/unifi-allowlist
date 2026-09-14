# Changelog

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

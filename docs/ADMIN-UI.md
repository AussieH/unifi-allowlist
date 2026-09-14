# Admin UI

A small web page for the things `scripts/admin.sh` does: list players, add one (and see the
one-time link), rotate a link, enable, disable, delete, and read the audit log.

It runs on your LAN (the agent's container is a natural home) and calls the Worker's `/admin`
API with `ADMIN_KEY`. The key stays in a root-owned config file on that machine; the browser
only ever sees pages.

```
Your browser ── LAN or tailnet, port 8080 ──► admin-ui (Node, no dependencies)
                                                    │ Bearer ADMIN_KEY, outbound HTTPS
                                                    ▼
                                              Cloudflare Worker /admin/*
```

## Why it has its own password

A LAN is not a trust boundary. Guests, IoT devices and anything compromised on your network can
reach port 8080. So the UI signs you in with a password (scrypt-hashed, at least 12 characters),
issues an `HttpOnly` `SameSite=Strict` session cookie signed with a per-install secret, checks a
CSRF token on every change, and allows five sign-in attempts per five minutes per address.
Sessions last 12 hours by default.

There is no JavaScript on the pages and the Content-Security-Policy allows none.

## Install

On the machine (Node 20 or newer):

```bash
sudo ./admin-ui/install.sh
sudoedit /etc/unifi-allowlist/admin-ui.json      # workerUrl, adminKey
sudo node /opt/unifi-allowlist-ui/set-password.js --config /etc/unifi-allowlist/admin-ui.json
sudo systemctl enable --now unifi-allowlist-ui
```

Then open `http://<machine>:8080`. If the container has no `sudo`, run those as root.

## TLS

The UI itself speaks plain HTTP. On a wired home LAN that is a judgement call. To do it
properly, put it behind something that terminates TLS and set `"behindTls": true` so the cookie
gets the `Secure` flag:

- **Tailscale Serve**: `tailscale serve --bg 8080` on the machine, and set `"listen": "127.0.0.1"`
  so the UI is unreachable from the LAN at all. You get `https://<machine>.<tailnet>.ts.net`
  with a certificate managed for you.
- **Caddy**: `allow-admin.lan { reverse_proxy 192.168.x.x:8080 }` with its internal CA.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `listen` | `0.0.0.0` | Interface to bind |
| `port` | `8080` | Port |
| `workerUrl` | (required) | Your Worker, e.g. `https://allow.example.com` |
| `adminKey` | (required) | The Worker's `ADMIN_KEY` |
| `behindTls` | `false` | Mark cookies `Secure` when a proxy terminates HTTPS |
| `sessionHours` | `12` | How long a sign-in lasts |
| `siteName` | `Allow-list admin` | Page heading |
| `sessionSecret` | generated | Signs cookies; `set-password.js` fills it |
| `passwordHash` | (set by `set-password.js`) | scrypt hash of the sign-in password |

To change the password, run `set-password.js` again and restart the service. To sign everyone
out, change `sessionSecret` and restart.

## What it cannot do

It does not set players' addresses. Nothing can, other than the player pressing the button from
that address. It does not touch UniFi either; the agent does that from the Worker's list, as
before.

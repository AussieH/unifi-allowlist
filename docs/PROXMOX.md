# Running the agent on Proxmox

The agent needs almost nothing: one core, 512 MB, a few gigabytes of disk and Node 20+. An
unprivileged Debian LXC is the natural fit. This page is the Proxmox-specific part of
[SETUP.md](SETUP.md), step 3.

## Create the container

On the Proxmox host, as root. Pick a free VMID and a storage; `pveam` lists templates.

```bash
pveam update
pveam available --section system | grep debian-12
pveam download local debian-12-standard_12.12-1_amd64.tar.zst     # or whatever is current

pct create 223 local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname allowlist --cores 1 --memory 512 --swap 256 \
  --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --description "unifi-allowlist agent"
pct start 223
```

Use a bridge that can reach the controller. DHCP is fine; nothing points at the container's
LAN address, though a reservation on the router keeps logs tidy. If you would rather set a
static address: `--net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1`.

## Install Node and the agent

```bash
pct exec 223 -- bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update && apt-get install -y curl ca-certificates gnupg git sudo
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  cd /root && git clone https://github.com/AussieH/unifi-allowlist.git
  ./unifi-allowlist/agent/install.sh
'
```

Then continue with the config, `--list-groups` and the dry run in [SETUP.md](SETUP.md). To edit
the config from the host:

```bash
pct exec 223 -- nano /etc/unifi-allowlist/config.json
```

Notes that only apply to the Proxmox template:

- It has no `sudo` until you install it (done above). `runuser -u unifi-allowlist --` works too.
- Locale warnings from `apt` are harmless; `apt-get install -y locales` and `dpkg-reconfigure
  locales` quiets them.
- The systemd unit's hardening works in an unprivileged container as shipped.

## Optional: the admin UI over Tailscale

If you run the [admin UI](ADMIN-UI.md) in the same container and want it reachable only over
your tailnet, `tailscaled` needs a TUN device. Unprivileged containers do not get one by
default; add two lines to the container's config on the host and restart it:

```bash
cat >> /etc/pve/lxc/223.conf <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
pct reboot 223
```

Then inside the container:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname allowlist          # prints a login URL; approve it in your tailnet
tailscale serve --bg 8080                   # HTTPS on https://allowlist.<tailnet>.ts.net
```

and set `"listen": "127.0.0.1"` and `"behindTls": true` in `admin-ui.json`, so the UI answers
only through Tailscale Serve.

## Backups

The container's config files hold the agent key, the UniFi password and, if you use the UI, the
admin key and password hash. Add the VMID to your `vzdump` job so a rebuild is a restore rather
than a re-setup:

```bash
pvesh get /cluster/backup                        # find the job id
pvesh set /cluster/backup/<job-id> --vmid <existing list>,223
```

## Removing it

```bash
pct stop 223 && pct destroy 223 --purge
```

Then delete the local admin in UniFi, and rotate `AGENT_KEY` (`wrangler secret put AGENT_KEY`)
if anyone else might have read the container's disk.

#!/usr/bin/env bash
#
# Installs the unifi-allowlist agent as a systemd service.
# Run as root on a Debian/Ubuntu LXC or VM inside your network:
#
#   sudo ./install.sh
#
# Idempotent; safe to re-run to upgrade the script in place.

set -euo pipefail

APP_DIR=/opt/unifi-allowlist
CONF_DIR=/etc/unifi-allowlist
SERVICE=unifi-allowlist-agent
USER=unifi-allowlist
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run me as root (sudo ./install.sh)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20 or newer first, e.g.:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Node $NODE_MAJOR is too old; this agent needs Node 20 or newer." >&2
  exit 1
fi

echo "==> Creating service user"
id -u "$USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"

echo "==> Installing agent to $APP_DIR"
install -d -m 0755 "$APP_DIR"
install -m 0755 "$SRC_DIR/unifi-allowlist-agent.js" "$APP_DIR/unifi-allowlist-agent.js"

echo "==> Preparing $CONF_DIR"
install -d -m 0750 -o root -g "$USER" "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
  install -m 0640 -o root -g "$USER" "$SRC_DIR/config.example.json" "$CONF_DIR/config.json"
  NEW_CONFIG=1
else
  echo "    existing config.json left untouched"
  NEW_CONFIG=0
fi

echo "==> Installing systemd unit"
install -m 0644 "$SRC_DIR/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload

if (( NEW_CONFIG )); then
  cat <<EOF

Installed but not started: the config is still the example.

  1. Edit $CONF_DIR/config.json
       workerUrl, agentKey, and the unifi.* block
  2. Find your firewall group ID:
       sudo -u $USER node $APP_DIR/unifi-allowlist-agent.js -c $CONF_DIR/config.json --list-groups
  3. Put that ID in unifi.groupIdV4, then test:
       sudo -u $USER node $APP_DIR/unifi-allowlist-agent.js -c $CONF_DIR/config.json --once --dry-run
  4. Start it:
       sudo systemctl enable --now $SERVICE
       sudo journalctl -u $SERVICE -f
EOF
else
  echo "==> Restarting $SERVICE"
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  systemctl --no-pager --lines=10 status "$SERVICE" || true
fi

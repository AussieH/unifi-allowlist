#!/usr/bin/env bash
#
# Installs the unifi-allowlist admin UI as a systemd service, next to (or without) the agent.
# Run as root on a Debian/Ubuntu LXC or VM inside your network:
#
#   sudo ./install.sh
#
# Idempotent; safe to re-run to upgrade in place.

set -euo pipefail

APP_DIR=/opt/unifi-allowlist-ui
CONF_DIR=/etc/unifi-allowlist
CONF="$CONF_DIR/admin-ui.json"
SERVICE=unifi-allowlist-ui
USER=unifi-allowlist
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run me as root (sudo ./install.sh)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20 or newer first." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Node $NODE_MAJOR is too old; this needs Node 20 or newer." >&2
  exit 1
fi

echo "==> Creating service user"
id -u "$USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER"

echo "==> Installing to $APP_DIR"
install -d -m 0755 "$APP_DIR"
install -m 0755 "$SRC_DIR/server.js" "$APP_DIR/server.js"
install -m 0755 "$SRC_DIR/set-password.js" "$APP_DIR/set-password.js"

echo "==> Preparing $CONF"
install -d -m 0750 -o root -g "$USER" "$CONF_DIR"
if [[ ! -f "$CONF" ]]; then
  install -m 0640 -o root -g "$USER" "$SRC_DIR/config.example.json" "$CONF"
  NEW_CONFIG=1
else
  echo "    existing admin-ui.json left untouched"
  NEW_CONFIG=0
fi

echo "==> Installing systemd unit"
install -m 0644 "$SRC_DIR/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload

if (( NEW_CONFIG )); then
  cat <<EOF

Installed but not started: the config is still the example.

  1. Edit $CONF: workerUrl and adminKey (the ADMIN_KEY you gave the Worker)
  2. Set the sign-in password:
       node $APP_DIR/set-password.js --config $CONF
  3. Start it:
       systemctl enable --now $SERVICE
     then open http://<this machine>:8080
EOF
else
  echo "==> Restarting $SERVICE"
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  systemctl --no-pager --lines=5 status "$SERVICE" || true
fi

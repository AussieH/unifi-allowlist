#!/usr/bin/env bash
#
# Thin curl wrapper around the Worker's /admin API.
#
# Configure once, either via environment or ~/.config/unifi-allowlist/admin.env:
#   WORKER_URL=https://allow.example.com
#   ADMIN_KEY=...            # the value you set with `wrangler secret put ADMIN_KEY`
#
# Usage:
#   ./admin.sh list
#   ./admin.sh add steve "Steve"
#   ./admin.sh rotate steve
#   ./admin.sh disable steve
#   ./admin.sh enable steve
#   ./admin.sh delete steve
#   ./admin.sh audit 50

set -euo pipefail

ENV_FILE="${HOME}/.config/unifi-allowlist/admin.env"
# shellcheck source=/dev/null
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"

: "${WORKER_URL:?set WORKER_URL (e.g. https://allow.example.com)}"
: "${ADMIN_KEY:?set ADMIN_KEY, the secret you gave the Worker}"

WORKER_URL="${WORKER_URL%/}"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer ${ADMIN_KEY}")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "${WORKER_URL}${path}"
}

pretty() {
  if command -v jq >/dev/null 2>&1; then jq .; else cat; fi
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    api GET /admin/players | pretty
    ;;

  add)
    slug="${1:?usage: admin.sh add <slug> [display name]}"
    name="${2:-$slug}"
    echo "Issuing a link for '${slug}'. It is shown once and cannot be recovered —" >&2
    echo "send it to the player over a private channel." >&2
    api POST /admin/players "$(printf '{"slug":"%s","name":"%s"}' "$slug" "$name")" | pretty
    ;;

  rotate)
    slug="${1:?usage: admin.sh rotate <slug>}"
    echo "The old link stops working immediately." >&2
    api POST "/admin/players/${slug}/rotate" | pretty
    ;;

  enable|disable)
    slug="${1:?usage: admin.sh ${cmd} <slug>}"
    api POST "/admin/players/${slug}/${cmd}" | pretty
    ;;

  delete)
    slug="${1:?usage: admin.sh delete <slug>}"
    read -rp "Delete '${slug}' and their allow-list entry? [y/N] " reply
    [[ "$reply" == [yY]* ]] || { echo "Cancelled." >&2; exit 1; }
    api DELETE "/admin/players/${slug}" | pretty
    ;;

  audit)
    limit="${1:-100}"
    api GET "/admin/audit?limit=${limit}" | pretty
    ;;

  *)
    sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac

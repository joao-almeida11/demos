#!/usr/bin/env bash
# deploy.sh
#
# Run this script on the OpenSUSE server to install or update the API.
# Idempotent — safe to re-run on updates.
#
# Usage:
#   First install:  sudo bash deploy.sh install
#   Update code:    sudo bash deploy.sh update
#
# Prerequisite: Node.js 22+ installed via:
#   sudo zypper install nodejs22 npm22
#   OR use nvm: https://github.com/nvm-sh/nvm

set -euo pipefail

APP_DIR="/opt/api"
APP_USER="nodeapp"
LOG_DIR="/var/log/fastify-api"

# ── install ───────────────────────────────────────────────────────────────────

install() {
  echo "==> Creating app user"
  id "$APP_USER" &>/dev/null || \
    useradd -r -s /sbin/nologin -d "$APP_DIR" "$APP_USER"

  echo "==> Creating directories"
  mkdir -p "$APP_DIR"/{uploads,logs,dist}
  mkdir -p "$LOG_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
  chmod 750 "$APP_DIR/uploads"

  echo "==> Installing Nginx"
  zypper --non-interactive install nginx

  echo "==> Copying config files"
  cp nginx/api.conf    /etc/nginx/conf.d/api.conf

  echo "==> Merging nginx.conf rate-limit zones (manual step required)"
  echo "    Review nginx/nginx.conf.additions and merge into /etc/nginx/nginx.conf"
  echo "    Then run: nginx -t && systemctl reload nginx"

  echo "==> Installing systemd unit"
  cp systemd/fastify-api.service /etc/systemd/system/fastify-api.service
  systemctl daemon-reload
  systemctl enable fastify-api

  echo "==> Installing Node.js dependencies"
  cd "$APP_DIR"
  npm ci --omit=dev

  echo "==> Building TypeScript"
  npm run build

  echo "==> Starting services"
  systemctl start fastify-api
  systemctl enable nginx
  systemctl start nginx

  echo ""
  echo "Done! Check status:"
  echo "  systemctl status fastify-api"
  echo "  journalctl -u fastify-api -f"
  echo "  nginx -t"
}

# ── update (zero-downtime deploy) ─────────────────────────────────────────────
#
# systemd's restart strategy for zero-downtime with cluster mode:
#   1. Build new code while old version is still running
#   2. systemctl restart fastify-api
#      → systemd sends SIGTERM to primary
#      → primary forwards SIGTERM to workers
#      → workers finish in-flight requests (up to TimeoutStopSec=300s)
#      → workers exit cleanly
#      → systemd starts fresh primary
#
# This means there IS a brief restart window (~1-2s for Node.js startup).
# If true zero-downtime restarts are critical, consider running TWO systemd
# units (blue/green) behind Nginx and toggling the upstream — but for your
# scale (30-100 users) the restart gap is acceptable.

update() {
  echo "==> Pulling latest code to $APP_DIR"
  cd "$APP_DIR"
  # If using git:
  # git fetch origin
  # git reset --hard origin/main

  echo "==> Installing/updating dependencies"
  npm ci --omit=dev

  echo "==> Building TypeScript"
  npm run build

  echo "==> Restarting Fastify (graceful — in-flight requests drain first)"
  systemctl restart fastify-api

  echo "==> Reload Nginx config (no downtime)"
  nginx -t && systemctl reload nginx

  echo "Done. New version running:"
  systemctl status fastify-api --no-pager
}

# ── logs helper ───────────────────────────────────────────────────────────────

logs() {
  journalctl -u fastify-api -f --output=cat
}

# ── entrypoint ────────────────────────────────────────────────────────────────

case "${1:-help}" in
  install) install ;;
  update)  update  ;;
  logs)    logs    ;;
  *)
    echo "Usage: $0 {install|update|logs}"
    exit 1
    ;;
esac

#!/usr/bin/env bash
# One-command setup of the live listener on an Ubuntu server (e.g. a DigitalOcean droplet).
#
#   curl -fsSL https://raw.githubusercontent.com/vishalsolana/memedashboard/claude/friendly-ptolemy-ig8jx7/deploy/install.sh | bash
#
# Installs Node.js 22 if needed (without touching an older system Node that other
# apps use), downloads the project to ~/memedashboard, runs it as a service that
# restarts on crash/reboot, and opens the dashboard port. Safe to run again to update.
set -euo pipefail

REPO="https://github.com/vishalsolana/memedashboard.git"
BRANCH="claude/friendly-ptolemy-ig8jx7"
DIR="$HOME/memedashboard"
PORT="${PORT:-3100}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "Checking Node.js"
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0; }
if ! command -v node >/dev/null 2>&1; then
  $SUDO apt-get update -y
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
elif [ "$(node_major)" -lt 22 ]; then
  echo "System Node is $(node -v); installing Node 22 with nvm just for this project."
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  set +u # nvm's scripts use unset variables
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
  set -u
fi
NODE_BIN="$(command -v node)"
echo "Using $NODE_BIN ($(node -v))"

command -v git >/dev/null 2>&1 || $SUDO apt-get install -y git

say "Downloading the project to $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  if ! systemctl is-active --quiet memedashboard; then
    echo "Port $PORT is already used by another program. Re-run with another port, e.g.:"
    echo "  curl -fsSL <same link> | PORT=3200 bash"
    exit 1
  fi
fi

say "Installing the service (port $PORT)"
$SUDO tee /etc/systemd/system/memedashboard.service >/dev/null <<EOF
[Unit]
Description=Pump.fun dashboard live listener
After=network-online.target
Wants=network-online.target

[Service]
User=$(whoami)
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN scripts/listen.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable memedashboard >/dev/null 2>&1
$SUDO systemctl restart memedashboard

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow "$PORT/tcp" >/dev/null
fi

sleep 5
IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
say "Done"
$SUDO systemctl --no-pager --lines=5 status memedashboard || true
cat <<EOF

Dashboard:  http://$IP:$PORT   (numbers update every minute; refresh the page)
Logs:       journalctl -u memedashboard -f
Restart:    sudo systemctl restart memedashboard
Update:     run the same install command again

If the page doesn't open, add an inbound rule for TCP $PORT in your DigitalOcean
Cloud Firewall (Networking -> Firewalls), if the droplet has one.
EOF

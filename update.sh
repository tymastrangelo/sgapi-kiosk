#!/bin/bash
# update.sh — pull the latest code onto the Pi and restart. Run it on the Pi.
set -e
cd "$(dirname "$0")"

echo "==> Pulling latest code"
git pull --ff-only

# Only reinstall when the dependency list actually changed — better-sqlite3
# compiles from source here and takes a few minutes.
if ! git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json 2>/dev/null; then
  echo "==> Dependencies changed, reinstalling"
  npm install --omit=dev
fi

echo "==> Restarting the backend"
sudo systemctl restart sgapi-kiosk.service

echo ""
echo "Done. The TV reloads itself within a few seconds."
echo "Uploaded slides and the database were untouched."
sudo systemctl status sgapi-kiosk.service --no-pager -l | head -n 5

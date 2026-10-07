#!/usr/bin/env bash
set -euo pipefail

PROFILE="/tmp/flow-${TARGET_KEY}-profile"
ARCHIVE="/tmp/flow-${TARGET_KEY}-auth.tgz"
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

START_URL="$(node scripts/bootstrap-flow-account-v2.mjs config)"

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
sleep 2

google-chrome   --user-data-dir="$PROFILE"   --remote-debugging-address=127.0.0.1   --remote-debugging-port=9222   --remote-allow-origins='*'   --no-sandbox   --disable-dev-shm-usage   --disable-gpu   --password-store=basic   --no-first-run   --no-default-browser-check   --window-size=1440,900   "$START_URL" >/tmp/chrome.log 2>&1 &

x11vnc -display :99 -rfbport 5900 -nopw -forever -shared -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:6080 >/tmp/cloudflared.log 2>&1 &

URL=""
for i in $(seq 1 75); do
  URL="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' /tmp/cloudflared.log | head -1 || true)"
  if [ -n "$URL" ] && curl -fsS --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
test -n "$URL"

FULL_URL="$URL/vnc.html?autoconnect=true&resize=scale"
FLOW_BOOTSTRAP_URL="$FULL_URL" node scripts/bootstrap-flow-account-v2.mjs announce

node scripts/bootstrap-flow-account-v2.mjs waitsignal
node scripts/bootstrap-flow-account-v2.mjs capture
tar -czf "$ARCHIVE" -C /tmp flow-auth-state.json
FLOW_BOOTSTRAP_ARCHIVE="$ARCHIVE" node scripts/bootstrap-flow-account-v2.mjs upload
node scripts/bootstrap-flow-account-v2.mjs complete

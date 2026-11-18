#!/usr/bin/env bash
# Safe update of only the already-running read-only Hub container.
# No publisher children, profiles, Flow actions, or activation.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd -P)/deploy/oracle-free"
if [ -e "$root/activation/operator-activation.json" ]; then
  echo '[HUB REFRESH] REFUSE: global activation file present'
  exit 2
fi
test -f "$root/.env" && grep -qx '# OCI_HUB_PREVIEW_MANAGED=1' "$root/.env" || {
  echo '[HUB REFRESH] REFUSE: only validated read-only Hub preview may refresh'
  exit 2
}
if [ "$(stat -c %a "$root/.env")" != 600 ]; then
  echo '[HUB REFRESH] REFUSE: Hub password environment permissions are too open'
  exit 2
fi
running="$(sudo docker ps --format '{{.Names}}' | grep -E 'publisher-(fruttidrama|earth-in-10|dinnie)' || true)"
if [ -n "$running" ]; then
  # A future paused child deployment must never be stopped by this script.
  echo '[HUB REFRESH] Paused children already present, preserving them'
fi
echo '[HUB REFRESH] Recreating only read-only Hub with updated code and channel manifest'
sudo docker compose -f "$root/compose.yaml" --project-directory "$root" \
  --profile reconstruction-dashboard up --no-deps -d --force-recreate hub
status=000
for i in $(seq 1 25); do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8081/health || true)"
  [ "$status" = 401 ] && break
  sleep 1
done
if [ "$status" != 401 ]; then
  echo "[HUB REFRESH] FAIL: expected HTTP 401, got $status"
  exit 2
fi
test ! -e "$root/activation/operator-activation.json" || {
  echo '[HUB REFRESH] FAIL: global activation appeared unexpectedly'; exit 2;
}
echo '[HUB REFRESH] PASS: new code loaded, password unchanged, activation OFF'

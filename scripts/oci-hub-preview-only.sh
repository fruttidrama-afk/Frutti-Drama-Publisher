#!/usr/bin/env bash
# Deliberately start ONLY the paused, local-only inspection dashboard.
# No publisher, Flow browser, scheduler, video transfer, or activation.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
bash scripts/oci-host-preflight.sh
root="$(pwd -P)"
dir="$root/deploy/oracle-free"
test -f "$dir/hub/channels.json" || { echo '[HUB PREVIEW] Missing reviewed manifest'; exit 2; }
test ! -e "$dir/activation/operator-activation.json" || {
  echo '[HUB PREVIEW] REFUSE: activation file exists'
  exit 2
}
if command -v ss >/dev/null && ss -lntH | awk '$4 ~ /:8081$/ {found=1} END {exit !found}'; then
  echo '[HUB PREVIEW] REFUSE: 8081 already listening; no changes made'
  exit 2
fi
# Never overwrite a real operational .env. Only recognize our own tiny preview .env.
if [ -e "$dir/.env" ]; then
  if [ "$(wc -l < "$dir/.env")" -ne 3 ] \
    || ! grep -qx '# OCI_HUB_PREVIEW_MANAGED=1' "$dir/.env" \
    || ! grep -qx 'PUBLISHER_HUB_USER=operator' "$dir/.env" \
    || ! grep -Eq '^PUBLISHER_HUB_PASSWORD=[a-f0-9]{64}$' "$dir/.env"; then
    echo '[HUB PREVIEW] REFUSE: foreign .env; never overwrite credentials'
    exit 2
  fi
  password="$(sed -n 's/^PUBLISHER_HUB_PASSWORD=//p' "$dir/.env")"
else
  command -v openssl >/dev/null || { echo '[HUB PREVIEW] Missing openssl'; exit 2; }
  password="$(openssl rand -hex 32)"
  ( set -C; printf '# OCI_HUB_PREVIEW_MANAGED=1\nPUBLISHER_HUB_USER=operator\nPUBLISHER_HUB_PASSWORD=%s\n' "$password" > "$dir/.env" )
  chmod 600 "$dir/.env"
fi
mkdir -p "$dir/activation" "$dir/reconciliation" "$dir/reconciliation-media" "$dir/data"
command -v curl >/dev/null || { echo '[HUB PREVIEW] Missing curl'; exit 2; }
echo '[HUB PREVIEW] Starting reconstruction dashboard only, activation hard-disarmed'
sudo docker compose -f "$dir/compose.yaml" --project-directory "$dir" \
  --profile reconstruction-dashboard up --no-deps -d hub
# Authenticated-only health endpoint must return 401 to an anonymous caller.
status=000
for i in $(seq 1 30); do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8081/health || true)"
  [ "$status" = 401 ] && break
  sleep 1
done
if [ "$status" != 401 ]; then
  echo "[HUB PREVIEW] FAIL: health endpoint HTTP $status, expected 401"
  exit 2
fi
test ! -e "$dir/activation/operator-activation.json" || {
  echo '[HUB PREVIEW] FAIL: activation file unexpectedly appeared'; exit 2;
}
publisher_count="$(sudo docker ps --format '{{.Names}}' | grep -Ec '(^|[-_])(publisher-fruttidrama|publisher-dinnie|publisher-earth-in-10)([-_]|$)' || true)"
test "$publisher_count" -eq 0 || { echo '[HUB PREVIEW] FAIL: publisher containers present'; exit 2; }
echo '[HUB PREVIEW] PASS: localhost-only; password required; 0 publishers; automation OFF'
echo 'HUB PREVIEW USER: operator'
echo 'HUB PREVIEW PASSWORD: stored privately in deploy/oracle-free/.env; do not include it in support logs or chat'
echo 'To view from Windows, connect an SSH local tunnel (-L 8081:127.0.0.1:8081), then open http://127.0.0.1:8081/'

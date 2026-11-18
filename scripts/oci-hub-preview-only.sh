#!/usr/bin/env bash
# Start ONLY the paused inspection dashboard on the operator's OCI staging VM.
# No publisher, Flow session, media transfer, job scheduler, or activation.
# Requires deliberate human invocation on the VM and SSH tunnel for access.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
bash scripts/oci-host-preflight.sh
root="$(pwd -P)"
dir="$root/deploy/oracle-free"
test -f "$dir/hub/channels.json" || { echo '[HUB PREVIEW] Missing reviewed channel manifest'; exit 2; }
test ! -e "$dir/activation/operator-activation.json" || {
  echo '[HUB PREVIEW] REFUSE: global activation file exists'; exit 2;
}
# Do not touch a previously configured publisher or OAuth environment.
if [ -e "$dir/.env" ]; then
  echo '[HUB PREVIEW] REFUSE: deployment .env already exists; do not overwrite credentials'
  exit 2
fi
if command -v ss >/dev/null && ss -lntH | awk '$4 ~ /:8081$/ {found=1} END {exit !found}'; then
  echo '[HUB PREVIEW] REFUSE: port 8081 is already in use'
  exit 2
fi
command -v openssl >/dev/null || { echo '[HUB PREVIEW] Missing openssl'; exit 2; }
password="$(openssl rand -hex 32)"
test "${#password}" -eq 64
mkdir -p "$dir/activation" "$dir/reconciliation" "$dir/reconciliation-media" "$dir/data"
# Explicitly do not create a central activation file, publisher data, or media.
( set -C; printf 'PUBLISHER_HUB_USER=operator\nPUBLISHER_HUB_PASSWORD=%s\n' "$password" > "$dir/.env" )
chmod 600 "$dir/.env"
echo '[HUB PREVIEW] Starting only reconstruction-dashboard/hub (activation hard-disarmed)'
sudo docker compose -f "$dir/compose.yaml" --project-directory "$dir" \
  --profile reconstruction-dashboard up --no-deps -d hub
# localhost-only checks: 401 is correct without the private operator password.
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8081/health || true)"
if [ "$status" != "401" ]; then
  echo "[HUB PREVIEW] FAIL: expected authenticated localhost-only hub, got HTTP $status"
  exit 2
fi
test ! -e "$dir/activation/operator-activation.json" || {
  echo '[HUB PREVIEW] FAIL: global activation appeared unexpectedly'; exit 2;
}
publisher_count="$(sudo docker ps --format '{{.Names}}' | grep -Ec '(^|[-_])(publisher-fruttidrama|publisher-dinnie|publisher-earth-in-10)([-_]|$)' || true)"
test "$publisher_count" -eq 0 || { echo '[HUB PREVIEW] FAIL: publisher was started'; exit 2; }
echo '[HUB PREVIEW] PASS: localhost-only, basic authentication enforced, 0 publisher containers, activation OFF'
echo 'HUB PREVIEW USER: operator'
echo "HUB PREVIEW PASSWORD (PRIVATE; do not paste in chat): $password"
echo 'ACCESS: via SSH tunnel from Windows: -L 8081:127.0.0.1:8081 ; then http://127.0.0.1:8081/'

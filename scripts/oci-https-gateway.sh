#!/usr/bin/env bash
# Separate, explicit opt-in public HTTPS entrypoint; NEVER activates publishers.
# Run from SSH on the real Oracle host after OCI TCP/80 and TCP/443 ingress rules.
# Commands: check (read-only), enable (starts Caddy only), status (read-only).
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-check}"
case "$MODE" in check|enable|status) ;; *) echo 'Usage: bash scripts/oci-https-gateway.sh check|enable|status'; exit 2;; esac
base="$(pwd -P)/deploy/oracle-free"
ip="${PUBLISHER_EXPECTED_PUBLIC_IP:-129.146.3.38}"
if ! [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo '[HTTPS] REFUSE: invalid operator-verified IPv4'
  exit 2
fi
host="${ip//./-}.sslip.io"
[ -f "$base/https/Caddyfile" ] || { echo '[HTTPS] Missing TLS configuration'; exit 2; }
if [ "$MODE" = status ]; then
  echo "[HTTPS] expected_hostname=$host"
  echo '[HTTPS] public gateway status:'
  sudo docker ps --filter 'name=https-gateway' --format '{{.Names}} {{.Status}} {{.Ports}}'
  curl -sS -o /dev/null -w '[HTTPS] local_hub_http=%{http_code}\n' --max-time 5 http://127.0.0.1:8081/health || true
  curl -sS -o /dev/null -w '[HTTPS] public_https_http=%{http_code} tls_verify=%{ssl_verify_result}\n' --max-time 8 "https://$host/health" || true
  exit 0
fi
echo '[HTTPS] Confirming staging Hub and disabled factory'
test ! -e "$base/activation/operator-activation.json" || {
  echo '[HTTPS] REFUSE: global factory activation file exists'; exit 2;
}
test -f "$base/.env" || { echo '[HTTPS] REFUSE: Hub preview .env missing'; exit 2; }
test "$(stat -c %a "$base/.env")" = 600 || { echo '[HTTPS] REFUSE: Hub .env must have mode 600'; exit 2; }
grep -qx '# OCI_HUB_PREVIEW_MANAGED=1' "$base/.env" || { echo '[HTTPS] REFUSE: Hub is not a controlled preview'; exit 2; }
grep -Eq '^PUBLISHER_HUB_PASSWORD=[a-f0-9]{64}$' "$base/.env" || {
  echo '[HTTPS] REFUSE: Hub password not verified strong'; exit 2;
}
local_health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1:8081/health || true)"
[ "$local_health" = 401 ] || { echo "[HTTPS] REFUSE: Hub localhost health returned $local_health, expected 401"; exit 2; }
if command -v ss >/dev/null; then
  if ss -lntH | grep -E '(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]):8081([[:space:]]|$)'; then
    echo '[HTTPS] REFUSE: port 8081 accessible outside localhost'
    exit 2
  fi
fi
running="$(sudo docker ps --format '{{.Names}}' | grep -E 'publisher-(fruttidrama|dinnie|earth-in-10)' || true)"
[ -z "$running" ] || { echo '[HTTPS] REFUSE: publisher containers already running'; exit 2; }
resolved="$(getent ahostsv4 "$host" | awk '{print $1;exit}')"
[ "$resolved" = "$ip" ] || {
  echo "[HTTPS] REFUSE: public DNS ($resolved) does not match expected host IP ($ip)"
  exit 2
}
echo "[HTTPS] CHECK PASS: localhost hub 401, DNS $host -> $ip, factory OFF"
echo '[HTTPS] This does not prove public TCP/80+443 ingress or certificate issuance.'
if [ "$MODE" = check ]; then exit 0; fi
echo '[HTTPS] Enabling ONLY the optional Caddy HTTPS gateway; publisher children remain STOPPED'
sudo env PUBLISHER_HTTPS_HOSTNAME="$host" docker compose \
  -f "$base/compose.yaml" --project-directory "$base" \
  --profile explicit-https-gateway up --no-deps -d https-gateway
test ! -e "$base/activation/operator-activation.json" || {
  echo '[HTTPS] FAIL: factory activation file appeared unexpectedly'; exit 2;
}
echo "[HTTPS] Published hostname (pending Oracle ingress and ACME verification): https://$host/"
echo '[HTTPS] Caddy obtains trusted certs only when TCP 80+443 reach the host.'
echo '[HTTPS] Automation OFF; no publisher children started.'

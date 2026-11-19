#!/usr/bin/env bash
# Fully offline, disposable proof: no public traffic, real Cloudflare or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
source_script="$(pwd -P)/scripts/oci-quick-tunnel-preview.sh"
bash -n "$source_script"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/scripts" "$root/deploy/oracle-free" "$root/bin" "$root/home"
cp "$source_script" "$root/scripts/oci-quick-tunnel-preview.sh"
cat >"$root/deploy/oracle-free/compose.yaml" <<'S'
  PUBLISHER_HUB_ACTIVATION_ARMED: "false"
S
{
 echo '# OCI_HUB_PREVIEW_MANAGED=1'
 printf 'PUBLISHER_HUB_PASSWORD=%064d\n' 0
}>"$root/deploy/oracle-free/.env"
chmod 600 "$root/deploy/oracle-free/.env"
cat > "$root/bin/curl" <<'S'
#!/bin/bash
printf '401'
S
cat > "$root/bin/ss" <<'S'
#!/bin/bash
exit 0
S
cat > "$root/bin/cloudflared" <<'S'
#!/bin/bash
echo 'INF Your quick Tunnel has been created! Visit it at https://factory-test.trycloudflare.com'
while true; do sleep 30; done
S
chmod +x "$root/bin"/*
export PATH="$root/bin:$PATH" HOME="$root/home"
cd "$root"
if bash scripts/oci-quick-tunnel-preview.sh start >"$root/negative.out" 2>&1; then
 echo '[QUICK HTTPS OFFLINE] FAIL: accepted missing permitted email'; exit 1
fi
grep -q 'requires one exact allowed email' "$root/negative.out"
bash scripts/oci-quick-tunnel-preview.sh check
bash scripts/oci-quick-tunnel-preview.sh start 'admin@example.com'
bash scripts/oci-quick-tunnel-preview.sh status
bash scripts/oci-quick-tunnel-preview.sh stop
mkdir -p "$root/deploy/oracle-free/activation"
echo '{}' >"$root/deploy/oracle-free/activation/operator-activation.json"
if bash scripts/oci-quick-tunnel-preview.sh start 'admin@example.com' >"$root/negative.out" 2>&1; then
 echo '[QUICK HTTPS OFFLINE] FAIL: accepted activated gate'; exit 1
fi
grep -q 'factory activation file exists' "$root/negative.out"
echo '[QUICK HTTPS OFFLINE] PASS: required email PIN, Hub guard, lifecycle, activation refusal'

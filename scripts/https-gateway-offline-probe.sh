#!/usr/bin/env bash
# CI-only code/config checks. Never creates .env, contacts Oracle, starts
# an HTTP listener, opens network ingress, or authorizes production actions.
set -euo pipefail
cd "$(dirname "$0")/.."
bash -n scripts/oci-https-gateway.sh
test ! -e deploy/oracle-free/activation/operator-activation.json
test ! -e deploy/oracle-free/.env
python3 - <<'PY'
from pathlib import Path
caddy=Path('deploy/oracle-free/https/Caddyfile').read_text()
compose=Path('deploy/oracle-free/compose.yaml').read_text()
assert caddy.count('reverse_proxy')==1, 'HTTPS gateway may only have one reverse proxy'
assert 'reverse_proxy hub:8081' in caddy, 'Gateway must forward to authenticated Hub'
assert '{$PUBLISHER_HTTPS_HOSTNAME}' in caddy, 'No implicit public hostname allowed'
for forbidden in ['publisher-fruttidrama:8080','publisher-earth-in-10:8080','publisher-dinnie:8080',
                  '0.0.0.0:8080','0.0.0.0:8081','127.0.0.1:8080']:
  assert forbidden not in caddy, 'Gateway must not directly expose publisher: '+forbidden
assert 'profiles: ["explicit-https-gateway"]' in compose
assert 'PUBLISHER_HUB_ACTIVATION_ARMED: "false"' in compose
print('[HTTPS GATEWAY OFFLINE] PASS: TLS gateway separate, only hub proxied, activation hard-OFF')
PY
# Code must refuse a production public setup when a safe preview .env is absent.
# No real hostname lookup or network access is needed for this negative test.
if bash scripts/oci-https-gateway.sh check > /tmp/https-offline-guard.out 2>&1; then
 echo '[HTTPS GATEWAY OFFLINE] FAIL: preflight accepted absent Hub secrets'
 exit 1
fi
grep -q 'Hub preview .env missing' /tmp/https-offline-guard.out
rm -f /tmp/https-offline-guard.out

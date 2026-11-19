#!/usr/bin/env bash
# One-command OCI A1 offline acceptance after updating the safety branch.
# The image BUILD can download public Debian/npm dependencies. The two runtime
# TESTS are fully network-isolated and never use production credentials,
# databases, Flow sessions, YouTube/Meta tokens, or exposed host ports.
# Never starts the actual three publisher services or activates the factory.
set -euo pipefail
cd "$(dirname "$0")/.."
echo '[OCI ACCEPTANCE] Checking host and stopped factory'
bash scripts/oci-host-preflight.sh
if [ -e deploy/oracle-free/activation/operator-activation.json ]; then
  echo '[OCI ACCEPTANCE] REFUSE: activation control file exists; inspect it before image testing'
  exit 2
fi
echo '[OCI ACCEPTANCE] Validating isolated Compose configuration without deploying'
bash scripts/oci-compose-offline-probe.sh
echo '[OCI ACCEPTANCE] Building local ARM64 safety image (public package downloads only)'
sudo docker build --pull=false --tag publisher-factory-a1-safety:acceptance .
echo '[OCI ACCEPTANCE] Testing Chromium WITHOUT ANY NETWORK or mounts'
sudo docker run --rm --network none --cap-drop=ALL \
  --security-opt no-new-privileges \
  --entrypoint node publisher-factory-a1-safety:acceptance \
  ./scripts/oci-browser-offline-probe.mjs
echo '[OCI ACCEPTANCE] Testing full paused runtime WITHOUT ANY NETWORK or mounts'
sudo docker run --rm --network none --cap-drop=ALL \
  --security-opt no-new-privileges \
  --entrypoint node publisher-factory-a1-safety:acceptance \
  ./scripts/oci-runtime-offline-probe.mjs
echo '[OCI ACCEPTANCE] PASS: safe ARM64 build, Chrome, paused runtime, multi-show Compose; factory still OFF'

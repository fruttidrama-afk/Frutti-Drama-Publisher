#!/usr/bin/env bash
# On the OCI host: start all THREE child panels in PAUSED state only.
# Does not authenticate to Flow, submit, download, recover, schedule, publish,
# import historical episodes, or create an operator activation file.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
root="$(pwd -P)/deploy/oracle-free"
test ! -e "$root/activation/operator-activation.json" || {
  echo '[CHILD STAGING] REFUSE: global activation file already present'; exit 2;
}
test -f "$root/.env" && grep -qx '# OCI_HUB_PREVIEW_MANAGED=1' "$root/.env" || {
  echo '[CHILD STAGING] REFUSE: only the previously verified paused Hub preview is supported'; exit 2;
}
command -v openssl >/dev/null || { echo '[CHILD STAGING] Missing OpenSSL'; exit 2; }
ids=(fruttidrama earth-in-10 dinnie)
for id in "${ids[@]}"; do
  env_file="$root/channels/$id.env"
  if [ -e "$env_file" ]; then
    grep -qx '# OCI_PAUSED_CHILD_PREVIEW=1' "$env_file" || {
      echo "[CHILD STAGING] REFUSE: foreign existing config: $id"; exit 2;
    }
    grep -Eq '^PUBLISHER_SESSION_SECRET=[a-f0-9]{64}$' "$env_file" || {
      echo "[CHILD STAGING] REFUSE: invalid publisher signing secret: $id"; exit 2;
    }
    grep -Eq '^PUBLISHER_SETUP_TOKEN=[a-f0-9]{64}$' "$env_file" || {
      echo "[CHILD STAGING] REFUSE: invalid setup credential: $id"; exit 2;
    }
  elif [ -e "$root/data/$id" ]; then
    echo "[CHILD STAGING] REFUSE: existing state without managed staging config: $id"
    exit 2
  fi
done
# No dangerous partial overwrites: all prior configs were checked above.
for id in "${ids[@]}"; do
  env_file="$root/channels/$id.env"
  if [ ! -e "$env_file" ]; then
    tmp="$(mktemp "$root/channels/.staging-$id.XXXXXX")"
    {
      echo '# OCI_PAUSED_CHILD_PREVIEW=1'
      cat "$root/channels/$id.env.example"
      printf 'PUBLISHER_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
      printf 'PUBLISHER_SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)"
    } > "$tmp"
    chmod 600 "$tmp"
    mv -n "$tmp" "$env_file"
    rm -f "$tmp"
  fi
done
echo '[CHILD STAGING] Launching paused children only; central gate remains absent'
sudo docker compose -f "$root/compose.yaml" --project-directory "$root" \
  --profile explicit-publisher up --no-deps -d \
  publisher-fruttidrama publisher-earth-in-10 publisher-dinnie
ports=(8080 8082 8083)
for n in 0 1 2; do
  id="${ids[$n]}"
  port="${ports[$n]}"
  ok=false
  for retry in $(seq 1 45); do
    response="$(curl -sS --max-time 3 "http://127.0.0.1:$port/factory/health" || true)"
    if printf '%s' "$response" | python3 -c '
import json,sys
try: x=json.load(sys.stdin)
except Exception: sys.exit(1)
sys.exit(0 if x.get("ok") is True and x.get("operator_activated") is False and x.get("publisher_enabled") is False else 1)
' >/dev/null 2>&1; then
      ok=true
      break
    fi
    sleep 2
  done
  [ "$ok" = true ] || {
    echo "[CHILD STAGING] FAIL: $id did not reach paused health on $port"
    exit 2
  }
  echo "[CHILD STAGING] PASS $id: HTTP health, generation/publication OFF"
done
test ! -e "$root/activation/operator-activation.json" || {
  echo '[CHILD STAGING] FAIL: operator activation file appeared'; exit 2;
}
echo '[CHILD STAGING] ALL 3 PAUSED: Hub cards should now read PAUSADA after refresh.'
echo '[CHILD STAGING] Publication auth and Flow project are unconfigured, so activation remains locked.'

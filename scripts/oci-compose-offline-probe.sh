#!/usr/bin/env bash
# Parse Docker Compose draft without loading .env, creating containers,
# connecting networks, modifying host state, or reading production secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
sudo docker compose --profile explicit-publisher --profile reconstruction-dashboard \
  -f deploy/oracle-free/compose.yaml config --no-env-resolution --format json > "$out"
python3 - "$out" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: doc=json.load(f)
services=doc.get('services') or {}
assert set(services)=={'publisher','hub'}, f'Unexpected service list: {list(services)}'
publisher=services['publisher']; hub=services['hub']
assert 'explicit-publisher' in publisher.get('profiles',[]), 'Publisher must require opt-in Compose profile'
assert 'reconstruction-dashboard' in hub.get('profiles',[]), 'Hub must require opt-in Compose profile'
assert publisher.get('environment',{}).get('PUBLISHER_ENABLED')=='false', 'Publisher env must be hard-disabled'
assert hub.get('environment',{}).get('PUBLISHER_HUB_ACTIVATION_ARMED')=='false', 'Hub activation must be hard-disarmed'
for label,service,target in [('publisher',publisher,8080),('hub',hub,8081)]:
 ports=service.get('ports') or []
 assert len(ports)==1, f'{label}: service must have a single private host port'
 port=ports[0]
 assert port.get('host_ip')=='127.0.0.1', f'{label}: must bind localhost only'
 assert int(port.get('target'))==target, f'{label}: incorrect destination port'
 mounts=hub.get('volumes') or []
media=[v for v in mounts if v.get('target')=='/data/reconciliation-media']
assert len(media)==1 and media[0].get('read_only') is True, 'Historical source MP4 mount must be read-only'
activation=[v for v in (publisher.get('volumes') or []) if v.get('target')=='/activation']
assert len(activation)==1 and activation[0].get('read_only') is True, 'Publisher must never write the global activation switch'
assert publisher.get('restart')=='unless-stopped' and hub.get('restart')=='unless-stopped', 'Services must have explicit restart policies'
print('[OCI COMPOSE OFFLINE] PASS',json.dumps({
 'services':sorted(services),
 'publisher_profile':'explicit-publisher','hub_profile':'reconstruction-dashboard',
 'operator_activation':'OFF','publisher_generation':'OFF',
 'host_ports':'loopback-only','source_media':'read-only','containers_started':0
},sort_keys=True))
PY

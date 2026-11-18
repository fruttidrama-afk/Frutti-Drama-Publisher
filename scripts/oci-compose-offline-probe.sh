#!/usr/bin/env bash
# Validate a disposable copy of the deployment file with an empty fixture
# .env. Never read or create deploy/oracle-free/.env in the actual repository.
set -euo pipefail
cd "$(dirname "$0")/.."
# Compose points at the real code only after manual deployment; this probe
# validates syntax and required mounts but never reads any local secrets.
for file in Dockerfile factory-hub.mjs reconciliation-studio.mjs public/reconciliation.html; do
  test -f "$file" || { echo "[OCI COMPOSE OFFLINE] FAIL: missing mount/build source $file"; exit 1; }
done
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/deploy/oracle-free/channels"
cp deploy/oracle-free/compose.yaml "$root/deploy/oracle-free/compose.yaml"
: > "$root/deploy/oracle-free/.env"
chmod 600 "$root/deploy/oracle-free/.env"
for id in fruttidrama earth-in-10 dinnie; do
  cp "deploy/oracle-free/channels/$id.env.example" "$root/deploy/oracle-free/channels/$id.env"
  chmod 600 "$root/deploy/oracle-free/channels/$id.env"
done
out="$root/composed.json"
(cd "$root" && sudo docker compose --profile explicit-publisher --profile reconstruction-dashboard \
  -f deploy/oracle-free/compose.yaml config --no-env-resolution --format json > "$out")
python3 - "$out" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: doc=json.load(f)
services=doc.get('services') or {}
required={'publisher-fruttidrama','publisher-earth-in-10','publisher-dinnie','hub'}
assert set(services)==required, f'Unexpected service list: {list(services)}'
hub=services['hub']
assert 'reconstruction-dashboard' in hub.get('profiles',[]),'Hub requires opt-in profile'
assert hub.get('environment',{}).get('PUBLISHER_HUB_ACTIVATION_ARMED')=='false','Hub must stay disarmed'
assert hub.get('environment',{}).get('PUBLISHER_HUB_DATA_ROOT')=='/data/publisher','Hub child DBs must be contained in isolated data root'
hostports={'hub':8081}
for channel,port in [('fruttidrama',8080),('earth-in-10',8082),('dinnie',8083)]:
 label='publisher-'+channel;publisher=services[label];hostports[label]=port
 assert 'explicit-publisher' in publisher.get('profiles',[]),f'{label}: no opt-in Compose profile'
 env=publisher.get('environment') or {}
 assert env.get('PUBLISHER_ENABLED')=='false',f'{label}: publisher must stay hard-OFF'
 assert env.get('PUBLISHER_CHANNEL_ID')==channel,f'{label}: wrong show identity'
 assert env.get('PUBLISHER_GLOBAL_ACTIVATION_FILE')=='/activation/operator-activation.json',f'{label}: wrong central gate'
 assert env.get('PUBLISHER_GLOBAL_FLOW_LOCK_PATH')=='/flow-lock/flow.lock',f'{label}: not using shared credit/browser lock'
 volume=publisher.get('volumes') or []
 db=[v for v in volume if v.get('target')=='/data']
 assert len(db)==1 and db[0].get('source','').endswith('/data/'+channel),f'{label}: must use private SQLite and Flow profile'
 activation=[v for v in volume if v.get('target')=='/activation']
 assert len(activation)==1 and activation[0].get('read_only') is True,f'{label}: must not modify global gate'
 assert publisher.get('restart')=='unless-stopped',f'{label}: missing restart policy'
for label,target in hostports.items():
 service=services[label]
 ports=service.get('ports') or []
 assert len(ports)==1,f'{label}: expected one private host port'
 port=ports[0]
 assert port.get('host_ip')=='127.0.0.1',f'{label}: must bind to localhost only'
 assert int(port.get('published'))==target,f'{label}: wrong loopback port'
 assert int(port.get('target'))==(8081 if label=='hub' else 8080),f'{label}: wrong target port'
mounts=hub.get('volumes') or []
media=[v for v in mounts if v.get('target')=='/data/reconciliation-media']
assert len(media)==1 and media[0].get('read_only') is True, 'Historical source MP4 mount must be read-only'
assert hub.get('restart')=='unless-stopped','Hub needs explicit restart policy'
assert sum(float(service.get('cpus',0)) for service in services.values())<=2.0,'A1 CPU allocation would exceed 2 available OCPUs'
print('[OCI COMPOSE OFFLINE] PASS',json.dumps({
 'services':sorted(services),'isolated_children':3,
 'publisher_profile':'explicit-publisher','hub_profile':'reconstruction-dashboard',
 'operator_activation':'OFF','publisher_generation':'OFF','shared_flow_lock':True,
 'host_ports':'loopback-only','source_media':'read-only','containers_started':0
},sort_keys=True))
PY

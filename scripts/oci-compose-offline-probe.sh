#!/usr/bin/env bash
# Validate a disposable copy of the deployment file with an empty fixture
# .env. Never read or create deploy/oracle-free/.env in the actual repository.
set -euo pipefail
cd "$(dirname "$0")/.."
# Compose points at the real code only after manual deployment; this probe
# validates syntax and required mounts but never reads any local secrets.
for file in Dockerfile factory-hub.mjs reconciliation-studio.mjs public/reconciliation.html deploy/oracle-free/https/Caddyfile; do
  test -f "$file" || { echo "[OCI COMPOSE OFFLINE] FAIL: missing mount/build source $file"; exit 1; }
done
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/deploy/oracle-free/channels" "$root/deploy/oracle-free/https"
cp deploy/oracle-free/https/Caddyfile "$root/deploy/oracle-free/https/Caddyfile"
cp deploy/oracle-free/compose.yaml "$root/deploy/oracle-free/compose.yaml"
: > "$root/deploy/oracle-free/.env"
chmod 600 "$root/deploy/oracle-free/.env"
for id in fruttidrama earth-in-10 dinnie; do
  cp "deploy/oracle-free/channels/$id.env.example" "$root/deploy/oracle-free/channels/$id.env"
  chmod 600 "$root/deploy/oracle-free/channels/$id.env"
done
out="$root/composed.json"
(cd "$root" && sudo docker compose --profile explicit-publisher --profile reconstruction-dashboard --profile explicit-https-gateway \
  -f deploy/oracle-free/compose.yaml config --no-env-resolution --format json > "$out")
python3 - "$out" <<'PY'
import json,sys
with open(sys.argv[1],encoding='utf-8') as f: doc=json.load(f)
services=doc.get('services') or {}
required={'publisher-fruttidrama','publisher-earth-in-10','publisher-dinnie','hub','https-gateway'}
assert set(services)==required, f'Unexpected service list: {list(services)}'
hub=services['hub']
assert 'reconstruction-dashboard' in hub.get('profiles',[]),'Hub requires opt-in profile'
assert hub.get('environment',{}).get('PUBLISHER_HUB_ACTIVATION_ARMED')=='false','Hub must stay disarmed'
assert hub.get('environment',{}).get('PUBLISHER_HUB_DATA_ROOT')=='/data/publisher','Hub child DBs must be contained in isolated data root'
gateway=services['https-gateway']
assert 'explicit-https-gateway' in gateway.get('profiles',[]), 'HTTPS gateway requires separate opt-in'
assert gateway.get('environment',{}).get('PUBLISHER_HTTPS_HOSTNAME')=='not-configured.invalid', 'Domain must be unset by default'
assert gateway.get('image','').startswith('caddy:'), 'HTTPS gateway requires Caddy'
assert gateway.get('depends_on',{}).get('hub'), 'HTTPS gateway must proxy only Hub'
assert len(gateway.get('ports') or [])==2, 'HTTPS gateway must expose only 80/443'
assert sorted(int(p.get('published')) for p in gateway['ports'])==[80,443], 'HTTPS gateway ports must be 80/443'
assert all(p.get('host_ip')=='0.0.0.0' for p in gateway['ports']), 'HTTPS gateway public host binding mismatch'
assert all(p.get('protocol','tcp')=='tcp' for p in gateway['ports']), 'Public UDP exposure forbidden'
assert any(v.get('target')=='/etc/caddy/Caddyfile' and v.get('read_only') for v in gateway.get('volumes',[])), 'HTTPS config must be immutable'
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
def memory_bytes(value):
 if isinstance(value,(int,float)):return int(value)
 raw=str(value or '0').strip().lower()
 multipliers={'':1,'b':1,'k':1024,'kb':1024,'ki':1024,'kib':1024,
  'm':1024**2,'mb':1024**2,'mi':1024**2,'mib':1024**2,
  'g':1024**3,'gb':1024**3,'gi':1024**3,'gib':1024**3}
 import re
 m=re.fullmatch(r'(\d+(?:\.\d+)?)([a-z]*)',raw)
 assert m and m.group(2) in multipliers,f'Unrecognized memory limit: {raw}'
 return int(float(m.group(1))*multipliers[m.group(2)])
ram={name:memory_bytes(service.get('mem_limit',0)) for name,service in services.items()}
assert all(x>0 for x in ram.values()),'Every service requires a strict memory cap'
assert sum(ram.values())<10*1024**3,'Aggregate container limits leave too little headroom for the 11 GiB host'
print('[OCI COMPOSE OFFLINE] PASS',json.dumps({
 'services':sorted(services),'isolated_children':3,
 'publisher_profile':'explicit-publisher','hub_profile':'reconstruction-dashboard',
 'operator_activation':'OFF','publisher_generation':'OFF','shared_flow_lock':True,
 'host_ports':'hub+children=loopback; https=opt-in-80/443','source_media':'read-only','containers_started':0,
 'memory_budget_gib':round(sum(ram.values())/1024**3,2)
},sort_keys=True))
PY

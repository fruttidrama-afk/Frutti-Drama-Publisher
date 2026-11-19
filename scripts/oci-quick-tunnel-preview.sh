#!/usr/bin/env bash
# Temporary HTTPS preview without OCI Console, open ingress, domain or Cloudflare account.
# Cloudflare email PIN -> existing authenticated localhost Hub only.
# No generation, recovery, publication, activation or child ports.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
base="$(pwd -P)/deploy/oracle-free"
private="$base/.quick-tunnel"
pidfile="$private/cloudflared.pid"
logfile="$private/cloudflared.log"
mode="${1:-check}"
usage(){ echo 'Usage: bash scripts/oci-quick-tunnel-preview.sh check | start your@email.com | status | stop'; }
case "$mode" in check|start|status|stop) ;; *) usage; exit 2;; esac
running(){
  test -f "$pidfile" || return 1
  local pid args
  IFS= read -r pid < "$pidfile" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  args="$(ps -ww -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$args" == *cloudflared* && "$args" == *'tunnel --url http://127.0.0.1:8081'* && "$args" == *'--allowed-mail'* ]]
}
show_link(){
  test -f "$logfile" || return 1
  grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$logfile" | tail -n 1
}
if [ "$mode" = status ]; then
  if running; then
    echo '[QUICK HTTPS] RUNNING (temporary; email PIN + separate Hub password)'
    show_link || echo '[QUICK HTTPS] Cloudflare URL not yet in log'
  else
    echo '[QUICK HTTPS] STOPPED'
  fi
  exit 0
fi
if [ "$mode" = stop ]; then
  if running; then
    IFS= read -r pid < "$pidfile"
    kill "$pid"
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    echo '[QUICK HTTPS] STOPPED: preview disconnected'
  else
    echo '[QUICK HTTPS] No owned preview tunnel to stop'
  fi
  rm -f "$pidfile"
  exit 0
fi
test ! -e "$base/activation/operator-activation.json" || {
  echo '[QUICK HTTPS] REFUSE: factory activation file exists'; exit 2;
}
test -f "$base/.env" && grep -qx '# OCI_HUB_PREVIEW_MANAGED=1' "$base/.env" || {
  echo '[QUICK HTTPS] REFUSE: verified paused Hub preview config is missing'; exit 2;
}
test "$(stat -c %a "$base/.env")" = 600 || {
  echo '[QUICK HTTPS] REFUSE: Hub secrets must be mode 600'; exit 2;
}
grep -Eq '^PUBLISHER_HUB_PASSWORD=[a-f0-9]{64}$' "$base/.env" || {
  echo '[QUICK HTTPS] REFUSE: Hub must have a strong password'; exit 2;
}
grep -Fq 'PUBLISHER_HUB_ACTIVATION_ARMED: "false"' "$base/compose.yaml" || {
  echo '[QUICK HTTPS] REFUSE: Hub activation is not hard disarmed'; exit 2;
}
if command -v ss >/dev/null; then
  if ss -lntH | awk '{print $4}' | grep -Eq '^(0\.0\.0\.0|\*|\[::\]):8081$'; then
    echo '[QUICK HTTPS] REFUSE: Hub port 8081 is listening publicly'; exit 2;
  fi
fi
status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8081/health || true)"
[ "$status" = 401 ] || {
  echo "[QUICK HTTPS] REFUSE: unauthenticated Hub must return 401, received $status"; exit 2;
}
echo '[QUICK HTTPS] CHECK PASS: strong credentials, disarmed factory, authenticated Hub bound locally'
if [ "$mode" = check ]; then exit 0; fi
mail="${2:-}"
if ! [[ "$mail" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  echo '[QUICK HTTPS] REFUSE: start requires one exact allowed email address'; usage; exit 2;
fi
command -v cloudflared >/dev/null || {
  echo '[QUICK HTTPS] REFUSE: cloudflared not installed. Use the official ARM64 package.'; exit 2;
}
if test -e "$HOME/.cloudflared/config.yaml" || test -e "$HOME/.cloudflared/config.yml"; then
  echo '[QUICK HTTPS] REFUSE: Quick Tunnel conflicts with an existing cloudflared config'; exit 2;
fi
mkdir -p "$private"
chmod 700 "$private"
if running; then
  echo '[QUICK HTTPS] Preview already running; no second tunnel created'
  show_link || true
  exit 0
fi
: > "$logfile"
chmod 600 "$logfile"
nohup cloudflared tunnel --url http://127.0.0.1:8081 --allowed-mail "$mail" </dev/null >"$logfile" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$pidfile"
chmod 600 "$pidfile"
found=''
for i in $(seq 1 30); do
  if ! running; then
    echo '[QUICK HTTPS] FAIL: cloudflared terminated, diagnostic lines:'
    tail -n 12 "$logfile" | sed -E 's/([A-Za-z0-9_-]{24,})/[REDACTED]/g'
    rm -f "$pidfile"
    exit 2
  fi
  found="$(show_link || true)"
  [ -n "$found" ] && break
  sleep 1
done
if [ -z "$found" ]; then
  echo '[QUICK HTTPS] FAIL: tunnel did not report public URL; stopping it'
  kill "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  exit 2
fi
echo "[QUICK HTTPS] TEMPORARY URL: $found"
echo '[QUICK HTTPS] Browser: permitted email + PIN, then existing Hub Basic authentication.'
echo '[QUICK HTTPS] URL changes on restart; NOT production; automation remains OFF.'

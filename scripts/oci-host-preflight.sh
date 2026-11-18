#!/usr/bin/env bash
# Read-only OCI A1 safety diagnostics. Never starts/stops containers or touches
# production credentials, Flow accounts, publishing, or factory databases.
set -euo pipefail
echo "[OCI HOST] architecture=$(uname -m) kernel=$(uname -r)"
test "$(uname -m)" = "aarch64" || { echo "[OCI HOST] FAIL: expected Oracle Ampere ARM64"; exit 1; }
. /etc/os-release
echo "[OCI HOST] os=${PRETTY_NAME:-unknown}"
test "${ID:-}" = "ubuntu" || { echo "[OCI HOST] FAIL: expected Ubuntu host"; exit 1; }
command -v docker >/dev/null || { echo "[OCI HOST] FAIL: Docker not installed"; exit 1; }
command -v git >/dev/null || { echo "[OCI HOST] FAIL: Git not installed"; exit 1; }
echo "[OCI HOST] docker=$(docker --version)"
docker compose version || { echo "[OCI HOST] FAIL: Docker Compose not installed"; exit 1; }
echo "[OCI HOST] cpu_count=$(getconf _NPROCESSORS_ONLN)"
echo "[OCI HOST] memory:"
free -h | head -n 3
echo "[OCI HOST] filesystems:"
df -h / /home/ubuntu | awk '!seen[$1]++'
echo "[OCI HOST] docker_disk:"
sudo docker system df || true
# The Factory must remain unstarted during reconstruction.
running="$(sudo docker ps --format '{{.Names}}' | grep -Ei '(^|[-_])(publisher|factory|frutti|dinnie|earth)([-_]|$)' || true)"
if [ -n "$running" ]; then
  echo "[OCI HOST] FAIL: potential live Publisher containers detected (no stop performed)"
  printf '%s\n' "$running"
  exit 2
fi
# No HTTP server should be exposed on the internal draft runtime ports.
if command -v ss >/dev/null; then
  listening="$(ss -lntH | awk '$4 ~ /:(8080|8081)$/ {print $4}' || true)"
  if [ -n "$listening" ]; then
    echo "[OCI HOST] WARN: draft service port already listening; inspect before any future deployment"
    printf '%s\n' "$listening"
  else
    echo "[OCI HOST] no draft ports 8080/8081 listening"
  fi
fi
if [ -f deploy/oracle-free/activation/operator-activation.json ]; then
  echo "[OCI HOST] WARN: global activation file exists; operator must verify it is OFF"
else
  echo "[OCI HOST] global activation file absent (OFF)"
fi
echo "[OCI HOST] PASS: local checks only; OCI quotas, network rules and future availability are not validated here"

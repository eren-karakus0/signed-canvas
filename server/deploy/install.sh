#!/usr/bin/env bash
# Install or update the Signed Canvas archiver on the server.
#
#   ./install.sh <room>
#
# Idempotent: safe to re-run to ship a code change. It touches only /root/flop/canvas and the
# two canvas-* units. It never reads, writes or restarts anything belonging to flop-agent,
# flop-watchdog, alertbot or kartel-ca-watcher, which share this host.
set -euo pipefail

ROOM="${1:-}"
if [[ -z "$ROOM" ]]; then
  echo "usage: install.sh <room>" >&2
  exit 2
fi
if [[ ! "$ROOM" =~ ^[a-z0-9][a-z0-9_-]{0,47}$ ]]; then
  echo "room must match ^[a-z0-9][a-z0-9_-]{0,47}$ — got '$ROOM'" >&2
  exit 2
fi

DEST=/root/flop/canvas
UNITS=/etc/systemd/system

echo "== python and its one library =="
python3 - <<'PY'
import sys
import sqlite3
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey  # noqa: F401
assert sys.version_info >= (3, 12), sys.version
print(f"  python {sys.version.split()[0]}  sqlite {sqlite3.sqlite_version}  cryptography ok")
PY

echo "== files =="
install -d -m 700 "$DEST"
for f in verifier.py placement.py snapshot.py presence.py archive.py ingest.py app.py; do
  install -m 700 "$(dirname "$0")/../canvas/$f" "$DEST/$f"
  echo "  $f"
done

echo "== self-check before anything is started =="
# A unit that starts and then fails on its first import is worse than one that never starts:
# systemd will restart it forever and the failure is buried in the journal.
( cd "$DEST" && python3 -c "
import app, archive, ingest, placement, presence, snapshot, verifier
print('  imports ok')
" )

echo "== units =="
sed "s|--room %i|--room $ROOM|" "$(dirname "$0")/canvas-ingest.service" > "$UNITS/canvas-ingest.service"
install -m 644 "$(dirname "$0")/canvas-api.service" "$UNITS/canvas-api.service"
systemctl daemon-reload

echo "== start =="
systemctl enable --now canvas-api.service
systemctl enable --now canvas-ingest.service
sleep 4

echo "== health =="
for attempt in 1 2 3 4 5; do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/health; then
    echo
    break
  fi
  [[ $attempt -eq 5 ]] && { echo "api did not answer /health" >&2; exit 1; }
  sleep 2
done

echo "== status =="
systemctl is-active canvas-api.service canvas-ingest.service
echo
echo "logs:  journalctl -u canvas-ingest -u canvas-api -f"
echo "room:  $ROOM"
echo
echo "The service is on loopback only. Nothing outside this box can reach it until a"
echo "Cloudflare Tunnel is pointed at http://127.0.0.1:8787 — see deploy/TUNNEL.md."

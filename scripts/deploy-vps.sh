#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $EUID -ne 0 ]]; then echo 'Run as root on the configured VPS.' >&2; exit 1; fi
if [[ ! -f /etc/luma.env || ! -f "$project_dir/dist-server/index.js" ]]; then echo 'Configure VPS and run npm run build first.' >&2; exit 1; fi
cp -a "$project_dir/dist" "$project_dir/dist-server" "$project_dir/package.json" "$project_dir/node_modules" "$project_dir/speech" /opt/luma/
systemctl restart luma
systemctl is-active --quiet luma
for attempt in {1..20}; do
  if curl -fsS --max-time 2 http://172.18.0.1:8090/api/session >/dev/null; then exit 0; fi
  sleep 0.5
done
echo 'Luma health check failed.' >&2
exit 1

#!/usr/bin/env bash
# One-time domain activation on the already configured VPS. Safe to retry.
set -euo pipefail
exec 9>/run/lumori-domain.lock
flock -n 9 || exit 0
state_dir=/var/lib/lumori-domain-activation
mkdir -p "$state_dir"
chmod 700 "$state_dir"
if [[ -f "$state_dir/complete" ]]; then exit 0; fi
for resolver in 1.1.1.1 8.8.8.8; do
  for domain in lumori.ru www.lumori.ru; do
    answer="$(dig +time=2 +tries=1 +short @"$resolver" "$domain" A)"
    if [[ "$answer" != '193.233.126.148' ]]; then
      echo "Waiting for public DNS: $domain via $resolver"
      exit 0
    fi
    ipv6="$(dig +time=2 +tries=1 +short @"$resolver" "$domain" AAAA)"
    if [[ -n "$ipv6" ]]; then echo "Unexpected IPv6 record for $domain; activation paused."; exit 0; fi
  done
done
if ! /opt/luma/bin/node --input-type=module - <<'JS'
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/var/lib/luma/luma.db',{readOnly:true});
const n=db.prepare(`SELECT count(*) AS n FROM chats WHERE messages LIKE '%"status":"streaming"%'`).get().n;
db.close();process.exit(n ? 1 : 0);
JS
then echo 'Waiting for the current Codex task to finish.'; exit 0; fi
if ! docker exec novotarmansky-nginx-1 test -f /etc/letsencrypt/live/lumori.ru/fullchain.pem; then
  now="$(date +%s)"
  previous=0
  if [[ -f "$state_dir/last-attempt" ]]; then read -r previous < "$state_dir/last-attempt"; fi
  if (( now - previous < 3600 )); then echo 'Waiting before another certificate attempt.'; exit 0; fi
  echo "$now" > "$state_dir/last-attempt"
  cd /opt/novotarmansky
  docker compose run --rm certbot certonly --webroot -w /var/www/certbot --non-interactive --agree-tos --register-unsafely-without-email --cert-name lumori.ru -d lumori.ru -d www.lumori.ru
fi
# Prepare config, back up existing files and validate before reload.
cp /opt/novotarmansky/nginx/conf.d/lumori.conf "$state_dir/lumori.previous.conf"
cp /opt/novotarmansky/nginx/conf.d/luma.conf "$state_dir/luma.previous.conf"
cp /etc/luma.env "$state_dir/luma.previous.env"
rollback() {
  cp "$state_dir/lumori.previous.conf" /opt/novotarmansky/nginx/conf.d/lumori.conf
  cp "$state_dir/luma.previous.conf" /opt/novotarmansky/nginx/conf.d/luma.conf
  cp "$state_dir/luma.previous.env" /etc/luma.env
  systemctl restart luma
  docker exec novotarmansky-nginx-1 nginx -t && docker exec novotarmansky-nginx-1 nginx -s reload
}
trap 'rollback' ERR
cat > /opt/novotarmansky/nginx/conf.d/lumori.conf <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name lumori.ru www.lumori.ru;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 308 https://lumori.ru$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name lumori.ru www.lumori.ru;
    ssl_certificate /etc/letsencrypt/live/lumori.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lumori.ru/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 12m;
    if ($host = www.lumori.ru) { return 308 https://lumori.ru$request_uri; }
    location / {
        proxy_pass http://172.18.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 960s;
    }
}
NGINX
cat > /opt/novotarmansky/nginx/conf.d/luma.conf <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name luma.193-233-126-148.sslip.io;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 308 https://lumori.ru$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name luma.193-233-126-148.sslip.io;
    ssl_certificate /etc/letsencrypt/live/luma.193-233-126-148.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/luma.193-233-126-148.sslip.io/privkey.pem;
    return 308 https://lumori.ru$request_uri;
}
NGINX
docker exec novotarmansky-nginx-1 nginx -t
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/luma.env')
lines=p.read_text().splitlines()
lines=[l for l in lines if not l.startswith('APP_ORIGIN=')]
p.write_text('\n'.join(lines)+'\nAPP_ORIGIN=https://lumori.ru\n')
p.chmod(0o600)
PY
systemctl restart luma
docker exec novotarmansky-nginx-1 nginx -s reload
healthy=false
for attempt in {1..20}; do
  if curl -fsS --max-time 5 --resolve lumori.ru:443:127.0.0.1 https://lumori.ru/api/session > /dev/null; then healthy=true; break; fi
  sleep 1
done
[[ "$healthy" == true ]]
trap - ERR
date -u > "$state_dir/complete"
systemctl disable --now lumori-domain-activate.timer
echo 'Lumori HTTPS activated; old URL redirects to https://lumori.ru.'

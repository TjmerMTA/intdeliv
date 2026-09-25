#!/bin/bash
# Публічний тунель до локального сервера (GitHub Actions). Два режими:
#   CF_TUNNEL_TOKEN + API_URL — постійний (named) тунель Cloudflare на своєму домені, адреса незмінна;
#   без CF_TUNNEL_TOKEN        — quick tunnel *.trycloudflare.com (без акаунта, нова адреса на кожен старт).
#   tunnel.sh start      — запустити cloudflared у фоні (pid → tunnel.pid, лог → tunnel.log)
#   tunnel.sh url [сек]  — дочекатися публічної адреси й надрукувати її (код 1, якщо не дочекались)
set -euo pipefail
PORT=${PORT:-8787}
case "${1:-}" in
  start)
    if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
      [ -n "${API_URL:-}" ] || { echo "tunnel: CF_TUNNEL_TOKEN задано, а API_URL — ні" >&2; exit 1; }
      # токен через змінну оточення, а не аргументом — щоб не світився в списку процесів
      TUNNEL_TOKEN="$CF_TUNNEL_TOKEN" nohup cloudflared tunnel --no-autoupdate run > tunnel.log 2>&1 &
    else
      nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > tunnel.log 2>&1 &
    fi
    echo $! > tunnel.pid ;;
  url)
    for _ in $(seq 1 "${2:-60}"); do
      if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
        grep -q 'Registered tunnel connection' tunnel.log 2>/dev/null && { echo "${API_URL%/}"; exit 0; }
      else
        U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log 2>/dev/null | head -1 || true)
        [ -n "$U" ] && { echo "$U"; exit 0; }
      fi
      sleep 1
    done
    exit 1 ;;
  *) echo "usage: $0 start|url [секунд]" >&2; exit 2 ;;
esac

# Konfiguracje Caddy

`Caddyfile.local` serwuje PWA i `/api/*` przez loopback; `Caddyfile.production`
włącza HTTPS dla `APP_DOMAIN`. API zachowuje prefiks `/api`; prywatne odpowiedzi
mają `Cache-Control: no-store`. Nagłówki bezpieczeństwa i limit body 16KB są wspólne.
Fastify ufa wyłącznie wydzielonej podsieci ingress z edge i API.

`Caddyfile.admin` obsługuje osobny profil `admin` na 127.0.0.1:8090, statyczne pliki
InvenTree i chronione media (`/auth/`). Nie jest trasą publicznej PWA. Używaj tunelu
SSH/VPN i panelu z prawem zapisu tylko w kontrolowanym maintenance.

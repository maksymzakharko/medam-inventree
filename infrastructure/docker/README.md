# Obrazy MEDAM

`Dockerfile` buduje API i PWA w jednym etapie Node 26.13.0/pnpm 12.18.0, a następnie
osobne cele `api` i `edge`. `pnpm install --frozen-lockfile` respektuje `allowBuilds`
dla Argon2/esbuild; `pnpm deploy --prod` zawiera pakiet shared i migracje Drizzle.
Uruchomienie API odczytuje prywatne pliki sekretów, usuwa dodatkowe grupy i trwale
przechodzi na UID/GID 1000, tracąc capabilities. Proces init pozostaje jako root
z `CAP_KILL`, aby przekazać sygnał zakończenia do API po zmianie UID.
Nie montuje socketu Docker.

Oficjalne obrazy InvenTree/PostgreSQL/Redis/Caddy i obrazy bazowe są przypięte
wersją oraz digestem. Opcjonalny BuildKit secret `proxy_ca` dodaje zaufane CA
wyłącznie podczas pobierania zależności; nie wyłącza weryfikacji TLS.

Instalacja: [docs/09-installation.md](../../docs/09-installation.md).
Nie wykonano pełnego build/start Compose w obecnym środowisku (niedostępny daemon).

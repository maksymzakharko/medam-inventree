# MEDAM React PWA

Vite/React/TypeScript, polski interfejs, osobne widoki ratownika i administracji.
`src/api.ts` obsługuje cookies/CSRF i wygaśnięcie sesji. PWA nigdy nie otrzymuje
administracyjnego tokenu InvenTree. Service worker przechowuje wyłącznie zasoby
statyczne; API jest network-only, a zużycie offline nie jest kolejkowane.

`pnpm --filter @medam/web dev` uruchamia Vite na loopback; `/api` jest proxy do
lokalnego Fastify na3000. Dla tego trybu ustaw w konfiguracji API
`APP_ORIGIN=http://127.0.0.1:5173` i otwieraj właśnie ten adres Vite. Nie umieszczaj
sekretów backendu w zmiennych VITE ani w kodzie klienta.

`pnpm build` tworzy statyczne dist dla Caddy. Manifest, PNG/SVG i ikona iOS są
w public. Testy PWA oraz komputer/telefon: `tests/e2e`; rzeczywisty iOS/Android
wymaga pilotażu HTTPS. Instrukcje wdrożenia są w `../../docs/09-installation.md`.

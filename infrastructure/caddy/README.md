# Plan Caddy

Caddy udostępni publicznie wyłącznie PWA i `/api`, z automatycznym HTTPS dla domeny
właściciela. Panel InvenTree będzie dostępny tylko kanałem administracyjnym.
Nie przekazujemy dowolnego `/api` do InvenTree. `trustProxy` w Fastify zostanie
ograniczone do znanego proxy/sieci kontenerowej, bez zaufania do nagłówków klienta.
Gotowy Caddyfile powstanie po wyborze domeny i sposobu dostępu administracyjnego.

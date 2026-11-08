# Fastify API

`server.ts` ładuje konfigurację, tworzy pulę PostgreSQL i uruchamia `app.ts`.
`buildApp` przyjmuje konfigurację, bazę i opcjonalny klient InvenTree; ten sam
serwer jest używany przez testy i produkcję.

- `modules/auth`: sesje, CSRF, Argon2id, reset i limity.
- `modules/users`: role, indywidualne przydziały, odwołanie dostępu.
- `modules/inventory`: odczyty, izolacja, FEFO, minima/krok ilościowy.
- `modules/consumption`, `movements`: trwała brama i idempotencja wszystkich mutacji.
- `modules/reports`, `audit`: zgłoszenia, własna historia i eksporty uprawnionych danych.
- `integrations/inventree`: walidowany klient REST, timeouty, paginacja i audyt efektu.
- `db`, `../drizzle`: transakcje i wersjonowane migracje; `cli`: kontrolowane narzędzia.

Żaden moduł nie utrzymuje własnych bieżących ilości zapasów. Uruchomienie i odbiór:
`../../../docs/09-installation.md` i `../../../docs/12-release-verification.md`.

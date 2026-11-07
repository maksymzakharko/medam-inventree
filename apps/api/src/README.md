# Backend — zaplanowane granice modułów

`server.ts` i rejestracja pluginów powstaną podczas implementacji.
To szkielet katalogów, bez działającego serwera.

| Moduł | Odpowiedzialność |
| --- | --- |
| auth | Sesje PostgreSQL, CSRF, hasła, limity i reset |
| users | Role, aktywność kont, przypisanie numerycznego location ID |
| inventory | Odczyty InvenTree, FEFO, kontrola lokalizacji, progi |
| consumption | Protokół operacji i trwała idempotencja |
| movements | Przyjęcia, przesunięcia, korekty; ten sam protokół co rozchód |
| reports | Zgłoszenia problemów i eksporty uprawnionych danych |
| audit | Historia własnych operacji i osobny widok administracyjny |
| integrations/inventree | Typowany klient, walidacja Zod, pagination, timeouty |
| plugins | Konfiguracja, DB, cookies/session, CSRF, security headers, log redaction |

Kod migracji Drizzle trafi do `apps/api/drizzle/` w kolejnym etapie.
Projekt tabel opisano w `docs/02-architecture.md` i `docs/04-security-and-consistency.md`.

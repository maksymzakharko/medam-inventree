# Testy MEDAM

Testy nie łączą się z produkcją. Do uruchomienia wymagają **osobnej bazy PostgreSQL**,
której nazwa zaczyna się od `medam_test`. Fixture odmawia pracy z inną nazwą i
przed testami czyści wyłącznie tę testową bazę. Nie wskazuj prawdziwej bazy aplikacji.

```sh
pnpm install --frozen-lockfile
pnpm --filter @medam/shared build
# Ustaw TEST_DATABASE_URL do lokalnej, izolowanej bazy medam_test.
pnpm test:integration
```

Suite integracyjny uruchamia prawdziwy Fastify, migracje Drizzle, sesje, CSRF i
trwałe operacje w prawdziwym PostgreSQL. Kontrolowany **testowy serwer HTTP**
zastępuje InvenTree wyłącznie w tych testach, aby odtwarzać timeout po zastosowaniu
zmiany, częściową realizację, brak i duplikację audytu oraz wadliwe filtrowanie.
Nie jest importowany do produkcji i nie jest dowodem zgodności żywej instancji
InvenTree. Osobny smoke test prawdziwego InvenTree pozostaje wymagany.

Zakres: wszystkie 10 tożsamości ratowników i 12 magazynów; cudze szczegóły, rozchody,
zgłoszenia, historia, operacje i eksporty; nieznane pola; nieprawidłowa późniejsza
strona odpowiedzi upstream; sesje, CSRF i reset; 20 jednakowych równoległych kluczy;
trwały gate po restarcie; częściowa realizacja i uzgodnienie; przyjęcie po cid;
przesunięcie z nowym PK oraz LOT/EXP; rozliczenie administracyjnej straty;
normalizacja UUID przy korelacji audytu; ręczne rozliczenie rozbieżności odrębnym
stanem terminalnym, poświadczenie w rzeczywistym CLI i rollback po błędzie audytu;
trzy rzeczywiste żądania HTTP z opóźnionym body, których dostęp zostaje odebrany
między uwierzytelnieniem nagłówków a zapisem (dezaktywacja, zmiana magazynu, degradacja roli).

## E2E w przeglądarce

```sh
pnpm exec playwright install chromium
# TEST_DATABASE_URL nadal wskazuje izolowaną bazę medam_test.
pnpm test:e2e
```

Playwright buduje React PWA, uruchamia testowy serwer statyczny i prawdziwe API
z tą samą odseparowaną bazą oraz kontrolowanym upstream HTTP. Harness nasłuchuje
wyłącznie na `127.0.0.1:5179`; ścieżki `/__test/*` istnieją tylko w kodzie harnessu,
nie w aplikacji lub obrazie produkcyjnym. Nie uruchamiaj E2E równocześnie z testami
integracyjnymi na tej samej bazie.

Dwa projekty: desktop Chromium oraz widok mobilny Chromium. Sprawdzają logowanie,
własny LOT, rozchód i wynik, historię, zgłoszenie, wylogowanie, blokadę offline i
odzyskanie niepewnej operacji po przeładowaniu strony bez drugiej mutacji.
Administrator przechodzi przyjęcie nowej partii, przesunięcie, stratę, eksport
wybranego magazynu oraz dezaktywację konta. Test PWA sprawdza rzeczywisty CacheStorage:
wyłącznie shell i zasoby statyczne, brak prywatnych odpowiedzi API, brak danych
w localStorage i brak odtworzenia zapasów po przeładowaniu offline.
Zrzuty i ślady niepowodzeń trafiają do ignorowanych przez Git `test-results/` oraz
`playwright-report/`. Mobilna emulacja nie zastępuje testów instalacji PWA na
rzeczywistym Androidzie i iOS ani testów HTTPS na docelowym VPS.

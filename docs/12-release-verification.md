# Weryfikacja wydania 0.1.0 — 8 listopada 2026

Kod: gałąź `feat/working-mvp` repozytorium `maksymzakharko/medam-inventree`.
Raport dotyczy implementacji do lokalnych testów i pilotażu. Nie potwierdza
wdrożenia produkcyjnego ani pełnego odbioru na OVH.

## Rzeczywiście wykonane

| Sprawdzenie | Wynik i zakres |
| --- | --- |
| Kompilacja | `pnpm build` zaliczone: shared, Fastify API i React/Vite |
| TypeScript | `pnpm typecheck` zaliczone, Node 26.13.0 / pnpm 12.18.0 |
| Pakiet produkcyjny | `pnpm --filter @medam/api deploy --prod …` oraz uruchomienie CLI z osobnego pakietu zaliczone; natywny Argon2 i zależności rozwiązywane |
| Integracja/bezpieczeństwo | **43/43 zaliczone**, 6 plików, 0 pominiętych, prawdziwy PostgreSQL 17.11 |
| Przeglądarka | **8/8 zaliczone**, Chromium 158 desktop i emulacja Pixel 7, bez pominięć i flaky retry |
| PWA | Zasoby PNG 192/512/180 px, manifest, brak prywatnego API w cache, zachowanie offline i ponowne otwarcie strony sprawdzone |
| Wygląd | Zrzuty desktop/mobile obejrzane, brak poziomego overflow, nawigacja i formularze sprawdzone w przeglądarce |
| Zależności produkcyjne | `pnpm audit --prod`: 0 znanych zgłoszeń info/low/moderate/high/critical w odpowiedzi rejestru z dnia audytu |
| Infrastruktura offline | 16 testów bezpieczeństwa archiwów/checkpointu i orkiestracji backupu zaliczone; prawdziwe tar/SHA, kontrolowany Docker/dump double; shell/Python syntax i konfiguracje Compose lokalna/produkcja/restore zaliczone bez demona |
| Odtworzenie aplikacyjnej bazy | `pg_dump` custom → oddzielna baza PostgreSQL; wszystkie **13 tabel**, w tym migracje, zgodne; szczegóły poniżej |

Dowody maszynowe: [podsumowanie](evidence/release-test-summary.json),
[odtworzenie bazy](evidence/application-db-restore.json).
Testy źródłowe są w `tests/integration`, `tests/security` i `tests/e2e`.

## Co sprawdzono testami

- Każdy z 10 ratowników: własny magazyn dostępny, pozostałe magazyny i ścieżki
  administracyjne odcięte; szczegóły, rozchód, historia, zgłoszenia i manipulacja
  identyfikatorami nie ujawniają cudzych danych.
- Login, sesje, CSRF/Origin, reset jednorazowy, wycofanie sesji i role.
- 20 równoczesnych powtórzeń tego samego klucza: jedna mutacja; inny payload
  pod tym kluczem odrzucony. Powrót po utracie odpowiedzi nie dubluje zużycia.
- Niejednoznaczny/ częściowy wynik, trwały gate po restarcie API, uzgodnienie
  dowodów, CLI maintenance oraz rollback przy błędzie audytu.
- Błędy filtrów upstream, nieprawidłowe daty, blokady partii, minimum sumowane
  po używalnych LOT, reguły ilości i źródłowy/docelowy zakres eksportu transferu.
- Prawdziwy HTTP ze spowolnionym body: żądanie rozpoczęte przed zmianą magazynu,
  dezaktywacją lub odebraniem roli nie wykorzystuje starej autoryzacji do zapisu.
- Wielkie litery UUID są normalizowane; korelacja i odkrywanie dowodów korzystają
  z identyfikatora utrwalonego w bazie.
- E2E: ratownik login → zużycie → historia → zgłoszenie → logout; utrata sieci,
  odzyskanie niepewnej operacji; administrator przyjęcie → przesunięcie → strata
  → CSV → odebranie dostępu; PWA privacy/offline na obu rozmiarach ekranu.

InvenTree w tych testach jest **kontrolowanym serwerem HTTP tylko dla testów**,
co umożliwia wymuszenie awarii, przycinania ilości i utraty odpowiedzi. Nie jest
to drugi silnik zapasów w aplikacji ani dowód działania faktycznej instancji InvenTree.

## Odtworzenie PostgreSQL aplikacji

2026-11-08 20:47 UTC: dump bazy `medam_test` klientem PostgreSQL 17.11 i restore
do nowej `medam_restore_check_20261108204727`. Porównano liczby i skróty całych
tabel: 12 tabel publicznych i tabela migracji Drizzle są identyczne.
Zachowano stan operacji/bramy, bez automatycznego ponowienia mutacji.
Po porównaniu odwołano sesje i tokeny resetu w kopii; aplikacji nie podłączono do kopii.

Zmierzony przebieg małego dump/restore i podstawowych porównań: około 0,41 s;
osobno potwierdzono metadane migracji. **Nie jest to pomiar RTO całego systemu.**
Obie bazy były oddzielnymi bazami tego samego lokalnego serwera testowego.
Nie wykonano w tym sprawdzeniu offsite, odtwarzania InvenTree, mediów ani VPS.

## Ograniczenia infrastruktury i kolejne bramki

Próba pobrania oficjalnego obrazu InvenTree wyczerpała mały dysk środowiska Codex
przy sterowniku Docker `vfs`. Import płaskiego systemu plików obrazu udał się,
ale pełny start przerwał brak miejsca; po odtworzeniu środowiska daemon Docker
był niedostępny. Nie zmieniano sterownika/uprawnień demona ani nie usuwano danych
użytkownika. Dalsze testy aplikacji uruchomiono na natywnym PostgreSQL 17.11.

Dlatego **niezaliczone lokalnie** pozostają:

- pełny build/start docelowego Compose, konto serwisowe i uprawnienia w żywym InvenTree;
- rzeczywiste remove/receipt/transfer i `cid`/audit na przypiętym obrazie;
- HTTPS/domena, zewnętrzna izolacja portów, reboot/autostart i rzeczywiste telefony;
- kompletna zaszyfrowana kopia offsite obu baz/plików i restore na oddzielnym hoście;
- rzeczywiste RPO/RTO, obciążenie i końcowy odbiór właściciela.

Workflow CI zawiera build kontenerów, migracje, start prawdziwego InvenTree/workera,
bootstrap konta integracji i sprawdzenie gotowości API/PWA. Jego wynik należy
potwierdzić dla opublikowanego commitu; sama definicja nie jest dowodem sukcesu.
Lokalne 43+8 testów nie zastępują wymienionych bramek.

Dokumenty 09–11 opisują instalację, backup/restore i zabezpieczenia. Przed użyciem
rzeczywistych zapasów konieczny jest pilotaż dwóch kont i zaliczenie pełnego restore.

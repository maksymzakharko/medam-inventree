# Weryfikacja wydania 0.1.0 — 9 listopada 2026

Kod: gałąź `feat/working-mvp`, sprawdzony commit
[`1821f2d5d659c07f7db5a4576c04442075d2991b`](https://github.com/maksymzakharko/medam-inventree/commit/1821f2d5d659c07f7db5a4576c04442075d2991b).
[GitHub Actions #19](https://github.com/maksymzakharko/medam-inventree/actions/runs/42579067148)
zakończyło się sukcesem: oba zadania `application` i `container-build` zaliczone.
Raport dotyczy implementacji do lokalnych testów i pilotażu. Nie potwierdza
wdrożenia produkcyjnego ani pełnego odbioru na OVH.

## Rzeczywiście wykonane

| Sprawdzenie | Wynik i zakres |
| --- | --- |
| Kompilacja | `pnpm build` zaliczone: shared, Fastify API i React/Vite |
| TypeScript | Lokalne `pnpm typecheck` zaliczone; kompilacja ponowiona w CI, Node 26.13.0 / pnpm 12.18.0 |
| Pakiet produkcyjny | `pnpm --filter @medam/api deploy --prod …` oraz uruchomienie CLI z osobnego pakietu zaliczone; natywny Argon2 i zależności rozwiązywane |
| Integracja/bezpieczeństwo | **43/43 zaliczone**, 6 plików, 0 pominiętych, prawdziwy PostgreSQL 17.11 |
| Przeglądarka | **10/10 zaliczone**, Chromium 158 desktop i emulacja Pixel 7, bez pominięć i flaky retry |
| PWA | Zasoby PNG 192/512/180 px, manifest, brak prywatnego API w cache, zachowanie offline i ponowne otwarcie strony sprawdzone |
| Wygląd | Zrzuty desktop/mobile obejrzane, brak poziomego overflow, nawigacja i formularze sprawdzone w przeglądarce |
| Zależności produkcyjne | `pnpm audit --prod` z 8 listopada: 0 znanych zgłoszeń info/low/moderate/high/critical; wynik dotyczy tej daty i lockfile |
| Bezpieczeństwo infrastruktury | **32/32 zaliczone** lokalnie i w CI: archiwa, SHA, ścieżki, uprawnienia, broker i orkiestracja backupu; część testów korzysta z kontrolowanego Docker/dump double |
| Prawdziwy Compose | Budowa API/PWA, migracje, PostgreSQL, Redis, InvenTree 1.7.0/API570 i worker zaliczone; trzy konfiguracje Caddy przechodzą parser |
| Pierwsza instalacja | Administrator CLI, 12 lokalizacji/mapowań, ponowna synchronizacja bez duplikatów, finalizacja uprawnień, rzeczywisty broker Redis i prywatny panel przez loopback zaliczone |
| Prawdziwy stock/audyt | Sześć operacji na InvenTree, w tym korelacja CID i wykrycie przycięcia rozchodu; szczegóły poniżej |
| Pełny checkpoint i izolowany restore | Obie bazy i dane InvenTree odtworzone na nowych wolumenach; porównania stock/LOT/EXP, migracji i pliku mediów, readiness i HTTP/401 zaliczone; **48,365 s** dla małego lokalnego zestawu |
| Odtworzenie aplikacyjnej bazy | `pg_dump` custom → oddzielna baza PostgreSQL; wszystkie **13 tabel**, w tym migracje, zgodne; szczegóły poniżej |

Dowody maszynowe: [podsumowanie](evidence/release-test-summary.json),
[CI i izolowany restore](evidence/ci-runtime-restore.json),
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

## Prawdziwy InvenTree i odtworzona aplikacja

Oddzielne zadanie CI uruchamia przypięty oficjalny obraz, rzeczywiste bazy i Redis.
Konto integracji nie ma staff/superuser ani DELETE; po bootstrapie traci prawo
tworzenia lokalizacji. Skrypt tworzy administratora przez rzeczywisty CLI,
synchronizuje 12 magazynów dwa razy i sprawdza brak nowych lokalizacji/operacji
przy powtórzeniu. Hasło i tokeny nie trafiają do logu ani dowodów w repozytorium.

Test kontraktu korzysta ze skompilowanego klienta i weryfikatora dowodów MEDAM:

| Operacja | Potwierdzony efekt i wynik |
| --- | --- |
| Przyjęcie | 5 sztuk, zgodny CID/aktor/partia, `SUCCEEDED` |
| Rozchód | 2 sztuki, `SUCCEEDED` |
| Częściowy transfer | 1 sztuka, dowód podziału i nowej pozycji, `SUCCEEDED` |
| Zwiększenie | 1 sztuka, `SUCCEEDED` |
| Pełny transfer | 3 sztuki, `SUCCEEDED` |
| Przycięcie rozchodu | Żądane 20, rzeczywiście 3; prawidłowo `DISCREPANCY`, pozycja z ilością 0 zachowana |

2026-11-09 07:28–07:29 UTC: checkpoint zatrzymał łagodnie autorów zapisów,
potwierdził pusty rzeczywisty broker, wykonał oba dumpy, archiwa i sumy oraz wznowił
usługi. Restore utworzył nowy projekt, sieci i wolumeny, odtworzył obie bazy i dane
InvenTree bez migracji lub ponawiania operacji. Skrypt unieważnia sesje/linki resetu
w kopii i zmienia sekret sesji. Worker i panel kopii pozostały wyłączone.

Porównania objęły wszystkie wiersze testowego stock z LOT/EXP i ilościami, hashe
migracji Drizzle oraz kontrolny plik mediów. Odtworzone API osiągnęło gotowość
zapisów, PWA odpowiedziało przez loopback 18080, a API bez sesji zwróciło 401.

**48,365 s** liczono od rozpoczęcia lokalnego restore do zakończenia porównań
i kontroli HTTP. Obrazy były już na tym samym runnerze, a dane były małym zestawem
testowym. Nie jest to czas odzyskania z offsite, pomiar RPO/RTO hosta ani wynik
obciążenia produkcyjnego. Publiczne dowody nie zawierają dumpów lub sekretów.

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

## Kolejne bramki na zakupionym VPS

Kod i lokalny restore są sprawdzone. VPS jeszcze nie został kupiony; pozostają:

- HTTPS/domena, zewnętrzna izolacja portów, reboot/autostart i rzeczywiste telefony;
- kompletna zaszyfrowana kopia offsite obu baz/plików i restore na oddzielnym hoście;
- rzeczywiste RPO/RTO, obciążenie i końcowy odbiór właściciela.

Przebieg CI potwierdza wyłącznie zakres wskazany powyżej. Nie zastępuje odbioru
hosta, testu z niezależnej lokalizacji ani odzyskania po utracie całego VPS.

Dokumenty 09–11 opisują instalację, backup/restore i zabezpieczenia. Przed użyciem
rzeczywistych zapasów konieczny jest pilotaż dwóch kont i restore z docelowego offsite.

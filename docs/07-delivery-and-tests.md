# Etapy realizacji i testy odbiorowe

Status: plan do zatwierdzenia. Żadne poniższe testy działającego systemu nie zostały
jeszcze wykonane. Szczegółowe punkty API i crash matrix w dokumentach 03 i 04.

## Kolejność i bramki akceptacji

| Etap | Konkretne działania | Wynik do przeglądu / warunek przejścia |
| --- | --- | --- |
| 1. Audyt/plan | Repo, kod i OpenAPI InvenTree, architektura, repo scaffold, zagrożenia, kontrakty | Ten pakiet; akceptacja kierunku i decyzji krytycznych. Audyt VPS po zakupie |
| 2. Staging/infrastruktura | Read-only preflight, backup zastanej konfiguracji, Compose, prywatne PG/Redis/InvenTree, HTTPS, worker i health, backup/alerty | Działający staging i raport konfiguracji; brak publicznych DB/admin; zgoda przed zmianami produkcyjnymi |
| 3. Kontrakt InvenTree i magazyny | Testy stock/remove/transfer/audit, 12 lokalizacji, mapowanie PK, import dry-run | Dowody rzeczywistego zachowania v570, korelacji UUID, LOT/EXP i częściowego transferu; brak wymyślonych gwarancji |
| 4. Fastify | Migracje Drizzle, sesje/CSRF/reset, role, scopes, klient, gate, idempotencja, odczyty, zużycie, audit, zgłoszenia, operacje admina | Przechodzące testy API i izolacji, odzyskiwanie po crashu; brak wtórnych stanów stock |
| 5. React PWA | Pięć ekranów, polskie błędy, FEFO/alerty, UUID odzyskiwania, manifest/ikony, network-only API | Działająca aplikacja przez HTTPS i testy browser/mobile; brak offline zapisów |
| 6. Weryfikacja całości | Integracja, E2E, izolacja wszystkich kont, awarie, reboot, pełny backup/restore na osobnym hoście | Faktyczny raport z wersjami, logami bez sekretów, RPO/RTO i wynikiem restore |
| 7. Pilotaż | Dwa konta ratowników, testowe lub zatwierdzone dane, Android/iOS, uwagi i poprawki | Akceptacja użytkowników i poprawki sprawdzone ponownie; plan importu rzeczywistych zapasów |
| 8. Produkcja | Wyłącznie po zgodzie właściciela: konta pozostałych, zatwierdzony import, instrukcje, okno wdrożenia | Końcowy odbiór; dyżur alertów, gotowy rollback i backup; żadnego automatycznego startu |

Nie szacujemy dat kalendarzowych bez decyzji o zakupie, domenie i zakresu pilotażu.
Kod może powstawać lokalnie bez dostępu do produkcji. Testy kontraktowe stock/audit
muszą poprzedzać uznanie integracji za bezpieczną. Wykrycie nieusuwalnego wyścigu
wymaga korekty projektu lub minimalnego zatwierdzonego rozszerzenia InvenTree.

## Strategia testów

- **Vitest:** reguły Zod, canonical decimal/quantum, role, EXP w Europe/Warsaw, FEFO,
  przejścia stanu operacji, odpowiedzi błędów. Testy chronią zachowanie, nie strukturę kodu.
- **Integracja Fastify/PG:** rzeczywisty PostgreSQL i migracje, injection HTTP,
  sesje/CSRF/reset, UNIQUE idempotencji, transakcje, gate po restarcie procesu.
  Kontrolowany serwer upstream tylko do deterministycznych awarii/timeoutów.
- **Kontrakt InvenTree:** prawdziwe przypięte InvenTree z PG/Redis/worker,
  odczyt schema API, rzeczywiste przyjęcie/usunięcie/transfer/audit, statusy i wygasanie.
  Mock nie potwierdza zachowania InvenTree.
- **Playwright E2E:** prawdziwy backend i testowy stack; Desktop Chromium/WebKit,
  widoki mobilne i network errors. Faktyczne iOS/Android osobno w pilotażu — emulacja
  nie jest dowodem instalacji PWA na urządzeniu.
- **Infrastruktura:** kontrolowany reboot staging, autostart, zewnętrzny test portów
  IPv4/IPv6/HTTPS, wyzwolenie alertu, pełny restore offsite na innym hoście.

## Macierz krytyczna

| Obszar | Przypadek i oczekiwany dowód |
| --- | --- |
| Izolacja 10×12 | Dla każdego i=1…10: MAG-i widoczny, MAG-j j≠i i MAG-00/MAG-11 niedostępne. Lista, detail, search, history, problem, operation status, export i zużycie. Brak wycieku oraz zero upstream mutation przy odmowie |
| Manipulacja | Obcy StockItem, warehouseId/actorId w body/query, zmiana roli, obcy cursor, nieprawidłowe mapowanie, podlokalizacja, obcy element na dalszej stronie → odmowa całego żądania |
| Sesje | Poprawne flags cookie, rotacja, brak/wygaśnięcie/revoke, zmiana roli/przypisania, reset, logout; brak i obcy CSRF/Origin, rate limiting i brak enumeracji |
| Partie | Wczoraj/dziś/jutro EXP, brak LOT/EXP, status damaged/returned/unknown, rezerwacje, nieaktywny Part, mało stock; jednostki i precyzja bez float |
| Idempotencja | 20 równoległych jednakowych żądań: jedna próba mutacji; inny payload:409; replay po restarcie API/DB i po retencji; UUID innego użytkownika:404 |
| Równoczesność | Dwa zużycia z sumą ponad stan, zużycie vs transfer, partial transfer z nowym PK, receipt nowego PK; globalny gate we wszystkich ścieżkach |
| Niejednoznaczność | Crash PREPARED, DISPATCHING przed HTTP, po zastosowaniu upstream przed odpowiedzią, po 201 przed commitem aplikacji, po commicie przed odpowiedzią do telefonu |
| Weryfikacja efektu | Remove ponad stan daje częściowy efekt: brak fałszywego sukcesu. `deltas.removed`, cid/notes, wyłączony audyt, usunięty do zera item, duplikat/brak dowodu |
| Gate/recovery | UNCERTAIN utrzymany po restarcie; brak TTL release/resend; spóźniony worker nie nadpisuje uzgodnienia ani nie odblokowuje następnej operacji |
| E2E | Login → stock → zużycie → potwierdzona historia → problem → logout; utrata sieci w każdym kroku, session expiry, powrót przez ten sam UUID |
| Backup | Komplet obu dumpów/media/sekretów, awaria jednego składnika → alert i brak oznaczenia sukcesu; restore z offsite bez połączenia do produkcji |
| Reboot/porty | Autostart wszystkich usług, ochrona replay po restarcie, HTTPS, brak publicznych PG/Redis/admin, zewnętrzny alert o wyłączonym hoście |

Audyt wymaga niezmienialnego śladu intencji, wyniku, odmowy autoryzacji i zmiany admina,
bez haseł, cookies, tokenów i danych pacjenta. Oczekiwane wyniki nie są wynikami testów.

## Raport przyszłego przebiegu

Każdy raport: data UTC i lokalna, commit aplikacji, wersje/digesty obrazów, hash OpenAPI,
host testowy, wersja migracji, komendy, liczba testów pass/fail/skip, załączone dowody,
odchylenia i osoba wykonująca. Awaria lub pominięcie jest jawne. Nie wolno zastępować
testów urządzeń zrzutem z przeglądarki ani restore samą kontrolą integralności restic.

Przed produkcją komplet instrukcji: instalacja, aktualizacja/rollback, konta i reset,
minimum/LOT/EXP, ratownik (zużycie, wynik niepewny, problem, sesja), magazynier
(przyjęcie/przesunięcie/korekta), uzgadnianie, backup/restore/retencja, monitoring.
Instrukcje implementacyjne powstaną wraz z działającymi poleceniami i będą sprawdzone
na staging. Obecny plan nie udaje gotowego podręcznika obsługi nieistniejącej aplikacji.

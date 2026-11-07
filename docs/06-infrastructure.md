# Plan infrastruktury, backupów i odtwarzania — etap 1

Data audytu: 7 listopada 2026, strefa Europe/Warsaw. Status: projekt do akceptacji, bez wdrożenia i bez testu VPS. Właściciel potwierdził, że VPS **nie został jeszcze kupiony**. Audyt zdalnego hosta i test SSH wykonamy po jego zakupie; obecnie nie ma serwera, którego stan można potwierdzić. Dostęp do środowiska roboczego Codex nie oznacza dostępu do VPS OVH.

## Fakty i wersje

- Oficjalne GitHub `releases/latest` wskazuje InvenTree **1.7.0**, wydane 3 listopada 2026. Przed wdrożeniem ponownie sprawdzić poprawki bezpieczeństwa; obraz przypiąć do zweryfikowanego tagu i digestu, identycznie dla serwera i workera. Nie stosować ruchomego `latest` ani automatycznej aktualizacji obrazu.
- Oficjalny Compose z tagu 1.7.0 używa `postgres:17` i `redis:7-alpine`, serwera InvenTree oraz oddzielnego workera `invoke worker`. To punkt odniesienia, nie ukończona konfiguracja dla tej aplikacji. Konkretny patch i digest PostgreSQL/Redis/Caddy wymagają wyboru i testu w etapie infrastruktury.
- Dokumentacja ostrzega o niezgodności narzędzi backupu, kiedy serwer PostgreSQL jest nowszy niż klient w obrazie InvenTree. W tym projekcie proponowany PostgreSQL 17 dla obu baz. Nie omijać backupu flagą `--skip-backup` w celu ukrycia problemu wersji.
- PostgreSQL i Redis nie otrzymują żadnych hostowych mapowań `ports`. Samo UFW nie zapewnia izolacji portów opublikowanych przez Docker; wymagana jest kontrola konfiguracji Docker, reguł hosta oraz test z zewnętrznej maszyny.

Źródła: [wydanie 1.7.0](https://github.com/inventree/InvenTree/releases/tag/1.7.0), [Compose w 1.7.0](https://github.com/inventree/InvenTree/blob/1.7.0/contrib/container/docker-compose.yml), [Docker w dokumentacji 1.7.0](https://github.com/inventree/InvenTree/blob/1.7.0/docs/docs/start/docker.md), [Docker i UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## Audyt VPS przed jakąkolwiek zmianą

Przygotowano [skrypt odczytowy](../infrastructure/scripts/vps-preflight-readonly.sh); nie został uruchomiony na VPS. Jego wynik pozostaje prywatnym materiałem audytu, nie treścią do publicznego repozytorium.

Po otrzymaniu dostępu wykonać wyłącznie odczyt. Ustalić odcisk klucza hosta przez panel OVH lub inny zaufany kanał; nie wyłączać `StrictHostKeyChecking` i nie przyjmować ślepo wyniku `ssh-keyscan`. Korzystać z klucza i nie upraszczać istniejących zasad SSH.

Zakres zebrania dowodów:

| Obszar | Odczyt / wynik do raportu |
| --- | --- |
| Połączenie | SSH z `BatchMode=yes`, poprawnym portem i weryfikacją znanego hosta; użytkownik i zakres uprawnień, bez pokazywania klucza |
| System | `/etc/os-release`, `uname -m`, `uptime`, `timedatectl` i stan synchronizacji czasu |
| Zasoby | `nproc`, `free -h`, `df -hT`, `df -i`, `lsblk`; zapas miejsca na obrazy, backup i odtworzenie |
| Usługi | `systemctl --failed`, lista uruchomionych usług, `ss -lntup`; szczególnie istniejący reverse proxy i porty 80/443 |
| Kontenery | `docker version`, `docker compose version`, `docker ps --format`, `docker compose ls`, lista nazw wolumenów; bez pełnego `docker inspect` ujawniającego env |
| Sieć i firewall | istniejące reguły UFW/nftables/iptables i firewall OVH, konfiguracja IPv4/IPv6, DNS A/AAAA domeny; odczyt z uprawnieniami właściciela |
| Dane i konfiguracja | lokalizacje istniejących aplikacji/wolumenów oraz właściciele plików; nie kopiować sekretów do logów lub Git |
| Odzyskiwanie | dostęp do konsoli rescue OVH, aktualne snapshoty/kopie, miejsce docelowe offsite i możliwość odtworzenia |

Wyniki zostaną zapisane z datą i identyfikatorem serwera. Brak polecenia, uprawnienia lub odpowiedzi odróżnić od stwierdzonej awarii. Nie instalować Docker, nie restartować usług i nie modyfikować firewalla w ramach tego odczytu.

Przed zatwierdzoną instalacją: zaszyfrowana kopia istniejącej konfiguracji i spis usług, potwierdzony punkt odtworzenia oraz uzgodnione okno zmian. Nigdy `docker compose down -v`, `docker system prune` ani kasowanie wolumenów bez oddzielnej wyraźnej zgody.

## Docelowy układ na Ubuntu Server 24.04 LTS

Propozycja z aktualnej oferty OVH: **VPS-1 (2 vCPU, 4 GB RAM, 40 GB NVMe) do pilotażu; VPS-2 (4 vCPU, 8 GB RAM, 75 GB NVMe) do produkcji**, z Ubuntu Server 24.04 LTS, lokalizacją w Polsce lub innym zatwierdzonym regionie UE i bez dodatkowego panelu hostingowego. To dobór do weryfikacji pomiarami pełnego zestawu usług. Dla stagingu i testu restore potrzebny jest oddzielny, choćby tymczasowy VPS, bez produkcyjnych adresów DNS i bez dostępu do produkcyjnych usług z prawem zapisu. Konieczny monitoring miejsca na bazy, obrazy, media i lokalne checkpointy. Ceny i warianty sprawdzać przy zamówieniu. [Oferta VPS OVH](https://www.ovhcloud.com/pl/vps/).

| Usługa | Rola / dostęp |
| --- | --- |
| `edge` — Caddy | Jedyny publiczny punkt HTTP/HTTPS; React jako statyczny build, `/api/*` do Fastify; zachowuje ścieżkę `/api`, limity rozmiaru i timeouty |
| `api` — Node LTS/Fastify | Własne sesje, role, przypisania lokalizacji, walidacja, idempotencja, audyt; jedyny dostęp medyków do InvenTree |
| `app-db` — PostgreSQL 17 | Osobna baza i użytkownik runtime z ograniczonymi grantami; oddzielne konto migracji, brak konta superuser w aplikacji |
| `inventree-server` | Oficjalny przypięty obraz; API w sieci wewnętrznej; brak publicznego mapowania portu 8000 |
| `inventree-worker` | Ten sam obraz i konfiguracja wersji co serwer; oficjalny `invoke worker`, współdzielone media |
| `inventree-db` — PostgreSQL 17 | Wyłączna baza InvenTree; Node nie otrzymuje jej poświadczeń ani uprawnień SQL |
| `inventree-cache` — Redis 7 | Wewnętrzny cache i zadania InvenTree, bez portu hosta; nie jest źródłem stanów i nie zastępuje trwałego rejestru operacji w PostgreSQL aplikacji |
| Backup i monitoring | Harmonogram na hoście, eksportery wyłącznie wewnętrzne; zewnętrzny monitoring dostępności i niezależne powiadomienia |

Dla rekomendowanego VPS-2 preferowane dwie instancje PostgreSQL w kontenerach, aby rozdzielić konta i sieci. Wspólna instancja z osobnymi bazami i użytkownikami jest dopuszczalną alternatywą po analizie zasobów VPS. Żaden użytkownik aplikacji nie posiada dostępu do tabel InvenTree.

Sieci Compose:

- `ingress`: tylko edge i API; z zewnątrz TCP 80/443 oraz istniejący ograniczony SSH. UDP 443 tylko jeżeli świadomie włączymy HTTP/3.
- `app-data`, `internal: true`: tylko API i `app-db`.
- `inventree-api`, `internal: true`: tylko API i serwer InvenTree; opcjonalny zaufany proxy administracyjny.
- `inventree-data`, `internal: true`: serwer, worker, baza InvenTree, Redis. Uprawniony kontener backupu może mieć dostęp na czas kopii.
- Dostęp wychodzący dodawać tylko usługom, które go rzeczywiście potrzebują (Caddy ACME, transport resetu hasła, backup offsite). Ustawienie `internal` wymaga testu rzeczywistej osiągalności każdej zależności, nie tylko sprawdzenia składni Compose.

Warunek wyłącznego kanału zapisów obejmuje również kolejki worker, zadania build/sales/purchase/transfer, pluginy i importy — patrz [audyt API](03-inventree-api.md). W MVP te niezależne workflowy nie zmieniają chronionych zapasów. Worker pozostaje dla zweryfikowanych zadań; żadnego czyszczenia kolejki bez zgody.

Panel InvenTree dla administratora (i uprawnionego magazyniera wyłącznie w maintenance; rutynowe zapisy przez Fastify): domyślnie wyłącznie przez zatwierdzony VPN lub ograniczony tunel SSH do interfejsu loopback, bez publicznej trasy w aplikacji medyków. Jeżeli właściciel wybierze Cloudflare Tunnel/Access, potrzebne są osobna domena, polityka osób/grup, weryfikacja JWT i odcięcie bezpośredniego originu. Nie ufać samemu nagłówkowi e-mail. Ratownicy nie otrzymują kont InvenTree. Token usługi integracyjnej wyłącznie w backendzie; jego minimalne role zweryfikować testami API.

Trwałe wolumeny oddzielnie: PG aplikacji, PG InvenTree, media/dane InvenTree, dane certyfikatów Caddy. Konfiguracje montowane read-only. Sekrety w plikach poza repo z prawami `0600` i poprawnym właścicielem, udostępniane wyłącznie konkretnej usłudze przez Compose secrets lub obsługiwany plik konfiguracji. Zweryfikować, które obrazy rzeczywiście obsługują zmienne `_FILE`; nie zakładać takiej obsługi w InvenTree. Sekrety Compose na pojedynczym hoście wymagają także ochrony i backupu źródłowych plików.

Każda usługa: przypięty obraz, `restart: unless-stopped`, właściwy healthcheck, limity zasobów po pomiarach, `no-new-privileges`, minimalne capabilities, użytkownik bez roota tam gdzie wspiera to oficjalny obraz. Nie wymuszać `read_only` na ślepo na obrazach wymagających zapisu. Logi Docker np. `local` z `max-size=10m`, `max-file=5`; nie włączać debug w produkcji. Włączyć Docker przy starcie systemu. Healthcheck nie restartuje automatycznie zawieszonego procesu — alert i procedura naprawcza pozostają potrzebne.

Oficjalne healthchecki InvenTree 1.7.0: `invoke server-health` na lokalny port oraz `invoke worker-health`. PostgreSQL: `pg_isready`; Redis: `redis-cli ping`. API: odrębne liveness (proces) i readiness (PG aplikacji oraz kontrolowany odczyt InvenTree), bez ujawniania konfiguracji i sekretów publicznie. Zależności `service_healthy` pomagają przy rozruchu, ale aplikacja także musi obsługiwać późniejszą niedostępność zależności.

HTTPS: DNS A/AAAA musi wskazywać prawidłowy serwer i publiczne porty muszą być osiągalne dla wybranego wyzwania ACME; alternatywa DNS challenge wymaga ograniczonego tokena DNS. Caddy przechowuje trwały stan certyfikatów. Testować łańcuch certyfikatu, odnowienie, HTTP→HTTPS i IPv6. HSTS włączyć po potwierdzeniu poprawnej domeny. Nie publikować ani nie zmieniać DNS w etapie 1. [Wymagania HTTPS Caddy](https://caddyserver.com/docs/automatic-https).

## Backup spójny między systemami

Propozycja do zatwierdzenia: **RPO 4 godziny, RTO 4 godziny**, kopia skoordynowana co 3 godziny (z budżetem najwyżej 1 godziny na checkpoint, upload i weryfikację) oraz przed każdą migracją/aktualizacją. Wiek danych liczymy od punktu zamrożenia zapisów, a nie od chwili zakończenia uploadu. To cele, których nie można deklarować jako osiągnięte przed pomiarem pełnego odtworzenia. Jeżeli krótkie blokady zapisu co 3 godziny są nieakceptowalne, potrzebny jest osobny projekt PITR i uzgadniania dwóch baz, a nie samo częstsze `pg_dump`.

Nie kopiować surowych plików działającego PostgreSQL. Nie traktować dwóch niezależnych dumpów jako jednej transakcji. Skrypt backupu ma blokadę `flock`, ograniczony timeout, `umask 077` i obsługę błędu z alertem. Procedura:

1. Utwórz identyfikator zestawu backupowego i manifest (czas rozpoczęcia, wersja aplikacji/commit, wersje i digesty obrazów, wersje schematów, nazwy baz i planowane składniki). Bez wartości sekretów.
2. Włącz uzgodniony tryb maintenance blokujący nowe zapisy w API i wszystkie inne kanały mutacji InvenTree, także interfejs administracyjny. Poczekaj na zakończenie aktywnych żądań i zadań; wstrzymaj harmonogramy i worker po opróżnieniu potrzebnych kolejek. Upewnij się, że operacje aplikacji nie pozostają w trakcie wysłania. Nieznane wyniki zachowaj jako wymagające uzgodnienia; nie odtwarzaj ich ponownym POST.
3. Zatrzymaj procesy będące źródłami zapisów, pozostawiając bazy dostępne do kopii. Zablokuj też administracyjny dostęp z prawem zmiany podczas checkpointu. Zapisz punkt czasowy zamrożenia.
4. Wykonaj `pg_dump` w formacie custom obu baz klientem pasującym do major serwera; obejmij schemat, dane i informacje o migracjach. Wersjonowane odtwarzanie ról/grantów z konfiguracji, a sekrety ról z chronionej kopii. Skopiuj media InvenTree i niezbędne konfiguracje/sekrety/certyfikaty do lokalnego zestawu z kontrolami dostępu. Nie pakuj live `PGDATA`. Redis cache odtwarza się pusty; brak niezakończonych zadań jest warunkiem checkpointu.
5. Sprawdź kody wyjścia wszystkich etapów, `pg_restore --list` obu dumpów, obecność wymaganych plików i sumy kontrolne. Błąd któregokolwiek składnika oznacza niekompletny zestaw.
6. Odblokuj normalny ruch po ukończeniu kompletnego lokalnego checkpointu i kontroli stanu usług. Nie czekaj z blokadą na transfer offsite. Skrypt obsługuje bezpieczne wyjście awaryjne i sygnalizuje, jeśli maintenance nie udało się zdjąć.
7. Prześlij komplet przez **restic** do szyfrowanego repozytorium w innym miejscu niż VPS, np. zatwierdzony S3/Object Storage w UE lub oddzielny rest-server. Hasło repozytorium przechowywane w menedżerze sekretów i oddzielnej kopii awaryjnej; nigdy wyłącznie na VPS. Samo szyfrowanie dostawcy storage nie zastępuje szyfrowania klienta.
8. Dopiero po sukcesie uploadu i weryfikacji obecności snapshotu wystaw metrykę `last_complete_offsite_backup` wraz z czasem punktu zamrożenia. Lokalny dump i backup/snapshot oferowany z VPS nie zastępują tego zestawu spójnego aplikacyjnie i szyfrowanej kopii offsite. Przekroczenie budżetu transferu oznacza ryzyko RPO i wymaga alertu.

Przykładowa retencja do zatwierdzenia: wszystkie zestawy z ostatnich 7 dni, 30 dziennych, 12 tygodniowych, 12 miesięcznych; musi mieścić się w uzgodnionym limicie retencji danych i pojemności. Restic `forget/prune` uruchamiane oddzielną zaufaną tożsamością, początkowo w `--dry-run`. Na serwerze produkcyjnym nie przechowywać uprawnienia usuwania całej historii, jeżeli backend pozwala na model append-only; sprawdzić zgodność konkretnego backendu i blokad restic zamiast zakładać prostą politykę S3 bez delete. Preferowana dodatkowa niezależna kopia lub mechanizm niezmienności zgodny z wybranym narzędziem. Nie stosować polityki retencji, która usuwa ostatnią znaną dobrą kopię po błędzie harmonogramu.

Weryfikacja: codziennie kontrola metadanych `restic check`, okresowo kontrola części danych, co najmniej raz w miesiącu pełna kontrola i odtworzenie próbne po początkowym teście odbiorowym; częstotliwość dopasować do rozmiaru i kosztu. Test integralności repozytorium nie zastępuje uruchomienia odtworzonej aplikacji. Lokalne zestawy przechowywać krótko, np. 48 godzin po potwierdzeniu offsite, z monitoringiem zajętości. Dobór retencji uwzględnia, że identyfikatory wizyt mogą być danymi osobowymi.

Źródła: [backup InvenTree w wersji 1.7.0](https://github.com/inventree/InvenTree/blob/1.7.0/docs/docs/start/backup.md), [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [restic — retencja i append-only](https://restic.readthedocs.io/en/stable/060_forget.html), [restic — odtwarzanie](https://restic.readthedocs.io/en/stable/050_restore.html).

## Rzeczywisty test odtworzenia — bramka przed pilotażem

Status teraz: **nie wykonano**. Nie ma VPS, kopii ani danych testowych, z których można wykazać restore. Raport nie może zawierać fikcyjnego czasu lub wyniku.

1. Przygotować oddzielny VPS/host z odrębnymi nazwami sieci i wolumenów, zamkniętym dostępem, wyłączoną wysyłką maili i integracjami z prawem zapisu; nie podłączać go do produkcyjnego DNS ani produkcyjnej bazy/API.
2. Rozpocząć pomiar RTO od symulacji utraty hosta. Pobrać wybrany kompletny zestaw **z offsite**, odtworzyć z manifestu przypięte obrazy i bezpieczną konfigurację; odtworzyć bazy i media w tej samej wersji InvenTree, w której wykonano backup. Nie wykonywać automatycznej migracji przed sprawdzeniem odtworzenia.
3. Sprawdzić role i granty PostgreSQL, migracje aplikacji, 12 identyfikatorów lokalizacji InvenTree i mapowania użytkowników, partie LOT/EXP, ilości kontrolne, historię stock tracking, audyt aplikacyjny, media i statusy idempotencji. Nie porównywać ilości wyłącznie z drugą kopią w Node — takich stanów nie projektujemy.
4. Unieważnić odtworzone sesje oraz linki resetu hasła i obrócić sekrety zależnie od scenariusza awarii. Zablokować automatyczne wznowienie operacji o niepewnym wyniku. Dla wybranych danych pilotażowych przetestować logowanie, izolację kont, rozchód, problem report i replay tego samego klucza idempotencji.
5. Zmierzyć czas pełnego przywrócenia obsługi oraz odległość czasową ostatniego kompletnego punktu od awarii (rzeczywisty RPO). Osobno zapisać czas downloadu, restore baz, weryfikacji i aplikacji. Zweryfikować brak zmian produkcyjnych podczas testu.
6. Raport: identyfikator backupu, UTC i czas lokalny testu, host testowy, wersje/digesty, dowody kontrolne, wyniki, osoba wykonująca, rzeczywiste RPO/RTO, odchylenia i decyzja go/no-go. Jeżeli cele przekroczone — poprawić procedurę i powtórzyć przed produkcją.

## Monitoring i reakcja

Minimalny zestaw: zewnętrzny HTTPS uptime, hostowy monitoring CPU/RAM/dysku/inodów, stan kontenerów i restartów, health serwera/workera, czas odpowiedzi i błędy InvenTree, zajętość kolejek, PostgreSQL connections/backup, oraz trwałe metryki operacji aplikacji. Metryki i panel monitoringu bez publicznego dostępu. Unikać montowania socketu Docker do kontenera monitorującego; jeżeli narzędzie go wymaga, świadomie ocenić uprawnienia równoważne administracji hostem.

Proponowane progi do pomiaru: brak HTTPS/readiness przez 2 minuty; wiek ostatniego kompletnego punktu offsite >3,5 godziny ostrzeżenie, >4 godziny alarm przekroczenia celu RPO; dowolna awaria backupu/restore; dysk >80% ostrzeżenie i >90% alarm; wzrost 5xx lub restartów; niedostępny worker; brak heartbeat zadania backupu; zbliżający się termin certyfikatu. Alert o operacji `UNCERTAIN/DISCREPANCY` natychmiast do magazyniera i administratora. Logi strukturalne z request/operation ID i redakcją cookie, Authorization, haseł, treści resetów i danych wizyt; ograniczona retencja, brak treści klinicznych.

Powiadomienia wymagają zatwierdzonego kanału i odbiorców. W etapie 1 nie wysyłamy e-maili ani wiadomości. Monitoring musi alarmować także przy całkowitym wyłączeniu VPS, dlatego heartbeat backupu i uptime potrzebują punktu poza tym hostem. Test alarmu i przywrócenia do normy jest osobnym dowodem odbioru.

## Aktualizacje i wycofanie zmian

- Każde wydanie: zatwierdzony commit + digesty obrazów + migracje + raport CI. Test najpierw na odtworzonej kopii bez produkcyjnych integracji, potem uzgodnione okno zmian i pełny backup skoordynowany.
- Migracje aplikacji w osobnym kroku/kontem; wzorzec expand/contract, zgodność co najmniej poprzedniej wersji aplikacji gdzie możliwe. Migracje InvenTree jawne, jednokrotne i według dokumentacji przypiętej wersji; wyłączyć niekontrolowane migracje przy każdym rozruchu po sprawdzeniu obsługi odpowiedniej konfiguracji.
- Jeśli problem dotyczy tylko statycznego frontendu/API i schemat jest zgodny, przełączyć obraz na poprzedni digest po zamrożeniu nowych zapisów i kontroli operacji w toku.
- Po niezgodnej migracji InvenTree nie uruchamiać starszego obrazu na nowszej bazie. Potrzebne jest odtworzenie **całego zgodnego zestawu** na oddzielnych wolumenach i weryfikacja; zachować nowe wolumeny do analizy. Cofnięcie backupu traci operacje wykonane po checkpointcie — wymaga zgody właściciela i planu uzgodnienia. Nie obiecywać bezstratnego rollbacku po mutacjach.
- Reboot VPS i odtworzenie autostartu testować najpierw na stagingu; produkcyjny restart tylko w zatwierdzonym oknie z dostępem do konsoli rescue. Zapisać wynik HTTPS, API, workerów, bazy i ochrony przed powtórzeniem rozchodów po restarcie.

## Decyzje do akceptacji

1. Docelowy VPS, host/port/użytkownik SSH, zaufany odcisk hosta, bezpieczne przekazanie klucza i zakres uprawnień do odczytu, później do instalacji; obecne usługi i dane do zachowania.
2. Domena PWA i DNS, model HTTPS, dostęp administracyjny przez VPN/tunel czy Cloudflare Access, uprawnienia do DNS (bez sekretów w czacie).
3. Parametry i budżet VPS oraz osobne środowisko staging/restore; dopuszczalne okna maintenance i restartu.
4. Cele RPO/RTO i koszt storage, dostawca/region UE repozytorium offsite, retencja, właściciel klucza szyfrowania i procedura odzyskania bez VPS.
5. Odbiorcy i kanał alarmów, odpowiedzialna osoba za reakcję i cykliczne testy restore; retencja logów i backupów wraz z identyfikatorem wizyty.
6. Akceptacja etapu infrastruktury po audycie VPS oraz odrębna końcowa zgoda na produkcję po pilotażu, testach izolacji, backupie i pomyślnym restore.

Wynik etapu 1 nie upoważnia do zmian produkcyjnych. Ostateczne kryteria infrastruktury (HTTPS, izolacja portów, reboot, rzeczywisty backup i restore, Android/iOS) pozostają niewykonane do czasu przygotowania środowiska i zgody właściciela.

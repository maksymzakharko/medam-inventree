# Zakupy i granice bezpieczeństwa

VPS jeszcze nie istnieje. Przygotowanie projektu nie kupiło usług, nie zmieniło
DNS/firewalla/SSH i nie uruchomiło produkcji. Poniższa lista służy właścicielowi
do zamówienia i odbioru; nie jest potwierdzeniem zgodności prawnej ani wydajności.

| Pozycja | Wybór / odpowiedzialność |
| --- | --- |
| VPS | OVH VPS-2, docelowo 4 vCPU/8 GB/75 GB NVMe, Ubuntu 24.04 LTS amd64, UE; potwierdzić aktualną ofertę i pomiary |
| Domena | Własna domena/subdomena magazynu, dostęp do DNS i poprawne A/AAAA |
| HTTPS | Automatyczny certyfikat Caddy/ACME; publiczne TCP 80/443, kontrola odnowienia |
| Offsite | Oddzielny storage w UE, pojemność/transfer/retencja, test dostępu oraz restic append-only/immutability |
| Klucz backupu | Menedżer sekretów i niezależna kopia awaryjna hasła restic oraz dostępu do storage |
| Restore/staging | Oddzielny host, choćby tymczasowy, bez prawa zapisu do usług produkcyjnych |
| Monitoring | Zewnętrzny uptime/heartbeat i zatwierdzony odbiorca alarmów, odpowiedzialna osoba dyżurna |
| Urządzenia | Android i iPhone/iPad do realnego testu HTTPS/PWA, offline i sesji |

Brak wymaganej subskrypcji InvenTree, Booksy, panelu hostingowego lub usługi AI.
Koszty VPS, domeny, storage, transferu i ewentualnych powiadomień sprawdź bezpośrednio
u dostawców. Nie podano ceny, której nie można potwierdzić przy zakupie.

## VPS-2 2027 i dodatki OVH

Oferta sprawdzona 9 listopada 2026 na [stronie OVH](https://www.ovhcloud.com/pl/vps/):
VPS-2 2027 ma 4 vCore, 8 GB RAM i 75 GB SSD NVMe; codzienny backup z ostatnich
24 godzin jest podany jako zawarty w cenie. Dostępność regionu, warunki backupu
i parametry zamówienia potwierdź w koszyku. Nie sprawdzano dostępności zakupu
i nie zamówiono żadnej usługi.

Ta konfiguracja jest rozsądnym punktem startowym dla 10 ratowników, magazynu
i gabinetu. To rekomendacja dla MVP, bez gwarancji wydajności: pomiary na zakupionym
hoście muszą potwierdzić zapas RAM, czas operacji i miejsce na obrazy oraz kopie.

| Dodatek | Rekomendacja dla tego projektu |
| --- | --- |
| Płatny rozszerzony backup OVH | Opcjonalny, jeśli potrzebujesz dłuższej historii lub wygodnego odzyskania całej maszyny. Potwierdź retencję i sposób restore. |
| Snapshot VPS | Opcjonalna dodatkowa kopia przed aktualizacją; nie stanowi dowodu spójności obu baz i mediów. |
| Oddzielny storage offsite | Wymagany przed produkcją: szyfrowany restic i spójne checkpointy opisane w dokumencie 10, dostęp awaryjny poza VPS. Preferowane oddzielne konto i region/dostawca. |
| Dodatkowy dysk | Na start zbędny przy małym katalogu i krótkiej retencji lokalnej; zakup po pomiarze zajętości. Dysk przy tym samym VPS nie jest offsite. |
| Plesk/cPanel, Windows, płatny certyfikat SSL, dodatkowy IP, zarządzana baza | Nie są potrzebne do przygotowanej konfiguracji Ubuntu/Docker/Caddy. |
| Domena i zewnętrzny monitoring | Potrzebne przed produkcją; można użyć istniejącej domeny/subdomeny i odpowiedniej usługi monitoringu. |

Backup dostawcy uzupełnia kopię aplikacyjną. Dzienna kopia maszyny sama nie
potwierdza celu RPO 4 godziny ani zgodnego punktu obu baz i plików. Najpierw
przeznacz budżet na offsite, odzyskanie kluczy i próbę restore; rozszerzony backup
OVH można dodać według potrzeb. Włącz MFA konta OVH/DNS/storage i zachowaj
niezależne kody odzyskiwania w menedżerze sekretów.

## Zabezpieczenia w plikach projektu

- Oddzielne kontenery/bazy PostgreSQL aplikacji i InvenTree. Runtime MEDAM nie
  otrzymuje hasła administratora ani dostępu do SQL InvenTree. Oddzielny migrator
  posiada schemat aplikacji; runtime nie może modyfikować/usunąć audytu.
- PostgreSQL, Redis i InvenTree bez portów hosta. Panel administracyjny wyłącznie
  przez loopback + tunel SSH/VPN. Edge jako jedyny publiczny HTTP/HTTPS.
- Backend startuje z plikami sekretów i przechodzi na UID/GID 1000 bez capabilities.
  Proces init ma `CAP_KILL`, aby przekazać sygnał zakończenia do procesu o innym UID.
  Compose secrets
  na jednym hoście to prywatne pliki, nie zewnętrzny vault; wymagają ochrony hosta.
- Konto integracji InvenTree bez staff/superuser i bez hasła interaktywnego.
  Role: stock view/add/change, part view, stock location view; add lokalizacji
  wyłącznie podczas bootstrapu, odbierane finalizacją. Stock delete jest wyłączone.
  Minimalne role trzeba potwierdzić rzeczywistymi testami wydania 1.7.0/API570.
- Audyt InvenTree włączony, automatyczne usuwanie wyłączone; monitor kontroluje
  ustawienia i token. Token ważny 365 dni; ostrzeżenie przed wygaśnięciem (30 dni).
  Kontrolowana rotacja wymaga maintenance, zmiany prywatnego pliku i odtworzenia API;
  nie należy regenerować tokenu podczas rozchodów.
- Hasła Argon2id, odwoływalne sesje HttpOnly/Secure w produkcji, CSRF, role i
  magazyn weryfikowane przez backend. Przeglądarka nie otrzymuje tokenu InvenTree.
- Trwała brama i historia idempotencji przechowywane z audytem w transakcjach
  aplikacji. Zapisów do InvenTree nie ponawia się automatycznie; timeout/niepełny
  dowód wymaga uzgodnienia. Backup i restore zachowują te blokady.
- PWA nie kolejkuje operacji offline ani nie zapisuje prywatnych API w cache.
  HTTPS i nagłówki bezpieczeństwa nie zastępują testu przeglądarek/izolacji.
- Oficjalne obrazy i obrazy bazowe przypięte wersją i digestem; aplikacja budowana
  ze źródeł i lockfile pnpm. Jej lokalne tagi są zmienne, a checkpoint zapisuje
  rzeczywiste image ID i commit/archiwum źródeł. Brak automatycznej aktualizacji.
  Kolejne wydanie wymaga stagingu, aktualizacji zależności i przeglądu bezpieczeństwa.

Poziom roli InvenTree jest szerszy niż pojedynczy endpoint (np. stock add służy
również endpointom korekt). Dlatego token pozostaje tylko w backendzie, a właściciel
utrzymuje wyłączny kanał zapisów do chronionych zapasów. Nie jest to izolacja
lokalizacji w samym tokenie InvenTree; izolację ratowników egzekwuje MEDAM.

## Odbiór hosta i obsługa incydentu

Po zakupie zachowaj mocne SSH, zweryfikowany host key, dostęp rescue, aktualizacje
OS, synchronizację czasu i przegląd portów z zewnętrznej maszyny. Nie zakładaj, że
UFW blokuje port opublikowany przez Docker. Weryfikacja IPv6 jest obowiązkowa,
jeżeli istnieje AAAA. Nie udostępniaj całego katalogu projektu przez serwer WWW.

Nie zapisuj danych pacjenta, opisu leczenia ani nazwisk w operacjach, notatkach,
raportach i zgłoszeniach. Nawet zewnętrzny identyfikator wizyty może być daną
osobową: właściciel ustala podstawę przetwarzania, retencję, dostęp i umowy z
dostawcami oraz uprawnienia personelu. Nie zadeklarowano zgodności prawnej.

Przy podejrzeniu niepewnego rozchodu: wstrzymaj nowe zapisy, zachowaj UUID operacji,
zakończ pierwotne żądania i innych autorów zapisów, sprawdź rzeczywisty stan i audyt
InvenTree. Dopiero uprawniony administrator używa odpowiedniej komendy CLI z
`--confirm-upstream-stopped` i uzasadnieniem. Flaga jest poświadczeniem operatora,
nie automatycznym dowodem. Nie edytuj ręcznie bramy w SQL i nie wysyłaj ponownie
POST z nowym identyfikatorem, aby ominąć blokadę.

Przy utracie hosta odzyskuj pełny zgodny checkpoint na nowych zasobach, rotuj
ujawnione sekrety i unieważniaj sesje/linki resetu. Nie uruchamiaj starszego InvenTree
na nowszej bazie. Przed przełączeniem ruchu rozlicz operacje po checkpointcie,
zapisz wyniki restore i uzyskaj końcową zgodę na produkcję.

## Jednostki i harmonogramy InvenTree 1.7.0

Part.units korzysta z rejestru jednostek fizycznych: `piece` oznacza jedną sztukę,
np. ampułkę opisaną w nazwie produktu. Skrót `amp.` nie przechodzi walidacji;
`amp` oznacza amper, więc nie zastępuje ampułki. Nie wykonujemy ukrytych przeliczeń.

`INVENTREE_PLUGINS_ENABLED=False` dotyczy pluginów zewnętrznych. Wbudowane moduły
nadal są ładowane. Compose dodatkowo wyłącza callbacki zdarzeń i harmonogramy
pluginów oraz automatyczne sprawdzanie kursów/aktualizacji przez global_settings.
Wymusza też włączony audyt stock i brak automatycznego usuwania dowodów audytu.
Retencja pozostaje oddzielną zatwierdzaną polityką. Nie wyłącza to workera ani
jego heartbeat; zbędne workflowy zmieniające stock nadal pozostają poza MVP.

## Korelacja audytu i zaufanie do identyfikatora żądania

InvenTree 1.7.0 korzysta z django-structlog 11, które domyślnie ignoruje przychodzący
`X-Request-ID`. Skutkiem był brak możliwości znalezienia dowodu przyjęcia po UUID.
Plik `infrastructure/docker/medam_settings.py` stanowi wyłącznie nakładkę ustawień
wewnętrznego Django InvenTree: włącza jawne zaufanie do identyfikatora żądania.
Własny backend pozostaje Node.js/Fastify.

Ta konfiguracja obowiązuje przy prywatnym API InvenTree: UUID wysyła uwierzytelniona
usługa Fastify, a potwierdzenie wymaga również zgodnego aktora, zasobu i ilości.
Sam CID nie dowodzi ani nie deduplikuje operacji. Nie udostępniaj administracyjnego
API InvenTree ratownikom ani publicznego proxy tych endpointów. Konfiguracja dotyczy
serwera, workera i narzędzi bootstrap, a rzeczywisty test CI sprawdza zgodność CID.
Źródło zmiany: https://github.com/jrobichaud/django-structlog/blob/11.0.0/docs/changelog.rst.

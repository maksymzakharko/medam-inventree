# MEDAM — przekazanie prac do nowego środowiska

Stan zapisany: **13 listopada 2026, Europe/Warsaw**. Jest to punkt wznowienia projektu, nie potwierdzenie wdrożenia produkcyjnego.

## 1. Obowiązująca decyzja właściciela

Ostatnie polecenia: zapisać stan do kontynuacji poza dotychczasową chmurą oraz **„chcę kontynuować na InvenTree”**.

Właściciel rozważał mniejszy własny system i otrzymał opis wariantu Fastify + jeden PostgreSQL. Nie rozpoczęto jego implementacji. Decyzja o pozostaniu przy InvenTree zamyka ten kierunek jako aktualne zadanie. [Prompt badawczy](requirements/research-alternatives-archived.md) jest wyłącznie archiwum; nie traktuj jego instrukcji jako kolejnego zlecenia. Nie usuwaj InvenTree, nie przebudowuj silnika zapasów i nie twórz równoległych edytowalnych stanów.

Priorytet: uzyskać działający, bezpieczny dostęp z nowego środowiska; wykonać audyt zakupionego VPS-1; przygotować proporcjonalny plan instalacji obecnego projektu z InvenTree na tym serwerze.

## 2. Gdzie jest kod

- Repozytorium: https://github.com/maksymzakharko/medam-inventree
- Gałąź implementacji i kontynuacji: `feat/working-mvp`.
- PR: https://github.com/maksymzakharko/medam-inventree/pull/1 — nie łącz automatycznie i nie traktuj PR jako zgody na produkcję.
- Ostatni commit przed niniejszym przekazaniem: `def931caff4b0ffa9091b1c406a8919464f9f456`.
- Sprawdzony kod na Ubuntu 26.04: `beb0847b32037900fe7397a9e610ff4358ad628d`.
- Nie zakładaj, że domyślna gałąź zawiera całą aplikację; wybierz jawnie `feat/working-mvp`.

```bash
git clone --branch feat/working-mvp https://github.com/maksymzakharko/medam-inventree.git
cd medam-inventree
git status --short
git log -5 --oneline
```

Nie wykonuj jeszcze `setup.sh`, bootstrapu ani instalacji pakietów na VPS tylko dlatego, że repozytorium zostało pobrane. Najpierw audyt i plan.

## 3. Cel biznesowy i zakres

Firma usług medycznych: 10 ratowników, około 20–30 preparatów, 70% wizyt mobilnych i 30% w gabinecie. 12 lokalizacji: główny MAG-00, osobiste MAG-01…MAG-10, gabinet MAG-11. Telefon jest podstawowym urządzeniem.

Wymagane: katalog produktów i jednostek, LOT/EXP, przyjęcia, przesunięcia/zwroty, zużycie, straty/korekty z uzasadnieniem, historia i eksport CSV, minima magazynowe, ostrzeżenia ważności i FEFO, zgłoszenia problemów. Zgłoszenie samo nie zmienia ilości.

Ratownik ma dostęp wyłącznie do swojego magazynu, zużycia, własnej historii i zgłoszeń. Magazynier zarządza zapasami we wszystkich magazynach; administrator dodatkowo kontami, przypisaniami i rozstrzyganiem operacji. Każde API egzekwuje te ograniczenia.

Poza MVP: dane pacjentów i dokumentacja leczenia, integracja Booksy, płatności, fiskalizacja, rekomendacje/dawkowanie, zapisy offline i platforma SaaS. Identyfikator wizyty wymaga świadomej polityki danych. Nie deklaruj zgodności prawnej na podstawie samego wdrożenia.

Pierwotne pełne wymagania: [archiwum zlecenia](requirements/original-project-request.md). Instrukcja obsługi: [dokument 13](13-user-guide.md).

## 4. Co już działa w kodzie

Monorepo pnpm: React/TypeScript/Vite PWA, Node.js LTS/Fastify/TypeScript, wspólne Zod. Node `26.13.0`, pnpm `12.18.0` — wersje w repozytorium, nie aktualizuj ich przy okazji bez sprawdzeń.

Sesje w PostgreSQL, Argon2id, CSRF/Origin, limity logowania, nadzorowany reset i odwoływanie sesji. Konta i osobiste przypisania magazynów mają rzeczywisty backend. UI po polsku: ratownik oraz magazynier/administrator, minima, ilości, CSV, zgłoszenia, historia.

InvenTree `1.7.0`, API `570`, pozostaje jedynym źródłem ilości/LOT/EXP/lokalizacji. MEDAM przechowuje uprawnienia, konfigurację, audyt i trwałą idempotencję. Odczyty i mutacje sprawdzają rzeczywistą lokalizację; nie ma dowolnego proxy do administracyjnego API InvenTree.

Operacje przez HTTP nie tworzą wspólnej transakcji obu baz. MEDAM używa trwałej bramy, dowodów audytu, UUID i stanów niepewności. `UNCERTAIN`/`DISCREPANCY` nie zwalnia się po czasie. Nie ponawiaj mutacji automatycznie ani z nowym UUID po utracie odpowiedzi. Nie uznawaj 201 upstream za dowód pełnego rozchodu.

Compose: oddzielne PostgreSQL aplikacji i InvenTree, Redis, worker, API, edge Caddy, opcjonalny prywatny panel. Obrazy oficjalne przypięte wersją/digestem. Sekrety generowane prywatnie przy instalacji. Brak domyślnych haseł i rzeczywistych produktów/stanów.

## 5. Potwierdzone testy i ich granice

| Dowód | Wynik |
| --- | --- |
| [CI #21, Ubuntu 26.04.1 amd64](https://github.com/maksymzakharko/medam-inventree/actions/runs/42846658502) | Oba zadania zaliczone dla `beb0847…` |
| [CI #22, commit dokumentacyjny `def931c…`](https://github.com/maksymzakharko/medam-inventree/actions/runs/42848694902) | Oba zadania zaliczone, ponownie sprawdzone przy przekazaniu |
| Integracja/bezpieczeństwo | 43 testy, prawdziwy PostgreSQL + kontrolowany upstream HTTP dla awarii |
| Przeglądarki | 10 testów desktop/Pixel 7, prywatność PWA, utrata sieci, przepływy ról |
| Infrastruktura | 32 testy archiwów, integralności, uprawnień, brokera i orkiestracji |
| Prawdziwy InvenTree | Build/start, bootstrap 12 magazynów, powtórzenie bez duplikatów, minimalne uprawnienia po finalizacji, Redis i prywatny panel |
| Operacje stock | Przyjęcie/CID, zużycie, częściowy/pełny transfer, zwiększenie i wykrycie przyciętego rozchodu |
| Checkpoint i restore | Obie bazy/pliki, porównania stock/LOT/EXP, migracji i pliku mediów, API gotowe, HTTP edge i 401 bez sesji |

Restore w CI Ubuntu 26.04 trwał **49,029 s** na małym zestawie, z obrazami już na tym samym runnerze. To nie jest RTO nowego hosta ani test offsite. Wcześniejszy wynik na Ubuntu 24.04: 48,365 s, osobny przebieg. Nie mieszaj tych pomiarów.

Dowody: [raport wydania](12-release-verification.md), [Ubuntu 26.04](14-ubuntu-26.04.md), [JSON](evidence/ubuntu-26.04.json). Testy CI nie potwierdzają wydajności na 4 GB RAM ani działania obrazu OVH, restartu hosta, prawdziwego HTTPS, telefonów iOS/Android, alarmów czy odzyskania z docelowego storage.

## 6. Zakupiony VPS i brak odbioru hosta

Właściciel kupił **OVH VPS-1 2027** — dostępny był tylko ten wariant: 2 vCore, 4 GB RAM, 40 GB NVMe. Nie wracaj do pytania, czy serwer został kupiony. Właściciel wskazywał Ubuntu 26.04; rzeczywiste `/etc/os-release` trzeba sprawdzić po uzyskaniu dostępu.

Nie potwierdzono pomiarów hosta, uruchomienia aplikacji, stanu dysków, istniejących usług, host key, backupu ani obecności produkcyjnych danych. Nie zakładaj, że serwer jest pusty. Nie wykonano przez agenta instalacji, restartu, edycji SSH/firewalla, synchronizacji magazynów ani importu na VPS.

Pełny kod był planowany z zapasem 8 GB RAM. Limity stałych usług Compose sumują się do 5504 MiB (5,375 GiB), a opcjonalny panel dodaje 128 MiB. **Limity nie są rezerwacją ani pomiarem zużycia.** Nie dowodzi to ani niemożności działania na VPS-1, ani wystarczalności 4 GB.

Na VPS-1 rozważ po audycie: mniejszą liczbę procesów InvenTree/workera, limity i ustawienia PostgreSQL oraz budowanie obrazów w CI. Każdą zmianę należy zmierzyć. Nie obiecuj pracy produkcji i kopii restore równolegle na tym samym małym serwerze. Nie usuwaj zabezpieczeń i testów dla oszczędności RAM.

Domena, DNS, offsite, odbiorca alarmów i realny katalog/ilości wymagają ustalenia. Nie kupiono ich ani nie skonfigurowano w tej sesji. Cel RPO/RTO po 4 godziny jest założeniem do pomiaru. Codzienna kopia dostawcy nie zastępuje spójnej szyfrowanej kopii aplikacji poza VPS.

## 7. Dostęp SSH — przyczyna zatrzymania

Właściciel podał host, IPv4/IPv6 i konto `ubuntu`; prywatne dane połączenia powinien przekazać nowemu środowisku osobno. Nie publikujemy ich w tym dokumencie. Port wskazany przez wyniki właściciela: **22**.

Właściciel wykonał polecenie dodania przygotowanego publicznego klucza do `authorized_keys`. To deklaracja wykonania, nie zaliczone logowanie. Fingerprint starego publicznego klucza wdrożeniowego:

```text
SHA256:/PSZ7M2xzym/1hZ55aULVweiRm9IH/PA0FE5M1wpGPA
komentarz: medam-deployment-access
```

Klucz prywatny znajduje się wyłącznie w starym środowisku, poza repozytorium. Nie jest częścią Git, pakietu źródeł ani tej instrukcji. Jego dostępności po zmianie środowiska nie gwarantujemy. Preferowane rozwiązanie: wygenerować w nowym środowisku nową parę, przekazać tylko klucz publiczny do dodania bez nadpisywania wcześniejszych wpisów; po potwierdzeniu dostępu stary wpis można odwołać. Nie próbuj odtwarzać klucza prywatnego z publicznego.

Hasło SSH zostało wcześniej ujawnione przez właściciela w rozmowie. **Nie zapisano go w repozytorium ani tej instrukcji.** Należy je zmienić; nie potwierdzono, że rotacja nastąpiła. Nie proś o ponowne wklejenie hasła, klucza prywatnego lub tokenu VPN do rozmowy; używaj bezpiecznej konfiguracji sekretów.

Przekazane przez właściciela wyniki z 13 listopada:

- `ssh.service` active/running; `ssh.socket` active/enabled.
- Nasłuch `0.0.0.0:22` i `[::]:22`.
- `ssh.service` disabled przy aktywnym `ssh.socket` nie świadczy o awarii.
- Wpisy nieudanych prób `admin1` nie były próbami agenta logującego się jako `ubuntu`; same nie dowodzą skutecznego włamania.

W starym środowisku połączenia SSH zwracały `Connection refused`, również poza piaskownicą. Późniejsza kontrola aktywnej polityki proxy wykazała **`tcp.enabled: false`**, bez konfiguracji VPN. Brak dostępu występował również przy kontrolnym zewnętrznym połączeniu TCP. Te błędy nie są dowodem, że SSH VPS jest wyłączone lub klucz użytkownika jest błędny. Nie zmieniaj ponownie serwera na podstawie tych samych błędów.

W obecnym wariancie Codex Cloud surowy TCP/SSH obsługiwany jest przez wspierane połączenie VPN Tailscale i proxy CONNECT. Samo „Enable all public internet access” nie włącza publicznego SSH. Właściciel nie może zmienić konfiguracji obecnego środowiska, dlatego przenosi pracę.

Nowe środowisko może być lokalne, z rzeczywistym dostępem SSH, albo chmurowe z poprawnie skonfigurowanym VPN. W wariancie chmurowym VPS i środowisko muszą być osiągalne przez odpowiednią sieć Tailscale i reguły dostępu. Nie zainstalowano ani nie skonfigurowano Tailscale na VPS w tej sesji. Zmiana konfiguracji chmury może wymagać ponownej publikacji i nowego zadania; nie edytuj lokalnego pliku polityki, aby udawać przyznanie dostępu.

Źródło sprawdzone 13 listopada: [oficjalna dokumentacja środowisk i VPN](https://learn.chatgpt.com/docs/environments/cloud-environments#private-networking-vpn). Jeśli nowy agent ma instrukcje własnego środowiska, powinien je przeczytać przed diagnozą, bez zakładania identycznej konfiguracji.

## 8. Kolejność wznowienia

1. Przeczytaj `CONTINUE.md`, `AGENTS.md` i ten dokument. Sprawdź gałąź, stan Git oraz późniejsze polecenia właściciela.
2. Zbadaj możliwości sieciowe nowego środowiska. Uzyskaj dane hosta i nowy bezpieczny dostęp. Nie przenoś haseł/kluczy w Git ani przez opis PR.
3. Zweryfikuj fingerprint hosta niezależnie, np. z konsoli OVH (`sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Nie wyłączaj weryfikacji host key.
4. Po pierwszym połączeniu wykonaj tylko odczyt: `id`, `/etc/os-release`, CPU/RAM/dysk, synchronizacja czasu, usługi/porty i istniejące zasoby Docker. Dostępny jest [preflight](../infrastructure/scripts/vps-preflight-readonly.sh); przejrzyj go przed uruchomieniem, zachowaj wyniki prywatnie.
5. Przedstaw konkretny plan dla VPS-1, z konfiguracją InvenTree i budżetem zasobów, planem kopii istniejącej konfiguracji oraz wycofania zmian. Nie wyłączaj firewalla/AppArmor/SSH, nie czyść wolumenów i nie instaluj przez `curl | sh`.
6. Dopiero po akceptacji planu wykonaj potrzebne zmiany serwera. Używaj [instrukcji 09](09-installation.md), [backupu 10](10-backup-restore.md) i [bezpieczeństwa 11](11-security-and-purchases.md); dostosuj opisane tam pierwotne zalecenia sprzętowe do faktycznie kupionego VPS-1 na podstawie pomiaru.
7. Przed realnymi zapasami: pilotaż dwóch kont, izolacja, stock/LOT/EXP, duplikaty i utrata odpowiedzi, restart hosta, HTTPS, fizyczne telefony, alarmy, offsite i odtworzenie na niezależnym hoście. Nie przenoś automatycznie wyniku CI na te kontrole.

## 9. Szczegóły implementacji, których nie należy cofać

- `piece` to jednostka sztuki. `amp.` jest niepoprawne, `amp` oznacza amper. Nie przeliczaj samodzielnie dawek, ml ani opakowań.
- `infrastructure/docker/medam_settings.py`: zaufanie do uwierzytelnionego `X-Request-ID` dla CID audytu django-structlog 11 oraz jawny alias Redis workera także przy migracjach/check. Nie usuwaj tej nakładki bez zastępczego dowodu zgodności.
- API startuje małym launcherem odczytującym prywatne sekrety, potem przechodzi na UID/GID 1000. Root init potrzebuje `CAP_KILL` do przekazania sygnału dziecku o innym UID; aplikacja traci capabilities po zmianie UID.
- Worker uruchamia `manage.py qcluster` bez pośredniego PTY `invoke worker`, żeby poprawnie kończyć pracę po SIGTERM. Backup odmawia po wymuszonym zakończeniu/niezerowym exit.
- Sprawdzenie kolejki działa jako odczytowy `check` przed importem Django z PostgreSQL read-only. Zwykły start Django może sam zlecać zadania. Redis nie ma liczników acknowledgement locks, więc `None` jest rozpoznawane tylko dla dokładnie znanego brokera, po łagodnym zatrzymaniu workera. Redis ma `noeviction`.
- Odtwarzanie zachowuje prywatne katalogi/sekrety; publiczne źródła SQL muszą być czytelne dla UID PostgreSQL w bind mountach. Nie przywracaj błędnego `0600` dla każdego pliku źródłowego.
- Docker nie publikuje portów kontenera podłączonego tylko do sieci internal. Dedykowane mosty dla proxy administracyjnego i odtworzonego edge są celowe; API/InvenTree/bazy kopii nadal mają sieci wewnętrzne. Porty panelu/restore pozostają na loopback.
- Przywracanie tworzy świeży cel i odmawia nadpisywania istniejących zasobów. Nie wykonuje replay operacji, zachowuje bramę, unieważnia skopiowane sesje i nie uruchamia workera automatycznie.

## 10. Co przenosi Git, a co nie

Git przenosi kod, migracje, lockfile, Compose, instrukcje, skrypty oraz publiczne podsumowania dowodów. Ten commit przekazania nie zmienia działania aplikacji.

Nie przenosi: `.env`, `secrets/`, haseł, kluczy prywatnych, tokenów, dumpów, lokalnych baz testowych, node_modules, przeglądarek Playwright, plików starej sesji ani bieżących połączeń. Nie zakładaj, że ścieżki `/workspace/work/...` istnieją w nowym środowisku. Świeża instalacja ma wygenerować własne sekrety; ewentualne rzeczywiste dane trzeba najpierw zidentyfikować i zabezpieczyć osobną procedurą.

Testy aplikacji wymagają wyłącznie odseparowanej bazy `medam_test*`; fixture celowo czyści tę testową bazę. Nigdy nie wskazuj bazy produkcyjnej. Szczegóły: [tests/README](../tests/README.md).

Jeżeli w rozmowie pojawi się nowsze polecenie właściciela, ma ono pierwszeństwo przed tym snapshotem. Nie deklaruj wykonanych operacji na VPS bez rzeczywistego połączenia i dowodów.

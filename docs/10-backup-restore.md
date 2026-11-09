# Backup, monitoring i próba odtworzenia

Cel do potwierdzenia pomiarem: RPO 4 godziny i RTO 4 godziny. Backup co 3 godziny
pozostawia godzinę na checkpoint i upload. Wiek danych liczymy od `frozenAtUtc`,
a nie zakończenia wysyłania. Nie wykonano jeszcze pełnej próby Docker/restore ani
backupowania rzeczywistej instancji; skrypty nie stanowią dowodu osiągnięcia celów.

## Konfiguracja szyfrowanego offsite

Zamów osobny storage w zatwierdzonym regionie UE, poza VPS. Restic szyfruje dane
przed wysłaniem. Hasło repozytorium i dostęp awaryjny zachowaj także poza VPS,
np. w firmowym menedżerze sekretów; bez hasła zaszyfrowanej kopii nie odtworzysz.
Pliki lokalnych checkpointów zawierają jawne sekrety: katalog `0700`, pliki `0600`,
krótka retencja i szyfrowany dysk/host pozostają potrzebne.

Przygotuj `/etc/medam` z prawami `0700`, a pliki konfiguracyjne `0600` należące do
root/operatora. Przykładowa zawartość prywatnego `/etc/medam/restic.env` dla S3:

```dotenv
RESTIC_REPOSITORY='s3:https://ENDPOINT_EU/BUCKET/medam'
RESTIC_PASSWORD_FILE=/etc/medam/restic-password
AWS_ACCESS_KEY_ID='UZUPELNIJ_W_PRYWATNYM_PLIKU'
AWS_SECRET_ACCESS_KEY='UZUPELNIJ_W_PRYWATNYM_PLIKU'
AWS_DEFAULT_REGION='REGION_DOSTAWCY'
```

Nie wpisuj tych sekretów do Git, komunikatora ani argumentów poleceń. Nie dodawaj
`export` w tym pliku: odczytuje go też systemd `EnvironmentFile`. Przy ręcznym
wywołaniu skryptów `RESTIC_ENV_FILE` wskazuje zaufany lokalny plik powłoki.
Nadaj konto storage zgodnie z dokumentacją backendu; przetestuj blokady restic,
przyrostową kopię i model append-only/immutability u wybranego dostawcy.

Nowe losowe hasło i inicjalizacja **nowego** repozytorium (operator z uprawnieniami):

```bash
sudo install -d -m 0700 /etc/medam
sudo sh -c 'umask 077; test ! -e /etc/medam/restic-password && openssl rand -hex 32 > /etc/medam/restic-password'
sudo chmod 0600 /etc/medam/restic.env
sudo bash -c 'set -a; . /etc/medam/restic.env; set +a; restic init'
```

`restic.env` utwórz wcześniej prywatnym edytorem. Nie wykonuj `init` na istniejącym
repozytorium. Sprawdź odzyskanie pliku hasła z niezależnego miejsca.

## Checkpoint

Przed kopią obowiązuje wyłączny kanał zapisów MEDAM. Zakończ narzędzia CLI,
importy i inne prace administracyjne; zamknij zewnętrzne tokeny/workflowy zapisujące
te same zapasy. Nie zmieniaj wydania lub sekretów w trakcie checkpointu.

```bash
cd /opt/medam
infrastructure/scripts/backup.sh --local-only
sudo RESTIC_ENV_FILE=/etc/medam/restic.env infrastructure/scripts/backup.sh --offsite
```

Skrypt bierze `flock`, zatrzymuje wejście edge/panel, czeka na zakończenie API,
potem serwera i workera. Niezerowy exit procesu, przymusowe zabicie, oczekujące
lub zablokowane zadanie brokera przerywają kopię. Usługi uruchomione przed kopią
są wznawiane także przy błędzie; nieudane wznowienie alarmuje. Kolejki nie są
czyszczone. Tryb maintenance jest sygnalizowany świeżym markerem przez najwyżej
godzinę; starszy marker jest alarmem. Checkpoint obejmuje:

- Dump custom obu baz klientem PostgreSQL 17, wraz z migracjami i audytem.
- Dane/media InvenTree, dane/config Caddy, konfigurację i wszystkie pliki sekretów.
- Źródła bieżącego wydania bez zależności/buildów, lockfile i przypięte konfiguracje.
- Wersje, rzeczywiste image ID/digesty, czas zamrożenia i metadane nierozstrzygniętych
  operacji oraz bramy. Niepewny wynik pozostaje niepewny po restore.
- Sumy SHA-256 i manifest formatu 2. `pg_restore --list` sprawdza oba dumpy;
  walidator sprawdza kompletność, sumy i bezpieczne ścieżki archiwów.

Wynik pojawia się w `backups/YYYYMMDDTHHMMSSZ`. `.partial` oznacza niedokończony
zestaw i nie jest źródłem restore. Sukces lokalny nie aktualizuje metryki offsite.
Po sprawdzonym uploadzie i znalezieniu odpowiedniego snapshotu restic skrypt
aktualizuje atomowo `last-complete-offsite-checkpoint` czasem zamrożenia.
Nie ma automatycznego ponawiania zapisów do InvenTree ani automatycznego czyszczenia
blokady. Redis odtwarza się pusty; dlatego kompletna kopia wymaga pustego brokera.

Nie wykonuj surowej kopii działającego `PGDATA`. Nie łącz dumpów z dwóch różnych
checkpointów. Snapshot OVH jest dodatkowym środkiem, a nie zamiennikiem tego zestawu.
Źródła są dołączone również wtedy, gdy bieżące wydanie nie ma jeszcze commitu;
autorytatywna jest kopia `source.tar.gz` wraz z sumą.

## Harmonogram, alarmy i integralność

Szablony zakładają `/opt/medam` i `/etc/medam/restic.env`. Przed włączeniem timers
wykonaj ręczny udany backup i przygotuj `backups`. Jeśli używasz innego katalogu,
dostosuj ścieżki `ExecStart`, `WorkingDirectory`, `ReadWritePaths` i `ReadOnlyPaths`.
Nie instaluj timerów z katalogu projektu modyfikowalnego przez niezaufane konto.

```bash
sudo install -d -m 0700 /opt/medam/backups
sudo install -m 0644 infrastructure/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now medam-backup.timer medam-monitor.timer medam-restic-check.timer
sudo systemctl list-timers 'medam-*'
sudo journalctl -u medam-backup.service -u medam-monitor.service -u medam-restic-check.service --since today
```

Backup: co 3 godziny UTC. Metadata check restic: codziennie 01:30 UTC. Monitor:
co minutę, alarm readiness po 2 minutach. Monitor sprawdza także dysk/inode,
RAM/load, health/restarty kontenerów, połączenia PG, brokera, audyt i datę wygaśnięcia
tokenu integracji. `UNCERTAIN`/`DISCREPANCY` alarmuje od razu; starsze operacje
w toku i zajęta brama wymagają kontroli. Wiek offsite >3,5 h ostrzega, >4 h alarmuje.

Opcjonalny `/etc/medam/monitor.env` (`0600`):

```dotenv
MONITOR_HTTPS_ORIGIN=https://magazyn.twoja-firma.pl
# ALERT_WEBHOOK_FILE=/etc/medam/alert-webhook-url
```

Domyślnie alarmy zapisują się tylko w prywatnym journalu. Dopiero świadome ustawienie
`ALERT_WEBHOOK_FILE` włącza HTTPS POST `{"message":"..."}` do własnego zatwierdzonego
endpointu. Adres trzymaj w prywatnym pliku `0600`. Dopasuj format po stronie odbiorcy;
skrypt nie konfiguruje Slack/e-mail/SMS i nie wysłał wiadomości podczas budowy.
Przetestuj dostarczenie i powrót do normy w uzgodnionym kanale. Stan/dedup monitoringu
jest w `/var/lib/medam-monitor/state.json`. Zewnętrzny uptime i heartbeat są osobnym
wymaganiem, bo lokalny monitor nie działa przy utracie całego VPS.

Kontrole integralności (nie zastępują uruchomienia odzyskanej aplikacji):

```bash
sudo RESTIC_ENV_FILE=/etc/medam/restic.env infrastructure/scripts/restic-check.sh --metadata
sudo RESTIC_ENV_FILE=/etc/medam/restic.env infrastructure/scripts/restic-check.sh --full
```

Szablony nie usuwają lokalnych kopii ani historii offsite. Początkowo retencję
wykonuj ręcznie po potwierdzeniu offsite i testu restore; plan: 7 dni wszystkich,
30 dziennych, 12 tygodniowych, 12 miesięcznych, do zatwierdzenia z właścicielem
danych. Retencja/prune to oddzielna tożsamość i najpierw `--dry-run`. Monitoruj miejsce
na lokalne kopie; 48 h to propozycja retencji lokalnej, nie automatyczne usuwanie.

## Izolowany restore na oddzielnym hoście

Zacznij pomiar od symulacji utraty hosta. Pobierz **z offsite** kompletny checkpoint
do prywatnego katalogu. Przykład poniżej działa na nowym hoście, po prywatnym
odtworzeniu `restic.env` i hasła; `ID_SNAPSHOTU` wybierz z `restic snapshots --tag medam`:

```bash
sudo bash -c 'set -a; . /etc/medam/restic.env; set +a; restic snapshots --tag medam'
sudo bash -c 'set -a; . /etc/medam/restic.env; set +a; restic restore ID_SNAPSHOTU --target /srv/medam-download'
```

Restic zachowuje ścieżkę źródłową, więc checkpoint będzie np. pod
`/srv/medam-download/opt/medam/backups/YYYYMMDDTHHMMSSZ`. Nie uruchamiaj oryginalnej
produkcyjnej `.env` z pobranego zestawu. Użyj skryptu z zaufanego bieżącego wydania:

```bash
python3 infrastructure/scripts/checkpoint.py validate /srv/medam-download/opt/medam/backups/ID_CHECKPOINTU
infrastructure/scripts/restore.sh /srv/medam-download/opt/medam/backups/ID_CHECKPOINTU --target /srv/medam-restore-01 --project medam-restore-proba01 --build-app-images
```

Katalog docelowy **nie może istnieć**, również jako pusty katalog lub dowiązanie.
Katalogi odtworzenia pozostają prywatne (`0700`), sekrety i konfiguracja `0600`.
Wersjonowane źródła mają `0644`/`0755`, aby proces PostgreSQL po zmianie UID mógł
odczytać podmontowane pliki inicjalizacyjne SQL. Nie zmienia to praw sekretów.
Skrypt odmawia także, jeśli projekt ma już kontenery, wolumeny lub sieci. Każde
niepowodzenie pozostawia nowe zasoby do kontroli; nie usuwa ich i nie próbuje
ponownie na tym samym celu. Po zbadaniu błędu wybierz kolejną nową nazwę/katalog.
Nie wskazuj produkcyjnego DNS ani zewnętrznych baz/API. Domyślne porty są wyłącznie
loopback: PWA 18080, panel 18090. Podsiec ingress to oddzielna `172.30.11.0/28`;
jeśli zajęta, podaj inną wolną prywatną `/28` przez `--subnet`.

Restore sprawdza sumy i ścieżki archiwów, odtwarza role z prywatnych sekretów,
obie bazy i media na nowych wolumenach, nadaje granty runtime, unieważnia sesje
i linki resetu oraz zmienia sekret sesji. Zachowuje oryginalny pepper/token
InvenTree, historię operacji i bramę. Nie wykonuje migracji ani replay zapisów.
Nie uruchamia workera, panelu administracyjnego, TLS/ACME lub wysyłki alertów.
Wszystkie sieci są wewnętrzne. Certyfikaty Caddy pozostają w checkpointcie, nie
są serwowane na hoście testowym. Oryginalna konfiguracja jest wyłącznie dowodem
w `recovery-evidence`.

`--build-app-images` buduje API/PWA z dołączonych źródeł i lockfile pod nowymi tagami;
potrzebny jest dostęp do rejestrów pakietów. Nie gwarantuje identycznych bajtów obrazu.
Bez flagi wymagane są obecne obrazy aplikacji o dokładnych ID z `image-lock.json`
(np. uprzednio załadowany zaufany artefakt wydania). Oficjalne obrazy pozostają
przypięte wersją/digestem z zapisanych plików Compose. Odzyskuj na tej samej
architekturze co źródłowy host i sprawdź wersje przed próbą upgrade.

Po starcie sprawdź w odzyskanej aplikacji: 12 mapowań i PK lokalizacji, role i
przypisania, LOT/EXP i kontrolne ilości z InvenTree, media, historię stock/audyt,
idempotencję i zachowanie niepewnych operacji. Testowe rozchody wykonuj tylko na
tej izolowanej kopii. Jeśli potrzebujesz workera, najpierw przejrzyj zapisane
zadania i politykę wyłącznych zapisów; nie uruchamiaj go automatycznie z oryginalną
konfiguracją. Zapisz datę UTC, snapshot/checkpoint, host, wersje, wyniki i czasy.

Pełne przywrócenie produkcji oraz przełączenie DNS wymagają osobnego planu po tej
próbie: rotacji poświadczeń zależnie od awarii, uzgodnienia operacji po checkpointcie,
monitoringu i końcowej zgody właściciela. Cofnięcie kopii może utracić późniejsze
operacje; nie zastępuj nim uzgadniania niepewnego rozchodu.

# Instalacja MEDAM

Stan: gotowe pliki lokalnego projektu. VPS OVH nie został kupiony; nie wykonano
instalacji produkcyjnej. Poniższe polecenia są instrukcją dla właściciela po zakupie
i odczytowym audycie hosta. Wyniki sprawdzeń tego wydania opisuje dokument 12.
Pełny start Compose, HTTPS i restore muszą przejść odbiór na docelowym środowisku.

## Wymagania i przygotowanie

Rekomendacja: OVH VPS-2, 4 vCPU, 8 GB RAM, minimum 75 GB NVMe, Ubuntu 24.04 LTS
amd64, region UE. Przed zakupem sprawdź aktualne parametry. Potrzebne są także
domena, storage offsite i oddzielny host do próby restore. Nie ma płatnego panelu,
Booksy ani obowiązkowej płatnej usługi logowania.

1. Zweryfikuj odcisk klucza SSH przez panel OVH; zachowaj bezpieczne zasady SSH.
   Uruchom `infrastructure/scripts/vps-preflight-readonly.sh` na zakupionym hoście.
   Zachowaj wynik prywatnie. Sprawdź synchronizację czasu, dostęp rescue, zajęte
   porty, IPv4/IPv6, istniejące wolumeny i wolne miejsce.
2. W uzgodnionym oknie przygotuj Ubuntu z Docker Engine i Compose pluginem
   **2.24.4 lub nowszym** według [oficjalnej instrukcji Docker](https://docs.docker.com/engine/install/ubuntu/).
   Wymagane narzędzia hosta: `git`, `openssl`, `python3`, `curl`, `tar`, `util-linux`
   (`flock`), `coreutils` (`timeout`, `sha256sum`) oraz `restic`.
   Nie stosuj zdalnego skryptu `curl | sh`. Docker wymaga zaufanego administratora;
   dostęp do jego socketu oznacza uprawnienia równoważne root.
3. Skopiuj komplet zatwierdzonego wydania do `/opt/medam`, razem z lockfile,
   `apps`, `packages`, `infrastructure`, `docs` i plikami Compose. Repozytorium:
   `git clone --branch feat/working-mvp https://github.com/maksymzakharko/medam-inventree.git /opt/medam`.
   Zweryfikuj commit wydania według dokumentu 12. Nie przenoś `node_modules`, `.env`
   ani sekretów z innej instancji.
4. Użytkownik wykonujący polecenia musi czytać katalog projektu i obsługiwać Docker.
   Zarezerwuj podsieć `172.30.10.0/28`; jeśli koliduje z siecią hosta/VPN/Dockera,
   wpisz wolną prywatną `/28` jako `MEDAM_INGRESS_SUBNET` w `.env` przed startem.

Sprawdzenie narzędzi nie uruchamia kontenerów:

```bash
cd /opt/medam
docker version
docker compose version
openssl version
python3 --version
restic version
```

## Lokalna próba na komputerze lub stagingu

```bash
cd /opt/medam
infrastructure/scripts/setup.sh
infrastructure/scripts/medam-compose.sh config --quiet
infrastructure/scripts/bootstrap.sh administrator
```

`setup.sh` tworzy prywatną `.env` i losowe pliki sekretów (`0700`/`0600`). Nie
nadpisuje istniejącej `.env`. Nie kopiuj jej zawartości do zgłoszeń ani logów.
Bootstrap wymaga terminala TTY: buduje obrazy, inicjuje oddzielne bazy, wykonuje
migracje, nadaje ograniczone granty, włącza audyt InvenTree i tworzy administratora
MEDAM przez ukryty prompt hasła. Zanotuj wyświetlony UUID administratora.

Następnie, podstawiając rzeczywisty UUID:

```bash
infrastructure/scripts/medam-compose.sh run --rm --no-deps app-cli dist/cli/index.js sync-warehouses --actor UUID_ADMINA
infrastructure/scripts/finalize-bootstrap.sh
infrastructure/scripts/medam-compose.sh ps
infrastructure/scripts/medam-compose.sh exec -T api node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");process.exit(r.ok?0:1)'
```

Synchronizacja tworzy/wiąże 12 lokalizacji `MAG-00`–`MAG-11`: główny magazyn,
10 ratowników i gabinet. Nie tworzy leków ani ilości. Lokalizacje identyfikuje po
stałym kodzie i PK; duplikat lub niejednoznaczny zapis zatrzymuje synchronizację.
Nie uruchamiaj jej ponownie po niepewnym wyniku przed uzgodnieniem operacji.
Finalizacja odbiera kontu integracji prawo tworzenia lokalizacji i uruchamia PWA.

Otwórz `http://localhost:8080`. Tryb HTTP działa lokalnie; instalację PWA i Secure
cookies na urządzeniach mobilnych sprawdzaj przez produkcyjny HTTPS na stagingu.
`/api/me` bez sesji ma zwracać 401. `/health/ready` pozostaje wewnętrznym endpointem.

## Produkcja po zakupie VPS

W pustym katalogu wydania (jeszcze przed lokalnym setupem) użyj:

```bash
infrastructure/scripts/setup.sh --production --domain magazyn.twoja-firma.pl
infrastructure/scripts/medam-compose.sh config --quiet
```

Ustaw DNS A/AAAA na właściwy host. Publikuj wyłącznie TCP 80/443 oraz wcześniej
zatwierdzony, ograniczony SSH. Usuń niepoprawny AAAA zamiast zostawiać częściowo
działające IPv6. Zweryfikuj reguły OVH i hosta, uwzględniając sposób publikowania
portów przez Docker. PostgreSQL, Redis i InvenTree nie mają portów publicznych.
Nie zmieniaj reguł przez skrypty tego projektu.

Wykonaj bootstrap, sync i finalizację jak wyżej, a następnie sprawdź HTTPS,
przekierowanie HTTP, cookies Secure/HttpOnly, readiness, isolation, backup i restore.
Plik produkcyjny włącza `NODE_ENV=production` oraz Secure cookies; wrapper dobiera
go z `MEDAM_MODE=production`. Jeśli `.env` już istnieje, setup jej nie przełączy:
edytuj konfigurację świadomie, zachowując sekrety i istniejące dane.

Nie uruchamiaj zwykłego `docker compose up` z pominięciem wrappera w produkcji.
Nie używaj `down -v`, `prune` ani usuwania wolumenów. Wznowienie bez migracji:
`infrastructure/scripts/medam-compose.sh start`. Każda aktualizacja wymaga osobnego
checkpointu, przeglądu migracji i okna zmian; restart nie jest procedurą aktualizacji.

## Konta, hasła i panel InvenTree

Konta tworzy administrator w PWA lub rzeczywistym CLI:

```bash
infrastructure/scripts/medam-compose.sh run --rm --no-deps app-cli dist/cli/index.js --help
infrastructure/scripts/medam-compose.sh run --rm --no-deps app-cli dist/cli/index.js create-user --actor UUID_ADMINA --login ratownik01 --role medic --warehouse MAG-01
infrastructure/scripts/medam-compose.sh run --rm --no-deps app-cli dist/cli/index.js reset-password --actor UUID_ADMINA --user UUID_NOWEGO_KONTA
```

Role: `medic`, `warehouse_manager`, `admin`. Ratownik wymaga przypisania magazynu.
Reset wydaje prywatny link jednorazowy ważny 15 minut, na terminal lub do nowego
pliku `--output` wewnątrz kontenera. Zewnętrzny plik wymaga jawnego prywatnego bind
mountu; po przekazaniu tokenu nie zostawiaj go w repozytorium. Sam publiczny wniosek
o reset nie wysyła e-maila. Operator przekazuje link uzgodnionym bezpiecznym kanałem.

Osobne konto administracyjne InvenTree utwórz oficjalnym interaktywnym narzędziem:

```bash
infrastructure/scripts/medam-compose.sh run --rm --no-deps inventree-server invoke superuser
infrastructure/scripts/medam-compose.sh --profile admin up -d admin-proxy
```

Na swoim komputerze zestaw tunel do zatwierdzonego hosta:

```bash
ssh -N -L 8090:127.0.0.1:8090 UZYTKOWNIK@HOST_VPS
```

Dla ewidencji całych ampułek/opakowań wybierz zatwierdzoną jednostkę bazową.
InvenTree 1.7.0 rozpoznaje `piece` jako sztukę; `amp.` nie jest poprawną jednostką
fizyczną. W nazwie produktu można doprecyzować „ampułka”, zachowując ilości jako
liczbę sztuk i krok 1. Nie używaj `amp` (amper) i nie zakładaj automatycznych
przeliczeń opakowań, ml ani dawki. Wzór katalogu: [products.csv](templates/products.csv).

Panel: `http://localhost:8090`. Użyj go do przygotowania katalogu leków i pierwszych
partii LOT/EXP w kontrolowanym maintenance. Rutynowe zapisy po uruchomieniu zespołu
wykonuje MEDAM. Ratownicy nie otrzymują kont InvenTree. Wyłącz dodatkowe workflowy
zmieniające chronione zapasy, pluginy, importy i niezależne zapisy przez inne tokeny.

## Odbiór i utrzymanie

Skonfiguruj i sprawdź offsite oraz timery zgodnie z [dokumentem 10](10-backup-restore.md).
Monitoring na tym samym VPS nie wykryje własnego wyłączenia: potrzebny jest także
zewnętrzny uptime/heartbeat. Kanał alarmów pozostaje wyłączony do świadomego
skonfigurowania przez właściciela. Nie wysłano żadnych powiadomień w czasie budowy.

Przed dopuszczeniem rzeczywistych zapasów: próba izolacji dwóch ratowników,
rozchód częściowy/pełny, niepewna odpowiedź i trwała blokada, replay tego samego ID,
przypisania po odwołaniu sesji, stock tracking/audyt, pełny restore z offsite,
Android/iOS i restart stagingu. Zapisz rzeczywiste wyniki i czas RPO/RTO.
Brak któregokolwiek dowodu oznacza niewykonany odbiór, a nie sukces domyślny.

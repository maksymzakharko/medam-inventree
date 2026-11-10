# Ubuntu 26.04 LTS — zgodność hosta

Docker Engine oficjalnie obsługuje Ubuntu 26.04 LTS amd64:
https://docs.docker.com/engine/install/ubuntu/
GitHub udostępnia runner ubuntu-26.04:
https://github.com/actions/runner-images

Aplikacja używa przypiętych kontenerów Node, InvenTree, PostgreSQL, Redis i Caddy.
Nie instaluje ich bibliotek bezpośrednio na Ubuntu hosta. Skrypty wymagają Bash,
Python 3, OpenSSL, curl, tar, util-linux, coreutils i restic; jednostki systemd
nie zawierają ścieżek zależnych od wydania Ubuntu. Nie znaleziono wymogu zmiany
kodu aplikacji dla 26.04.

Workflow CI przeniesiono na ubuntu-26.04 dla testów aplikacji oraz pełnego
Compose/kontraktu InvenTree/checkpointu/restore. Wynik: **oba zadania zaliczone** dla commitu
`beb0847b32037900fe7397a9e610ff4358ad628d`.
[CI #21](https://github.com/maksymzakharko/medam-inventree/actions/runs/42846658502),
10 listopada 2026, host Ubuntu 26.04.1 amd64.

Zaliczone: 43 testy integracyjne, 10 przeglądarkowych (26,6 s),
32 infrastruktury, pełny build/start, bootstrap 12 magazynów, finalizacja
uprawnień, prywatny panel, sześć rzeczywistych operacji stock/audit, checkpoint
obu baz/plików i izolowany restore z porównaniami oraz HTTP/401.
Restore małego zestawu na tym samym runnerze: **49,029 s**, obrazy już dostępne.
Nie stwierdzono potrzeby zmiany kodu aplikacji ani obrazów kontenerów.

Host OVH wymaga oddzielnego odbioru: Docker z oficjalnego repozytorium dla
właściwego kodu wydania (bez wymuszania repozytorium noble), AppArmor, cgroups,
porty IPv4/IPv6, firewall Docker, DNS/HTTPS, restart/autostart, timery i offsite.
Nie wyłączaj AppArmor ani firewalla dla obejścia błędów. Nie wykonano testu na
obrazie OVH Ubuntu 26.04 ani restartu tego VPS. Dotychczasowe dowody w dokumencie
12 dotyczą wcześniejszego przebiegu na Ubuntu 24.04 i pozostają odrębnym dowodem.

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
Compose/kontraktu InvenTree/checkpointu/restore. Wynik należy odczytać dla
konkretnego commitu w Actions; sama zmiana runnera nie potwierdza zgodności.

Host OVH wymaga oddzielnego odbioru: Docker z oficjalnego repozytorium dla
właściwego kodu wydania (bez wymuszania repozytorium noble), AppArmor, cgroups,
porty IPv4/IPv6, firewall Docker, DNS/HTTPS, restart/autostart, timery i offsite.
Nie wyłączaj AppArmor ani firewalla dla obejścia błędów. Nie wykonano testu na
obrazie OVH Ubuntu 26.04 ani restartu tego VPS. Dotychczasowe dowody w dokumencie
12 dotyczą wcześniejszego przebiegu na Ubuntu 24.04 i pozostają odrębnym dowodem.

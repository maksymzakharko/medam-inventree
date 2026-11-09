# MEDAM — magazyn leków

React PWA i API Node.js/Fastify dla magazynu głównego, gabinetu i dziesięciu
osobistych magazynów ratowników. InvenTree jest jedynym źródłem bieżących zapasów,
lokalizacji, LOT i EXP. Wersja `0.1.0` jest przeznaczona do testów i pilotażu;
produkcja wymaga odbioru na docelowym VPS.

## Zaimplementowane

- Polskie PWA: logowanie, mój magazyn, wyszukiwanie/filtry, FEFO, zużycie, historia,
  zgłoszenia, wylogowanie, wygasanie sesji i odzyskiwanie niepewnej operacji.
- Panel magazyniera/administratora: magazyny, przyjęcia, przesunięcia, straty/korekty,
  minima i kroki ilościowe, CSV; administrator zarządza kontami i uzgadnianiem.
- Sesje PostgreSQL, cookies HttpOnly/Secure w HTTPS, CSRF/Origin, Argon2id,
  trwałe limity logowania i unieważnianie sesji po zmianie dostępu.
- Izolacja magazynów w backendzie, weryfikacja lokalizacji każdej pozycji,
  autoryzacja historii, zgłoszeń, szczegółów i operacji administracyjnych.
- Trwała idempotencja i globalna brama zapisów; brak automatycznego retry mutacji.
- Migracje, CLI, Docker Compose, Caddy, osobne role/bazy/sieci oraz backup/restore.

Reset hasła jest nadzorowany: administrator wydaje jednorazowy token przez CLI
po potwierdzeniu tożsamości i przekazuje go uzgodnionym kanałem. Bez SMTP system
nie twierdzi, że wysłał e-mail. MVP nie przechowuje danych pacjentów i nie integruje Booksy.

## Uruchomienie z Dockerem

Wymagane: Linux, Docker Engine/Compose v2, Git, Bash, OpenSSL, zapas RAM/dysku na
oficjalne obrazy. VPS: Ubuntu 24.04 LTS, rekomendowane 4 vCPU / 8 GB / 75 GB NVMe.

```bash
git clone https://github.com/maksymzakharko/medam-inventree.git
cd medam-inventree
git switch feat/working-mvp
infrastructure/scripts/setup.sh
infrastructure/scripts/bootstrap.sh administrator
```

Bootstrap pyta o hasło w terminalu. Wykonaj następnie pokazane polecenia
`sync-warehouses --actor UUID` i `finalize-bootstrap.sh`. Lokalna aplikacja:
**http://localhost:8080** — adres musi odpowiadać `APP_ORIGIN`.
Nie ma domyślnego hasła, kont ratowników ani sztucznych zapasów.

Pełne polecenia, konta, produkty, próbne przyjęcia i HTTPS:
[instalacja](docs/09-installation.md). Lokalny port jest dostępny tylko na loopback.
Produkcja wymaga domeny/HTTPS, sekretów, backupu poza VPS, audytu hosta i odbioru.
Instalator nie zmienia samowolnie SSH/firewalla.

## Rozwój bez VPS

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
# TEST_DATABASE_URL: wyłącznie oddzielna baza z nazwą medam_test*.
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

Node 26.13.0 i pnpm 12.18.0 są przypięte. Testy korzystają z prawdziwego PostgreSQL
oraz kontrolowanego serwera HTTP imitującego InvenTree dla powtarzalnych awarii.
Nie jest to test działającej instancji InvenTree. Wyniki i ograniczenia:
[raport wydania](docs/12-release-verification.md).

GitHub Actions uruchamia również osobny stos z przypiętym, prawdziwym InvenTree:
budowę kontenerów, migracje, bootstrap, operacje stock z dowodami audytu i izolowany
restore obu baz oraz plików. Wynik dla konkretnego commitu i granice tego testu
zawiera [raport wydania](docs/12-release-verification.md).

## Zasady operacyjne

InvenTree 1.7.0 może przyciąć rozchód do stanu i odpowiedzieć 201. API sprawdza
rzeczywisty efekt w audycie, a nie tylko HTTP. Nie deklarujemy transakcji dwóch baz
przez HTTP ani rozproszonego exactly-once. Każdy rutynowy zapis stock musi przejść
przez Fastify. Inne workflowy InvenTree, pluginy/importy i worker nie mogą niezależnie
zmieniać chronionych zapasów. Ręczna administracja wymaga maintenance.

`UNCERTAIN` zatrzymuje nowe mutacje do uzgodnienia. Odczyty, sesje i zgłoszenia
nadal działają. Nie ponawiaj operacji z nowym UUID i nie zwalniaj bramy samym timeoutem.
Sekrety `.env`/`secrets/` są poza Git. PWA nie cache'uje API ani offline rozchodów.

## Dokumentacja

- [Instalacja i aktualizacja](docs/09-installation.md)
- [Backup i izolowany restore](docs/10-backup-restore.md)
- [VPS, dodatki OVH i zabezpieczenia](docs/11-security-and-purchases.md)
- [Raport rzeczywistych sprawdzeń](docs/12-release-verification.md)
- [Instrukcja użytkownika](docs/13-user-guide.md)
- [Architektura](docs/02-architecture.md), [audyt InvenTree](docs/03-inventree-api.md)
- [Projekt bezpieczeństwa](docs/04-security-and-consistency.md)

Dokumenty 01–08 zachowują stan etapu projektowania z 7 listopada 2026.
Aktualne polecenia i status implementacji: README i dokumenty 09–13.

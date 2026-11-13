# Kontynuacja MEDAM w innym środowisku

Stan przekazania: **13 listopada 2026, Europe/Warsaw**.

1. Przeczytaj [AGENTS.md](AGENTS.md) i [pełny stan przekazania](docs/15-handover.md).
2. Właściciel ostatecznie zdecydował **kontynuować na InvenTree**. Nie zastępuj go własnym silnikiem magazynowym.
3. Właściciel kupił **OVH VPS-1: 2 vCore, 4 GB RAM, 40 GB NVMe**. Dopasowanie do tego limitu nie jest jeszcze potwierdzone pomiarem.
4. Kod i testy działają w CI na Ubuntu 26.04. **Nie wykonano logowania agenta ani instalacji na VPS.**
5. Poprzednie środowisko nie miało dostępu TCP/SSH; serwer według wyników właściciela nasłuchuje na porcie 22. Nie naprawiaj na tej podstawie SSH ani firewalla VPS.
6. Ustal bezpieczny dostęp w nowym środowisku, zweryfikuj klucz hosta i wykonaj wyłącznie odczytowy audyt. Dane hosta właściciel przekazuje osobno.
7. Zachowaj istniejące dane, usługi i dostęp właściciela. Instalacja produkcyjna wymaga konkretnego planu i jego akceptacji.

Gałąź robocza: `feat/working-mvp`. [PR #1](https://github.com/maksymzakharko/medam-inventree/pull/1).

Hasła, klucze prywatne, `.env`, pliki sekretów i dumpy **nie są częścią przekazania w Git**. Stary klucz prywatny nie przenosi się automatycznie do nowego środowiska; w razie potrzeby przygotuj nową parę i dodaj publiczny klucz bez nadpisywania istniejących wpisów.

# MEDAM — magazyn leków

Etap 1: audyt źródeł, projekt architektury i struktura monorepo, 7 listopada 2026.
Repozytorium docelowe: https://github.com/maksymzakharko/medam-inventree.

**To jest plan do akceptacji i szkielet repozytorium. Aplikacja i infrastruktura nie zostały jeszcze wdrożone.**
Właściciel nie kupił jeszcze VPS. Nie wykonano połączenia SSH, zmian serwera ani testów działającego InvenTree.

## Dokumenty

- [Audyt i decyzje do akceptacji](docs/01-audit-and-decisions.md)
- [Architektura i model danych](docs/02-architecture.md)
- [Zweryfikowane API InvenTree](docs/03-inventree-api.md)
- [Uwierzytelnianie, izolacja i spójność](docs/04-security-and-consistency.md)
- [Kontrakt własnego API](docs/05-api-contract.md)
- [VPS, backup, monitoring i odtwarzanie](docs/06-infrastructure.md)
- [Etapy realizacji i kryteria testów](docs/07-delivery-and-tests.md)
- [Raport rzeczywiście wykonanych sprawdzeń](docs/08-verification-report.md)

## Struktura

```text
apps/api/src/
  modules/{auth,users,inventory,consumption,movements,reports,audit}/
  integrations/inventree/
  plugins/
apps/web/{src,public}/
packages/shared/src/{schemas,types}/
infrastructure/{docker,caddy,scripts}/
docs/
tests/{integration,e2e,security}/
```

Docelowo Node.js 26 LTS, Fastify, TypeScript, React, Vite, Zod, Vitest i Playwright;
pnpm workspaces. InvenTree jest jedynym źródłem ilości, LOT, EXP i lokalizacji zapasów.
Własna baza PostgreSQL przechowuje tożsamości, sesje, przypisania, operacje i audyt.

Manifests pakietów na tym etapie nie zawierają zależności ani pozornych poleceń
`build`/`test`. Instalacja bibliotek, lockfile, migracje i działająca aplikacja są
kolejnymi etapami. `.env.example` zawiera wyłącznie nazwy konfiguracji i puste sekrety.

## Wybór VPS

VPS-1 (2 vCPU, 4 GB RAM, 40 GB NVMe) jest kandydatem do pilotażu.
Do produkcji rekomendowany VPS-2 (4 vCPU, 8 GB RAM, 75 GB NVMe), Ubuntu 24.04 LTS,
centrum danych w Polsce lub UE, bez płatnego panelu administracyjnego.
Parametry oferty sprawdzono 2026-11-07 na https://www.ovhcloud.com/pl/vps/.
Wydajność wymaga pomiaru po instalacji; rekomendacja nie jest wynikiem testu obciążenia.

## Granica upoważnienia

Właściciel wymaga zgody przed zmianami produkcyjnymi. Ten etap nie uruchamia
produkcji ani nie importuje rzeczywistych zapasów. Decyzje i kolejne bramki
akceptacji opisano w dokumentach 01 i 07.

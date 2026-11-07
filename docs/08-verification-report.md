# Raport weryfikacji etapu 1

Data: 7 listopada 2026. Środowisko: roboczy Codex Cloud, nie serwer OVH.
Właściciel potwierdził, że VPS jeszcze nie został kupiony.

## Rzeczywiście wykonane sprawdzenia

| Sprawdzenie | Wynik |
| --- | --- |
| GitHub metadata przez połączenie GitHub | Repo `maksymzakharko/medam-inventree` dostępne, publiczne, rozmiar początkowy 0 |
| `git ls-remote` i clone repo | Sukces; brak referencji/commitów; utworzono lokalną gałąź `audit/phase-1-plan` |
| Status środowiska | Codex Cloud gotowy, brak skonfigurowanych sekretów VPS; nie jest to dowód dostępu OVH |
| Lokalne narzędzia | Node 24.22.1, pnpm 11.25.0, Git i OpenSSH dostępne; `ssh-add -l`: brak połączenia z agentem uwierzytelniania |
| Oficjalne źródła wersji | InvenTree 1.7.0, Node LTS 26.13.0; rejestry npm i oferta OVH odczytane przez HTTPS |
| Kod InvenTree i schemat | Przejrzano tag 1.7.0 i snapshot API v570; bez uruchamiania upstream test suite |
| Krytyczne źródła zweryfikowane ponownie | `filter_location` zwraca queryset bez filtra dla nieistniejącego PK z cascade; `take_stock` przycina ilość i zapisuje faktyczne deltas |
| Przegląd architektury | Niezależny przegląd auth/scopes/idempotencji; poprawiono role endpointów, odzyskiwanie UUID, partial resolution i administracyjne straty |
| Struktura monorepo | Utworzono manifesty workspace i 3 pakietów, katalogi modułów, wzorcową konfigurację i dokumenty etapu 1 |
| JSON i linki dokumentów | 6 plików JSON poprawnych; 16 dokumentów Markdown, 20 linków lokalnych, 0 brakujących celów; bez zależności aplikacji |
| Skrypt preflight | `bash -n infrastructure/scripts/vps-preflight-readonly.sh` zaliczony; skrypt nie był wykonywany na VPS |
| Format zmian | `git diff --cached --check` użyte przed commitem; kontrola treści pod kątem przypadkowych sekretów |

Wersje i skróty źródeł zapisano w [version-observations.json](evidence/version-observations.json).

InvenTree commit: `365245ed73eb469cf80578856947ce92eca8b271`.
Repo schematu commit: `6c1dbec0b81d4f6af41db03648a96e800eb8ec23`.
SHA-256 `export/570/api.yaml`:
`2437e90db2f73a5fbac9585eb683421ca8c8710711b65f57196536e9b1b875ae`.

## Niewykonane — nie są zaliczone

- Audyt systemu Ubuntu/VPS, logowanie SSH do OVH, sprawdzenie istniejących usług,
  zasobów, portów i backupu konfiguracji: serwer jeszcze nie istnieje.
- Instalacja Docker/Compose, InvenTree, PostgreSQL/Redis/workera, Caddy i HTTPS.
- Tworzenie 12 lokalizacji, użytkowników, produktów, przyjęć i przesunięć.
- Połączenie działającego Fastify z InvenTree, migracje i bezpieczny reset hasła.
- Vitest, integracja, izolacja magazynów, crash tests i Playwright E2E:
  aplikacja nie została jeszcze zaimplementowana w etapie 1.
- Obciążenie, reboot/autostart, HTTPS, izolacja portów, Android/iOS.
- Backup offsite i rzeczywiste odtworzenie: nie ma zestawu backupowego ani hosta;
  brak pomiaru RPO/RTO i czasu restore. Podane cele są propozycją.

## Wniosek odbiorowy

Gotowy jest przeglądalny plan i struktura repozytorium. Gotowość produkcyjna:
**niepotwierdzona**. Etap 1 czeka na decyzje właściciela; audyt VPS będzie możliwy
po zakupie. Działanie i gwarancje integracji można potwierdzić dopiero testami
faktycznie zainstalowanej wersji, z włączonym audytem i wyłącznymi autorami zmian.
Lista akceptacji: [audyt i decyzje](01-audit-and-decisions.md).

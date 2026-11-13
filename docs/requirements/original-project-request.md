> Archiwum pierwotnych wymagań właściciela. Aktualny stan i decyzje: [przekazanie projektu](../15-handover.md).

# Projekt dla Codex: System magazynowy leków — InvenTree + Node.js + React PWA

## 1. Twoja rola i cel

Działasz jako Senior Full-Stack Developer, DevOps Engineer i Security Engineer.

Twoim zadaniem jest zaprojektowanie, wdrożenie, przetestowanie i udokumentowanie kompletnego systemu magazynowego dla firmy realizującej mobilne i stacjonarne usługi medyczne.

Masz przygotować rzeczywiście działający projekt na OVH VPS, a nie tylko prototyp, makiety lub dokumentację.

**Obowiązkowy stos technologiczny:**

- Backend: Node.js LTS + Fastify + TypeScript.
- Frontend: React + TypeScript + Vite.
- Aplikacja mobilna: responsywne PWA.
- Walidacja: Zod.
- Testy: Vitest, testy integracyjne i E2E.
- System magazynowy: InvenTree, aktualna stabilna wersja.
- Baza danych: PostgreSQL.
- Cache / kolejki InvenTree: Redis.
- Konteneryzacja: Docker Compose.
- Reverse proxy: Caddy lub równoważne rozwiązanie.
- Infrastruktura: OVHcloud VPS, Ubuntu Server 24.04 LTS.
- Opcjonalnie: Cloudflare DNS, Cloudflare Tunnel i Cloudflare Access.

Nie używaj FastAPI, Django ani Pythona do budowy własnego backendu aplikacji. Python pozostaje dopuszczalny jako wewnętrzna technologia samego InvenTree.

## 2. Kontekst biznesowy

Firma realizuje usługi kroplówek witaminowych.

- 10 ratowników medycznych.
- Około 70% wizyt realizowanych mobilnie.
- Około 30% wizyt w gabinecie.
- Około 20–30 rodzajów preparatów i leków.
- Każdy ratownik posiada własny magazyn.
- Pracownicy korzystają przede wszystkim ze smartfonów.
- Booksy Med zarządza wizytami, kalendarzem i pracownikami.
- Płatności i fiskalizacja są obsługiwane osobno.
- Dokumentacja medyczna pacjentów jest prowadzona w odrębnym systemie.

Projekt dotyczy wyłącznie ewidencji magazynowej. Nie zastępuje dokumentacji medycznej ani systemu prowadzenia wizyt.

## 3. Cele funkcjonalne

System ma umożliwiać:

1. Zarządzanie centralnym magazynem.
2. Prowadzenie osobnego magazynu każdego ratownika.
3. Prowadzenie magazynu gabinetu.
4. Ewidencję ilości, partii LOT i dat ważności EXP.
5. Przyjęcia dostaw i przesunięcia między magazynami.
6. Rejestrowanie rzeczywistego zużycia preparatów.
7. Obsługę strat, uszkodzeń i rozbieżności.
8. Pełną historię operacji magazynowych.
9. Ostrzeżenia o niskich stanach i terminach ważności.
10. Bezpieczną obsługę na telefonie.
11. Eksport danych do audytu.
12. Rozbudowę systemu w przyszłości.

InvenTree pozostaje jedynym źródłem prawdy o ilościach, partiach i lokalizacjach zapasów.

Nie twórz drugiego niezależnego silnika magazynowego w Node.js.

## 4. Docelowa architektura

Przepływ danych:

```text
Ratownik — smartfon
        |
        v
React + TypeScript PWA
        |
        v
Node.js + Fastify API
        |
        +---- PostgreSQL aplikacji
        |     - użytkownicy
        |     - role
        |     - przypisania magazynów
        |     - idempotency keys
        |     - audyt aplikacyjny
        |
        v
InvenTree REST API
        |
        v
InvenTree + PostgreSQL + Redis
```

Zasady:

- Frontend nigdy nie komunikuje się bezpośrednio z administracyjnym API InvenTree.
- Backend Fastify jest jedyną warstwą dostępu ratowników do magazynów.
- Tokeny InvenTree znajdują się wyłącznie po stronie serwera.
- Backend korzysta z udokumentowanego API InvenTree.
- Backend nie modyfikuje bezpośrednio tabel bazy InvenTree.
- Aplikacja może korzystać z tej samej instancji PostgreSQL, ale powinna posiadać osobną bazę danych i osobnego użytkownika o ograniczonych uprawnieniach.
- Nie synchronizuj stanów magazynowych do drugiej bazy jako niezależnego źródła prawdy.
- Dane aplikacyjne i magazynowe muszą być odpowiednio rozdzielone.

Zweryfikuj faktyczne możliwości API aktualnie zainstalowanej wersji InvenTree przed implementacją operacji.

## 5. Struktura repozytorium

Użyj monorepo z pnpm workspaces.

Proponowana struktura:

```text
inventree-mobile/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   ├── public/
│   │   └── package.json
│   └── api/
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   ├── users/
│       │   │   ├── inventory/
│       │   │   ├── consumption/
│       │   │   ├── movements/
│       │   │   ├── reports/
│       │   │   └── audit/
│       │   ├── integrations/
│       │   │   └── inventree/
│       │   ├── plugins/
│       │   └── server.ts
│       └── package.json
├── packages/
│   └── shared/
│       ├── src/
│       │   ├── schemas/
│       │   └── types/
│       └── package.json
├── infrastructure/
│   ├── docker/
│   ├── caddy/
│   └── scripts/
├── docs/
├── tests/
├── AGENTS.md
├── pnpm-workspace.yaml
└── README.md
```

Zachowaj prostą strukturę. Nie wprowadzaj mikroserwisów ani niepotrzebnych warstw abstrakcji.

## 6. Struktura magazynów

Utwórz w InvenTree:

- MAG-00 — magazyn główny.
- MAG-01 — ratownik 01.
- MAG-02 — ratownik 02.
- MAG-03 — ratownik 03.
- MAG-04 — ratownik 04.
- MAG-05 — ratownik 05.
- MAG-06 — ratownik 06.
- MAG-07 — ratownik 07.
- MAG-08 — ratownik 08.
- MAG-09 — ratownik 09.
- MAG-10 — ratownik 10.
- MAG-11 — gabinet stacjonarny.

Każdy magazyn musi mieć stabilny identyfikator w InvenTree.

W bazie aplikacji przechowuj przypisanie użytkownika do identyfikatora magazynu, a nie wyłącznie do nazwy magazynu.

Nie zakładaj, że standardowe uprawnienia InvenTree zapewniają pełną izolację odczytu między magazynami.

## 7. Uprawnienia — wymaganie krytyczne

### Ratownik

Może:

- Wyświetlać wyłącznie swój magazyn.
- Przeglądać własne partie leków.
- Rejestrować zużycie ze swojego magazynu.
- Przeglądać historię własnych operacji.
- Zgłaszać problemy.

Nie może:

- Wyświetlać stanów innych ratowników.
- Odczytywać danych innych magazynów przez API.
- Wykonywać rozchodu z innych magazynów.
- Zmieniać przypisanego magazynu.
- Samodzielnie zwiększać stanów.
- Przesuwać preparatów między magazynami.
- Zmieniać LOT lub EXP.
- Korzystać z administracyjnego interfejsu InvenTree.

### Magazynier / dyspozytor

Może:

- Przeglądać wszystkie magazyny.
- Przyjmować dostawy.
- Przesuwać zapasy.
- Obsługiwać zwroty i korekty.
- Przeglądać historię i raporty.

### Administrator

Ma pełne uprawnienia administracyjne.

### Zasada obowiązkowa

Każde żądanie API musi przechodzić autoryzację po stronie backendu.

Backend ustala dozwolony magazyn na podstawie sesji użytkownika.

Nie ufaj identyfikatorowi magazynu przesłanemu przez frontend.

W przypadku operacji na konkretnym StockItem:

1. Uwierzytelnij użytkownika.
2. Ustal przypisany magazyn.
3. Pobierz bieżącą pozycję magazynową z InvenTree.
4. Zweryfikuj jej rzeczywistą lokalizację.
5. Sprawdź uprawnienia do operacji.
6. Zweryfikuj ilość i status partii.
7. Wykonaj operację przez InvenTree API.
8. Zapisz wynik i audyt.

Nie polegaj wyłącznie na filtrowaniu danych w React.

Zadbaj również o zabezpieczenie endpointów historii, eksportów, wyszukiwania i szczegółów zasobów.

## 8. Uwierzytelnianie

Zaimplementuj bezpieczne logowanie pracowników.

Preferowane rozwiązanie:

- Sesje oparte na bezpiecznych ciasteczkach HttpOnly.
- Secure i odpowiednie SameSite.
- Ochrona przed CSRF dla operacji modyfikujących.
- Hasła przechowywane z wykorzystaniem Argon2id lub sprawdzonego dostawcy tożsamości.
- Rate limiting logowania.
- Mechanizm unieważniania sesji.
- Bezpieczny reset hasła.
- Audyt prób logowania i operacji administracyjnych.

Nie zapisuj tokenów administracyjnych w localStorage.

Nie implementuj własnej kryptografii.

Jeśli Cloudflare Access zostanie wykorzystany do uwierzytelniania, zweryfikuj podpisy i odbiorcę tokenów po stronie backendu oraz zapewnij poprawne mapowanie tożsamości na konto ratownika. Samo sprawdzanie nagłówka z adresem e-mail nie jest wystarczające.

## 9. Model danych aplikacji

Zaprojektuj minimalny schemat PostgreSQL obejmujący:

- Users.
- Roles.
- UserWarehouseAssignments.
- Sessions, jeśli wybrany mechanizm logowania tego wymaga.
- IdempotencyRecords.
- ApplicationAuditEvents.
- ProblemReports.

Możesz zastosować Drizzle ORM lub Prisma, wybierając prostsze rozwiązanie dla tego projektu.

Stosuj migracje bazy danych.

Nie przechowuj kopii ilości magazynowych jako niezależnych, edytowalnych stanów.

## 10. Panel mobilny React PWA

Aplikacja ma być responsywna, szybka i wygodna na Androidzie oraz iOS.

Interfejs w języku polskim.

### Ekran 1 — Logowanie

- Login i hasło lub zatwierdzony mechanizm SSO.
- Obsługa wygaśnięcia sesji.
- Wylogowanie.
- Czytelne komunikaty błędów.

### Ekran 2 — Mój magazyn

Pokaż:

- Nazwę preparatu.
- Ilość.
- Jednostkę.
- Numer LOT.
- Datę EXP.
- Stan minimalny.
- Ostrzeżenia o niskich stanach.
- Ostrzeżenia o krótkim terminie ważności.

Dodaj wyszukiwanie i filtrowanie.

### Ekran 3 — Rejestracja zużycia

Proces:

1. Wybór preparatu.
2. Wybór partii.
3. Podgląd ilości i daty ważności.
4. Wprowadzenie ilości.
5. Opcjonalny identyfikator wizyty.
6. Potwierdzenie.
7. Wyświetlenie wyniku zapisu.

Wprowadź walidację ilości i jednostek.

Nie pozwalaj na rozchód przeterminowanych, zablokowanych lub niedostępnych partii.

Nie potwierdzaj sukcesu przed uzyskaniem odpowiedzi z InvenTree.

### Ekran 4 — Historia

Wyświetl wyłącznie operacje danego pracownika.

### Ekran 5 — Zgłoszenie problemu

Możliwość zgłoszenia:

- Uszkodzenia.
- Przeterminowania.
- Rozbieżności.
- Innego problemu.

Zgłoszenie nie zmienia automatycznie stanu magazynowego.

## 11. API backendu

Zaprojektuj API Fastify, np.:

```text
GET    /api/me
GET    /api/my-stock
GET    /api/my-stock/:id
POST   /api/consumptions
GET    /api/my-history
POST   /api/problem-reports
GET    /api/problem-reports

GET    /api/admin/warehouses
POST   /api/admin/warehouse-transfers
GET    /api/admin/audit
```

To przykładowe endpointy własnego backendu, a nie deklaracja endpointów InvenTree.

Dla każdego endpointu określ:

- Schemat żądania.
- Schemat odpowiedzi.
- Wymagane uprawnienia.
- Walidację.
- Obsługę błędów.
- Limity.
- Zasady audytu.

Wspólne schematy Zod umieść w `packages/shared`.

## 12. Integracja z InvenTree

Zbuduj osobny moduł klienta API InvenTree.

Wymagania:

- Centralna konfiguracja URL i sekretów.
- Timeouty.
- Bezpieczna obsługa błędów.
- Typowane odpowiedzi.
- Walidacja danych zewnętrznych.
- Obsługa paginacji.
- Ograniczone ponawianie bezpiecznych żądań.
- Logowanie techniczne bez ujawniania sekretów.

Nie wykonuj automatycznych ponowień operacji zmieniających stany bez mechanizmu zapobiegającego duplikatom.

Nie zakładaj, że InvenTree udostępnia natywne klucze idempotencji.

Przed implementacją sprawdź aktualny schemat API oraz sposób działania operacji usuwania i przesuwania zapasów.

## 13. Spójność operacji magazynowych

To wymaganie o wysokim priorytecie.

Zabezpiecz system przed:

- Podwójnym kliknięciem przycisku.
- Powtórzeniem żądania przez telefon.
- Utratą połączenia po wykonaniu operacji.
- Równoczesnymi rozchodami.
- Przesunięciem partii w trakcie rozchodu.
- Rozchodem ponad dostępny stan.
- Niespójnością między audytem aplikacji a InvenTree.

Zastosuj identyfikatory operacji oraz trwały mechanizm idempotencji.

Nie zakładaj, że transakcja w bazie aplikacji obejmuje również operację wykonaną w InvenTree.

Zaprojektuj bezpieczną obsługę niejednoznacznych wyników, procedurę uzgadniania operacji i odzyskiwania po awarii.

Jeżeli API InvenTree nie pozwala zagwarantować wymaganej atomowości, udokumentuj ograniczenie i zaproponuj mechanizm minimalizujący ryzyko. Nie deklaruj gwarancji, których nie da się potwierdzić.

## 14. Partie, ważność i historia

Wykorzystaj InvenTree do:

- Ewidencji LOT.
- Ewidencji EXP.
- Kontroli ilości.
- Rejestrowania przesunięć.
- Rejestrowania rozchodów.
- Historii operacji.

Dodaj:

- Ostrzeżenia o zbliżającej się dacie ważności.
- Kontrolę stanów minimalnych.
- Rekomendację FEFO.
- Blokowanie niedopuszczonych partii zgodnie z ustaloną polityką.
- Zgłoszenia uszkodzeń i strat.

Nie zakładaj, że sama instalacja InvenTree zapewnia zgodność z przepisami dotyczącymi obrotu produktami leczniczymi.

## 15. Booksy Med

Booksy Med pozostaje systemem zarządzania wizytami.

W MVP nie implementuj integracji z Booksy.

Nie zakładaj istnienia publicznego API Booksy Med.

Przygotuj architekturę umożliwiającą integrację w przyszłości.

Nie zapisuj w systemie magazynowym danych osobowych pacjentów ani szczegółowej dokumentacji medycznej.

Identyfikator wizyty może być danymi osobowymi, jeśli umożliwia powiązanie z pacjentem — uwzględnij to w projekcie bezpieczeństwa i retencji.

## 16. Infrastruktura OVH VPS

Zainstaluj i skonfiguruj:

- Docker Engine.
- Docker Compose.
- InvenTree.
- PostgreSQL.
- Redis.
- Worker InvenTree.
- Node.js API.
- React PWA.
- Reverse proxy i HTTPS.
- Monitoring.
- Backupy.

Wszystkie usługi powinny uruchamiać się automatycznie po restarcie VPS.

Nie wystawiaj PostgreSQL ani Redis do publicznego internetu.

Nie udostępniaj panelu administratora InvenTree ratownikom.

Preferuj oddzielne sieci kontenerów i ograniczenie dostępu do wewnętrznych usług.

Skonfiguruj healthchecki, limity logów, polityki restartów i odpowiednie zarządzanie sekretami.

Nie umieszczaj haseł w plikach śledzonych przez Git.

## 17. Backup i odtwarzanie

Wymagane:

- Backup obu baz PostgreSQL.
- Backup plików InvenTree.
- Backup niezbędnej konfiguracji.
- Szyfrowana kopia poza VPS.
- Retencja kopii.
- Monitoring nieudanych backupów.
- Procedura przywracania.

Wykonaj rzeczywisty test odtworzenia na oddzielnym środowisku.

Udokumentuj czas i wynik testu.

## 18. Testy

### Testy backendu

- Walidacja danych.
- Logowanie i sesje.
- Role i uprawnienia.
- Izolacja magazynów.
- Obsługa błędów InvenTree.
- Idempotencja.
- Równoczesne operacje.
- Audyt.

### Testy bezpieczeństwa

Ratownik 01:

- Widzi wyłącznie MAG-01.
- Nie może odczytać MAG-02.
- Nie może wykonać rozchodu z MAG-02.
- Nie może odczytać historii MAG-02.
- Nie może zmienić magazynu przez manipulację żądaniem.

Powtórz testy dla pozostałych użytkowników.

### Testy E2E

- Logowanie.
- Wyświetlanie zapasów.
- Rozchód.
- Historia.
- Zgłoszenie problemu.
- Wylogowanie.
- Obsługa błędów sieciowych.

### Testy infrastruktury

- Restart VPS.
- Uruchamianie kontenerów.
- HTTPS.
- Izolacja usług.
- Backup i odtworzenie.
- Dostęp z Androida i iOS.

Wyniki testów muszą być rzeczywiste i udokumentowane.

## 19. Zasady pracy Codex na VPS

Przed zmianami:

1. Zweryfikuj dostęp SSH.
2. Sprawdź system operacyjny i parametry serwera.
3. Zidentyfikuj istniejące usługi.
4. Sprawdź dostępne miejsce i pamięć.
5. Przygotuj plan wdrożenia.
6. Przygotuj plan wycofania zmian.
7. Wykonaj kopię istniejącej konfiguracji.

Nie wykonuj destrukcyjnych operacji bez zgody.

Nie usuwaj istniejących danych, kontenerów ani wolumenów bez wyraźnej akceptacji.

Nie wyłączaj zabezpieczeń SSH i firewalla.

Nie publikuj sekretów w rozmowie, logach ani repozytorium.

W przypadku brakujących dostępów lub decyzji poproś właściciela o ich bezpieczne dostarczenie.

## 20. Etapy wdrożenia

### Etap 1 — Audyt i plan

- Zweryfikuj środowisko VPS.
- Zweryfikuj dokumentację InvenTree.
- Sprawdź API.
- Przygotuj architekturę.
- Przygotuj listę dostępów i ryzyk.
- Przedstaw plan wdrożenia do akceptacji.

### Etap 2 — Infrastruktura

- Docker Compose.
- PostgreSQL.
- Redis.
- InvenTree.
- HTTPS.
- Backupy.
- Monitoring.

### Etap 3 — Magazyny

- Utworzenie 12 lokalizacji.
- Przygotowanie importu produktów.
- Testy przyjęć i przesunięć.
- Testy LOT i EXP.

### Etap 4 — Backend Node.js

- Fastify + TypeScript.
- PostgreSQL aplikacji.
- Logowanie.
- Role.
- Przypisania magazynów.
- Klient InvenTree API.
- Rozchody.
- Audyt.
- Idempotencja.

### Etap 5 — Frontend React

- Logowanie.
- Mój magazyn.
- Rozchód.
- Historia.
- Zgłoszenia.
- Instalowalne PWA.

### Etap 6 — Testy

- Testy jednostkowe.
- Integracyjne.
- E2E.
- Bezpieczeństwo.
- Backup i odtworzenie.

### Etap 7 — Pilotaż

- Dwa konta ratowników.
- Dane testowe lub zatwierdzone.
- Testy na rzeczywistych telefonach.
- Poprawki.

### Etap 8 — Produkcja

Po akceptacji właściciela:

- Konta dla wszystkich ratowników.
- Import rzeczywistych produktów i stanów.
- Instrukcje.
- Uruchomienie produkcyjne.

## 21. Dokumentacja i rezultaty

Dostarcz:

1. Kod źródłowy.
2. Działające InvenTree.
3. Działający backend Node.js.
4. Działające React PWA.
5. Docker Compose.
6. Migracje bazy aplikacji.
7. Konfigurację środowiska bez sekretów.
8. Instrukcję instalacji.
9. Instrukcję aktualizacji.
10. Instrukcję zarządzania użytkownikami.
11. Instrukcję backupów.
12. Raport testów.
13. Instrukcję dla ratowników.
14. Dokumentację architektury.
15. Listę ryzyk i ograniczeń.

## 22. Kryteria odbioru

Projekt można uznać za gotowy, gdy:

- InvenTree działa stabilnie na OVH VPS.
- Backend Node.js komunikuje się z InvenTree.
- React PWA działa na smartfonach.
- Każdy ratownik widzi tylko własny magazyn.
- Backend skutecznie blokuje dostęp do cudzych magazynów.
- Rozchody prawidłowo aktualizują stany InvenTree.
- LOT i EXP są zachowane.
- Historia operacji działa.
- Operacje są odporne na przypadkowe duplikaty.
- Backup został skutecznie odtworzony.
- Testy krytyczne przechodzą.
- Dokumentacja jest kompletna.
- Właściciel zatwierdził wdrożenie produkcyjne.

## 23. Pierwsze polecenie

Rozpocznij od audytu i planowania.

Nie wdrażaj od razu całego systemu.

Najpierw:

1. Sprawdź dostępność VPS i jego konfigurację.
2. Zweryfikuj aktualną dokumentację InvenTree.
3. Sprawdź schemat API i możliwości operacji magazynowych.
4. Zaproponuj szczegółową architekturę Node.js + Fastify + React.
5. Przygotuj strukturę repozytorium.
6. Określ sposób uwierzytelniania i izolacji magazynów.
7. Zaprojektuj bezpieczną obsługę rozchodów i idempotencji.
8. Przygotuj plan backupów i monitoringu.
9. Przedstaw plan wdrożenia oraz listę decyzji wymagających akceptacji.

Poczekaj na moją zgodę przed zmianami produkcyjnymi.

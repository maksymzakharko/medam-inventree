# Projekt bezpieczeństwa i spójności — etap 1

Data: 2026-11-07. To projekt do implementacji i walidacji na przypiętej wersji InvenTree, nie wynik testów produkcyjnych. VPS jeszcze nie został kupiony; nie potwierdzono konfiguracji usług, polityk ani danych. Ustalenia o API 1.7.0 pochodzą z [audytu kodu i OpenAPI](03-inventree-api.md) i muszą zostać sprawdzone wobec faktycznie zainstalowanej wersji i jej OpenAPI.

## 1. Granice zaufania i magazyny

React PWA i Fastify pod jednym origin HTTPS. Publiczne są wyłącznie HTTPS PWA/API i ograniczony SSH. Token InvenTree istnieje wyłącznie w sekrecie backendu. Panel oraz REST InvenTree dostępne wewnętrznie, administracja przez dedykowany prywatny kanał. Ratownicy nie otrzymują kont ani tokenów InvenTree. Konto integracji ma wyłącznie potwierdzone testami uprawnienia do wymaganych operacji, bez uprawnień superusera, zarządzania użytkownikami lub konfiguracją.

InvenTree jest wyłącznym źródłem bieżących stanów, LOT, EXP i lokalizacji. PostgreSQL aplikacji zawiera tożsamości, przypisania, operacje, blokady, audyt i zgłoszenia, ale nie edytowalne kopie bieżących ilości. Ilość żądana, zaobserwowany efekt oraz referencja tracking zapisane w audycie są dowodem zdarzenia, nie stanem magazynu.

Lokalizacje MAG-00…MAG-11 przypięte do trwałych InvenTree PK, nazwy są etykietami. Brak przypisania, nieistniejąca lokalizacja lub kilka aktywnych przypisań ratownika oznacza odmowę dostępu. Zmiana przypisania jest operacją administratora z audytem, unieważnieniem sesji i blokadą w razie nierozstrzygniętych operacji starego magazynu.

Nie zakładamy `MAG-01 = location 1`. Bootstrap odczytuje PK faktycznie utworzonych lub jednoznacznie zweryfikowanych lokalizacji i zapisuje mapowanie. Niejednoznaczne duplikaty nazw/kodów zatrzymują bootstrap zamiast przypisywania „pierwszego pasującego” rekordu. W etapie audytu nie tworzymy lokalizacji ani przypisań na produkcji.

## 2. Sesje i reset

- Preferencja MVP: sesja serwerowa w PostgreSQL. Losowy identyfikator sesji 256 bit z biblioteki platformy, w DB tylko jego SHA-256; cookie `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, bez `Domain`.
- Token sesji nie zawiera zaufanej roli ani magazynu. Każde żądanie sprawdza aktywność konta i bieżącą rolę/przypisanie w DB. Rotacja identyfikatora po logowaniu, zmianie uprawnień i reautoryzacji; stare sesje są unieważniane.
- Propozycja do zatwierdzenia: idle 30 min, maksymalnie 12 h od logowania; UI ostrzega o wygaśnięciu i zachowuje wyłącznie nieprzesłany szkic operacji. Reset hasła, dezaktywacja i zmiana roli unieważniają wszystkie sesje konta.
- Hasła Argon2id z utrzymywanej biblioteki; parametry startowe 64 MiB, 3 iteracje, równoległość 1, następnie benchmark na VPS. Długie hasła i menedżery haseł są dozwolone. Brak domyślnych kont/hasła w repo i logach; bootstrap pierwszego administratora przez bezpieczny CLI/TTY.
- CSRF: utrzymywana biblioteka tokenów synchronizowanych z sesją, token w `X-CSRF-Token`; porównanie dokładnego `Origin` dla wszystkich żądań zmieniających dane (także login, logout, reset). Login posiada preauth CSRF state. SameSite nie zastępuje CSRF. Brak CORS dla obcych originów. `Content-Type: application/json`, limity body i ścisłe Zod `.strict()` odrzucające dopisane pola.
- Ograniczenie prób logowania i resetu na konto oraz IP, z neutralnymi błędami chroniącymi przed enumeracją. Przy wielu instancjach limit musi korzystać ze współdzielonego trwałego źródła; limit w pamięci pojedynczego procesu nie jest globalnym limitem. Zaufanie do proxy tylko dla rzeczywistego Caddy/Cloudflare, aby klient nie obchodził limitu przez `X-Forwarded-For`.
- Bezpieczeństwo resetu wymaga zatwierdzonego kanału dostarczenia. Preferowane: link na wcześniej zweryfikowany firmowy adres przez SMTP lub zatwierdzone SSO. Gdy go brak, MVP może użyć nadzorowanego resetu inicjowanego przez administratora po weryfikacji pracownika: pojedynczy losowy token, hash w DB, TTL 15 min, jednorazowe zużycie atomową aktualizacją, przekazanie uzgodnionym kanałem, bez hasła widocznego administratorowi. Nie wystarczy znać e-mail/login. Brak pytań bezpieczeństwa. Po zmianie hasła wszystkie poprzednie sesje wygasają. Interfejs resetu nie zawiera zewnętrznych skryptów, ma `Referrer-Policy: no-referrer` i nie loguje tokenu z URL.
- Cloudflare Access jest opcją, nie domyślnym wymaganiem. Jeśli wybrane, backend waliduje JWT przez JWKS, issuer, audience, czas ważności i mapuje stabilne `sub` na aktywne konto. Sam nagłówek e-mail nie uwierzytelnia.

## 3. Izolacja danych i reguły ról

Ratownik ma dokładnie jeden aktywny `inventree_location_id`. API `my-*` nie przyjmuje `warehouseId`, `actorId`, `role`, `userId` ani upstream URL od klienta. Nieznane pola są błędem walidacji. Parametry wyszukiwania, paginacji i sortowania mają zamkniętą listę i limity, nie są dowolnym proxy parametrów InvenTree.

Istotne ustalenie audytu 1.7.0: filtr lokalizacji domyślnie może obejmować podlokalizacje, a nieistniejący location może pozostawić queryset bez filtra. Dlatego backend sprawdza istnienie przypiętej lokalizacji, wysyła `cascade=false` i waliduje rzeczywistą lokalizację KAŻDEGO zwróconego StockItem przed zbudowaniem odpowiedzi. Inny lub pusty location oznacza fail-closed całego żądania i alert; nie wystarczy zaufać upstream querystring. Raw upstream `count`/`next` nie może ujawniać liczby obcych zasobów ani tokenizowanego URL.

Dla szczegółów i mutacji: sesja → aktywny użytkownik/rola/przypisanie → pobranie aktualnego StockItem → porównanie rzeczywistego location → sprawdzenie statusu, dostępności i ilości → operacja. Pobranie szczegółu obcego zasobu zwraca takie samo 404 jak brak zasobu. Nie przekazujemy ratownikowi raw upstream body.

Historia ratownika jest filtrowana po `actor_user_id` z sesji, nie tylko po magazynie, bo pracownik ma widzieć wyłącznie swoje operacje. Wspólne konto integracji InvenTree nie rozróżnia ratowników, dlatego aplikacyjna mapa operation UUID → actor jest niezbędna. Własne historyczne zdarzenia pozostają własne po zmianie przypisania, ale DTO nie ujawnia metadanych innych pracowników, IP ani niepotrzebnych danych magazynów.

Zgłoszenia ratownika: tylko własne odczyty i tworzenie w dozwolonym magazynie; podany `stockItemId` podlega tej samej kontroli własności. Zgłoszenie nigdy samo nie zmienia ilości. Magazynier widzi wszystkie magazyny i zgłoszenia, przyjmuje i przesuwa zapasy, wykonuje jawnie uprawnione korekty; nie zmienia użytkowników i przypisań. Administrator zarządza kontami i przypisaniami. Role nie są zakodowane wyłącznie w UI.

Eksport jest osobnym endpointem z kontrolą roli i zakresu zarówno przy zleceniu, jak i pobieraniu pliku. Brak publicznych stałych URL plików. Odpowiedzi uwierzytelnione: `Cache-Control: no-store`, brak cache CDN/service worker. CSV zabezpiecza wartości zaczynające się od `=`, `+`, `-`, `@`, TAB/CR przed interpretacją jako formuły arkusza.

## 4. Minimalne dane aplikacji

| Tabela | Istotne pola/ograniczenia |
|---|---|
| `roles` | stabilny klucz `medic`, `warehouse_manager`, `admin` |
| `users` | UUID PK, znormalizowany login UNIQUE, hash hasła, role FK, active, password version, timestamps |
| `warehouse_mappings` | InvenTree location PK, code UNIQUE (`MAG-00`…`MAG-11`), enabled; mapowanie identyfikatorów, bez ilości; istnienie i jednoznaczność weryfikowane z API przy bootstrap/readiness |
| `user_warehouse_assignments` | user FK, InvenTree location PK FK do mapowania, valid_from/valid_to; częściowy UNIQUE(user_id) dla aktywnego przypisania; audyt zmiany |
| `sessions` | hash tokenu UNIQUE, user FK, expires_at, idle_at, revoked_at, CSRF state, bez plaintext tokenu |
| `password_reset_tokens` | hash tokenu UNIQUE, user FK, expires_at, consumed_at, created_by; atomowe jednorazowe zużycie |
| `idempotency_records` | operation UUID PK, actor FK, typ operacji, idempotency key, request hash, stan, request DTO, upstream refs, bezpieczny response, timestamps; UNIQUE(actor, typ, key) |
| `inventory_mutation_gate` | jeden trwały rekord z kluczem `inventory` i nullable operation FK; CHECK klucza i PK zapobiegają tworzeniu alternatywnych gate; brak ilości magazynowej |
| `application_audit_events` | append-only event UUID, operation UUID, actor, action, resource refs, wynik, timestamp, bez sekretów i dokumentacji pacjenta |
| `problem_reports` | UUID, reporter FK, captured location PK, opcjonalny stockItem PK, kategoria, ograniczony opis, status; opis nie powinien zawierać pacjenta |

Migracje Drizzle z osobną rolą migratora. Rola runtime nie posiada DDL ani UPDATE/DELETE audytu; zadania retencji z osobną ograniczoną rolą. Upstream ID nie jest FK do tabel InvenTree: DB aplikacji nie odczytuje i nie modyfikuje bezpośrednio jego tabel. Żądania i audyt mogą zawierać żądaną ilość i zaobserwowany efekt, ale nie tworzą tabeli bieżącego stanu. Schemat i DTO nie mają danych pacjenta. Identyfikator wizyty domyślnie wyłączony do zatwierdzenia celu, formatu i retencji; pseudonimowy identyfikator nadal może być danymi osobowymi.

## 5. Operacja i trwała idempotencja

Nie ma transakcji obejmującej PostgreSQL aplikacji i InvenTree HTTP. Nie deklarujemy distributed exactly-once. Cel: jedna próba wysłania zapisu na operację, brak automatycznego ponawiania niejednoznacznego wyniku, trwałe powiązanie z audytem i możliwość uzgodnienia.

### Maszyna stanów

```text
PREPARED ──walidacja nie powiodła się przed wysłaniem──> REJECTED
PREPARED ──commit DISPATCHING przed HTTP──────────────> DISPATCHING
DISPATCHING ──2xx + potwierdzony pełny efekt──────────> SUCCEEDED
DISPATCHING ──potwierdzony brak efektu/odmowa─────────> REJECTED
DISPATCHING ──timeout, crash, 5xx, błędny payload─────> UNCERTAIN
DISPATCHING ──potwierdzony efekt inny niż żądany──────> DISCREPANCY
UNCERTAIN/DISCREPANCY ──udokumentowane uzgodnienie────> RECONCILED_APPLIED
UNCERTAIN/DISCREPANCY ──udokumentowany brak efektu────> RECONCILED_NOT_APPLIED
UNCERTAIN/DISCREPANCY ──potwierdzony efekt częściowy──> RECONCILED_PARTIAL
```

Stan `RECONCILED_NOT_APPLIED` zamyka tę operację, nie uruchamia ponownie starego requestu. Ewentualną nową operację tworzy jawnie uprawniona osoba z nowym UUID, po odblokowaniu i rewalidacji. Przy stwierdzonej częściowej realizacji administrator może po weryfikacji dowodu zamknąć operację jako `RECONCILED_PARTIAL`, z faktycznym `appliedQuantity`, uzasadnieniem i audytem; to zwalnia gate, ale nie oznacza pełnego wykonania. Nie księgujemy automatycznej kompensacji ani reszty. Ewentualna dalsza korekta jest osobną jawnie zatwierdzoną operacją.

`PREPARED` może być bezpiecznie podjęty przez worker po restarcie, ponieważ w tym stanie żaden kod nie może wysłać HTTP. Przejście `PREPARED → DISPATCHING` jest warunkową aktualizacją `WHERE state='PREPARED'`; tylko zwycięzca wysyła. `DISPATCHING` po utracie procesu oznacza `UNCERTAIN`, nawet jeżeli faktyczny crash nastąpił jeszcze przed wysłaniem pakietu. Brak pewności jest celowym kosztem bezpieczeństwa.

### Protokół zapisów

1. PWA generuje UUID operacji raz przy potwierdzeniu; ten UUID jest równocześnie `Idempotency-Key` i identyfikatorem `/api/operations/:id`, znanym przed pierwszą odpowiedzią. PWA zachowuje ten sam klucz przy odzyskiwaniu po zerwaniu sieci. Przycisk jest blokowany na czas żądania. Nowy klucz nie jest sposobem ponowienia nierozstrzygniętej operacji.
2. Fastify autoryzuje, waliduje zamknięty DTO, normalizuje go i oblicza hash standardowym SHA-256. `(actor, operation kind, key)` jest UNIQUE. Ten sam klucz z innym hash daje 409. Ten sam z tym samym hash zwraca zapisany wynik lub stan/poll URL, nie wykonuje ponownie upstream write. Odczyt istniejącego klucza i sprawdzenie właściciela następują przed rezerwacją gate i nowym fetch StockItem; replay musi działać także po zużyciu/usunięciu pozycji lub przy gate zajętym tą operacją. Kolizja UUID innego właściciela nie pozwala odczytać ani nadpisać jego operacji. Odczyt statusu operacji również autoryzuje właściciela/rolę.
3. W krótkiej transakcji PG blokujemy `SELECT … FOR UPDATE` pojedynczy rekord globalnego `inventory_mutation_gate`, sprawdzamy brak nierozstrzygniętej operacji i rezerwujemy go, tworząc `PREPARED` + audyt intencji. Każda mutacja (consume, transfer, receipt, return, korekta) używa tego samego gate. Transakcja obejmująca czas HTTP nie jest potrzebna. Kolumna `operation_id` pozostaje wypełniona także po crashu procesu.
4. Dopiero po rezerwacji gate pobieramy ponownie rzeczywisty StockItem z InvenTree i sprawdzamy location, status, in-stock/allocations i dostępną ilość według konkretnej akcji; jeśli nie pasują, kończymy bez wywołania mutacji. Wszystkie wewnętrzne mutacje, włącznie z administracyjnymi korektami, muszą respektować ten sam gate. Reguły dopuszczenia są per akcja: zużycie medyczne blokuje expired/damaged/returned; administracyjne decrease może rozliczyć stratę takiej partii z wymaganym powodem, odrębnym typem zdarzenia i dowodem, bez uznania jej za dopuszczoną do użycia.
5. W transakcji zapisujemy `DISPATCHING` i pełny jednoznaczny identyfikator operacji wysyłany w dopuszczonym polu tracking notes InvenTree (np. `medam-op:<UUID>` bez loginu, wizyty lub pacjenta). Commit następuje przed pojedynczym wywołaniem HTTP. Nie stosujemy retry biblioteki, proxy ani job runnera do mutacji.
6. Odpowiedź 2xx nie jest automatycznie pełnym sukcesem: audyt kodu 1.7.0 wskazuje clamping remove do aktualnego stanu. Trzeba sprawdzić udokumentowaną odpowiedź, upstream tracking i efekt ilości. Dla remove źródłem jest `/api/audit/`, `event_type=12`, faktyczne `deltas.removed`, dokładne `notes` i testowane `cid`; szczegóły i źródła w [audycie API](03-inventree-api.md). Zachowanie trzeba potwierdzić testem kontraktowym na przypiętej wersji. Różnica względem żądania jest błędem częściowej realizacji, a nie sukcesem zużycia.
7. Po dowodzie wyniku zapisujemy wynik terminalny, referencję tracking, audyt i zwolnienie gate w jednej transakcji aplikacji. Sukces UI jest możliwy dopiero po trwałym zapisaniu pełnego potwierdzonego wyniku. Jeżeli DB nie może zatwierdzić wyniku, operacja pozostaje nierozstrzygnięta mimo znanej procesowi odpowiedzi upstream.
8. Timeout, 5xx, przerwane połączenie, niepoprawna odpowiedź lub restart po `DISPATCHING`: nie ponawiamy mutacji, zachowujemy blokady i pokazujemy „Wynik wymaga sprawdzenia. Nie powtarzaj operacji”; administrator dostaje alert. Timeout klienta nie dowodzi anulowania operacji przez serwer InvenTree. Sam upływ TTL/lease nigdy nie zwalnia gate.

Każde przejście stanu jest warunkowe na poprzednim stanie. Zwalniamy gate wyłącznie `WHERE operation_id = <domykane UUID>` w tej samej transakcji co wynik i audyt. Spóźniona odpowiedź starego workera nie może nadpisać uzgodnionego wyniku ani zwolnić gate należącego do następnej operacji. Odpowiedź in-flight po timeout trzeba wykluczyć przed orzeczeniem „nie zastosowano” i otwarciem drogi do nowej operacji.

Dlaczego globalny gate w MVP, nie wyłącznie per StockItem: częściowy transfer i przyjęcie mogą utworzyć nowy StockItem ID, nieznany aplikacji przed odpowiedzią. Jeden trwały gate obejmuje także takie dzieci i upraszcza dowód serializacji dla dziesięciu ratowników. Tradeoff jest jawny: nierozstrzygnięta operacja zatrzymuje wszystkie rozchody i administracyjne zapisy przez Fastify do uzgodnienia, także w pozostałych magazynach. Same odczyty pozostają możliwe. W przyszłości po testach można przejść na trwałe gate'y magazynów (transfer blokuje źródło i cel w rosnącej kolejności PK), aby ograniczyć zakres zatrzymania. Sam advisory lock w sesji PG znika po crashu i nie spełnia tego celu.

Upstream listy można nadal odczytywać podczas blokady, ale każda NOWA mutacja stock lub dopuszczenia partii otrzymuje czytelny 409/423 z własnym identyfikatorem zgłoszenia, bez ujawniania danych obcego autora. Wiadomość informuje o konieczności uzgodnienia, nie proponuje ponowienia z nowym kluczem. Gate nie blokuje logowania/resetu/logout, odczytów i replay istniejącego wyniku, app-only zgłoszeń ani samego uzgadniania — to ostatnie musi móc zakończyć operację i zwolnić gate.

### Uzgodnienie

Worker wyłącznie odczytujący sprawdza osierocone DISPATCHING/UNCERTAIN, przegląda paginowany audit/tracking endpoint danej wersji i szuka dokładnego operation UUID. Audyt kodu wskazał, że tracking w 1.7.0 przeniesiono do `/api/audit/`; nie wolno użyć starej ścieżki bez weryfikacji OpenAPI.

Jednoznaczny wpis tracking z UUID, właściwym StockItem/ruchem i pełną oczekiwaną deltą może pozwolić zakończyć `RECONCILED_APPLIED`. Duplikat UUID, kilka sprzecznych wpisów, zmieniona lokalizacja, niezgodna delta albo brak danych wymagają ręcznego uzgodnienia. Sama bieżąca ilość równa oczekiwanej nie jest dowodem wykonania konkretnego żądania. Sam brak wpisu nie dowodzi niewysłania lub niewykonania, zwłaszcza gdy pierwotny request mógł nadal działać. Przed stwierdzeniem braku efektu trzeba także wykluczyć nadal aktywny request upstream.

Potwierdzony częściowy efekt kończy się `RECONCILED_PARTIAL`, z zachowaniem faktycznej ilości i dowodu. Domknięcie spornego wyniku i odblokowanie jest operacją uprawnionego administratora z dowodem, powodem, identyfikatorem operatora i audytem; opcjonalnie druga osoba zatwierdza. Nigdy nie zwalniamy wyłącznie „bo minęło 30 sekund”. Minimalny tombstone `(actor pseudonym, operation kind, key, request hash, terminal state)` musi pozostać zachowany tak, aby stare żądanie nie zostało ponownie uznane za nowe po retencji. Usuwanie pól osobowych nie może bezwarunkowo usuwać ochrony deduplikacji.

### Ograniczenie dotyczące zewnętrznych writerów

Gate w DB aplikacji nie blokuje bezpośrednich zapisów w InvenTree admin, skryptów, workerów ani innych integracji. [Audyt API](03-inventree-api.md) potwierdził niezależne mutacje przez build/sales/purchase/transfer oraz pluginy z harmonogramami i zdarzeniami. Przed pilotażem trzeba skontrolować aktywne i zakolejkowane zadania; nieużywane workflowy i pluginy zmieniające stock pozostają wyłączone. Samo odcięcie HTTP nie zatrzyma już zakolejkowanej mutacji. Nie kasujemy istniejącej kolejki bez zgody. Worker do zweryfikowanych powiadomień/raportów nadal działa. Kontrola location przed żądaniem HTTP nie stanowi atomowego warunku location w samej mutacji InvenTree. Dlatego standardowa eksploatacja wymaga wyłącznego writer'a poprzez Fastify. Administracyjne awaryjne zmiany w UI InvenTree wymagają okna maintenance: zamknięcie nowych zapisów PWA, domknięcie/uzgodnienie aktywnych operacji, backup, praca administracyjna, weryfikacja, ponowne otwarcie. Jeśli biznes wymaga swobodnych równoległych upstream zapisów, należy przed wdrożeniem zweryfikować natywną atomowość/version preconditions lub zaprojektować i zatwierdzić minimalne rozszerzenie InvenTree; Fastify sam nie daje gwarancji atomowej kontroli obcego systemu.

## 6. Ilości, partie i offline PWA

Ilości przesyłane jako kanoniczne stringi dziesiętne zgodne z precyzją potwierdzoną w API, nie JavaScript float. W MVP preferowane całe jednostki bazowe (np. ampułka), jeśli to odpowiada rzeczywistemu użyciu. Jednostka pochodzi z Part w InvenTree; frontend nie ustala przelicznika. Ilość musi być >0 i <= rzeczywiście dostępna. Zgodność dozowania, LOT i EXP jest polityką właściciela magazynu, nie domysłem UI.

Rekomendacja: deny-by-default dla nieznanego statusu, brakującego LOT lub EXP oraz niedopuszczonej/nieaktywnej/niedostępnej partii. Dokładna lista statusów dopuszczonych i znaczenie przydziałów muszą zostać potwierdzone testem kontraktowym. EXP jest datą kalendarzową, więc potrzebna jawna polityka, czy produkt jest ważny do końca wskazanego dnia; porównanie według `Europe/Warsaw`, nie przypadkowej strefy kontenera. FEFO sortuje wyłącznie dozwolone partie w dozwolonej lokalizacji.

Service worker cachuje wyłącznie wersjonowane statyczne pliki aplikacji. Żadne API, sesje ani magazynowe dane osobowe nie trafiają do cache SW ani localStorage. Brak kolejki zapisów offline i background sync w MVP. Offline UI pokazuje brak możliwości zapisu; nie potwierdza zużycia. Warto lokalnie przechować wyłącznie opaque UUID trwającej operacji, aby po powrocie sieci sprawdzić jej status; nie przechowuje się tokenu ani identyfikatora wizyty. Wylogowanie usuwa szkice i pamięć sesji w UI.

## 7. Testy odbiorowe — plan, nie wykonane wyniki

| Obszar | Minimalne przypadki |
|---|---|
| Izolacja 10 ratowników | Dla każdego i=1…10 odczyt MAG-i; dla każdego j≠i próba listy/detail/consume/history/report/export/operation status → brak danych i brak upstream write. Macierz obejmuje także MAG-00 i MAG-11. |
| Manipulacja | Body/query z warehouseId, actorId, role, obcy stockItemId; odpowiedź strict validation lub odmowa, zero wycieku i mutacji. |
| Błędy upstream filtra | Nieistniejąca location, cascade, obcy element w jednej stronie wyników, upstream count obejmujący inne lokalizacje → fail-closed. |
| Sesje | Brak sesji, cookie flags, wygasła/odwołana sesja, dezaktywacja konta, zmiana roli/przypisania, rotacja, CSRF/brak Origin/obcy Origin. |
| Reset | Jednorazowość, expiry, token nie w logach, brak enumeracji, unieważnienie poprzednich sesji, limit prób. |
| Idempotencja | 20 równoległych kopii tego samego klucza → jedna próba upstream; ten sam klucz/inny body → 409; druga instancja API; reconnect i replay po restarcie. |
| Równoczesność | Dwa różne klucze z sumą >stan; consume vs full/partial transfer; receipt/transfer utworzył nowy StockItem; wszystkie drogi używają tego samego globalnego durable gate. |
| Crash matrix | Po rezerwacji PREPARED, po DISPATCHING przed HTTP, upstream zastosował przed timeout, po 2xx przed commitem PG, po commicie przed odpowiedzią HTTP. Stan i blokady przeżywają restart. |
| Upstream outcomes | 2xx+clamping/partial effect, 4xx potwierdzony brak efektu, 5xx po mutacji, zła schema, timeout, duplikat markerów, brak tracking, history pagination. |
| Dane | Expired/blocked/missing LOT/EXP, unknown status, part unit tampering, przecinki/float/overflow/ujemne/zerowe ilości, date-only granica północy Warsaw. |
| Audyt | Intencja przed mutacją, wynik+zwolnienie gate atomowo w PG, nieudane logowania/CSRF/admin updates, brak sekretów/pacjenta, operator uzgodnienia. |
| PWA/E2E | Login, stock, consume, history, report, logout, network loss, session expiry, wiele zakładek, brak cached API i offline queue, Android/iOS na rzeczywistych telefonach podczas pilotażu. |
| Recovery | Odtworzenie app DB+InvenTree DB+files w izolowanym środowisku; nowe zapisy zablokowane do uzgodnienia operacji po niespójnym punkcie backupu. |

## 8. Decyzje do właściciela

1. Akceptacja modelu wyłącznego writer'a Fastify i maintenance dla ręcznego InvenTree; bez tego pozostaje nieusunięty wyścig location/quantity.
2. Akceptacja zatrzymania wszystkich zapisów magazynowych przez globalny durable gate przy wyniku UNCERTAIN oraz odpowiedzialna osoba i SLA uzgadniania.
3. Kanał resetu/firmowe SMTP lub SSO; polityka czasu sesji i ewentualne MFA administratora.
4. Jednostki całkowite vs ułamkowe, dozwolone statusy, brak LOT/EXP, znaczenie ostatniego dnia EXP.
5. Identyfikator wizyty domyślnie wyłączony; cel i retencja wymagają decyzji. Retencja audytu/backupów i dedup tombstones nie może być arbitralnie uznana za zgodność prawną.
6. Testy 12 lokalizacji, import i rzeczywiste operacje dopiero po zatwierdzeniu planu oraz dostępu do izolowanej instancji.

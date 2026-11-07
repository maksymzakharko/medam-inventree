# Kontrakt własnego API — projekt etapu 1

To endpointy Fastify, nie InvenTree. Wspólne schematy Zod powstaną w
`packages/shared`. Poniższe DTO, limity i zachowanie są projektem, nie działającym API.

## Zasady wspólne

Wszystkie obiekty wejściowe Zod `.strict()`, bez dodatkowych pól; jawna biała lista
query. UUID kanoniczne, InvenTree PK dodatni integer, tekst trimowany i ograniczony,
daty ISO `YYYY-MM-DD`. Ilość to string kanoniczny `^[0-9]+(\.[0-9]{1,5})?$`, maks.
10 cyfr całkowitych, >0 po normalizacji; bez exponent, comma, float i nadmiarowych zer.
Po normalizacji sprawdzić quantum jednostki i faktyczną dostępność. Hash requestu
liczony z jednoznacznego DTO, nie z surowej kolejności pól JSON.

Wszystkie ścieżki po sesji poza health i publicznym przepływem auth; mutacje z
CSRF i dokładną kontrolą Origin. Login/reset też CSRF. Body domyślnie maks. 16 KiB,
opis problemu do 1000 znaków, login do 254, hasło 12–128 znaków; bez logowania treści
haseł/tokenów. Proponowane limity do kalibracji: odczyt 120/min/użytkownik, zapis
30/min/użytkownik, status 60/min/użytkownik; login 5/15 min/konto i 30/15 min/IP;
reset 3/h/konto i 10/h/IP. Liczniki auth są współdzielone/trwałe; nie polegać tylko
na pamięci procesu. `429` z `Retry-After`. Brak zaufania do dowolnego X-Forwarded-For.

Przykładowy DTO pozycji:

```json
{
  "id": 123,
  "partId": 8,
  "name": "Preparat testowy",
  "quantity": "12",
  "availableQuantity": "12",
  "unit": "amp.",
  "lot": "LOT-TEST",
  "exp": "2027-06-30",
  "minimum": "5",
  "warnings": [],
  "eligibleForConsumption": true
}
```

`quantity` i available pochodzą z aktualnego InvenTree; minimum z konfiguracji.
Ratownik nie otrzymuje raw stock metadata, obcych lokalizacji ani linków upstream.
Prywatne odpowiedzi mają `Cache-Control: no-store`. Listy: `{items, nextCursor}`;
magazyn może mapować offset na własny cursor, bez oddawania `next` InvenTree.

## Uwierzytelnianie

| Endpoint | Żądanie → odpowiedź | Uprawnienia, walidacja, audyt |
| --- | --- | --- |
| `GET /api/auth/csrf` | brak → `{csrfToken}` + preauth cookie | Publiczny, 30/min/IP; tworzy stan CSRF bez ujawnienia sesji pracownika |
| `POST /api/auth/login` | `{login,password}` → `{user,csrfToken}` + nowa cookie sesji | Preauth CSRF, limity loginu; neutralne 401; audyt sukcesu i odmowy, brak hasła |
| `POST /api/auth/logout` | `{}` → 204 | Sesja + CSRF; unieważnienie sesji w PG i cookie; audyt |
| `POST /api/auth/password-reset/request` | `{login}` → 202 | Publiczny + CSRF, stała neutralna odpowiedź; uruchamiany dopiero po wyborze kanału resetu; audyt i limity |
| `POST /api/auth/password-reset/confirm` | `{token,newPassword}` → 204 | Jednorazowy niewygasły token, CSRF; reset i revoke wszystkich sesji atomowo; audyt bez tokenu |
| `GET /api/me` | brak → `{user:{id,login,role,warehouse},csrfToken}` | Aktywna sesja; warehouse tylko własny dla ratownika; 401 po revoke/expiry |

Przy nadzorowanym resecie publiczne request-reset może wyłącznie przyjąć neutralne
zgłoszenie, nie wydać tokenu. Token generuje uprawniony admin po sprawdzeniu
tożsamości. Admin nie ustawia znanego sobie hasła pracownika.

## Ratownik i wspólne widoki

| Endpoint | Żądanie → odpowiedź | Zakres, limity i audyt |
| --- | --- | --- |
| `GET /api/my-stock` | `q<=80, filter=all/low/expiring/blocked, cursor, limit<=50` → lista StockDto | Ratownik tylko przypisany PK; wymuszony cascade=false; walidacja każdego wyniku; brak warehouseId/actorId; odmowy audytowane |
| `GET /api/my-stock/:id` | PK → StockDto | Pobranie bieżącego StockItem, sprawdzenie location; obcy/brak → takie samo 404; 120/min; audyt odmów |
| `POST /api/consumptions` | `Idempotency-Key: UUID`, `{stockItemId,quantity}` → OperationDto | Wyłącznie medic, własny stock; pełna walidacja i gate; intencja + wynik + dowód audit |
| `GET /api/operations/:id` | operation UUID → OperationDto | Właściciel lub uprawniony admin; obcy → 404; 60/min; bez danych obcego autora |
| `GET /api/my-history` | `cursor, limit<=50, from,to` → lista własnych zdarzeń | Actor z sesji; okres <=90 dni/żądanie; keyset; żadnego userId ani warehouseId; audyt odmów |
| `POST /api/problem-reports` | Idempotency-Key, `{category,stockItemId?,description}` → `{id,status,createdAt}` | Wyłącznie medic; category damage/expired/discrepancy/other; location z sesji; optional stock weryfikowany; 10/min; zero stock mutation; audyt utworzenia |
| `GET /api/problem-reports` | `cursor,limit<=50,status?` → lista zgłoszeń | Ratownik tylko reporter=self; magazynier/admin wszystkie w zakresie roli; audyt odmów |

Identyfikator wizyty nie jest częścią początkowego DTO. Jeżeli właściciel zatwierdzi
format i retencję, wersjonowany schemat dopuści pole `visitReference<=64`, bez
osoby/pacjenta w InvenTree notes, URL i logach.

Zużycie administracyjne ma osobny endpoint `/api/admin/consumptions` poniżej.
Ratownik nie uzyskuje tej ścieżki przez zmianę body. Tworzenie problem-reports w MVP
jest przypisane ratownikowi; magazynier/admin przegląda zgłoszenia i rozlicza je
przez osobne operacje. Nie zgadujemy magazynu administratora bez przydziału.

## Magazynier i administrator

| Endpoint | Żądanie → odpowiedź | Uprawnienia, limity i audyt |
| --- | --- | --- |
| `GET /api/admin/warehouses` | brak → `{items:[{id,code,name}]}` | warehouse_manager/admin; walidacja mapowań, 60/min, audyt odmów |
| `GET /api/admin/warehouses/:id/stock` | jak my-stock → lista StockDto | warehouse_manager/admin; lokalizacja z mapowań, własna walidacja wyników; 120/min |
| `POST /api/admin/consumptions` | Idempotency-Key, `{stockItemId,quantity}` → OperationDto | warehouse_manager/admin; bieżąca lokalizacja i taka sama polityka zużycia medycznego jak dla ratownika; globalny gate, pełny audyt |
| `POST /api/admin/warehouse-transfers` | Idempotency-Key, `{stockItemId,destinationWarehouseId,quantity}` → OperationDto | warehouse_manager/admin; source z bieżącej pozycji, target istniejący i aktywny, !=source, gate globalny, merge=false; pełny audyt |
| `POST /api/admin/receipts` | Idempotency-Key, `{partId,warehouseId,quantity,lot,exp}` → OperationDto | warehouse_manager/admin; zatwierdzona jednostka, LOT/EXP, istniejący produkt i lokalizacja; nowa partia StockItem; pełny audyt |
| `POST /api/admin/adjustments` | Idempotency-Key, `{stockItemId,quantity,direction,reason}` → OperationDto | warehouse_manager/admin; reason wymagany <=500, jawny increase/decrease, ten sam gate; decrease strat dopuszcza expired/damaged/returned po odrębnej kontroli ilości i powodu, nie jako zużycie medyczne; increase nie służy obejściu blokad/statusów; nie zmienia LOT/EXP; pełny audyt |
| `GET /api/admin/audit` | `actor?,operationId?,from,to,cursor,limit<=100` → lista AuditDto | warehouse_manager widzi operacje stock i zgłoszenia; admin dodatkowo zdarzenia auth/admin; okres <=90 dni; bez sekretów; audyt dostępu |
| `GET /api/admin/exports` | `kind=stock/operations/problems, warehouseId?,from,to` → strumień CSV | warehouse_manager/admin; okres max366 dni, max10000 wierszy, 5/h; autoryzacja przed stream, no-store, CSV formula escaping; audyt zakresu i wyniku |
| `POST /api/admin/operations/:id/reconcile` | `{resolution,evidenceIds,reason}` → OperationDto | Tylko admin po reautoryzacji; serwer weryfikuje dowody, nie ufa samemu claimed result; brak nowej mutacji upstream; pełny audyt operatora |
| `POST /api/admin/users` | `{login,role,warehouseId?}` → `{id,bootstrapRequired}` | Tylko admin, bez domyślnego hasła; ratownik wymaga mapowania; audyt |
| `PATCH /api/admin/users/:id` | ścisły zestaw `{active?,role?,warehouseId?}` → UserDto | Tylko admin po reautoryzacji; wersja/warunek chroni przed utraconą aktualizacją; zmiana przydziału po domknięciu operacji; revoke sesji; audyt przed/po |
| `POST /api/admin/users/:id/password-reset` | `{}` → `{resetInitiated:true}` | Admin po reautoryzacji i weryfikacji tożsamości; jednorazowy token przez wybrany bezpieczny kanał; 3/h/konto; audyt bez sekretu |

Rutynowa zmiana LOT/EXP nie jest otwartym endpointem: błąd danych trafia do
administratora, kontrolowanego maintenance i udokumentowanej korekty. Przyjęcia,
zwroty i zwiększenia wymagają tej samej trwałej idempotencji co zużycie.
Raport problemu i pozostałe app-only create używają transakcji PG i klucza
idempotencji, ale nie potrzebują globalnej blokady InvenTree.

## Wyniki i błędy

OperationDto: `{id,state,requestedQuantity?,appliedQuantity?,createdAt,updatedAt}`.
UUID generowany w PWA przed wysłaniem jest jednocześnie `Idempotency-Key` i ID operacji.
Pełny potwierdzony efekt: 201 i `SUCCEEDED`. Trwające/niepewne: 202 z
`Location: /api/operations/<UUID>` i jawnym stanem; nie jest to sukces zużycia.
Powtórzony zgodny klucz zwraca utrwalony status/wynik PRZED nowym pobraniem StockItem
i sprawdzeniem zajętości gate, nigdy nową mutację. Dzięki temu recovery działa też
po utracie pierwszej odpowiedzi i po usunięciu pozycji do zera.
Inny body pod tym samym kluczem: 409 `IDEMPOTENCY_CONFLICT`.

Wspólny błąd: `{error:{code,message,requestId,operationId?}}`. Komunikat po polsku,
bez stacktrace, SQL, upstream URL/tokenów i raw upstream body.

| HTTP | Znaczenie |
| --- | --- |
| 400 | Schemat/ilość/jednostka, nieznane pola lub parametr |
| 401 | Brak/wygaśnięcie/odwołanie sesji; UI kieruje do logowania |
| 403 | Niewłaściwa rola/CSRF/Origin; brak danych zasobu |
| 404 | Brak lub cudzy zasób; nie pozwala potwierdzić jego istnienia |
| 409 | Konflikt klucza, niedozwolony stan partii, za mało zapasu wykryte PRZED wysłaniem |
| 423 | Trwały gate zajęty nierozstrzygniętą operacją; bez danych autora innego magazynu |
| 429 | Limit; Retry-After |
| 502/503 | Nieprawidłowy/nieosiągalny upstream PRZED dispatch; bez potwierdzenia zapisu |

Po `DISPATCHING` timeout/5xx nie prowadzi do komunikatu sugerującego bezpieczny
retry nowym kluczem: zwracamy UUID i stan `UNCERTAIN`, jeśli odpowiedź do klienta
jest możliwa. Po utracie DB UI musi odzyskać status przez ten sam UUID po powrocie
usługi. `DISCREPANCY` pokazuje rzeczywiście potwierdzony efekt i wymaga operatora;
`RECONCILED_PARTIAL` zamyka potwierdzoną częściową realizację z faktyczną ilością,
bez automatycznej reszty/kompensacji. Gate blokuje nowe mutacje stock, nie auth,
app-only zgłoszenia, status/replay ani uzgadnianie.

Publiczne `GET /health/live` ma minimalną odpowiedź liveness bez zależności;
prywatne `GET /health/ready` sprawdza DB, konfigurację, zgodność InvenTree i gate.
Nierozstrzygnięta operacja oznacza niegotowość zapisów, nie bezcelowy restart przez
liveness; odczyty mogą działać. Health nie ujawnia wersji/sekretów publicznie.

# Audyt API InvenTree — 7 listopada 2026

Status: analiza oficjalnej dokumentacji, opublikowanego OpenAPI i kodu wydania. **Nie wykonano testu działającej instancji VPS**; właściciel jeszcze nie kupił serwera. Nie ma zainstalowanej instancji, konfiguracji ani tokenu do sprawdzenia. Poniższe przykłady nie są instrukcją wykonania zmian na produkcji.

## Wersja i wiarygodność źródeł

- GitHub `releases/latest` wskazuje stabilne **1.7.0**, opublikowane **3 listopada 2026, 12:50 UTC**, `prerelease=false`. [Wydanie](https://github.com/inventree/InvenTree/releases/tag/1.7.0), [metadane wydania](https://api.github.com/repos/inventree/InvenTree/releases/latest).
- Tag 1.7.0 wskazuje commit `365245ed73eb469cf80578856947ce92eca8b271`. Kod deklaruje **API v570**: [api_version.py#L4](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/InvenTree/api_version.py#L4).
- Oficjalny snapshot: [inventree/schema/export/570/api.yaml](https://github.com/inventree/schema/blob/6c1dbec0b81d4f6af41db03648a96e800eb8ec23/export/570/api.yaml). Zbadany commit repozytorium schematów: `6c1dbec0b81d4f6af41db03648a96e800eb8ec23`; SHA-256 pliku: `2437e90db2f73a5fbac9585eb683421ca8c8710711b65f57196536e9b1b875ae`.
- Strona dokumentacji dołączona do 1.7.0 podaje jeszcze wersję 568. Przy rozbieżności obowiązuje schemat rzeczywistej instancji, kod przypiętego wydania i test integracyjny, nie numer z ogólnej strony.
- Po uzyskaniu dostępu: odczytać `GET /api/`, pobrać `GET /api/schema/`, przejrzeć `/api-doc/`, zachować wersję, skrót schematu i digest obrazu. [Routing i schemat](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/InvenTree/urls.py#L56), [dokumentacja API](https://docs.inventree.org/en/stable/api/).

## Potwierdzony kontrakt

| Cel | Endpoint InvenTree 1.7.0 | Istotne cechy |
| --- | --- | --- |
| Lista zapasów | `GET /api/stock/` | `location`, `cascade`, `part`, `batch`, `search`, `expiry_before`, `expiry_after`, `expired`, `status`, `in_stock`, `allocated`, `limit`, `offset`, `ordering` |
| Pozycja | `GET /api/stock/{id}/` | Wymagana kontrola rzeczywistego `location`; identyfikator pozycji nie jest identyfikatorem produktu ani LOT |
| Lokalizacje | `GET/POST /api/stock/location/`, `GET /api/stock/location/{id}/` | `pk`, `name`, `parent`, `structural`, `external`; przy zakładaniu MAG-00…MAG-11 zachować zwrócone PK |
| Produkty | `GET /api/part/`, `GET /api/part/{id}/` | Jednostka `units`, nazwa, `minimum_stock`, aktywność produktu |
| Nowa partia/przyjęcie | `POST /api/stock/` | Tworzenie StockItem z `part`, `location`, `quantity`, `batch`, `expiry_date`; odpowiedź jest listą StockItem (także przy pojedynczym przyjęciu) |
| Zwiększenie istniejącej pozycji | `POST /api/stock/add/` | `items: [{pk, quantity}]`, `notes`; nie służy do zakładania nowego LOT/EXP |
| Rozchód | `POST /api/stock/remove/` | `items: [{pk, quantity}]`, `notes`; 201 nie dowodzi wykonania pełnej ilości |
| Przesunięcie | `POST /api/stock/transfer/` | `items: [{pk, quantity, merge?: false}]`, docelowe `location`, `notes` |
| Historia/uzgadnianie | `GET /api/audit/`, `GET /api/audit/{id}/` | `model_type`, `model_id`, `event_type`, `actor`, `cid`, `min_date`, `max_date`, `limit`, `offset` |
| Statusy | `GET /api/stock/status/` | Uwzględnić niestandardowe statusy instancji; nie traktować dowolnego `in_stock=true` jako dopuszczenia do zużycia medycznego |

Źródła: [routing stock](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/api.py#L1567), [schemat v570](https://github.com/inventree/schema/blob/6c1dbec0b81d4f6af41db03648a96e800eb8ec23/export/570/api.yaml), [serializery operacji](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/serializers.py#L1763).

StockItem udostępnia `pk`, `part`, `quantity`, `allocated`, `batch`, `expiry_date`, `location`, `status`, `status_custom_key`, `in_stock`, `expired`, `delete_on_deplete`, `is_building`, `belongs_to`, `customer`, `consumed_by`, `sales_order`. Produkt ma `units` oraz `minimum_stock`. `minimum_stock` jest cechą produktu, nie potwierdzonym indywidualnym progiem dla każdego magazynu. Progi MAG×produkt trzeba zaprojektować jako konfigurację aplikacji (bez kopiowania ilości) albo potwierdzić odrębne pole/API instancji.

Operacje stock add/remove/transfer przyjmują ilości jako **decimal string** (do 10 cyfr całkowitych i 5 po przecinku). App powinna dodatkowo wymagać `quantity > 0`, limitu i zgodności z jednostką. W odpowiedzi GET ilość może być liczbą; Zod normalizuje ją do dziesiętnej reprezentacji bez liczenia przez `number` dla operacji. `notes` ma limit **512 znaków**. Backend buduje jawny payload: nie przekazuje opcjonalnych `batch`, `status` i `packaging` dostarczonych przez ratownika.

Przykładowy payload wyłącznie do późniejszego testu staging:

```json
{
  "items": [{"pk": 123, "quantity": "2"}],
  "notes": "medam-op:550e8400-e29b-41d4-a716-446655440000"
}
```

Przy transferze dochodzi `"location": 456`; ustawiamy `merge: false`. Częściowy transfer tworzy nowy StockItem i pomniejsza źródłowy, dlatego nie zakładamy zachowania PK przemieszczonej części. [move](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L3121).

## Krytyczne ustalenia bezpieczeństwa i spójności

### 1. Filtr lokalizacji nie zapewnia izolacji

`cascade` domyślnie ma wartość true. Dla nieistniejącej lokalizacji ścieżka `cascade=true` zwraca **nieprzefiltrowany queryset**. [StockFilter.filter_location](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/api.py#L1053).

Każdy odczyt aplikacji ma wymuszać `location=<PK przypisany w sesji>&cascade=false`, nigdy przyjmować tego PK jako uprawnienia z frontendu. Zwalidować każdą zwróconą pozycję, odrzucić całą odpowiedź przy obcej lokalizacji. Brak przydziału, nieprawidłowy PK, usunięta lokalizacja, nieznana odpowiedź i błąd upstream oznaczają brak dostępu. Stosować własne DTO: zagnieżdżone dane InvenTree mogą zawierać informacje niepotrzebne ratownikowi. Historia/eksport ratownika są filtrowane według użytkownika w audycie aplikacji, a nie tylko bieżącego położenia StockItem.

### 2. Rozchód ponad dostępny stan jest przycinany

`take_stock()` uzyskuje blokadę wiersza i odświeża ilość. Następnie wykonuje `quantity = min(quantity, self.quantity)`. Żądanie 25 przy stanie 10 usuwa **10**, nie zwraca błędu niedoboru. Pozycja pusta może skutkować `False` i brakiem zdarzenia. [take_stock](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L3435), [blokada](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L3217).

`StockRemoveSerializer.save()` nie zamienia `False` w wyjątek i nie zwraca faktycznej ilości. Klasa CreateAPI zwraca `serializer.data` z kodem **201**. Dlatego 201 może oznaczać częściową realizację albo brak zmiany. Źródła: [remove serializer](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/serializers.py#L2016), [CleanCreate](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/InvenTree/mixins.py#L14).

Nie wolno potwierdzić pełnego zużycia na podstawie echa żądania. W aplikacji MVP jedna operacja obejmuje jedną pozycję. Przed zapisem walidujemy bieżący stan w blokadzie aplikacji, po zapisie uzgadniamy zdarzenie InvenTree i faktycznie usuniętą ilość. Częściowe wykonanie to `DISCREPANCY`, nigdy komunikat „zapisano żądaną ilość”, a stan InvenTree pozostaje źródłem prawdy. Brak wpisu nie daje automatycznego prawa ponowienia.

Przy wielu pozycjach serializer otacza pętlę jedną transakcją InvenTree i przetwarza PK w stałej kolejności. Wyjątek może wycofać transakcję, ale wartości `False`/przycięte ilości nie wywołują wyjątku. Taki batch nie jest gwarancją biznesową „wszystko albo nic”. [StockAdjustmentSerializer.validate](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/serializers.py#L1908).

### 3. Blokada ilości nie jest atomową kontrolą lokalizacji, EXP i statusu

`lock_quantity()` odświeża **tylko quantity**. API remove nie ma `expected_location`, `expected_status`, `expected_expiry`, ETag/If-Match ani warunkowego compare-and-swap w zbadanym kontrakcie. To, że Fastify odczytał i sprawdził magazyn przed POST, nie wyklucza zmiany lokalizacji pomiędzy żądaniami. Zablokowana lub przeterminowana partia także wymaga własnej kontroli; walidacja wejścia StockAdjustmentItem wywołuje `is_in_stock(check_status=false, check_quantity=false, check_in_production=false)`.

Proponowane ograniczenie MVP: wszystkie rutynowe zapisy stock, w tym magazyniera i administratora, przez Fastify oraz wspólną trwałą kolejkę i globalną trwałą bramę zapisów w PostgreSQL aplikacji. Bezpośrednie zapisy w InvenTree tylko w trybie maintenance, po zatrzymaniu/uzgodnieniu kolejki. Dostęp awaryjny musi być kontrolowany i audytowany. Blokada aplikacji nie blokuje obcych klientów ani UI InvenTree; utrata połączenia z bazą blokad lub śmierć procesu z trwającym HTTP wymaga pozostawienia trwałej blokady biznesowej `UNCERTAIN` do uzgodnienia.

Jeśli wymagamy bezwarunkowej atomowej kontroli także wobec zewnętrznych autorów zmian, potrzebna jest zmiana po stronie InvenTree (zatwierdzony plugin/rozszerzenie z transakcyjną walidacją i natywnym deduplication) albo rezygnacja z takich autorów. Nie obiecujemy atomowej transakcji między dwiema bazami i HTTP.

### 4. InvenTree „dostępny” ma szersze znaczenie

`StockStatusGroups.AVAILABLE_CODES` obejmuje **10 OK, 50 Attention, 55 Damaged i 85 Returned**. [status_codes.py](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/status_codes.py#L32). Dla preparatów proponujemy jawnie dopuszczony **OK**, jawne mapowanie statusów niestandardowych, nieznany status = blokada.

Sam `in_stock` nie sprawdza EXP. `is_expired()` oznacza datę wcześniejszą od bieżącej daty; nie jest częścią kontroli remove. EXP i LOT są obowiązkowe dla preparatów w polityce aplikacji; brak = blokada do wyjaśnienia. Strefa Europe/Warsaw i znaczenie EXP ostatniego dnia wymagają decyzji właściciela. Nie wyliczamy farmaceutycznego EXP z `Part.default_expiry`. FEFO jest rekomendacją pomiędzy dopuszczonymi partiami.

Rezerwacje są odrębne: dostępna ilość to stock minus allocated. MVP blokuje pozycje z rezerwacjami albo waliduje dostępność bez naruszania rezerwacji; `take_stock` nie wykonuje w badanym kodzie takiej atomowej walidacji. [dokumentacja dostępności](https://docs.inventree.org/en/stable/stock/availability/), [is_in_stock](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L2310), [is_expired](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L1485).

## Dowód wykonania i uzgadnianie

API v566 (włączone do 1.7.0) usunęło `/api/stock/track/`, `/api/stock/track/{id}/` i `/api/stock/track/status/`; używamy **`/api/audit/`**. [historia zmian API](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/InvenTree/api_version.py#L24).

Audyt StockItem przy rozchodzie zawiera:

- `model_type="stock.stockitem"`, `object_pk` jako string, `event_type=12` (STOCK_REMOVE), `actor` konta serwisowego;
- `notes` z naszym dokładnym prefiksem i UUID;
- `deltas.removed` z **faktycznie usuniętą ilością**, `deltas.quantity` z ilością po zmianie;
- `changes.quantity` z przed/po, gdy obiekt zmienił ilość; po usunięciu do zera zdarzenie nadal jest rejestrowane;
- `cid` do korelacji żądania. Kod wskazuje zgodność z przychodzącym `X-Request-ID`, jeżeli middleware i proxy zachowają nagłówek. Wysłać ten sam UUID jako `X-Request-ID` i w `notes`, ale potwierdzić zachowanie runtime.

Dowód w kodzie: [take_stock — removed po clamp](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L3463), [tracking_event](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/models.py#L2398), [audit batch w transakcji](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/helpers.py#L34), [serializacja deltas](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/serializers.py#L126), [cid](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/context.py#L295).

Przykładowy odczyt po późniejszym teście staging:

```text
GET /api/audit/?model_type=stock.stockitem&model_id=123&event_type=12&include_children=false&cid=<UUID>&limit=100&offset=0
```

`cid` to filtr dokładny; `notes` nie ma filtra, a `search` szuka tylko `object_repr` i nazwy aktora. Jeżeli `cid` nie jest zachowywany, pobrać ograniczoną datami historię danej pozycji z paginacją i porównać `notes` dokładnie. Przy transferze przejrzeć również zdarzenia split na źródłowym i nowym StockItem; nie zakładać, że jedna operacja ma zawsze jeden wpis. [filtry audit](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/api.py#L79).

UUID w notes/cid **nie deduplikuje** zmian po stronie InvenTree i nie ma gwarancji unikalności w audit. W zbadanym OpenAPI v570 nie ma udokumentowanego natywnego `Idempotency-Key`. Wymagane są trwałe unikalne klucze aplikacji i pojedyncza wysyłka mutacji. Wynik uzgadniania:

1. Dokładne dopasowanie UUID, StockItem, konta serwisowego, rodzaju zdarzenia i ilości = można potwierdzić wynik, zapisać PK audytu oraz dowód w jednej transakcji aplikacji.
2. Ilość inna niż żądana, powielone zdarzenia, brak korelacji lub inne niezgodności = `requires_review`; blokada następnych zapisów całego systemu.
3. Brak wpisu po timeout/crash = `UNCERTAIN`; brak dowodu nie oznacza niewykonania. Nie ponawiać automatycznie. Uzgodnić po zakończeniu przetwarzania upstream i kontroli stanu oraz audytu.
4. Nie wyprowadzać sukcesu wyłącznie z różnicy quantity przed/po; inne operacje mogły zmienić stan.

Audyt musi być włączony (`AUDIT_LOG_ENABLED`). Po wyłączeniu **nie ma historii stock**. Automatyczna retencja może usunąć dowód do uzgodnienia. Przed udostępnieniem zapisów potwierdzić konfigurację, konto odczytujące audyt i okres retencji; rozważyć blokadę zapisów przy wykryciu wyłączenia audytu. [dokumentacja audit](https://docs.inventree.org/en/stable/concepts/audit/), [tracking](https://docs.inventree.org/en/stable/stock/tracking/).

W kodzie upstream istnieją testy potwierdzające clamp i rzeczywiste `removed` oraz test dwóch transakcji z row lock: [tests.py#L442](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/tests.py#L442), [tests.py#L2324](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/stock/tests.py#L2324). **Nie uruchomiono tych testów w tym audycie**; jest to dowód implementacji i intencji upstream, nie wynik testów naszego systemu.

## Paginacja, transport, uprawnienia

- InvenTree stosuje DRF LimitOffsetPagination. Jawnie wysyłać `limit` i `offset`; zbadany schemat wymaga limit. Odpowiedź: `count`, `next`, `previous`, `results`. Obsługiwać kolejne strony z limitem łącznej pracy i czasu. Nie wykonywać bez kontroli URL z `next`: dopuścić jedynie ustalony origin/base path i zachować scope `location`, `cascade=false`, filtry. [settings.py#L561](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/InvenTree/settings.py#L561).
- Serwerowy token w nagłówku **`Authorization: Token <sekret>`**. Konto serwisowe z minimalnymi przetestowanymi rolami (odczyt stock/part/location/audit oraz operacje zapisu stock; bez superuser). Token v2 w 1.7 ma wygasanie i odwołanie. OAuth2 wymaga zarówno scopes, jak i uprawnień użytkownika. Nie wnioskować granulatności uprawnień do pojedynczej operacji lub magazynu z samej nazwy roli. [oficjalna dokumentacja auth](https://docs.inventree.org/en/stable/api/), [kod walidacji](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/users/authentication.py#L50).
- Rate limiting po stronie aplikacji; zbadane ustawienia InvenTree nie włączają domyślnych throttli DRF. Timeouty i walidacja odpowiedzi Zod są obowiązkowe. Ponowienia tylko bezpiecznych GET, z limitem, backoff i respektowaniem 429. Nigdy automatycznego ponowienia remove/transfer/add po timeout/5xx.
- API/audit filtruje według uprawnień **modelu**, nie magazynu ratownika. Własny backend nie przekazuje całego endpointu InvenTree do PWA. [audit get_queryset](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/api.py#L193).
- Backup musi obejmować sekret kryptograficzny InvenTree (`SECRET_KEY`): odtworzenie bazy bez poprawnego materiału klucza unieważnia użyteczność tokenów v2. Backup konfiguracji zawierającej klucze musi być zaszyfrowany i poza Git. [dokumentacja tokenów](https://docs.inventree.org/en/stable/api/#token-generation-version).

## Co musi potwierdzić staging przed implementacją produkcyjną

1. Wersja faktycznej instancji, OpenAPI, digest obrazu, auth, minimalne role i brak publicznego admin API.
2. MAG-00…MAG-11 zwracają trwałe PK; nieistniejące przypisanie nie ujawnia stanów; `cascade=false` jest zachowane na wszystkich stronach.
3. Create StockItem z LOT/EXP i units, częściowy transfer (nowe PK), pełny transfer, no merge, stan pusty i `delete_on_deplete`.
4. Remove prawidłowy, ponad stan, równoczesny remove/remove i remove/transfer; rozjazd quantity do zgłoszenia częściowej realizacji.
5. Status DAMAGED/RETURNED/niestandardowy, EXP dziś/wczoraj/brak, rezerwacje i part nieaktywny; aplikacja blokuje niedozwolone przypadki.
6. `X-Request-ID`→`cid`, dokładne `notes`, `deltas.removed`, audyt po usunięciu pozycji, wymagane uprawnienia i jawne `AUDIT_LOG_ENABLED=true`.
7. Zabicie API przed POST, po POST, po 201 przed zapisem audytu; timeout z odpowiedzią utraconą po realizacji; ten sam UUID i inny payload; reset sesji; restart procesu i DB.
8. Zatrzymanie nowych zapisów dla `UNCERTAIN`, brak automatycznego resend, dowód uzgodnienia i bezpieczne wznowienie.

Dopiero po tych testach można potwierdzić adapter dla konkretnej instancji. Do tego czasu wersja i kontrakt są **zweryfikowaną propozycją**, a nie deklaracją przetestowanego wdrożenia.

## Uzupełnienie: zakres wyłącznego writera i worker InvenTree

Globalna trwała brama zapisów aplikacji obejmuje **wszystkie operacje zmieniające stock i dopuszczenie partii**, w tym przyjęcia, transfery, korekty, status, LOT/EXP oraz import, a nie wyłącznie rozchody ratownika. Gdy wynik operacji jest `unknown`, brama pozostaje zamknięta po restarcie i blokuje dalsze zapisy do uzgodnienia. To mechanizm aplikacyjny; InvenTree worker i kod pluginów nie korzystają automatycznie z tej bramy.

Potwierdzone niezależne ścieżki zmian w kodzie 1.7.0:

| Ścieżka | Co może zmienić | Źródło |
| --- | --- | --- |
| Build consume | Zużywa przydzielone stock przez `complete_allocations` w zadaniu worker | [build/tasks.py#L37](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L37), [API kolejkujące zadanie](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/api.py#L1005) |
| Build delete/scrap/complete outputs | Usuwa i dzieli StockItem, zmienia lokalizację/status i stan produkcji; zadania uruchamiane w workerze | [build/tasks.py#L110](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L110), [#L142](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L142), [#L200](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L200) |
| Sales shipment completion | Kończy alokacje, wydaje stock klientowi; zadanie worker | [order/tasks.py#L240](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/tasks.py#L240) |
| Purchase receiving | Tworzy nowe StockItem z ilością, lokalizacją i danymi partii, może wiązać z build | [order/models.py#L1115](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/models.py#L1115) |
| Transfer order completion | Wywołuje `take_stock`, `splitStock` lub `move`; nie musi przechodzić przez endpoint `/stock/transfer/` | [order/models.py#L4369](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/models.py#L4369) |
| Plugins: harmonogramy i zdarzenia | Wywołuje dowolne zarejestrowane funkcje/plugin callbacki; kod działa wewnątrz InvenTree i może korzystać z ORM | [ScheduleMixin.py#L15](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/integration/ScheduleMixin.py#L15), [rejestracja harmonogramów](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/integration/ScheduleMixin.py#L158), [worker callbacki zdarzeń](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/event/events.py#L192) |

Nie należy utożsamiać wszystkich zadań okresowych ze zmianą stock. Zbadany domyślny `check_stale_stock` wysyła powiadomienia, a `scheduled_stocktake_reports` tworzy snapshoty raportowe: [part/tasks.py#L160](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/part/tasks.py#L160), [#L317](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/part/tasks.py#L317). Usuwanie starego audytu może jednak zniszczyć dowód operacji: [audit/tasks.py#L21](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/tasks.py#L21).

Warunek dopuszczenia MVP z wyłącznym writerem: audyt aktywnych i oczekujących zadań, harmonogramów, pluginów, webhooków, kont/tokenów, importów oraz cron/systemd/CLI; brak niezakończonych operacji build/sales/purchase/transfer, które mogą później zmienić magazyn. Nie włączamy tych workflowów na chronionych zapasach, dopóki nie zostaną objęte tym samym protokołem bramy albo transakcyjnym rozszerzeniem InvenTree. Pozostałe zadania worker (powiadomienia, raporty) mogą działać po weryfikacji, a worker pozostaje wymaganym elementem infrastruktury. Odcięcie samych endpointów HTTP nie zatrzymuje wcześniej zakolejkowanych zadań ani wewnętrznych pluginów. Niedozwolone byłoby „wyczyszczenie kolejki” bez kontroli i zgody na usunięcie istniejących danych; kolejkę uzgadniamy/opracowujemy przed uruchomieniem zapisów.

Kod i snapshot wystarczają do potwierdzenia **kontraktu opublikowanego wydania**, ale nie konfiguracji VPS, pluginów, kolejki, mutacji w przebudowanym obrazie ani zgodności faktycznie zainstalowanej instancji. Te elementy trzeba potwierdzić odczytowym audytem i testami staging.

## Uzupełnienie: zakres wyłącznego writera i worker InvenTree

Globalna trwała brama zapisów aplikacji obejmuje **wszystkie operacje zmieniające stock i dopuszczenie partii**, w tym przyjęcia, transfery, korekty, status, LOT/EXP oraz import, a nie wyłącznie rozchody ratownika. Gdy wynik operacji jest `UNCERTAIN`, brama pozostaje zamknięta po restarcie i blokuje dalsze zapisy do uzgodnienia. To mechanizm aplikacyjny; InvenTree worker i kod pluginów nie korzystają automatycznie z tej bramy.

Potwierdzone niezależne ścieżki zmian w kodzie 1.7.0:

| Ścieżka | Co może zmienić | Źródło |
| --- | --- | --- |
| Build consume | Zużywa przydzielone stock przez `complete_allocations` w zadaniu worker | [build/tasks.py#L37](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L37), [API kolejkujące zadanie](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/api.py#L1005) |
| Build delete/scrap/complete outputs | Usuwa i dzieli StockItem, zmienia lokalizację/status i stan produkcji; zadania uruchamiane w workerze | [build/tasks.py#L110](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L110), [#L142](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L142), [#L200](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/build/tasks.py#L200) |
| Sales shipment completion | Kończy alokacje, wydaje stock klientowi; zadanie worker | [order/tasks.py#L240](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/tasks.py#L240) |
| Purchase receiving | Tworzy nowe StockItem z ilością, lokalizacją i danymi partii, może wiązać z build | [order/models.py#L1115](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/models.py#L1115) |
| Transfer order completion | Wywołuje `take_stock`, `splitStock` lub `move`; nie musi przechodzić przez endpoint `/stock/transfer/` | [order/models.py#L4369](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/order/models.py#L4369) |
| Plugins: harmonogramy i zdarzenia | Wywołuje dowolne zarejestrowane funkcje/plugin callbacki; kod działa wewnątrz InvenTree i może korzystać z ORM | [ScheduleMixin.py#L15](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/integration/ScheduleMixin.py#L15), [rejestracja harmonogramów](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/integration/ScheduleMixin.py#L158), [worker callbacki zdarzeń](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/plugin/base/event/events.py#L192) |

Nie należy utożsamiać wszystkich zadań okresowych ze zmianą stock. Zbadany domyślny `check_stale_stock` wysyła powiadomienia, a `scheduled_stocktake_reports` tworzy snapshoty raportowe: [part/tasks.py#L160](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/part/tasks.py#L160), [#L317](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/part/tasks.py#L317). Usuwanie starego audytu może jednak zniszczyć dowód operacji: [audit/tasks.py#L21](https://github.com/inventree/InvenTree/blob/1.7.0/src/backend/InvenTree/audit/tasks.py#L21).

Warunek dopuszczenia MVP z wyłącznym writerem: audyt aktywnych i oczekujących zadań, harmonogramów, pluginów, webhooków, kont/tokenów, importów oraz cron/systemd/CLI; brak niezakończonych operacji build/sales/purchase/transfer, które mogą później zmienić magazyn. Nie włączamy tych workflowów na chronionych zapasach, dopóki nie zostaną objęte tym samym protokołem bramy albo transakcyjnym rozszerzeniem InvenTree. Pozostałe zadania worker (powiadomienia, raporty) mogą działać po weryfikacji, a worker pozostaje wymaganym elementem infrastruktury. Odcięcie samych endpointów HTTP nie zatrzymuje wcześniej zakolejkowanych zadań ani wewnętrznych pluginów. Niedozwolone byłoby „wyczyszczenie kolejki” bez kontroli i zgody na usunięcie istniejących danych; kolejkę uzgadniamy/opracowujemy przed uruchomieniem zapisów.

Kod i snapshot wystarczają do potwierdzenia **kontraktu opublikowanego wydania**, ale nie konfiguracji VPS, pluginów, kolejki, mutacji w przebudowanym obrazie ani zgodności faktycznie zainstalowanej instancji. Te elementy trzeba potwierdzić odczytowym audytem i testami staging.

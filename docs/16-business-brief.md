# MEDAM — opis biznesowy do przekazania wykonawcy

Stan: 13 listopada 2026. Obowiązujący kierunek: kontynuacja istniejącego rozwiązania z InvenTree. Szczegóły techniczne i stan dostępu: [przekazanie projektu](15-handover.md).

## Cel i skala

System magazynowy dla firmy świadczącej mobilne i stacjonarne usługi medyczne: 10 ratowników, około 20–30 leków i preparatów, około 70% wizyt mobilnych i 30% w gabinecie. Pracownicy korzystają głównie ze smartfonów Android/iOS.

12 magazynów: główny, 10 osobistych oraz gabinet. Celem jest wiarygodna informacja o dostępności produktów, partiach i ważności, rozliczenie zużycia i przekazań, wcześniejsze wykrywanie braków oraz ograniczenie pomyłek i ręcznych zestawień.

## Zakres pierwszego wdrożenia

- Katalog produktów, jednoznaczne jednostki ewidencyjne, aktywność/dezaktywacja.
- Stany według lokalizacji, LOT i EXP; wiele partii produktu i jedna partia w kilku magazynach.
- Dostawy, przesunięcia, zwroty, rzeczywiste zużycie, straty/uszkodzenia/przeterminowania i uzasadnione korekty.
- Historia autora, czasu, ilości i wyniku, filtrowanie oraz CSV do kontroli wewnętrznej.
- Minima w konkretnym magazynie, ostrzeżenia ważności, FEFO i blokada niedopuszczonych partii.
- Zgłoszenia problemów bez automatycznej zmiany ilości.
- Polski, responsywny interfejs PWA: logowanie, mój magazyn, zużycie, historia, zgłoszenia, wylogowanie i obsługa wygaśnięcia sesji.
- Prosta obsługa telefonu i czytelny status przy utracie sieci; bez rozchodów offline w MVP.

Nie wprowadza się automatycznych przeliczeń dawek, ml lub opakowań bez zatwierdzonej definicji jednostek. W InvenTree `piece` oznacza sztukę; opis produktu określa, czym jest ta sztuka.

## Uprawnienia i wiarygodność

| Rola | Uprawnienia |
| --- | --- |
| Ratownik | Tylko własny magazyn, jego partie, zużycie, własna historia i zgłoszenia |
| Magazynier/dyspozytor | Wszystkie magazyny, dostawy, transfery/zwroty, straty, korekty i raporty |
| Administrator | Dodatkowo konta, role, przypisania, ustawienia oraz wyjaśnianie nieprawidłowych operacji |

Ratownik nie zmienia magazynu, nie zwiększa ilości i nie edytuje LOT/EXP. Ograniczenia egzekwuje backend także dla bezpośrednich wywołań API. Wymagane są indywidualne konta, bezpieczne sesje i reset, odwoływanie dostępu oraz audyt.

System ma chronić przed podwójnym kliknięciem, ponowieniem po utracie odpowiedzi, równoczesnymi rozchodami ponad stan, utratą partii przy transferze i fałszywym potwierdzeniem częściowego zapisu. Niejednoznaczny wynik musi być jawny i wymagać bezpiecznego wyjaśnienia. Nie wolno ukrywać rozbieżności lub dowolnie edytować stanów poza kontrolowanymi operacjami.

## Architektura i wyłączenia

Istniejący projekt: React/TypeScript/Vite PWA, Node.js LTS/Fastify/TypeScript, Zod, PostgreSQL aplikacji, InvenTree z własnym PostgreSQL i Redis/workerem, Docker Compose, Caddy. InvenTree jest jedynym źródłem zapasów. Frontend nie otrzymuje jego tokenu i nie komunikuje się z nim bezpośrednio. Bazy i Redis nie mają publicznych portów; panel administracyjny tylko prywatnym kanałem.

MVP nie obejmuje danych pacjentów, dokumentacji medycznej, rezerwacji, Booksy, płatności, fiskalizacji, rekomendacji/dawkowania, SaaS ani aplikacji natywnych w sklepach. Dane medyczne i kalendarze pozostają w odrębnych systemach. Ewentualny identyfikator wizyty wymaga ustalenia polityki danych.

## Utrzymanie i infrastruktura

Właściciel kupił OVH VPS-1 (2 vCore, 4 GB RAM, 40 GB NVMe). Wymagany jest audyt rzeczywistego hosta i pomiar, czy dostrojony stos z InvenTree mieści się w tych zasobach. Nie należy wyceniać wdrożenia, zakładając automatycznie dostępność 8 GB RAM. Ubuntu 26.04 przeszedł testy CI, ale VPS nie został odebrany.

Zakres obejmuje HTTPS, healthchecki, autostart, limity logów, bezpieczne sekrety, monitoring i dostarczanie alarmów. Potrzebny jest spójny backup obu baz/plików/konfiguracji, szyfrowany offsite, retencja oraz sprawdzona procedura odzyskania na niezależnym środowisku. Wstępne cele RPO i RTO: po 4 godziny, do potwierdzenia pomiarem i uzgodnienia odpowiedzialności. Backup dostawcy nie jest jedyną metodą odzyskania.

## Wdrożenie i odbiór

1. Przegląd istniejącego kodu, potrzeb i dostępu do serwera.
2. Audyt hosta, plan zasobów, instalacji, kopii istniejącej konfiguracji i wycofania zmian.
3. Instalacja po akceptacji planu, konfiguracja domeny, sekretów, offsite i alarmów.
4. Przygotowanie rzeczywistego katalogu/jednostek, kont i zatwierdzonych stanów startowych.
5. Pilotaż dwóch ratowników na rzeczywistych Android/iOS.
6. Test izolacji magazynów, LOT/EXP, zużycia/przesunięć, duplikatów i utraty sieci; pomiar zasobów, restartu i odzyskania.
7. Odbiór i uruchomienie wszystkich użytkowników po zgodzie właściciela.

Uruchomienie techniczne nie jest potwierdzeniem zgodności organizacji z przepisami obrotu produktami leczniczymi. Właściciel i wykonawca ustalają odpowiedzialność, politykę danych/retencji oraz wymagane konsultacje.

## Oczekiwane rezultaty i wycena zewnętrzna

Wykonawca ma przejąć **istniejący** projekt, wskazać braki, wdrożyć go i przeprowadzić pilotaż/odbiór. Oczekiwane są kod w repozytorium właściciela, konfiguracje i migracje, rzeczywiste raporty testów, instrukcje instalacji/aktualizacji/wycofania, użytkowników, backupu i odtwarzania oraz szkolenie administratora. Repozytorium, domena i infrastruktura pozostają pod kontrolą właściciela.

Oferta powinna zawierać etapy, cenę i harmonogram, założenia/wyłączenia, koszty infrastruktury i utrzymania, zasady gwarancji/wsparcia/czasów reakcji, prawa do dalszego rozwijania kodu i przekazania innemu wykonawcy oraz sposób wyceny zmian zakresu. Przebudowa na inny silnik wymaga osobnej decyzji właściciela — obecnie wybrał on InvenTree.

Gotowy zakres kodu i dowody opisują [dokument 12](12-release-verification.md) i [dokument 14](14-ubuntu-26.04.md). Nie przedstawiaj wcześniejszych testów CI jako odbioru hosta OVH ani nowych prac wykonawcy.

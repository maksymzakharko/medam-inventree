# Archiwalny prompt badawczy — warianty architektury

**Nieaktywne zadanie.** 13 listopada 2026 właściciel zdecydował: „chcę kontynuować na InvenTree”. Poniżej zachowano wcześniej przygotowany prompt, aby nie utracić kontekstu. Nie stanowi on polecenia do przebudowy ani aktualnego planu prac. Kod nadal używa InvenTree jako jedynego źródła zapasów.

---

# Research architektury systemu magazynowego MEDAM

## Twoja rola

Działasz jako niezależny analityk biznesowy, architekt oprogramowania i inżynier bezpieczeństwa.

Przeprowadź research, który pomoże wybrać najprostsze, bezpieczne i ekonomicznie uzasadnione rozwiązanie magazynowe dla małej firmy medycznej.

Nie rozpoczynaj implementacji. Nie zmieniaj repozytorium ani infrastruktury. Wynikiem ma być analiza, rekomendacja i proponowany zakres pierwszego wdrożenia.

Nie zakładaj z góry, że należy użyć InvenTree, napisać własny system albo wybrać konkretny produkt. Porównaj te możliwości na podstawie rzeczywistych wymagań i kosztów utrzymania.

## 1. Kontekst biznesowy

Firma świadczy mobilne i stacjonarne usługi medyczne, w tym kroplówki witaminowe.

Skala działalności:

- 10 ratowników medycznych.
- Około 70% wizyt mobilnych i 30% w gabinecie.
- Około 20–30 rodzajów leków i preparatów.
- Pracownicy korzystają głównie ze smartfonów z Androidem lub iOS.
- Mały przewidywany ruch; dokładna liczba operacji dziennie nie została jeszcze ustalona.

Struktura magazynów:

- MAG-00 — magazyn główny.
- MAG-01–MAG-10 — osobiste magazyny ratowników.
- MAG-11 — magazyn gabinetu.

Booksy Med obsługuje wizyty i kalendarze. Dokumentacja medyczna, płatności i fiskalizacja pozostają w odrębnych systemach.

Projekt dotyczy ewidencji magazynowej, nie prowadzenia leczenia.

## 2. Obecny projekt

Repozytorium:
https://github.com/maksymzakharko/medam-inventree

Gałąź z implementacją:
feat/working-mvp

Pull request:
https://github.com/maksymzakharko/medam-inventree/pull/1

Jeśli masz dostęp, przejrzyj rzeczywisty kod i aktualną dokumentację. Nie opieraj analizy wyłącznie na README.

Dokumenty 01–08 opisują wcześniejszy etap projektowania i mogą zawierać historyczne założenia. Aktualny zakres implementacji i dowody sprawdzeń opisują README oraz dokumenty 09–14.

Obecna architektura:

- React + TypeScript + Vite PWA.
- Node.js LTS + Fastify + TypeScript.
- Zod i pnpm workspaces.
- PostgreSQL aplikacji: użytkownicy, sesje, przypisania, audyt, zgłoszenia i idempotencja.
- InvenTree jako źródło stanów, partii i lokalizacji.
- Oddzielny PostgreSQL InvenTree.
- Redis i worker InvenTree.
- Docker Compose i Caddy.

Zaimplementowano już m.in.:

- logowanie i sesje;
- role oraz izolację magazynów;
- interfejs ratownika i administracji;
- przyjęcia, przesunięcia, zużycia i korekty;
- minima, ostrzeżenia, historię, zgłoszenia i CSV;
- mechanizmy idempotencji oraz wyjaśniania niejednoznacznych wyników;
- testy i skrypty wdrożenia, backupu oraz odtwarzania.

Istnieją raporty zaliczonych testów na Ubuntu 26.04, ale nie traktuj ich jako dowodu poprawności przyszłej, zmienionej architektury ani wydajności na VPS z 4 GB RAM.

Nie potwierdzono uruchomienia produkcyjnego ani wprowadzenia rzeczywistych zapasów.

Pierwotnie InvenTree był wymaganiem obowiązkowym. Obecnie właściciel dopuszcza odejście od niego. Instrukcje repozytorium opisujące go jako obowiązkowy element należy uwzględnić jako wcześniejsze założenie, a nie ograniczenie tego researchu.

## 3. Główne pytanie badawcze

Czy dla opisanej skali i zakresu lepiej:

A. Pozostać przy InvenTree i istniejącej integracji.
B. Zastąpić InvenTree małym modułem magazynowym w obecnym backendzie Fastify.
C. Zastosować inne, prostsze gotowe rozwiązanie — tylko jeśli istnieje dobrze dopasowany kandydat.

Porównaj koszt przejścia od obecnego stanu, złożoność, ryzyko błędów, bezpieczeństwo, wymagania sprzętowe i późniejsze utrzymanie.

Twierdzenie, że wykorzystujemy „5–10% InvenTree”, jest hipotezą właściciela. Zweryfikuj faktyczny zakres używanych funkcji, zamiast powtarzać tę wartość jako ustalenie.

## 4. Wymagania funkcjonalne

### Katalog produktów

- Nazwa produktu.
- Jednoznaczna jednostka ewidencyjna.
- Aktywność/dezaktywacja.
- Reguły dopuszczalnej ilości.

Nie zakładaj automatycznych przeliczeń opakowań, ampułek, ml ani dawek. Wskaż decyzje potrzebne do ustalenia jednostek.

### Partie i zapasy

- Numer partii LOT.
- Data ważności EXP.
- Ilość w danym magazynie.
- Status dopuszczenia lub blokady.
- Wiele partii tego samego produktu.
- Ta sama partia obecna w kilku magazynach.

Sprawdź, jak definiować tożsamość partii. Nie zakładaj, że LOT jest globalnie unikalny.

### Operacje

- Przyjęcie dostawy.
- Przesunięcie między magazynami.
- Zwrot do magazynu głównego.
- Rejestracja zużycia.
- Strata, uszkodzenie lub przeterminowanie.
- Korekta po stwierdzeniu rozbieżności.

Operacje powinny zachowywać produkt, LOT i EXP oraz wskazywać autora, czas, ilość i uzasadnienie, gdy jest wymagane.

### Kontrola i raportowanie

- Stany minimalne dla produktu w konkretnym magazynie.
- Ostrzeżenia o niskich stanach i krótkim terminie ważności.
- Rekomendacja FEFO.
- Historia z filtrowaniem.
- Eksport CSV.
- Zgłoszenia problemów, które same nie zmieniają ilości.

### Obsługa telefonu

- Interfejs po polsku.
- Responsywne PWA.
- Mała liczba kroków przy rejestracji zużycia.
- Czytelny wynik operacji i obsługa utraty połączenia.
- Brak automatycznej kolejki rozchodów offline w pierwszej wersji.

## 5. Uprawnienia

### Ratownik

Może:

- przeglądać wyłącznie własny magazyn;
- rejestrować zużycie z własnego magazynu;
- przeglądać własną historię;
- zgłaszać problemy.

Nie może:

- odczytywać cudzych zapasów przez interfejs ani API;
- wykonywać operacji z cudzego magazynu;
- zmieniać przypisanego magazynu;
- samodzielnie zwiększać stanów;
- wykonywać przesunięć;
- zmieniać LOT lub EXP;
- korzystać z administracyjnego panelu systemu magazynowego.

### Magazynier / dyspozytor

Dostęp do wszystkich magazynów, dostaw, przesunięć, zwrotów, strat, korekt i raportów.

### Administrator

Zarządzanie kontami, rolami, przypisaniami, ustawieniami i procedurami wyjaśniania błędów.

Backend musi egzekwować uprawnienia niezależnie od danych przesłanych przez frontend.

## 6. Poprawność ewidencji — wymaganie krytyczne

Przeanalizuj zabezpieczenia przed:

- podwójnym kliknięciem;
- powtórzeniem żądania po utracie odpowiedzi;
- równoczesnymi rozchodami;
- zużyciem ponad dostępny stan;
- częściowym wykonaniem przesunięcia;
- awarią procesu podczas operacji;
- niespójnością między stanem a historią;
- zmianą uprawnień w trakcie żądania.

Dla wariantu własnego systemu oceń:

- jeden PostgreSQL jako źródło prawdy;
- rejestr ruchów i sposób utrzymywania bieżących sald;
- granice transakcji;
- blokady i ich kolejność;
- ograniczenia bazodanowe;
- dokładność ilości;
- trwałe klucze idempotencji;
- wynik nieznany po utracie połączenia podczas COMMIT;
- korekty i odwracanie operacji bez kasowania historii;
- uzgadnianie rejestru ruchów z saldami.

Nie sprowadzaj systemu do formularza pozwalającego dowolnie edytować aktualną ilość.

Nie zakładaj, że potrzebny jest pełny event sourcing, mikroserwisy lub globalna blokada wszystkich magazynów. Uzasadnij najprostszy wystarczający model.

Nie deklaruj exactly-once ani innych gwarancji bez precyzyjnego określenia ich zakresu i warunków.

## 7. Bezpieczeństwo i dane

Wymagane są:

- indywidualne konta;
- bezpieczne hasła i sesje;
- ochrona przed CSRF i zgadywaniem haseł;
- unieważnianie sesji po odebraniu dostępu;
- bezpieczny reset hasła;
- audyt istotnych działań;
- HTTPS;
- sekrety poza kodem i publicznymi logami;
- brak publicznego dostępu do PostgreSQL;
- brak prywatnych danych API w cache PWA.

System nie powinien przechowywać danych pacjentów ani dokumentacji medycznej. Opcjonalny identyfikator wizyty wymaga osobnego rozstrzygnięcia.

Nie deklaruj zgodności prawnej wyłącznie na podstawie zastosowanych technologii. Oddziel wymagania techniczne od kwestii wymagających konsultacji prawnej lub organizacyjnej. Dla twierdzeń prawnych podaj aktualne źródła i jurysdykcję.

## 8. Zakres wyłączony z pierwszej wersji

Nie potrzebujemy obecnie:

- integracji z Booksy;
- dokumentacji pacjentów;
- płatności i fiskalizacji;
- rekomendacji medycznych lub dawkowania;
- produkcji, BOM i montażu;
- rozbudowanej sprzedaży i zakupów;
- platformy wielofirmowej SaaS;
- natywnych aplikacji mobilnych;
- skomplikowanej synchronizacji offline.

Nie rozszerzaj MVP o te funkcje bez wykazania konieczności.

## 9. Infrastruktura i koszty

Docelowo OVH VPS, Ubuntu 26.04 LTS amd64, region UE.

Rozważane warianty według oferty przedstawionej przez właściciela:

- VPS-1: 2 vCPU, 4 GB RAM, 40 GB NVMe.
- VPS-2: 4 vCPU, 8 GB RAM, 75 GB NVMe.

Przeanalizuj:

- typowe działanie oraz chwilowe obciążenia;
- budowanie obrazów i aktualizacje;
- backup i odtwarzanie;
- zajętość obrazów, cache, logów i kopii;
- możliwość budowania aplikacji w CI;
- potrzebę Redis i workera;
- koszt osobnego środowiska testowego.

Nie traktuj sumy limitów pamięci kontenerów jako zmierzonego zużycia RAM.

Jeżeli brakuje pomiarów, podaj estymację z jawnymi założeniami oraz plan testu zasobów. Nie twierdź, że VPS-1 na pewno wystarczy.

Oddziel koszt serwera od kosztu prac programistycznych, aktualizacji, obsługi awarii i utrzymania własnego kodu.

## 10. Backup i eksploatacja

Wymagane:

- spójny backup danych i konfiguracji;
- szyfrowana kopia poza VPS;
- uzgodniona retencja;
- monitoring nieudanych kopii i dostępności;
- odtworzenie na niezależnym środowisku;
- udokumentowana aktualizacja i wycofanie zmian.

Wstępne cele RPO i RTO: po 4 godziny — do zweryfikowania i potwierdzenia pomiarami.

Backup maszyny oferowany przez dostawcę nie powinien być jedynym mechanizmem odzyskiwania.

## 11. Pytania, na które masz odpowiedzieć

1. Które wymagania są niezbędne, które opcjonalne, a które można odłożyć?
2. Jakie funkcje InvenTree faktycznie wykorzystuje obecny kod?
3. Co zyskujemy i tracimy po usunięciu InvenTree?
4. Czy jedna baza uprości poprawność operacji w porównaniu z obecną integracją HTTP?
5. Jakie nowe obowiązki i ryzyka przejmujemy, tworząc własny moduł magazynowy?
6. Czy istnieje prostsze gotowe rozwiązanie rzeczywiście pasujące do tych wymagań?
7. Które części obecnego projektu można zachować, dostosować lub trzeba zastąpić?
8. Jak powinien wyglądać minimalny model danych i protokół operacji?
9. Jakich testów potrzebujemy przed użyciem rzeczywistych zapasów?
10. Jaki VPS jest uzasadniony dla każdego wariantu i jakie pomiary są potrzebne?
11. Jak przejść na nową architekturę bez utraty historii lub zapasów, jeśli pojawiłyby się już dane?
12. Jakie decyzje właściciela blokują finalny zakres?

## 12. Oczekiwany raport

Dostarcz:

1. Krótką rekomendację z uzasadnieniem i poziomem pewności.
2. Tabelę wymagań: konieczne / opcjonalne / poza MVP.
3. Macierz porównania wariantów A, B i ewentualnie C.
4. Proponowaną architekturę, najlepiej z prostym diagramem.
5. Minimalny model danych i zasady spójności.
6. Ocenę wykorzystania istniejącego kodu, ze wskazaniem plików lub modułów.
7. Najważniejsze ryzyka oraz sposoby ich ograniczenia.
8. Plan prototypu technicznego i testów rozstrzygających.
9. Etapy wdrożenia i kryteria odbioru.
10. Ocenę kosztów i utrzymania, z jawnymi założeniami.
11. Listę pytań do właściciela.
12. Źródła z linkami i datą sprawdzenia.

Używaj przede wszystkim oficjalnej dokumentacji, kodu źródłowego i dokumentacji PostgreSQL. Wyraźnie oddziel:

- fakty potwierdzone w repozytorium;
- informacje ze źródeł zewnętrznych;
- estymacje;
- własne rekomendacje;
- kwestie wymagające testu.

Jeżeli nie masz dostępu do repozytorium, powiedz to wprost i wskaż, których wniosków nie możesz zweryfikować.

Nie uznawaj dotychczas poniesionych kosztów za wystarczający powód pozostania przy obecnej architekturze. Jednocześnie uwzględnij realny koszt zastąpienia działających elementów i ponownego udowodnienia ich poprawności.

Zaproponuj rozwiązanie proporcjonalne do skali firmy, bez nadmiernej rozbudowy.

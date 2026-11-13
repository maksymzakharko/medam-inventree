# Instrukcja użytkownika — MEDAM 0.1

## Ratownik

Administrator zakłada indywidualne konto i przypisuje osobisty MAG-01…MAG-10.
Pierwsze hasło ustawiasz jednorazowym tokenem otrzymanym po sprawdzeniu tożsamości.
Nie ma wspólnego domyślnego hasła.

1. Otwórz wskazaną domenę i zaloguj się. Sprawdź kod własnego magazynu.
2. Wyszukaj preparat i sprawdź jednostkę, LOT, EXP oraz dostępność. FEFO zaleca
   najwcześniejszą dopuszczoną datę ważności. Minimum dotyczy sumy używalnych partii.
3. Wybierz zużycie przy właściwej partii, podaj rzeczywistą dodatnią ilość
   w pokazanych jednostkach i sprawdź podsumowanie.
4. Potwierdź raz i poczekaj na wynik. Kliknięcie ani utrata połączenia nie dowodzą
   zaksięgowania. Sprawdź potwierdzony wynik i historię.
5. Uszkodzenie, przeterminowanie lub rozbieżność zgłoś w „Zgłoszeniach”. Zgłoszenie
   nie zmienia ilości. Nie wpisuj danych pacjenta, PESEL ani dokumentacji wizyty.

**Wynik wymaga sprawdzenia:** nie ponawiaj z nowym identyfikatorem. Zachowaj UUID,
sprawdź status po powrocie sieci i skontaktuj się z administratorem. Rozchód mógł
zostać wykonany mimo utraty odpowiedzi. Karta pamięta jedynie niejawny UUID.

Bez internetu nie zapiszesz zużycia. Przeterminowana, uszkodzona, zarezerwowana
lub niekompletna partia jest blokowana do użycia. Nie obchodź blokady korektą.
Po pracy wyloguj się. Reset hasła i zmiana dostępu unieważniają poprzednie sesje.

## Instalacja PWA

Android/Chrome: otwórz domenę HTTPS i „Zainstaluj aplikację”/„Dodaj do ekranu głównego”.
iPhone/Safari: udostępnij stronę → „Do ekranu początkowego”. Instalacja nie daje
rozchodów offline. Test na rzeczywistych telefonach należy do pilotażu; emulacja
przeglądarki go nie zastępuje.

## Magazynier

Wybierz magazyn. Przyjęcie wymaga istniejącego produktu, lokalizacji, ilości,
LOT i EXP. Nie zgaduj partii ani ważności. Katalog produktów przygotowuje uprawniony
administrator w InvenTree w kontrolowanym maintenance zgodnie z rozdziałem 09.

Przesunięcie wymaga pozycji źródłowej, innego magazynu docelowego i ilości.
Częściowe przesunięcie może utworzyć nowy StockItem; LOT i EXP mają pozostać zgodne.
Sprawdź wynik. Straty rozliczaj administracyjnym zmniejszeniem z przyczyną, osobno
od zużycia medycznego. Pozwala to rozliczyć uszkodzoną/przeterminowaną partię.
Zwiększenia wymagają powodu i nie służą obchodzeniu blokad.

Minimum i krok ustawiaj zgodnie z zatwierdzoną jednostką. CSV przechowuj tylko
w zatwierdzonym miejscu. Transfer widnieje w zakresie źródła i celu.

## Administrator

Konta są indywidualne. Aktywny ratownik ma jeden wolny magazyn osobisty; MAG-00
ani MAG-11 nie są osobistymi magazynami ratownika. Dezaktywacja zwalnia przypisanie
i sesje. Reaktywacja wymaga jawnego wolnego magazynu. Ostatni aktywny administrator
z hasłem jest chroniony przed odebraniem dostępu.

Reset w UI rejestruje prośbę, nie wysyła automatycznie e-maila. Wydaj token przez CLI
z rozdziału 09 i przekaż go bezpiecznym kanałem po sprawdzeniu tożsamości. Token
jest jednorazowy, ważny 15 minut; nie umieszczaj go w Git ani publicznym zgłoszeniu.

Uzgodnienie wymaga audytu InvenTree: UUID/cid, pozycji, aktora i faktycznej ilości.
Brak wpisu nie dowodzi niewykonania. Pełny/częściowy efekt wymaga dowodów. Konflikt,
nadmiarowy efekt lub orzeczenie braku efektu wymagają maintenance i CLI z uzasadnieniem.
Narzędzia nie ponawiają automatycznie reszty ani nie wykonują kompensacji.

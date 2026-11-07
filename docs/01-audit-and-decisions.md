# Etap 1 — audyt i decyzje

Stan na 7 listopada 2026, Europe/Warsaw. Zakres: audyt źródeł i repozytorium,
architektura, kontrakty, struktura projektu i plan wdrożenia do akceptacji.

## Ustalenia

| Obszar | Wynik i granica weryfikacji |
| --- | --- |
| Repozytorium | `maksymzakharko/medam-inventree`, publiczne, bez commitów/plików przy rozpoczęciu; brak istniejącej aplikacji do audytu |
| VPS | Właściciel jeszcze go nie kupił; nie było hosta do audytu SSH |
| Środowisko Codex | Robocze środowisko chmurowe, nie VPS OVH; Node 24.22.1 i pnpm 11.25.0; brak dostępnego agenta SSH i skonfigurowanych sekretów VPS |
| InvenTree | Oficjalne wydanie stabilne 1.7.0 z 2026-11-03; kod i snapshot OpenAPI v570 przeanalizowane; nie uruchomiono instancji |
| Ograniczenie remove | Przycinanie żądanej ilości do stanu; 201 nie jest dowodem pełnej realizacji |
| Ograniczenie filtrów | `cascade=true` i nieistniejąca lokalizacja mogą pozostawić listę bez filtrowania |
| Atomowość | Brak potwierdzonego natywnego klucza idempotencji i warunkowej mutacji względem location/status/EXP |
| Historia | W 1.7.0 `/api/audit/`; korelacja UUID i faktycznej delty wymaga testu uruchomionej instancji |
| Produkcja | Bez zmian; zgoda właściciela jest wymagana przed wdrożeniem produkcyjnym |

Źródła i dowody: [audyt API](03-inventree-api.md), [raport sprawdzeń](08-verification-report.md).

## Zakup VPS

Sprawdzona [oferta OVH](https://www.ovhcloud.com/pl/vps/):

| Plan | Zasoby | Zastosowanie w tym projekcie |
| --- | --- | --- |
| VPS-1 | 2 vCPU, 4 GB RAM, 40 GB NVMe | Pilotaż i mały ruch, pod warunkiem kontroli RAM/dysku i budowania obrazów poza serwerem |
| VPS-2 | 4 vCPU, 8 GB RAM, 75 GB NVMe | Rekomendacja do codziennej pracy 10 osób; zapas dla workera, baz, aktualizacji i backupu |

Wybierz Ubuntu Server 24.04 LTS, centrum danych w Polsce lub UE, bez Pleska/cPanelu.
Nie zakupiono żadnej usługi. To oszacowanie zasobów, nie wynik testu wydajności.
Istotny jest cały stos, nie liczba 20–30 produktów. CI buduje obrazy; VPS je pobiera.
Monitoring w MVP będzie lekki, z zewnętrznym sprawdzaniem dostępności. Próba restore
odbywa się na osobnym, tymczasowym VPS, bez rywalizacji z produkcją o RAM i dysk.
Backup dostawcy nie zastępuje spójnej, szyfrowanej kopii baz i mediów poza VPS.

## Decyzje przed implementacją i pilotażem

| Decyzja | Rekomendacja | Kiedy potrzebna |
| --- | --- | --- |
| Docelowy serwer | VPS-2; VPS-1 dopuszczalny do pilotażu | Przed zakupem/instalacją |
| Domena i DNS | Oddzielna subdomena aplikacji, Caddy HTTPS; domena do wskazania | Przed HTTPS i testami PWA |
| Architektura | Monorepo Fastify/React/Drizzle; dwie bazy i odrębne role PG; tylko InvenTree przechowuje stan | Przed etapem implementacji |
| Autorzy zmian stock | Wszystkie rutynowe zapisy przez Fastify; InvenTree UI wyłącznie administracyjne maintenance | Krytyczne przed pilotażem |
| Niejednoznaczna operacja | Globalny trwały gate blokuje wszystkie zapisy do uzgodnienia; właściciel wskazuje dyżurnego operatora | Krytyczne przed pilotażem |
| Dostęp admina | Prywatny kanał SSH/VPN, opcjonalnie Access z weryfikacją JWT; bez publicznego panelu dla ratowników | Przed instalacją |
| Hasła/reset | Lokalne sesje i Argon2id; wybrać firmowe SMTP lub nadzorowany jednorazowy reset | Przed kontami pracowników |
| Sesja | 30 min bezczynności, maks. 12 h; reautoryzacja administratora dla wrażliwych zmian | Przed pilotażem |
| Jednostki/partie | Całe jednostki bazowe, obowiązkowe LOT i EXP, status OK, brak rezerwacji; inne przypadki dopiero po walidacji polityki | Przed importem produktów |
| EXP | Propozycja: ważny do końca daty EXP w Europe/Warsaw; blokować datę wcześniejszą, brak EXP i nieznany status | Wymaga potwierdzenia właściciela przed pilotażem |
| Progi i ostrzeżenia | Minimum per magazyn×produkt; ostrzeżenie EXP 30 dni, pilne 7 dni; progi do zatwierdzenia | Przed pilotażem |
| Identyfikator wizyty | Domyślnie wyłączony; później tylko zatwierdzony pseudonimowy format, bez pacjenta | Przed włączeniem tej funkcji |
| Backup i retencja | Szyfrowany restic offsite; proponowane RPO/RTO 4 h; retencja w rozdziale 06 | Przed produkcją; cele wymagają pomiaru |
| Odpowiedzialność operacyjna | Osoba do alertów, uzgadniania i przywrócenia; kanał powiadomień i godziny reakcji | Przed pilotażem |
| Dane i produkcja | Najpierw dwaj ratownicy i dane testowe; rzeczywisty import i start po osobnej zgodzie | Po zaliczonych testach i restore |

Zatwierdzenie projektu nie jest zgodą na usuwanie istniejących danych ani uruchomienie
produkcji. Każda bramka w [planie realizacji](07-delivery-and-tests.md) ma konkretny
wynik do przeglądu. Dostępy będą potrzebne po zakupie serwera: host, port, użytkownik,
klucz przez bezpieczną konfigurację, znany fingerprint hosta, domena/DNS i konto offsite.
Nie należy wklejać kluczy ani haseł do rozmowy.

## Główne ryzyka i sposób ograniczenia

1. **Częściowy rozchód z kodem 201:** dowód `deltas.removed` w audycie, kontrola jednej pozycji na operację, brak automatycznej kompensacji.
2. **Wyścig z ręcznym InvenTree:** wyłączny kanał zapisów Fastify i kontrolowane maintenance; inaczej nie można zagwarantować atomowej kontroli lokalizacji.
3. **Utrata odpowiedzi/crash:** trwała intencja i gate, jedna próba wysyłki, `UNCERTAIN`, uzgodnienie zamiast ponawiania.
4. **Wyciek magazynu:** `cascade=false`, walidacja każdego wyniku, ścisłe DTO, testy 10×12 i testy cudzych identyfikatorów.
5. **Awaria jednego VPS:** backup offsite i sprawdzony restore; ta architektura nie zapewnia HA.
6. **Za mało pamięci/dysku VPS-1:** pilotaż z pomiarami, limity logów, obrazy z CI, możliwość przejścia na VPS-2.
7. **Retencja usuwa dowody:** osobna polityka audit/idempotency; tombstone nie pozwala uznać starej operacji za nową.
8. **Warunki prawne:** system ewidencji nie jest dokumentacją medyczną i sam nie dowodzi zgodności obrotu lekami. Właściciel zatwierdza politykę danych, LOT/EXP i retencję.

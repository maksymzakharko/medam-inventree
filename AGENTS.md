# Zasady pracy nad MEDAM

## Obowiązujące wymagania właściciela

- Najpierw audyt i plan; czekaj na zgodę przed zmianami produkcyjnymi.
- Nie kasuj danych, kontenerów ani wolumenów bez wyraźnej zgody.
- Nie osłabiaj SSH ani firewalla. Nie ujawniaj sekretów w Git, logach ani rozmowie.
- InvenTree jest jedynym źródłem prawdy o zapasach. Nie zapisuj własnych edytowalnych stanów.
- Własny backend: Node.js LTS + Fastify + TypeScript. Frontend: React + TypeScript + Vite PWA.
- pnpm workspaces, Zod wspólny dla kontraktów, Vitest i rzeczywiste testy integracyjne/E2E.
- Interfejs po polsku. Bez danych pacjentów i bez integracji Booksy w MVP.

## Reguły implementacji

- Autoryzuj każde żądanie na backendzie. Dla ratownika magazyn wynika z aktualnej sesji i przypisania w bazie.
- Nie przepuszczaj parametrów filtrowania InvenTree bez białej listy. `cascade=false` i kontrola lokalizacji każdego wyniku są obowiązkowe.
- Przed zmianą StockItem pobierz jego aktualny stan, sprawdź lokalizację, status, LOT/EXP i ilość.
- Nie traktuj 2xx z InvenTree jako dowodu pełnej realizacji rozchodu.
- Nie ponawiaj automatycznie zapisów do InvenTree. Niejednoznaczny wynik blokuje dalsze mutacje do uzgodnienia.
- Sesje HttpOnly/Secure, CSRF, Argon2id, odwoływanie sesji. Żadnych tokenów administracyjnych w przeglądarce.
- Zmiany audytu, operacji i trwałej blokady zatwierdzaj razem w transakcji aplikacji. Nie obejmuje ona InvenTree.
- Waliduj odpowiedzi InvenTree Zod; timeouty, paginacja, ograniczony retry tylko bezpiecznych odczytów.
- PWA nie kolejkuje rozchodów offline i nie cache'uje `/api/*` ani prywatnych danych.
- Nie deklaruj zaliczonych testów, odtworzenia backupu ani zgodności prawnej bez dowodów.

## Przed wdrożeniem

Sprawdź faktyczną wersję InvenTree, schema API i testy zgodności na staging.
Przypinaj obrazy wersją i digestem; nie wdrażaj ruchomego `stable`.
Wykonaj preflight, kopię konfiguracji, plan wycofania i test restore na oddzielnym środowisku.
Zachowaj oddzielne role/bazy PostgreSQL i brak publicznych portów PostgreSQL/Redis/InvenTree.

# React PWA — plan implementacji

Ekrany: logowanie, mój magazyn, rejestracja zużycia, moja historia, zgłoszenie problemu.
Magazynier/admin otrzyma osobne widoki przyjęć, przesunięć i uzgadniania operacji.

Jedna domena dla aplikacji i `/api`. Cookies HttpOnly; żadnego tokena InvenTree.
Status braku sieci i brak możliwości wykonania rozchodu offline.
Service worker przechowuje wyłącznie statyczne zasoby; `/api/*` zawsze network-only.
Po utracie odpowiedzi aplikacja sprawdza identyfikator operacji; nie generuje nowego
klucza dla tego samego zgłoszenia. Sukces dopiero po zweryfikowaniu wykonania.

Manifest PWA, ikony, Vite i komponenty powstaną po akceptacji planu.

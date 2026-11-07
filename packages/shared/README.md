# Wspólne kontrakty

W `src/schemas` powstaną ścisłe schematy Zod żądań i odpowiedzi opisanych w
`docs/05-api-contract.md`, a typy będą inferowane ze schematów.
Walidacja frontendu pomaga użytkownikowi; backend zawsze ponownie waliduje.
Nieznane pola są odrzucane, nie ignorowane. Ilości są dodatnimi ciągami dziesiętnymi,
nie liczbami zmiennoprzecinkowymi JavaScript. Wspólne pakiety nie importują sekretów
ani klienta InvenTree.

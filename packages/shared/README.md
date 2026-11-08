# Wspólne kontrakty

`src/index.ts` eksportuje ścisłe schematy Zod wejść, role/typy DTO, ilości i daty.
UUID normalizowane do małych liter zapewniają tę samą korelację w PostgreSQL,
InvenTree i UI. Ilości są stringami dziesiętnymi; kod nie liczy stock przez float.
Backend waliduje niezależnie od formularza, a zewnętrzne odpowiedzi dodatkowo
waliduje klient InvenTree. Ten pakiet nie importuje sekretów ani serwerowego klienta.

`pnpm --filter @medam/shared build` generuje dist JS/deklaracje przed API/web.

import { expect, test, type Page } from '@playwright/test';
import { TEST_PASSWORD } from '../fixtures/app-fixture.js';
import { navigate } from './navigation.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill('ratownik01');
  await page.getByLabel('Hasło', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mój magazyn', exact: true })).toBeVisible();
  await expect(page.getByText('TEST-LOT-01', { exact: true })).toBeVisible();
}

async function confirmConsumption(page: Page) {
  await page.getByRole('button', { name: /Zarejestruj zużycie Witamina C TEST/ }).click();
  await page.getByLabel('Ilość zużyta', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Dalej', exact: true }).click();
  await page.getByRole('button', { name: 'Potwierdź zużycie', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__test/reset');
  expect(response.ok()).toBe(true);
});

test('medic logs in, consumes its own lot, reads history, reports a problem and logs out', async ({ page }, testInfo) => {
  await login(page);
  await expect(page.getByText('TEST-LOT-02', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('inventory.png'), fullPage: true });
  await page.getByRole('button', { name: /Zarejestruj zużycie Witamina C TEST/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('inventory-viewport.png') });
  await confirmConsumption(page);
  const result = page.getByRole('dialog');
  await expect(result.getByRole('heading', { name: 'Operacja została potwierdzona' })).toBeVisible();
  await result.getByRole('button', { name: 'Zamknij', exact: true }).click();
  await navigate(page, 'history');
  await expect(page.getByRole('heading', { name: 'Historia operacji', exact: true })).toBeVisible();
  await expect(page.getByText('Potwierdzono', { exact: true }).first()).toBeVisible();
  await navigate(page, 'reports');
  await page.getByRole('button', { name: /Nowe zgłoszenie|Zgłoś problem/ }).first().click();
  await page.getByLabel('Opis problemu', { exact: true }).fill('Uszkodzone opakowanie — zgłoszenie testowe bez danych pacjenta.');
  await page.getByRole('button', { name: 'Wyślij zgłoszenie', exact: true }).click();
  await expect(page.getByText('Uszkodzone opakowanie — zgłoszenie testowe bez danych pacjenta.')).toBeVisible();
  await page.getByRole('button', { name: 'Moje konto', exact: true }).click();
  await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Zaloguj się do magazynu' })).toBeVisible();
});

test('blocks offline consumption and recovers an ambiguous saved operation without a duplicate', async ({ page, context, request }) => {
  await login(page);
  await context.setOffline(true);
  await expect(page.getByText('Brak połączenia z internetem. Zapisy magazynowe są niedostępne. Po powrocie sieci odśwież dane.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Zarejestruj zużycie Witamina C TEST/ })).toBeDisabled();
  await context.setOffline(false);
  await request.post('/__test/behaviour', { data: { behaviour: 'timeout-after-apply' } });
  await confirmConsumption(page);
  await expect(page.getByRole('heading', { name: 'Wynik wymaga sprawdzenia' })).toBeVisible();
  const id = await page.evaluate(() => sessionStorage.getItem('medam.pending-operation'));
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByText('Poprzednia operacja wymaga sprawdzenia.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wynik wymaga sprawdzenia' })).toBeVisible();
  expect((await (await request.get('/__test/stats')).json()).mutationCount).toBe(1);
});

test('caches the static PWA shell without private API data and cannot restore inventory offline', async ({ page, context, request }) => {
  await login(page);
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await manifestResponse.json() as { icons: Array<{ src: string; type: string; sizes: string }> };
  expect(manifest.icons.filter(icon => icon.type === 'image/png').map(icon => icon.sizes).sort()).toEqual(['192x192', '512x512']);
  const icons = [...manifest.icons, { src: await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'), type: 'image/png', sizes: '180x180' }];
  for (const icon of icons) {
    expect(icon.src).toBeTruthy();
    const response = await request.get(icon.src!);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain(icon.type);
    const dimensions = await page.evaluate(async src => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, icon.src!);
    if (icon.sizes !== 'any') expect(dimensions).toBe(icon.sizes);
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByText('TEST-LOT-01', { exact: true })).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect.poll(async () => page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = (await Promise.all(keys.map(async key => (await caches.open(key)).keys()))).flat();
    return requests.some(request => new URL(request.url).pathname.startsWith('/assets/'));
  })).toBe(true);
  const cachedPaths = await page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = (await Promise.all(keys.map(async key => (await caches.open(key)).keys()))).flat();
    return requests.map(request => new URL(request.url).pathname);
  });
  expect(cachedPaths).toContain('/');
  expect(cachedPaths.every(path => path === '/' || path === '/manifest.webmanifest' || path.startsWith('/assets/') || path.startsWith('/icons/'))).toBe(true);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Zaloguj się do magazynu', exact: true })).toBeVisible();
  await expect(page.getByText('Brak internetu. Logowanie wymaga połączenia z serwerem.', { exact: true })).toBeVisible();
  await expect(page.getByText('TEST-LOT-01', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zaloguj się', exact: true })).toBeDisabled();
});

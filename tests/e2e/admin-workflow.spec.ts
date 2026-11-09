import { expect, test, type Page } from '@playwright/test';
import { TEST_PASSWORD } from '../fixtures/app-fixture.js';
import { navigate } from './navigation.js';

async function closeVerifiedResult(page: Page, quantity: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Operacja została potwierdzona', exact: true })).toBeVisible();
  await expect(dialog.locator('.result-quantity strong')).toHaveText(quantity);
  await dialog.getByRole('button', { name: 'Zamknij', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBe(true);
});

test('administrator receives a lot, transfers stock, records a loss and exports the selected warehouse', async ({ page, request }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill('administrator');
  await page.getByLabel('Hasło', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Magazyny', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Minima i jednostki', exact: true }).click();
  const policy = page.getByRole('dialog');
  await policy.getByLabel('Magazyn ustawień', { exact: true }).selectOption('100');
  await policy.getByLabel('Preparat ustawień', { exact: true }).selectOption('1');
  await expect(policy.getByLabel('Minimum', { exact: true })).toHaveValue('5');
  await expect(policy.getByLabel('Krok ilości', { exact: true })).toHaveValue('1');
  await policy.getByLabel('Minimum', { exact: true }).fill('120.5');
  await policy.getByLabel('Krok ilości', { exact: true }).fill('0');
  await policy.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).click();
  await expect(policy.getByRole('alert')).toContainText('krok ilości dodatni');
  await policy.getByLabel('Krok ilości', { exact: true }).fill('0.5');
  await policy.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).click();
  await expect(policy.getByText('Ustawienia zostały zapisane.', { exact: true })).toBeVisible();
  await policy.getByLabel('Magazyn ustawień', { exact: true }).selectOption('101');
  await expect(policy.getByLabel('Minimum', { exact: true })).toHaveValue('5');
  await expect(policy.getByLabel('Krok ilości', { exact: true })).toHaveValue('1');
  await policy.getByLabel('Magazyn ustawień', { exact: true }).selectOption('100');
  await expect(policy.getByLabel('Minimum', { exact: true })).toHaveValue('120.5');
  await expect(policy.getByLabel('Krok ilości', { exact: true })).toHaveValue('0.5');
  await page.screenshot({ path: testInfo.outputPath('administrator-policy.png'), fullPage: true });
  await policy.getByRole('button', { name: 'Zamknij', exact: true }).click();
  const configuredStock = page.locator('.stock-row').filter({ hasText: 'TEST-LOT-00' });
  await expect(configuredStock.getByText('Minimum: 120,5 piece', { exact: true })).toBeVisible();
  await expect(configuredStock.getByText('Niski stan', { exact: true })).toBeVisible();
  await navigate(page, 'movements');
  await page.getByLabel('Magazyn przyjmujący', { exact: true }).selectOption('101');
  await page.getByLabel('Preparat', { exact: true }).selectOption('1');
  await page.getByLabel('Numer LOT', { exact: true }).fill('ADMIN-LOT-TEST');
  await page.getByLabel('Data EXP', { exact: true }).fill('2099-12-31');
  await page.getByLabel('Ilość', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Zapisz przyjęcie', exact: true }).click();
  await closeVerifiedResult(page, '7');

  await page.getByRole('button', { name: 'Przesunięcie', exact: true }).click();
  await page.getByLabel('Magazyn źródłowy', { exact: true }).selectOption('100');
  await page.getByLabel('Partia źródłowa', { exact: true }).selectOption('1000');
  await page.getByLabel('Magazyn docelowy', { exact: true }).selectOption('101');
  await page.getByLabel('Ilość', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Zapisz przesunięcie', exact: true }).click();
  await closeVerifiedResult(page, '5');

  await page.getByRole('button', { name: 'Korekta', exact: true }).click();
  await page.getByLabel('Magazyn źródłowy', { exact: true }).selectOption('100');
  await page.getByLabel('Partia źródłowa', { exact: true }).selectOption('1000');
  await page.getByLabel('Ilość', { exact: true }).fill('2');
  await page.getByLabel('Powód korekty', { exact: true }).fill('Uszkodzone opakowanie — kontrolowany test ewidencji straty.');
  await page.getByRole('button', { name: 'Zapisz korektę', exact: true }).click();
  await closeVerifiedResult(page, '2');
  expect((await (await request.get('/__test/stats')).json()).mutationCount).toBe(3);

  await navigate(page, 'stock');
  await page.getByRole('combobox', { name: 'Wybierz magazyn', exact: true }).selectOption('100');
  const source = page.locator('.stock-row').filter({ hasText: 'TEST-LOT-00' });
  await expect(source.locator('.stock-quantity strong')).toHaveText('93 piece');
  await page.getByRole('combobox', { name: 'Wybierz magazyn', exact: true }).selectOption('101');
  await expect(page.getByText('ADMIN-LOT-TEST', { exact: true })).toBeVisible();
  await expect(page.getByText('TEST-LOT-00', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('administrator-inventory.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Eksportuj wybrany magazyn', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('medam-magazyn-MAG-01.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('ADMIN-LOT-TEST');
  expect(csv).toContain('TEST-LOT-00');
  expect(csv).not.toContain('TEST-LOT-02');

  await navigate(page, 'users');
  await expect(page.getByRole('heading', { name: 'Zespół i uprawnienia', exact: true })).toBeVisible();
  const medic = page.locator('.user-row').filter({ has: page.getByRole('heading', { name: 'ratownik01', exact: true }) });
  await medic.getByRole('button', { name: 'Zarządzaj', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Konto aktywne' }).uncheck();
  await page.getByRole('button', { name: 'Zapisz zmiany', exact: true }).click();
  await expect(medic.getByText('Nieaktywne', { exact: true })).toBeVisible();
});

test('warehouse manager configures minimum and quantum while medic has no policy controls', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Login', { exact: true }).fill('magazynier');
  await page.getByLabel('Hasło', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await page.getByRole('button', { name: 'Minima i jednostki', exact: true }).click();
  const policy = page.getByRole('dialog');
  await policy.getByLabel('Magazyn ustawień', { exact: true }).selectOption('101');
  await policy.getByLabel('Preparat ustawień', { exact: true }).selectOption('1');
  await expect(policy.getByLabel('Minimum', { exact: true })).toHaveValue('5');
  await policy.getByLabel('Minimum', { exact: true }).fill('0');
  await policy.getByLabel('Krok ilości', { exact: true }).fill('0.25');
  await policy.getByRole('button', { name: 'Zapisz ustawienia', exact: true }).click();
  await expect(policy.getByText('Ustawienia zostały zapisane.', { exact: true })).toBeVisible();
  await policy.getByRole('button', { name: 'Zamknij', exact: true }).click();
  await page.getByRole('button', { name: 'Minima i jednostki', exact: true }).click();
  await policy.getByLabel('Magazyn ustawień', { exact: true }).selectOption('101');
  await policy.getByLabel('Preparat ustawień', { exact: true }).selectOption('1');
  await expect(policy.getByLabel('Minimum', { exact: true })).toHaveValue('0');
  await expect(policy.getByLabel('Krok ilości', { exact: true })).toHaveValue('0.25');
  await policy.getByRole('button', { name: 'Zamknij', exact: true }).click();
  await page.getByRole('button', { name: 'Moje konto', exact: true }).click();
  await page.getByRole('button', { name: 'Wyloguj się', exact: true }).click();
  await page.getByLabel('Login', { exact: true }).fill('ratownik01');
  await page.getByLabel('Hasło', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mój magazyn', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minima i jednostki', exact: true })).toHaveCount(0);
});

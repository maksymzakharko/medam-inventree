import { expect, type Page } from '@playwright/test';

/** The mobile sidebar is translated offscreen, so CSS :visible alone is insufficient. */
export async function navigate(page: Page, view: string) {
  const menu = page.getByRole('button', { name: 'Otwórz menu', exact: true });
  const mobile = await menu.isVisible();
  if (mobile) await menu.click();
  const sidebar = page.getByRole('complementary', { name: 'Menu główne', exact: true });
  await sidebar.getByRole('navigation').locator(`a[href="#${view}"]`).click();
  if (mobile) await expect(sidebar).not.toBeInViewport();
}

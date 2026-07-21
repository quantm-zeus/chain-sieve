import { expect, test } from '@playwright/test';
test('renders bootstrap capability disclaimer', async ({ page }) => { await page.goto('/'); await expect(page.getByText('NO LIVE CAPABILITIES')).toBeVisible(); await expect(page.getByText('Truth before intelligence.')).toBeVisible(); });

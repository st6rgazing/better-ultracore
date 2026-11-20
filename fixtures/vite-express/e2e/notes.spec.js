import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__test/fail', { data: { on: false } });
});

test('saving a note reaches the backend and shows Saved', async ({ page, request }) => {
  const ids = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/notes')) ids.push(r.headers()['x-request-id']); });
  await page.goto('/');
  await page.getByLabel('Note').fill('first note');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  expect(ids).toHaveLength(1);
  const log = await (await request.get('/__test/requests')).json();
  expect(log).toContain(ids[0]);
});

test('backend failure shows an error and not Saved', async ({ page, request }) => {
  await request.post('/__test/fail', { data: { on: true } });
  await page.goto('/');
  await page.getByLabel('Note').fill('doomed note');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('status')).toContainText('Error');
  await expect(page.getByRole('status')).not.toHaveText('Saved');
});

test('saved note is still listed after reload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Note').fill('persisted note');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'persisted note' })).toBeVisible();
});

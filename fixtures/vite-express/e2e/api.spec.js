import { test, expect } from '@playwright/test';

const json = { 'content-type': 'application/json' };

test('POST /api/notes rejects invalid bodies with 400', async ({ request }) => {
  for (const data of [{}, { text: '' }, { text: 42 }, { text: 'x'.repeat(201) }]) {
    const res = await request.post('/api/notes', { data, headers: { ...json, 'x-user': 'alice' } });
    expect(res.status()).toBe(400);
  }
});

test('GET /api/notes/:id is only readable by the owner', async ({ request }) => {
  const created = await request.post('/api/notes', { data: { text: 'private' }, headers: { ...json, 'x-user': 'owner' } });
  const { id } = await created.json();
  expect((await request.get(`/api/notes/${id}`, { headers: { 'x-user': 'owner' } })).status()).toBe(200);
  expect((await request.get(`/api/notes/${id}`, { headers: { 'x-user': 'intruder' } })).status()).toBe(403);
});

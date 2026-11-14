// The todo API's tests. They call a running backend: start one in the test profile's session
// (`stackctl --profile test --headless -s backend`), then run them in its environment with
// `stackctl --profile test run backend test`, which hands the script the backend's PORT.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const api = `http://localhost:${process.env.PORT}`;

function post(path: string, body: unknown) {
  return fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('lists the todos', async () => {
  const res = await fetch(`${api}/todos`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('rejects a todo without a title', async () => {
  const res = await post('/todos', { title: '   ' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'title is required' });
});

test('adds a todo, completes it and deletes it', async () => {
  const created = await post('/todos', { title: 'water the plants' });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: number };

  const updated = await fetch(`${api}/todos/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(((await updated.json()) as { completed: boolean }).completed, true);

  const deleted = await fetch(`${api}/todos/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
});

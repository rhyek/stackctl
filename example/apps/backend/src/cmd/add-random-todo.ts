import { faker } from '@faker-js/faker';

// A one-off command, surfaced in stackctl's `m` → commands menu for `api` (and runnable
// directly via `pnpm add-random-todo`). It seeds a handful of random todos by POSTing them
// to the *running* backend, so they flow through the real endpoint + validation and show up
// in the frontend. Each added title is printed so it's easy to spot — and filter — in
// stackctl's combined log view.

const API = 'http://localhost:3001/todos';
const COUNT = 5;

async function addTodo(title: string): Promise<string> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`POST ${API} -> ${res.status} ${res.statusText}`);
  }
  const todo = (await res.json()) as { title: string };
  return todo.title;
}

for (let i = 0; i < COUNT; i++) {
  const title = faker.lorem.sentence();
  try {
    console.log(`Added todo: ${await addTodo(title)}`);
  } catch (err) {
    console.error(`Failed to add todo: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

import { queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import type { Todo } from '@example/isomorphic';

// Every backend call goes through a TanStack Start server function. Server fns run on the frontend's
// Node server (never the browser), so they can reach the Express API directly — the browser never
// touches :3001, which is why the API needs no CORS. Base URL is a single env-driven constant.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

// The Todo shape is shared with the backend via @example/isomorphic; re-export it so callers
// in this app can keep importing it from here.
export type { Todo };

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `${fallback} (${res.status})`);
}

// GET — list all todos. Called from the route loader (server) to prime React Query.
export const listTodos = createServerFn({ method: 'GET' }).handler(async () => {
  const res = await fetch(`${BACKEND_URL}/todos`);
  if (!res.ok) {
    await readError(res, 'Failed to load todos');
  }
  return (await res.json()) as Todo[];
});

// POST — create a todo. Mutations use the default POST method so a failure is toasted globally
// (see src/start.ts).
export const addTodo = createServerFn({ method: 'POST' })
  .validator((title: string) => title)
  .handler(async ({ data }) => {
    const res = await fetch(`${BACKEND_URL}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: data }),
    });
    if (!res.ok) {
      await readError(res, 'Failed to add todo');
    }
    return (await res.json()) as Todo;
  });

// PATCH — toggle completion.
export const toggleTodo = createServerFn({ method: 'POST' })
  .validator((data: { id: number; completed: boolean }) => data)
  .handler(async ({ data }) => {
    const res = await fetch(`${BACKEND_URL}/todos/${data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed: data.completed }),
    });
    if (!res.ok) {
      await readError(res, 'Failed to update todo');
    }
    return (await res.json()) as Todo;
  });

// DELETE — remove a todo (backend returns 204).
export const deleteTodo = createServerFn({ method: 'POST' })
  .validator((data: { id: number }) => data)
  .handler(async ({ data }) => {
    const res = await fetch(`${BACKEND_URL}/todos/${data.id}`, { method: 'DELETE' });
    if (!res.ok) {
      await readError(res, 'Failed to delete todo');
    }
  });

// Shared query options so the loader (queryClient.query) and the component (useQuery) agree on the key.
export const todosQueryOptions = () =>
  queryOptions({
    queryKey: ['todos'] as const,
    queryFn: () => listTodos(),
  });

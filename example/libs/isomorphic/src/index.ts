// The Todo model shared by the backend (validation + response shape) and the frontend
// (types + form constraints). This is the "isomorphic" library: pure, dependency-free
// TypeScript that runs on the Node server and in the browser bundle, as source — no build.
// Edit it while stackctl is running and both apps pick it up live: the backend's `node --watch`
// restarts, and Vite hot-reloads the frontend.

/** Longest a todo title may be. Enforced by the backend, hinted by the frontend's input. */
export const TITLE_MAX_LENGTH = 200;

/** A todo as stored by the backend and rendered by the frontend. */
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  createdAt: string;
}

export type ValidateResult = { ok: true; title: string } | { ok: false; error: string };

/** Validate + normalize a new-todo request body. Shared so client and server agree on the rules. */
export function validateNewTodo(input: unknown): ValidateResult {
  const raw = (input as { title?: unknown } | null)?.title;
  const title = (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '').trim();
  if (!title) {
    return { ok: false, error: 'title is required' };
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return { ok: false, error: `title must be ${TITLE_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, title };
}

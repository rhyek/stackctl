import type { Todo } from '@example/isomorphic';
import { pool } from './pool.ts';

// The todo persistence layer, extracted from the backend into its own workspace library.
//
// @example/db is a *source-consumption* package: its package.json `exports` point straight at this
// file — there's no build, no `dist`, no emit. The backend imports `@example/db` and Node's native
// TypeScript support type-strips this source on the fly. It's wired purely by the pnpm
// `workspace:*` link, like `@example/isomorphic`, and neither is in the stackctl config: stackctl
// runs the services that import them.
//
// The database is the Postgres service in the workspace's docker-compose.yaml, which stackctl's
// `infra` brings up before the backend starts. Its schema is created by `src/migrate.ts`, run
// from the `db` service's `afterReady` callback in stackctl.config.ts — so by the time this
// module is imported, the table is there.

interface TodoRow {
  id: number;
  title: string;
  completed: boolean;
  created_at: Date;
}

/** A database row as the shared `Todo` shape (defined in @example/isomorphic). */
const toTodo = (row: TodoRow): Todo => ({
  id: row.id,
  title: row.title,
  completed: row.completed,
  createdAt: row.created_at.toISOString(),
});

/** All todos, newest first. */
export async function listTodos(): Promise<Todo[]> {
  const { rows } = await pool.query<TodoRow>('SELECT * FROM todos ORDER BY id DESC');
  return rows.map(toTodo);
}

/** A single todo by id, or `undefined` if it doesn't exist. */
export async function getTodo(id: number): Promise<Todo | undefined> {
  const { rows } = await pool.query<TodoRow>('SELECT * FROM todos WHERE id = $1', [id]);
  return rows[0] && toTodo(rows[0]);
}

/** Insert a new todo (title already validated by the caller) and return it. */
export async function insertTodo(title: string): Promise<Todo> {
  const { rows } = await pool.query<TodoRow>('INSERT INTO todos (title) VALUES ($1) RETURNING *', [
    title,
  ]);
  return toTodo(rows[0]);
}

/** Patch a todo's title and/or completed flag; returns the updated todo, or `undefined` if not found. */
export async function updateTodo(
  id: number,
  patch: { title?: string; completed?: boolean },
): Promise<Todo | undefined> {
  // COALESCE keeps the stored value for whichever field the patch leaves out.
  const { rows } = await pool.query<TodoRow>(
    `UPDATE todos
        SET title = COALESCE($2, title), completed = COALESCE($3, completed)
      WHERE id = $1
  RETURNING *`,
    [id, patch.title ?? null, patch.completed ?? null],
  );
  return rows[0] && toTodo(rows[0]);
}

/** Delete a todo by id (a no-op if it doesn't exist). */
export async function deleteTodo(id: number): Promise<void> {
  await pool.query('DELETE FROM todos WHERE id = $1', [id]);
}

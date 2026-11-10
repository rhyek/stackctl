import { type SubmitEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { TITLE_MAX_LENGTH } from '@example/isomorphic';
import { cn } from '~/lib/utils';
import { addTodo, deleteTodo, toggleTodo, todosQueryOptions } from '~/server/todos';

export const Route = createFileRoute('/')({
  // Prime React Query on the server before render so the first client paint already has the list —
  // no fetch-on-mount waterfall. The fetch happens here (loader), not in the component render.
  loader: ({ context }) =>
    context.queryClient.query({ ...todosQueryOptions(), staleTime: 'static' }),
  component: TodosPage,
});

function TodosPage() {
  const queryClient = useQueryClient();
  const { data: todos = [] } = useQuery(todosQueryOptions());
  const [title, setTitle] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: todosQueryOptions().queryKey });

  const add = useMutation({
    mutationFn: (value: string) => addTodo({ data: value }),
    onSuccess: () => {
      setTitle('');
      return invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: number; completed: boolean }) => toggleTodo({ data: vars }),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteTodo({ data: { id } }),
    onSuccess: () => invalidate(),
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (value) {
      add.mutate(value);
    }
  };

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16 sm:items-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Todos
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            A tiny list, served through TanStack Start.
          </p>
        </header>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            aria-label="New todo"
            maxLength={TITLE_MAX_LENGTH}
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-500 dark:focus:ring-slate-100/10"
          />
          <button
            type="submit"
            disabled={!title.trim() || add.isPending}
            className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Add
          </button>
        </form>

        <ul className="mt-5 space-y-1">
          {todos.length === 0 ? (
            <li className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
              No todos yet
            </li>
          ) : (
            todos.map((todo) => (
              <li
                key={todo.id}
                className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggle.mutate({ id: todo.id, completed: !todo.completed })}
                  aria-label={`Mark "${todo.title}" as ${todo.completed ? 'incomplete' : 'complete'}`}
                  className="size-4 shrink-0 cursor-pointer accent-slate-900 dark:accent-slate-100"
                />
                <span
                  className={cn(
                    'flex-1 truncate text-sm text-slate-700 dark:text-slate-200',
                    todo.completed && 'text-slate-400 line-through dark:text-slate-500',
                  )}
                >
                  {todo.title}
                </span>
                <button
                  type="button"
                  onClick={() => remove.mutate(todo.id)}
                  aria-label={`Delete "${todo.title}"`}
                  className="shrink-0 rounded-md p-1 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-700 dark:hover:text-red-400"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </main>
  );
}

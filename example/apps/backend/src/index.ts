import express from 'express';
import { listTodos, insertTodo, updateTodo, deleteTodo } from '@example/db';
import { validateNewTodo } from '@example/isomorphic';

// Injected by stackctl from this package's configured `port`.
const PORT = Number(process.env.PORT);

const app = express();
app.use(express.json());

// What stackctl waits on (the frontend's `deps` with `wait`): it starts once this returns 200.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/todos', async (_req, res) => {
  res.json(await listTodos());
});

app.post('/todos', async (req, res) => {
  // Same validation rules the frontend enforces — shared from @example/isomorphic.
  const result = validateNewTodo(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(await insertTodo(result.title));
});

app.patch('/todos/:id', async (req, res) => {
  const body = req.body as { title?: string; completed?: boolean } | undefined;
  const updated = await updateTodo(Number(req.params.id), {
    title: body?.title,
    completed: body?.completed,
  });
  if (!updated) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(updated);
});

app.delete('/todos/:id', async (req, res) => {
  await deleteTodo(Number(req.params.id));
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`todo api listening on http://localhost:${PORT}`);
});

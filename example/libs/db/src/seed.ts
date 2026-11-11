import { pool } from './pool.ts';

// Starter rows for an empty database. The `afterReady` callback runs this only when its `fresh`
// flag is set — the database's volume was created by this run — right after migrate.ts.

const titles = [
  'Read the stackctl docs',
  'Run `pnpm stackctl infra start`',
  'Add a todo of your own',
];
for (const title of titles) {
  await pool.query('INSERT INTO todos (title) VALUES ($1)', [title]);
}
console.log(`seeded ${titles.length} todos`);
await pool.end();

# Todo app

A small monorepo: an Express API, a TanStack Start frontend and a Go worker, sharing two
TypeScript libraries.

## Layout

- `apps/backend`: the HTTP API. Routes live in `src/index.ts`; anything longer than a handler
  goes in a module beside it.
- `apps/frontend`: the web app. Routes are files under `src/routes`; server functions live in
  `src/server`.
- `apps/worker`: a Go service that polls for work. One `main.go`; keep it that way until it
  outgrows the file.
- `libs/db`: the Postgres pool, the migrations and the queries. Nothing outside it writes SQL.
- `libs/isomorphic`: types and validation shared by the backend and the frontend. No Node or
  browser APIs in here.

## TypeScript

- Strict mode, no `any`. Reach for `unknown` and narrow it.
- Node runs the TypeScript as it is: no build step, no path aliases, and relative imports end
  in `.ts`.
- Prefer a plain function over a class. Export what a caller needs and nothing else.
- Validate at the edge: a request body is `unknown` until `libs/isomorphic` has checked it.
- No default exports, except where a framework requires one (route files, config files).
- Errors a user can cause get a 4xx and a JSON body `{ error: string }`. Everything else
  throws and is logged.

## Tests

- Test files are `*.spec.ts`, beside the code or under `test/`. Use `node:test` and
  `node:assert/strict`.
- Test behavior through the public surface: the HTTP API for the backend, the rendered page
  for the frontend.
- A test creates what it needs and deletes it afterwards. No test depends on another's rows.
- Don't mock the database.

## Database

- A schema change is a new statement in `libs/db/src/migrate.ts`, written so it can run twice.
- Never edit a statement that has already shipped: add one after it.
- Queries take their values as parameters. No string-built SQL.
- Timestamps are `timestamptz`, and leave the API as ISO 8601 strings.

## Frontend

- Tailwind classes in the markup; no CSS files besides the entry stylesheet.
- Data comes through server functions, never a `fetch` in a component.
- Every interactive element is reachable by keyboard and has a visible focus state.
- Dark mode follows the system setting. Check both before calling a change done.

## Go

- `gofmt` and `go vet` clean. Errors are wrapped with `%w` and returned, not logged and
  swallowed.
- Log one JSON object per line: `level`, `msg`, `context` and whatever the line needs.

## Git

- Branch from `main`, named `<area>/<what-it-does>`.
- Commit messages are imperative and say why, not what the diff already shows.
- One concern per pull request. A refactor that a feature needs goes in first, on its own.
- Never commit a `.env.local` file or anything else with a real credential in it.

## Before you call something done

- `pnpm typecheck` and `pnpm lint` pass.
- New behavior has a test, and the test fails without the change.
- The API's README section for an endpoint matches what the endpoint now does.

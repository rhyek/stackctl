import pg from 'pg';

// The connection string is assembled in the workspace's `.env.<profile>` file (from the same
// DB_* values docker-compose.yaml reads) and injected by stackctl — into the backend's process,
// into `stackctl exec`, and into the infra callbacks that run the scripts in this package.
const connectionString = process.env.DATABASE_URI;
if (!connectionString) {
  throw new Error(
    'DATABASE_URI is not set. Run this through stackctl (`pnpm dev`, or `pnpm stackctl exec -- …`) so the .env files are loaded.',
  );
}

/** One shared pool per process. */
export const pool = new pg.Pool({ connectionString });

import { buildCli } from './cli';

/** Compiles the CLI once for every e2e file (see `cli.ts`). */
export default async function setup(): Promise<void> {
  await buildCli();
}

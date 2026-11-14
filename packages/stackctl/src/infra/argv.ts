/**
 * Providers whose key is also an `infra` subcommand that runs the provider's own tool:
 * `stackctl infra docker-compose ps` is `docker compose ps`, bound to this project and profile.
 */
export const PASSTHROUGH_PROVIDERS: readonly string[] = ['docker-compose'];

/**
 * The index in `argv` of the provider word that starts a passthrough, or -1. Everything after
 * that word belongs to the provider's tool and must never be read as a stackctl flag —
 * `docker compose -p demo ps` names a Compose project, not a stackctl profile.
 *
 * Only words before the first bare `--` count (after it they belong to a wrapped command), and
 * between `infra` and the provider word only `infra`'s own profile and workspace flags may appear.
 */
export function findPassthrough(argv: readonly string[]): number {
  const end = argv.indexOf('--');
  const args = end === -1 ? argv : argv.slice(0, end);
  const infra = args.indexOf('infra');
  if (infra === -1) {
    return -1;
  }
  let i = infra + 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--profile') {
      i += 2;
    } else if (arg === '--workspace-dir') {
      i += 2;
    } else if (arg.startsWith('--profile=') || arg.startsWith('--workspace-dir=')) {
      i += 1;
    } else {
      return PASSTHROUGH_PROVIDERS.includes(arg) ? i : -1;
    }
  }
  return -1;
}

/** The provider and the verbatim arguments of a passthrough invocation, or null if it isn't one. */
export function passthroughArgs(
  argv: readonly string[],
): { provider: string; args: string[] } | null {
  const at = findPassthrough(argv);
  return at === -1 ? null : { provider: argv[at]!, args: argv.slice(at + 1) };
}

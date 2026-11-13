// `@dotenvx/primitives` ships no types. This declares the part stackctl uses: the parser that
// `@dotenvx/dotenvx` itself is built on, without the CLI tooling that package loads with it.
declare module '@dotenvx/primitives' {
  interface ParseOptions {
    /** The environment a `${VAR}` reference is looked up in, and whose variables win. */
    processEnv?: Record<string, string | undefined>;
    /** Let the source's values win over `processEnv`'s. */
    overload?: boolean;
    /** The files to read private keys from; `.env.keys` in the working directory if not given. */
    fk?: string[];
    /** Variable names (globs) whose values are not decrypted; `'*'` decrypts none. */
    ek?: string | string[];
  }
  interface ParseResult {
    parsed: Record<string, string>;
    /** Values that could not be decrypted. */
    errors: { code: string; message: string }[];
  }
  /** One assignment `scan` read: its value unquoted and unescaped, still unresolved. */
  interface ScannedLine {
    name: string;
    value: string;
    /** The quote around the value: `'`, `"`, `` ` `` or none (`''`). */
    quote: string;
  }
  interface ResolveOptions {
    /** Variables looked up first, and the environment of a `$(command)`. */
    processEnv?: Record<string, string>;
    /** Variables looked up after `processEnv`. */
    runningParsed?: Record<string, string>;
  }
  interface Primitives {
    parseSync(source: string, options?: ParseOptions): ParseResult;
    /** {@link parseSync}, with each name's values in the order `source` assigns them. */
    parsearraysSync(
      source: string,
      options?: ParseOptions,
    ): Omit<ParseResult, 'parsed'> & { parsed: Record<string, string[]> };
    /**
     * Every assignment in `source`, each name's values in order, unresolved; `line` is called
     * with each, in order.
     */
    scan(
      source: string,
      line?: (assignment: ScannedLine) => string,
    ): { scanned: Record<string, string[]> };
    /** `value` with its `${VAR}` and `$VAR` references replaced. */
    expand(value: string, options: ResolveOptions): string;
    /** `value` with each `$(command)` replaced by what it prints; throws when one fails. */
    evaluate(value: string, options: ResolveOptions): string;
    /** Whether `value` is one dotenvx encrypted (`encrypted:…`). */
    encrypted(value: string): boolean;
    keypair(): { publicKey: string; privateKey: string };
    encrypt(publicKey: string, value: string): string;
  }
  const primitives: Primitives;
  export default primitives;
}

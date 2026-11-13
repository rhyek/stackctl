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
  interface Primitives {
    parseSync(source: string, options?: ParseOptions): ParseResult;
    /** Every assignment in `source`, each name's values in order, unresolved. */
    scan(source: string): { scanned: Record<string, string[]> };
    keypair(): { publicKey: string; privateKey: string };
    encrypt(publicKey: string, value: string): string;
  }
  const primitives: Primitives;
  export default primitives;
}

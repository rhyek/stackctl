import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { type Config, proxyKeyAndCert } from './config.js';
import { currentProfile } from './env-base.js';
import { stateDirOf } from './log-files.js';
import { routeHosts as hostsOf } from './route-hosts.js';
import { trustFilePath } from './trust-file.js';

export { sessionTrustFile, trustFilePath } from './trust-file.js';

// The dev reverse proxy's TLS: the key and certificate a config names, or a self-signed
// certificate for each hostname the proxy serves, kept under `node_modules/.stackctl/tls/`, as
// Vite's basic-ssl plugin keeps its one under `node_modules/.vite/`.

/** How long a self-signed certificate is valid for. */
const CERT_DAYS = 365;

/** A certificate this close to expiring is made again. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** What the proxy's TLS listener is built from. */
export interface ProxyTls {
  /** The certificate for a client that names no host, or an unknown one. */
  key: string;
  cert: string;
  /** Picks each hostname's own certificate; absent with a certificate of the config's. */
  SNICallback?: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void; // oxfmt-ignore
}

/** Where the self-signed certificates live: `node_modules/.stackctl/tls/`. */
export function tlsDir(workspaceDir: string): string {
  return path.join(stateDirOf(workspaceDir), 'tls');
}

/** A PEM's text, else a file's path relative to the workspace, read. */
function pemOrFile(value: string, field: 'key' | 'cert', workspaceDir: string): string {
  if (value.includes('-----BEGIN ')) {
    return value;
  }
  const file = path.resolve(workspaceDir, value);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `reverseProxy.tls.${field}: can't read ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)}). ` +
        "Give the path of a PEM file, relative to the workspace, or the PEM's text.",
      { cause: err },
    );
  }
}

/** The proxy's TLS from a key and certificate of the config's (PEM text or paths). */
export function configuredTls(own: { key: string; cert: string }, workspaceDir: string): ProxyTls {
  return {
    key: pemOrFile(own.key, 'key', workspaceDir),
    cert: pemOrFile(own.cert, 'cert', workspaceDir),
  };
}

/** One host's key and certificate, in its file as `<key PEM><cert PEM>`. */
interface HostCert {
  key: string;
  cert: string;
}

/** The PEM blocks of one kind in a text. */
function pemBlocks(text: string, label: string): string[] {
  return text.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----\\n?`, 'g')) ?? []; // oxfmt-ignore
}

/** A host's certificate from its file, or `null` when it is missing, unreadable, for another host, or about to expire. */
function readHostCert(file: string, host: string): HostCert | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const [key] = pemBlocks(text, 'PRIVATE KEY');
  const [cert] = pemBlocks(text, 'CERTIFICATE');
  if (key === undefined || cert === undefined) {
    return null;
  }
  try {
    const x509 = new X509Certificate(cert);
    if (
      x509.checkHost(host) === undefined ||
      Date.parse(x509.validTo) - Date.now() < RENEW_BEFORE_MS
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { key, cert };
}

/** Makes a self-signed certificate for `host` and writes it, readable by the user alone. */
async function makeHostCert(dir: string, host: string): Promise<HostCert> {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_DAYS * 24 * 60 * 60 * 1000);
  // selfsigned's default extensions are a server's: not a CA, serverAuth, and the host as its one
  // subject alternative name (plus 127.0.0.1 for `localhost`).
  // Loaded only here: a session whose proxy makes no certificate never loads it.
  const { generate } = await import('selfsigned');
  const pems = await generate([{ name: 'commonName', value: host }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
  });
  const result = { key: pems.private, cert: pems.cert };
  fs.mkdirSync(dir, { recursive: true });
  // Written whole and then moved into place, so a session reading it never sees half a file.
  const file = path.join(dir, `${host}.pem`);
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, `${result.key.trimEnd()}\n${result.cert.trimEnd()}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return result;
}

/** A host's certificate: the one on disk while it is still good, else a new one. */
async function hostCert(dir: string, host: string): Promise<HostCert> {
  return readHostCert(path.join(dir, `${host}.pem`), host) ?? makeHostCert(dir, host);
}

/** `true` for a hostname that is one of `domains`, or under one. */
function isUnder(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The proxy's TLS from self-signed certificates: one for each of `hosts` (every hostname a route
 * names, the bare domains included), made now unless still good on disk, and a profile's trust file
 * with all of them. A client asking for another name under a domain (a host `'*'` routes, or a
 * mistyped subdomain) gets one made then, so it reaches the route or sees the proxy's 404; any
 * other name, or none, gets the canonical domain's.
 */
export async function selfSignedTls(opts: {
  workspaceDir: string;
  profile: string;
  /** Every hostname a route names, under each domain, and each bare domain. */
  hosts: string[];
  /** The domains (`publicAddress.domain`), canonical first. */
  domains: string[];
}): Promise<{ tls: ProxyTls; trustFile: string }> {
  const dir = tlsDir(opts.workspaceDir);
  const hosts = [...new Set([opts.domains[0]!, ...opts.hosts])];
  const certs = new Map<string, HostCert>(
    await Promise.all(hosts.map(async (host) => [host, await hostCert(dir, host)] as const)),
  );

  const trustFile = trustFilePath(opts.workspaceDir, opts.profile);
  writeTrustFile(
    trustFile,
    [...certs.values()].map((c) => c.cert),
  );

  const contexts = new Map<string, tls.SecureContext>();
  const contextOf = (host: string, cert: HostCert) => {
    const context = tls.createSecureContext({ key: cert.key, cert: cert.cert });
    contexts.set(host, context);
    return context;
  };
  for (const [host, cert] of certs) {
    contextOf(host, cert);
  }
  const pending = new Map<string, Promise<tls.SecureContext>>();
  const fallback = certs.get(opts.domains[0]!)!;
  return {
    trustFile,
    tls: {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback(servername, cb) {
        const host = servername.toLowerCase();
        const known = contexts.get(host);
        if (known !== undefined) {
          cb(null, known);
          return;
        }
        if (!isUnder(host, opts.domains)) {
          cb(null, contexts.get(opts.domains[0]!));
          return;
        }
        let made = pending.get(host);
        if (made === undefined) {
          made = hostCert(dir, host).then((cert) => contextOf(host, cert));
          pending.set(host, made);
          void made.finally(() => pending.delete(host));
        }
        void (async () => {
          let context: tls.SecureContext;
          try {
            context = await made;
          } catch (err) {
            cb(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          cb(null, context);
        })();
      },
    },
  };
}

/**
 * Writes a trust file: the given certificates, then the ones the ambient `NODE_EXTRA_CA_CERTS`
 * names, since a process takes only one such file and a service handed this one would otherwise
 * lose those.
 */
function writeTrustFile(file: string, certs: string[]) {
  const ambient = process.env.NODE_EXTRA_CA_CERTS;
  let inherited = '';
  if (ambient !== undefined && ambient !== '' && path.resolve(ambient) !== file) {
    try {
      inherited = pemBlocks(fs.readFileSync(ambient, 'utf8'), 'CERTIFICATE').join('');
    } catch {
      // Node ignores an unreadable NODE_EXTRA_CA_CERTS with a warning, and so does this.
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, [...certs.map((c) => `${c.trimEnd()}\n`), inherited].join(''));
  fs.renameSync(temp, file);
}

/**
 * The dev reverse proxy's TLS as the config asks for it (`reverseProxy.tls`): nothing, the
 * config's own key and certificate, or self-signed certificates for every hostname it serves,
 * with the profile's trust file written.
 */
export async function proxyTlsFor(
  config: Pick<Config<string>, 'reverseProxy'>,
  workspaceDir: string,
  profile: string = currentProfile(),
): Promise<{ tls?: ProxyTls; trustFile?: string }> {
  const proxy = config.reverseProxy;
  if (!proxy || proxy.tls === false) {
    return {};
  }
  if (proxy.tls === 'own') {
    return { tls: configuredTls(proxyKeyAndCert(proxy)!, workspaceDir) };
  }
  const { domains } = proxy.publicAddress;
  return selfSignedTls({
    workspaceDir,
    profile,
    hosts: [...domains, ...hostsOf(proxy.routes, domains)],
    domains,
  });
}

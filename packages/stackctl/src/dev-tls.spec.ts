import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defineConfig } from './config.js';
import { configuredTls, proxyTlsFor, selfSignedTls, tlsDir, trustFilePath } from './dev-tls.js';
import { packageEnvLayer } from './env.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-tls-')));
  dirs.push(dir);
  return dir;
}

/** The certificates in a PEM text, parsed. */
function certsIn(text: string): X509Certificate[] {
  return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
    (pem) => new X509Certificate(pem),
  );
}

describe('selfSignedTls', () => {
  test("makes a year's self-signed certificate per host, readable by the user alone", async () => {
    const dir = workspace();
    await selfSignedTls({ workspaceDir: dir, mode: 'development', hosts: ['web.example.test'], domains: ['example.test'] }); // oxfmt-ignore
    const file = path.join(tlsDir(dir), 'web.example.test.pem');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const [cert] = certsIn(fs.readFileSync(file, 'utf8'));
    expect(cert!.subject).toBe('CN=web.example.test');
    expect(cert!.checkHost('web.example.test')).toBe('web.example.test');
    expect(cert!.ca).toBe(false);
    expect(cert!.publicKey.asymmetricKeyType).toBe('ec');
    const days = (Date.parse(cert!.validTo) - Date.parse(cert!.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(365);
    // The canonical root's too: what a client naming no host gets.
    expect(fs.existsSync(path.join(tlsDir(dir), 'example.test.pem'))).toBe(true);
  });

  test('keeps a certificate that is still good, so the browser is not asked again', async () => {
    const dir = workspace();
    const opts = { workspaceDir: dir, mode: 'development', hosts: ['web.example.test'], domains: ['example.test'] }; // oxfmt-ignore
    await selfSignedTls(opts);
    const file = path.join(tlsDir(dir), 'web.example.test.pem');
    const before = fs.readFileSync(file, 'utf8');
    await selfSignedTls(opts);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test("makes a new one for a file that isn't that host's, or isn't a certificate", async () => {
    const dir = workspace();
    const opts = { workspaceDir: dir, mode: 'development', hosts: ['web.example.test', 'api.example.test'], domains: ['example.test'] }; // oxfmt-ignore
    await selfSignedTls(opts);
    const web = path.join(tlsDir(dir), 'web.example.test.pem');
    const api = path.join(tlsDir(dir), 'api.example.test.pem');
    fs.copyFileSync(api, web);
    fs.writeFileSync(api, 'not a certificate');
    await selfSignedTls(opts);
    expect(certsIn(fs.readFileSync(web, 'utf8'))[0]!.subject).toBe('CN=web.example.test');
    expect(certsIn(fs.readFileSync(api, 'utf8'))[0]!.subject).toBe('CN=api.example.test');
  });

  test('writes the mode its trust file: every host, then what NODE_EXTRA_CA_CERTS already named', async () => {
    // oxfmt-ignore
    const dir = workspace();
    const corporate = path.join(dir, 'corporate.pem');
    await selfSignedTls({ workspaceDir: workspace(), mode: 'x', hosts: ['corp.test'], domains: ['corp.test'] }); // oxfmt-ignore
    fs.copyFileSync(path.join(tlsDir(dirs.at(-1)!), 'corp.test.pem'), corporate);
    vi.stubEnv('NODE_EXTRA_CA_CERTS', corporate);
    const { trustFile } = await selfSignedTls({
      workspaceDir: dir,
      mode: 'test',
      hosts: ['web.example.test'],
      domains: ['example.test'],
    });
    expect(trustFile).toBe(trustFilePath(dir, 'test'));
    // The mode's own, under modes/<mode>/; the certificates stay shared, under tls/.
    expect(trustFile).toBe(path.join(dir, 'node_modules', '.stackctl', 'modes', 'test', 'trusted.pem')); // oxfmt-ignore
    expect(tlsDir(dir)).toBe(path.join(dir, 'node_modules', '.stackctl', 'tls'));
    const text = fs.readFileSync(trustFile, 'utf8');
    expect(text).not.toContain('PRIVATE KEY');
    expect(certsIn(text).map((c) => c.subject)).toEqual([
      'CN=example.test',
      'CN=web.example.test',
      'CN=corp.test',
    ]);
  });
});

describe('proxyTlsFor', () => {
  test('makes a certificate for every routed host under every root, and each bare root', async () => {
    const dir = workspace();
    const config = defineConfig({
      workspaceDir: dir,
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: {
          domain: ['example.test', 'example.localhost'],
          scheme: 'https',
          port: 4000,
        },
        tls: true,
        routes: [
          { subdomain: ['web', 'www'], service: 'web' },
          { subdomain: 'mail', service: 'mail' },
          { subdomain: 'app', paths: { '/**': 'worker' } },
          // Every other host: no name to make a certificate for ahead of time.
          { subdomain: '*', service: 'web' },
        ],
      },
      infra: { 'docker-compose': { services: { mail: { port: 8025 } } } },
      services: {
        web: { port: 3000 },
        worker: { port: 3001 },
      },
    });
    const { tls, trustFile } = await proxyTlsFor(config, dir, 'development');
    expect(tls?.SNICallback).toBeTypeOf('function');
    expect(
      certsIn(fs.readFileSync(trustFile!, 'utf8'))
        .map((c) => c.subject)
        .sort(),
    ).toEqual(
      [
        'example.test',
        'example.localhost',
        'web.example.test',
        'www.example.test',
        'mail.example.test',
        'app.example.test',
        'web.example.localhost',
        'www.example.localhost',
        'mail.example.localhost',
        'app.example.localhost',
      ]
        .map((host) => `CN=${host}`)
        .sort(),
    );
  });

  test('does nothing with tls off', async () => {
    const dir = workspace();
    const config = defineConfig({
      workspaceDir: dir,
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000 },
      services: { web: { port: 3000 } },
    });
    expect(await proxyTlsFor(config, dir)).toEqual({});
    expect(fs.existsSync(tlsDir(dir))).toBe(false);
  });
});

describe('configuredTls', () => {
  test("takes a PEM's text as it is, and reads a path relative to the workspace", async () => {
    const dir = workspace();
    await selfSignedTls({ workspaceDir: dir, mode: 'x', hosts: [], domains: ['mine.test'] });
    const pem = fs.readFileSync(path.join(tlsDir(dir), 'mine.test.pem'), 'utf8');
    const key = pem.slice(0, pem.indexOf('-----BEGIN CERTIFICATE-----'));
    const cert = pem.slice(key.length);
    fs.writeFileSync(path.join(dir, 'cert.pem'), cert);
    expect(configuredTls({ key, cert: 'cert.pem' }, dir)).toEqual({ key, cert });
  });

  test('names the field and the file it could not read', () => {
    const dir = workspace();
    expect(() => configuredTls({ key: 'missing.pem', cert: 'x' }, dir)).toThrow(
      new RegExp(`reverseProxy\\.tls\\.key: can't read ${path.join(dir, 'missing.pem')} \\(ENOENT\\)`), // oxfmt-ignore
    );
  });
});

describe('NODE_EXTRA_CA_CERTS', () => {
  test("is injected next to PORT and PUBLIC_ORIGIN, and a service's own .env value wins", () => {
    const dir = workspace();
    fs.mkdirSync(path.join(dir, 'packages/web'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages/api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/api/.env'), 'NODE_EXTRA_CA_CERTS=/own.pem\n');
    const cfg = defineConfig({
      workspaceDir: dir,
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, tls: true, routes: [{ subdomain: 'web', service: 'web' }] },
      services: { web: { port: 3000 }, api: { port: 3001 } },
    });
    const opts = { cwd: dir, extraCaCerts: '/trusted.pem' };
    expect(packageEnvLayer(cfg.services.web, opts)).toMatchObject({
      PORT: '3000',
      PUBLIC_ORIGIN: 'https://web.localhost:4000',
      NODE_EXTRA_CA_CERTS: '/trusted.pem',
    });
    expect(packageEnvLayer(cfg.services.api, opts)).toMatchObject({ NODE_EXTRA_CA_CERTS: '/own.pem' }); // oxfmt-ignore
  });
});

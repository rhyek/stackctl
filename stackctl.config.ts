import { defineConfig } from 'stackctl';

// stackctl runs its own docs site: `pnpm dev` starts VitePress behind the dev reverse proxy, at
// http://docs.localhost:21072.
//
// With a TLS terminator serving a real domain in front of the proxy (docs/config/reverse-proxy.md,
// "Behind a TLS terminator"), name the domain as ROOT_DOMAIN in `.env.development.local`, and the
// site is at https://docs.<ROOT_DOMAIN> instead.

// From stackctl's block in the port registry (21050–21099), beside the docs site's own 21070.
const PROXY_PORT = 21072;

export default defineConfig({
  reverseProxy: {
    port: PROXY_PORT,
    publicAddress: ({ envs }) =>
      envs.ROOT_DOMAIN
        ? { domain: envs.ROOT_DOMAIN, scheme: 'https' }
        : { domain: 'localhost', scheme: 'http', port: PROXY_PORT },
    routes: [{ subdomain: 'docs', service: 'docs' }],
  },
  services: {
    // The site lives at the repo's root, and its dev script is the root's `docs:dev`.
    docs: {
      relativeDir: '.',
      command: 'docs:dev',
      port: 21070,
      // VitePress compiles the first page it is asked for.
      healthcheck: { url: '/', timeout: 5000 },
      urls: [''],
    },
  },
});

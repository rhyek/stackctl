import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TanStack Start builds to a Web `fetch` handler: `vite build` emits `dist/client` (static assets)
// + `dist/server/server.js` (the `{ fetch }` handler), which `server.ts` runs via srvx on Node,
// also serving the static assets. `resolve.tsconfigPaths` makes the `~/` alias (from tsconfig
// paths) resolve at build.
// Under stackctl the dev server binds the `PORT` it's handed and is reached through stackctl's
// dev reverse proxy at `PUBLIC_ORIGIN` (http://app.localhost:21050 in this example): that host
// must be allowed, and the HMR client told to connect to the public port — the same one the page
// came from, or the scheme's default when the origin carries none — rather than to Vite's own, so
// the websocket is proxied like everything else. Neither is set when the config loads outside stackctl (`vite build`, `vite preview`).
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : undefined;

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    strictPort: true,
    ...(publicOrigin && {
      allowedHosts: [publicOrigin.hostname],
      hmr: {
        clientPort: Number(publicOrigin.port) || (publicOrigin.protocol === 'https:' ? 443 : 80),
      },
    }),
  },
  resolve: { tsconfigPaths: true },
  // Don't pre-bundle the linked workspace lib: keep @example/isomorphic's source in the module
  // graph so Vite watches it and hot-reloads on edit.
  optimizeDeps: { exclude: ['@example/isomorphic'] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

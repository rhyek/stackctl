// Production server. srvx — the web-standard universal server TanStack Start already builds on —
// runs the app's Web `fetch` handler on Node and serves dist/client (MIME, path-traversal guard,
// range/compression). Server-fn CSRF/origin is handled in src/start.ts. Node (>=22.18) strips the
// TS at load. Run via:  NODE_ENV=production node server.ts
import { serve, type ServerMiddleware } from 'srvx';
import { staticMiddleware } from 'srvx/static';
// @ts-expect-error — a `vite build` artifact under dist/; it has no type declarations.
import built from './dist/server/server.js';

const handler = built as { fetch: (req: Request) => Response | Promise<Response> };

// srvx/static sets one cache policy for the whole directory; only Vite's /assets are
// content-hashed, so they alone are marked immutable.
const immutableAssets: ServerMiddleware = async (req, next) => {
  const res = await next();
  if (new URL(req.url).pathname.startsWith('/assets/')) {
    res.headers.set('cache-control', 'public, max-age=31536000, immutable');
  }
  return res;
};

// srvx logs its own "Listening on..." banner and installs graceful-shutdown handlers.
serve({
  port: Number(process.env.PORT) || 3000,
  hostname: process.env.HOST || '0.0.0.0',
  middleware: [immutableAssets, staticMiddleware({ dir: 'dist/client' })],
  fetch: handler.fetch,
});

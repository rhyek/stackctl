// TanStack Start instance config. Two middlewares live here:
//   - `csrf` (request phase): same-origin protection for server functions. Server fns are
//     same-origin RPC endpoints, and this check (Sec-Fetch-Site → Origin → Referer) is opt-in —
//     without it they aren't origin-checked at all. Scoped to `serverFn` so router requests are
//     untouched. This is what silences Start's "not protected by the CSRF middleware" warning.
//   - `surfaceErrors` (function phase): the ONE place every server-fn failure is surfaced.
import { createStart, createMiddleware, createCsrfMiddleware } from '@tanstack/react-start';
import { toast } from 'sonner';

// Reject cross-site server-fn calls; leave router (SSR/document) requests alone.
const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' });

// Global server-fn error surface. The `.client()` phase wraps every server-fn call in the browser;
// on a rejection it toasts MUTATION (POST) failures — the state-changing calls where a silent
// failure is dangerous — then RE-THROWS so existing call-site handling + loaders still run (additive;
// it never hides an error). Reads (GET, in loaders) surface through the root route's errorComponent
// instead. Server-thrown Error messages serialize to the client, so `err.message` is the real cause.
const surfaceErrors = createMiddleware({ type: 'function' }).client(async ({ next, method }) => {
  try {
    return await next();
  } catch (err) {
    if (method === 'POST') {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
  functionMiddleware: [surfaceErrors],
}));

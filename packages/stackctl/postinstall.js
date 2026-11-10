// stackctl's `postinstall` entry. Plain JavaScript on purpose: Node refuses to strip types from
// anything under node_modules, so a `.ts` shim can't run once the package is installed. The real
// work lives in `dist/postinstall.js` (compiled from `src/postinstall.ts`); this only makes sure
// an install can never fail on its account — `dist` is absent while stackctl's own workspace
// installs (before its first build), and a lifecycle script that throws fails the whole install.
import('./dist/postinstall.js').then((m) => m.main()).catch(() => {});

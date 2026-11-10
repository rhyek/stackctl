import { startTransition } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { StartClient } from '@tanstack/react-start/client';

// Custom client entry that REPLACES TanStack Start's default one. The default entry wraps the app in
// <React.StrictMode>, whose dev-only double-invocation of effects/renders is noise here and breaks
// any single-shot effect. Omitting StrictMode is the whole reason this file exists. Hydrate inside
// startTransition so hydration stays interruptible.
startTransition(() => {
  hydrateRoot(document, <StartClient />);
});

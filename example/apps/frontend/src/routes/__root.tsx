import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { Toaster } from '~/components/ui/sonner';
import appCss from '~/styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // maximum-scale=1 stops iOS Safari from auto-zooming into focused inputs
        // (it does that whenever an input's font-size is < 16px).
        content: 'width=device-width, initial-scale=1, maximum-scale=1',
      },
      {
        title: 'Todos',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  // Read/loader + render errors surface here; server-fn MUTATION errors are toasted globally in
  // src/start.ts.
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
        {error instanceof Error ? error.message : 'Unexpected error'}
      </p>
    </div>
  ),
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster />
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}

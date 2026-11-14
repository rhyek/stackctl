```ts
// stackctl.config.ts
import { defineConfig } from 'stackctl';

export default defineConfig({
  reverseProxy: {
    port: 4000,
    routes: [
      // http://api.localhost:4000
      { subdomain: 'api', service: 'backend' },
      // http://app.localhost:4000
      { subdomain: 'app', service: 'frontend' },
    ],
  },
  services: {
    backend: {
      port: ({ envs }) => Number(envs.BACKEND_PORT),
      healthcheck: '/health',
    },
    frontend: {
      port: 3000,
      deps: [{ service: 'backend', wait: true }],
      urls: [{ label: 'Home page', url: '/' }],
    },
  },
  infra: {
    'docker-compose': {
      services: {
        db: {
          afterReady: async ({ exec, fresh }) => {
            await exec('pnpm', ['migrate']);
            if (fresh) {
              await exec('pnpm', ['seed']);
            }
          },
        },
      },
    },
  },
});
```

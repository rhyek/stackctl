```ts
// stackctl.config.ts
import { defineConfig } from 'stackctl';

export default defineConfig({
  infra: { 'docker-compose': true },
  reverseProxy: {
    port: 4000,
    routes: [
      { subdomain: 'api', service: 'backend' }, // http://api.localhost:4000
      { subdomain: 'app', service: 'frontend' }, // http://app.localhost:4000
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
      urls: ['/'], // a link to frontend in the footer
    },
    worker: {
      command: ['start', { watches: false }],
    },
  },
});
```

---
layout: home

hero:
  name: stackctl
  text: Run your monorepo's stack in one terminal.
  tagline: A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.
  image:
    src: /logo.svg
    alt: stackctl
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why stackctl
      link: /guide/why
    - theme: alt
      text: GitHub
      link: https://github.com/rhyek/stackctl

demo:
  src: /casts/demo-1794363459.cast
  alt: stackctl's terminal UI running the example monorepo

config:
  title: One file describes the stack.
  details: Services, what each one needs, how to tell it is ready, and the infrastructure under them, in TypeScript your editor checks. The terminal UI, your tests, CI and coding agents all read the same file.
  linkText: The config file
  link: /config/config-file

features:
  - icon: 🧩
    title: One typed config
    details: Describe every service once in stackctl.config.ts. Pick one and the services it needs come with it, started in order.
    link: /config/config-file
  - icon: 🖥️
    title: A terminal UI you'll keep open
    details: "One combined, filterable log, with each service's state and memory in the footer. Drive it with the keyboard or the mouse: click a service, a key hint or a script, and drag to copy."
    link: /guide/terminal-ui
  - icon: 🐳
    title: Infra included
    details: Point it at your docker-compose.yaml. Databases and brokers come up, get healthy and get migrated before your services start.
    link: /config/infra
  - icon: 🌱
    title: Environment handled
    details: Layered .env files per workspace, service and mode, injected into each process and reloaded when a file changes.
    link: /guide/env
  - icon: 🌐
    title: A hostname per service
    details: An optional dev reverse proxy gives each service its own host, over TLS too, with a status page while it starts.
    link: /config/reverse-proxy
  - icon: 🧪
    title: The same stack in tests and CI
    details: startStack() hands an e2e suite a healthy stack that ends with it. stackctl start --detach does the same for a CI job.
    link: /guide/testing
  - icon: 📦
    title: An SDK for scripts and tests
    details: startStack(), exec(), run() and resolveEnv() give your own scripts and test suites what the CLI gives a shell, typed and with the same environment.
    link: /reference/sdk
  - icon: 🤖
    title: Built for coding agents
    details: A headless mode, a localhost control API, an installable skill and llms.txt let an agent run your project the way you do.
    link: /ai/overview
  - icon: 🛠️
    title: Any language
    details: A service is a dev script in package.json or a Makefile target, so Node, Go and Rust services run side by side.
    link: /guide/services
---

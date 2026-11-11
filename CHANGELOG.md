# Changelog

## 0.1.2

- **Every log line's text starts in the same column**, infra's and those of a service added
  mid-session included.
- **Commands received over the control API are logged under `[control]`**, rather than
  `[dt:control]`.

## 0.1.1

- **The README and the docs name stackctl's SDK**: `startStack()`, `exec()`, `run()` and
  `resolveEnv()`, for your own scripts and test suites. See [docs/reference/sdk.md](docs/reference/sdk.md).

## 0.1.0

First release of stackctl, a terminal UI and CLI for a monorepo's services, infrastructure,
tests and CI during development. See [README.md](README.md).

- **One typed config file** (`stackctl.config.ts`) describes every service and the services it
  depends on.
- **An interactive terminal UI** to pick services and watch their combined, filterable logs and
  memory use.
- **A headless mode, `startStack()` and a control API** run the same stack from CI, an e2e suite
  or a coding agent, with an installable agent skill.
- **Infra from `docker-compose.yaml`**, brought up and migrated per mode before the services
  start. See [docs/config/infra.md](docs/config/infra.md).
- **Per-service `.env` loading**, live-reloaded, and JSON logs formatted for reading.
- **An optional dev reverse proxy** gives each service its own hostname. See
  [docs/config/reverse-proxy.md](docs/config/reverse-proxy.md).

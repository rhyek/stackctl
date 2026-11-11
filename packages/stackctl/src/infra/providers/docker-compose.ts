import { composeMemory, socketPath } from '../docker-engine.js';
import {
  SPAWN_FAILED,
  streamLines,
  type ExecOptions,
  type ExecResult,
  type LineStream,
} from '../exec.js';
import { InfraProvider, type Emit, type ProviderRuntime } from '../provider.js';
import {
  type DockerComposeCallbackContext,
  InfraError,
  type InfraServiceState,
  type Readiness,
  type ResolvedDockerComposeInfra,
  type ResolvedInfraService,
} from '../types.js';

/** The fields of a `docker compose ps --format json` row that readiness is read from. */
export interface PsRow {
  /** The container's id — what tells a container this run started from one already running. */
  ID?: string;
  Service: string;
  /** `created`, `running`, `restarting`, `exited`, `paused`, `removing` or `dead`. */
  State: string;
  /** `starting`, `healthy` or `unhealthy`; empty when the service has no healthcheck. */
  Health?: string;
  /** The container's labels, as one `key=value,key=value` string. */
  Labels?: string;
  ExitCode?: number;
}

/** The parts of `docker compose config --format json` that deciding a volume's fate needs. */
export interface ComposeConfig {
  services?: Record<string, { volumes?: { type: string; source?: string; target?: string }[] }>;
  volumes?: Record<string, { name?: string; external?: unknown }>;
}

/** How many lines of a failed container's logs go into its failure report. */
const FAILURE_LOG_LINES = 20;

/**
 * `docker compose ps --format json`, parsed. Current Compose prints one object per line; older
 * releases print a single array. No containers is no output at all.
 */
export function parsePs(stdout: string): PsRow[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    return JSON.parse(text) as PsRow[];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PsRow);
}

function classifyContainer(row: PsRow): Readiness {
  switch (row.State) {
    case 'running':
      switch (row.Health ?? '') {
        case '':
          return { state: 'ready', detail: 'running' };
        case 'healthy':
          return { state: 'ready', detail: 'healthy' };
        case 'unhealthy':
          return { state: 'failed', detail: 'unhealthy' };
        default:
          return { state: 'pending', detail: 'waiting for healthy' };
      }
    case 'exited': {
      // A container that ran to completion is done, not broken: an init or migration service.
      const code = row.ExitCode ?? 0;
      return { state: code === 0 ? 'ready' : 'failed', detail: `exited (${String(code)})` };
    }
    case 'dead':
      return { state: 'failed', detail: 'dead' };
    default:
      return { state: 'pending', detail: row.State };
  }
}

/**
 * A one-off container, from `docker compose run`. `ps` lists it under its service's name, but
 * it isn't the service: a `run db psql` left open inherits `db`'s healthcheck and, with no
 * server inside, never passes it.
 */
function isOneOff(row: PsRow): boolean {
  return (row.Labels ?? '').split(',').includes('com.docker.compose.oneoff=True');
}

/**
 * How a service stands, from its containers' rows — the live counterpart of {@link classify},
 * which answers "is it ready yet?" for a wait: here no containers at all is `stopped`, not
 * `pending`, since nothing is about to create them.
 */
export function stateOf(rows: PsRow[]): InfraServiceState {
  if (rows.length === 0) {
    return 'stopped';
  }
  const { state } = classify(rows);
  return state === 'ready' ? 'running' : state === 'pending' ? 'starting' : 'stopped';
}

/** A running container with no healthcheck, and an id to remember it by. */
function isRunningUnchecked(row: PsRow): boolean {
  return row.State === 'running' && !row.Health && row.ID !== undefined;
}

/**
 * Whether a service is ready, from its containers' rows. Readiness is exactly what the compose
 * file's `healthcheck` says — no probe of stackctl's own. A service with several containers is
 * ready when all of them are, and failed when any one is.
 */
export function classify(rows: PsRow[]): Readiness {
  if (rows.length === 0) {
    return { state: 'pending', detail: 'creating' };
  }
  const readings = rows.map(classifyContainer);
  return (
    readings.find((r) => r.state === 'failed') ??
    readings.find((r) => r.state === 'pending') ??
    readings[0]!
  );
}

/** The keys, under the file's top-level `volumes`, of the named volumes a service mounts. */
function mountedVolumeKeys(config: ComposeConfig, service: string): string[] {
  return (config.services?.[service]?.volumes ?? [])
    .filter((v) => v.type === 'volume' && v.source)
    .map((v) => v.source!);
}

/**
 * Whether a service has no data yet, given the volumes and containers that exist. A service
 * that mounts named volumes goes by them alone — its container comes and goes (`down`, a config
 * change) while the data stays. One that mounts none keeps its data in the container.
 */
export function isFresh(
  config: ComposeConfig,
  service: string,
  existing: { volumes: ReadonlySet<string>; services: ReadonlySet<string> },
): boolean {
  const volumes = mountedVolumeKeys(config, service).map(
    (key) => config.volumes?.[key]?.name ?? key,
  );
  return volumes.length > 0
    ? !volumes.some((name) => existing.volumes.has(name))
    : !existing.services.has(service);
}

/**
 * Which named volumes go when `targets` are destroyed, by the name Compose resolved for each.
 * A volume stays if it is `external`, or if a service that is *not* being destroyed mounts it
 * too. Anonymous volumes and bind mounts aren't listed here at all: `rm --volumes` already took
 * the first, and the second is the host's.
 */
export function selectVolumes(
  config: ComposeConfig,
  targets: string[],
): { remove: string[]; kept: { name: string; reason: string }[] } {
  const services = config.services ?? {};
  const mounted = (service: string) => mountedVolumeKeys(config, service);

  const remove: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const key of new Set(targets.flatMap(mounted))) {
    const definition = config.volumes?.[key];
    const name = definition?.name ?? key;
    const others = Object.keys(services).filter(
      (service) => !targets.includes(service) && mounted(service).includes(key),
    );
    if (definition?.external) {
      kept.push({ name, reason: 'external' });
    } else if (others.length > 0) {
      kept.push({ name, reason: `also mounted by ${others.join(', ')}` });
    } else {
      remove.push(name);
    }
  }
  return { remove, kept };
}

/**
 * Infra run by Docker Compose. Every Compose detail lives here: how it is invoked, how its
 * output is read, and which resources a destroy may touch.
 */
export class DockerComposeProvider extends InfraProvider {
  readonly key = 'docker-compose';

  /**
   * Ids of containers with no healthcheck that have been seen running before — either already
   * up when this run began ({@link readFresh}), or on an earlier reading ({@link readStatuses}).
   */
  private readonly seenRunning = new Set<string>();

  /** The Docker Engine's socket, once asked for; null when it isn't a local unix socket. */
  private engineSocket: Promise<string | null> | undefined;

  /** The service list, once asked for. See {@link listServices}. */
  private services: Promise<string[]> | undefined;

  constructor(
    private readonly resolved: ResolvedDockerComposeInfra,
    runtime: ProviderRuntime,
  ) {
    // The base class calls each callback with its own context plus what `toolContext` adds,
    // `compose`: the Docker Compose context these callbacks are typed for.
    super(
      runtime,
      resolved.services as Record<string, ResolvedInfraService>,
      resolved.readyTimeout,
    );
  }

  protected override toolLabel(): string {
    return 'docker compose';
  }

  protected toolContext(
    run: DockerComposeCallbackContext['compose'],
  ): Pick<DockerComposeCallbackContext, 'compose'> {
    return { compose: run };
  }

  /**
   * The project name, as an environment variable rather than `-p` so that it also reaches
   * whatever a callback runs — a script that calls `docker compose` itself lands on this project.
   */
  protected override extraEnv(): Record<string, string> {
    return { COMPOSE_PROJECT_NAME: this.resolved.projectName };
  }

  /**
   * The one place a Compose command line is assembled. `--project-directory` is always given,
   * so the compose file, `.env` and relative paths in the file resolve against the workspace
   * root whatever directory the command runs in.
   */
  private composeArgs(args: string[]): string[] {
    const { file } = this.resolved;
    return [
      'compose',
      '--project-directory',
      this.runtime.workspaceDir,
      ...(file === undefined ? [] : ['-f', file]),
      ...args,
    ];
  }

  private env(): Record<string, string> {
    return { ...this.runtime.envs, ...this.extraEnv() };
  }

  /** Runs `docker compose <args>` captured; a failure is an {@link InfraError} with its stderr. */
  private async compose(args: string[], onLine?: ExecOptions['onLine']): Promise<ExecResult> {
    const result = await this.runtime.exec('docker', this.composeArgs(args), {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
      onLine,
    });
    if (result.exitCode === SPAWN_FAILED) {
      throw new InfraError(
        "infra: couldn't run `docker compose` — is Docker installed and on your PATH?\n" +
          result.stderr.trim(),
      );
    }
    if (result.exitCode !== 0) {
      throw new InfraError(
        `\`docker compose ${args.join(' ')}\` failed (exit ${String(result.exitCode)}):\n` +
          result.stderr.trim(),
      );
    }
    return result;
  }

  /**
   * Forwards Compose's progress (`Container … Started`, image pulls) as plain output. Compose
   * writes all of it to stderr, so the stream says nothing about whether a line is an error.
   */
  private progress(emit: Emit): ExecOptions['onLine'] {
    return (line) => {
      const text = line.trim();
      if (text) {
        emit({ type: 'output', line: text, isError: false });
      }
    };
  }

  /**
   * The containers' memory as `docker stats` shows it, read from the Engine API over the socket of
   * the Docker context `docker` itself would use (so `DOCKER_HOST` and `DOCKER_CONTEXT` hold). On
   * macOS that is memory inside Docker's VM, not the Mac's own.
   */
  override async readMemory(): Promise<Map<string, number>> {
    this.engineSocket ??= this.runtime
      .exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
        cwd: this.runtime.workspaceDir,
        env: this.env(),
      })
      .then((r) => (r.exitCode === 0 ? socketPath(r.stdout) : null));
    const socket = await this.engineSocket;
    return socket
      ? composeMemory(socket, this.resolved.projectName).catch(() => new Map())
      : new Map();
  }

  /**
   * Sorted, because Compose prints them in no stable order and the list is shown to the user.
   * Asked of Compose once: a provider lives for one command, and the compose file doesn't
   * change under it.
   */
  listServices(): Promise<string[]> {
    this.services ??= this.compose(['config', '--services']).then(({ stdout }) =>
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort(),
    );
    return this.services;
  }

  /**
   * The one look at how things stand before `up` changes them. It answers which services have no
   * data yet, and notes which containers are already running — so the wait after the start can
   * tell a container that has been up all along from one this run started.
   */
  protected async readFresh(targets: string[]): Promise<Set<string>> {
    const [rows, config, volumes] = await Promise.all([
      this.ps(targets),
      this.config(),
      this.volumeNames(),
    ]);
    for (const row of rows) {
      if (isRunningUnchecked(row)) {
        this.seenRunning.add(row.ID!);
      }
    }
    const existing = { volumes, services: new Set(rows.map((row) => row.Service)) };
    return new Set(targets.filter((service) => isFresh(config, service, existing)));
  }

  /**
   * One `up` for every target, never one per service: concurrent `up` calls on a fresh project
   * race to create the network. `--remove-orphans` takes the containers of services no longer in
   * the compose file, and stopped one-off `run` containers. `--quiet-pull` keeps an image pull to its first and last line: without
   * it, a first run prints several hundred lines of per-layer download progress.
   */
  protected async startServices(targets: string[], emit: Emit): Promise<void> {
    await this.compose(
      ['up', '--detach', '--remove-orphans', '--quiet-pull', ...targets],
      this.progress(emit),
    );
  }

  /**
   * One reading per target, from `ps`. With one addition to {@link classify}: a container with
   * no healthcheck that this run just started is only called ready on the **second** reading
   * that finds it running. "Running" is all there is to go on for such a container, and one that
   * crashes on startup — a bad flag, a missing variable — is still reported as running for a
   * moment after `up` returns. A container that was already running when the run began skips
   * the second look, so bringing up what is already up stays quick.
   */
  protected async readStatuses(targets: string[]): Promise<Map<string, Readiness>> {
    const rows = await this.ps(targets);
    return new Map(
      targets.map((service) => {
        const own = rows.filter((row) => row.Service === service);
        const reading = classify(own);
        const unconfirmed = own.filter(
          (row) => isRunningUnchecked(row) && !this.seenRunning.has(row.ID!),
        );
        for (const row of unconfirmed) {
          this.seenRunning.add(row.ID!);
        }
        return [
          service,
          reading.state === 'ready' && unconfirmed.length > 0
            ? { state: 'pending', detail: 'started' }
            : reading,
        ];
      }),
    );
  }

  /** The compose file as Compose resolved it: interpolated, with every volume's real name. */
  private async config(): Promise<ComposeConfig> {
    const { stdout } = await this.compose(['config', '--format', 'json']);
    return JSON.parse(stdout) as ComposeConfig;
  }

  /** The name of every volume Docker has. Matched against the exact names `config` reports. */
  private async volumeNames(): Promise<Set<string>> {
    const result = await this.runtime.exec('docker', ['volume', 'ls', '--format', '{{.Name}}'], {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
    });
    if (result.exitCode !== 0) {
      throw new InfraError(`\`docker volume ls\` failed:\n${result.stderr.trim()}`);
    }
    return new Set(result.stdout.split('\n').filter(Boolean));
  }

  /** The targets' own containers. */
  private async ps(targets: string[]): Promise<PsRow[]> {
    const { stdout } = await this.compose(['ps', '--all', '--format', 'json', ...targets]);
    return parsePs(stdout).filter((row) => !isOneOff(row));
  }

  protected async failureDetail(service: string): Promise<string> {
    const { stdout, stderr } = await this.compose([
      'logs',
      '--no-color',
      '--tail',
      String(FAILURE_LOG_LINES),
      service,
    ]);
    return `${stdout}${stderr}`.trim();
  }

  /**
   * The whole project, by Compose's own teardown: containers, networks, the named volumes the
   * file declares, anonymous volumes, and orphan containers.
   */
  protected async destroyAll(emit: Emit): Promise<void> {
    await this.compose(['down', '--volumes', '--remove-orphans'], this.progress(emit));
  }

  /**
   * Only the named services. **Never `down <service> --volumes`**: that also deletes the volumes
   * of every other service whose container doesn't currently exist. So the containers go first
   * (with their anonymous volumes), and then exactly the named volumes those services own.
   */
  protected async destroyServices(targets: string[], emit: Emit): Promise<void> {
    await this.compose(['rm', '--stop', '--force', '--volumes', ...targets], this.progress(emit));
    const { remove, kept } = selectVolumes(await this.config(), targets);
    const say = (line: string) => emit({ type: 'output', line, isError: false });
    for (const { name, reason } of kept) {
      say(`kept volume ${name}: ${reason}`);
    }
    for (const name of remove) {
      const result = await this.runtime.exec('docker', ['volume', 'rm', name], {
        cwd: this.runtime.workspaceDir,
        env: this.env(),
      });
      if (result.exitCode === 0) {
        say(`removed volume ${name}`);
      } else if (/no such volume/i.test(result.stderr)) {
        // Never created — the service was never started. Nothing to remove.
      } else if (/in use/i.test(result.stderr)) {
        // Held by a container outside the file's active services (another profile, say).
        say(`kept volume ${name}: in use by another container`);
      } else {
        throw new InfraError(`couldn't remove volume ${name}:\n${result.stderr.trim()}`);
      }
    }
  }

  /** `docker compose down`, with Compose's own output. Never `--volumes`: the data stays. */
  async down(services: string[]): Promise<number> {
    return this.runtime.spawnInherit('docker', this.composeArgs(['down', ...services]), {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
    });
  }

  /** One `docker compose ps` for all the targets, each read with {@link stateOf}. */
  async readStates(targets: string[]): Promise<Map<string, InfraServiceState>> {
    const rows = await this.ps(targets);
    return new Map(
      targets.map((service) => [service, stateOf(rows.filter((row) => row.Service === service))]),
    );
  }

  /**
   * `docker compose events` for the targets: a line for every container created, started,
   * stopped, or whose health changed — one long-running command rather than a `ps` every few
   * seconds.
   */
  protected streamChanges(targets: string[], onChange: () => void): LineStream {
    const stream = this.runtime.stream ?? streamLines;
    return stream('docker', this.composeArgs(['events', '--json', ...targets]), {
      cwd: this.runtime.workspaceDir,
      env: this.env(),
      onLine: (_line, isError) => {
        if (!isError) {
          onChange();
        }
      },
    });
  }

  /** Compose itself, in the directory the user is standing in, with their arguments untouched. */
  async passthrough(args: string[], invocationCwd: string): Promise<number> {
    return this.runtime.spawnInherit('docker', this.composeArgs(args), {
      cwd: invocationCwd,
      env: this.env(),
    });
  }

  protected async runTool(args: string[], opts: ExecOptions): Promise<ExecResult> {
    return this.runtime.exec('docker', this.composeArgs(args), {
      ...opts,
      // The project name last: whatever `env` a callback passes, `compose` stays on this project.
      env: { ...opts.env, ...this.extraEnv() },
    });
  }
}

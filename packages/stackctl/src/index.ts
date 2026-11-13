export { defineConfig, findService, proxyHostsFor } from './config.js';
// stackctl's log utilities: `logging.formatter(config)` builds a structured-log formatter for a
// service's `logs.formatter` (and is the default applied to every service); the ecosystem helpers
// `logging.nodejs.{pino,winston}.formatter` are the same with adjusted defaults.
export { logging } from './log-formatter.js';
export type {
  FormatterConfig,
  FormatterConfigInput,
  FormatterFields,
  CustomField,
  CustomFields,
} from './log-formatter.js';
export type {
  ServiceConfigInput,
  ServiceInput,
  DefineConfigOptions,
  ResolvedServiceConfig,
  AnyServiceConfig,
  Config,
  ReverseProxyInput,
  ReverseProxyRoute,
  ReverseProxyTls,
  PublicAddress,
  ResolvedReverseProxy,
  ResolvedReverseProxyRoute,
  ResolvedPublicAddress,
  ConfigContext,
  ServiceContext,
  ServiceDetails,
  ServiceRoute,
  WorkspaceUrlsContext,
  BuildAddressOptions,
  PublicOriginInput,
  TokenRecord,
  ServiceTokens,
  PortResolver,
  DepsContext,
  DepsResolver,
  UrlResolver,
  UrlValue,
  UrlLinkInput,
  UrlsInput,
  UrlsResolver,
  UrlEntryInput,
  UrlLink,
  UrlEntry,
  Command,
  EnvFilesContext,
  EnvAdditionalFilesResolver,
} from './config.js';
export type { InfraServiceName, Register, ServiceConfig, ServiceName } from './register.js';
export type {
  InfraInput,
  DockerComposeInfraInput,
  DockerComposeCallbackContext,
  DockerComposeDestroyContext,
  DockerComposeReadyContext,
  DockerComposeServiceInput,
  DockerComposeServicesInput,
  DockerComposeStartContext,
  InfraServiceInput,
  InfraServicesInput,
  InfraServiceCallbacks,
  InfraEnabledContext,
  InfraCallback,
  InfraCallbackContext,
  InfraDestroyContext,
  InfraDestroyTrigger,
  InfraReadyContext,
  InfraStartContext,
  InfraStartTrigger,
  InfraTrigger,
  InfraRunOptions,
  InfraRunResult,
  ResolvedInfra,
  ResolvedDockerComposeInfra,
  ResolvedInfraService,
} from './infra/types.js';
// A test suite's stack: a detached headless session, started or reused, waited on until healthy.
export { startStack, stackEnvironment } from './stack.js';
export type { StartStackOptions, Stack } from './stack.js';
// One command with a target's directory and environment, as `stackctl exec` and `stackctl run` run it.
export { exec, run } from './one-off/sdk.js';
export type { OneOffOptions, ExecOptions, RunOptions, OneOffResult } from './one-off/sdk.js';
// What an infra callback's `control` is: a client for the running session's control API.
export type {
  ControlClient,
  SessionEvent,
  SessionStatus,
  SessionServiceStatus,
} from './control-client.js';
export type { EventBy, EventEntry, EventEnvelope, EventLine } from './event-log.js';
export type { ServiceAction } from './control-server.js';
export type { InfraAction, InfraStatus } from './infra/control.js';
export {
  resolveEnv,
  envCandidatePaths,
  ambientEnv,
  envFileNames,
  currentMode,
  DEFAULT_MODE,
  type Mode,
  type ModeSource,
  type EnvOverride,
  type Envs,
  type StackctlEnv,
  type EnvAdditionalFile,
  type EnvFileAnchor,
  type EnvFileBefore,
  type EnvFileAfter,
  type EnvFileOrder,
  type EnvFileScope,
} from './env.js';
export type { EnvResolution } from './env.js';

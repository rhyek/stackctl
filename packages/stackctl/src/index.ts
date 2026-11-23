export { defineConfig, proxyHostsFor } from './config';
// stackctl's log utilities: `logging.formatter(config)` builds a structured-log formatter for a
// service's `logs.formatter` (and is the default applied to every service); the ecosystem helpers
// `logging.nodejs.{pino,winston}.formatter` are the same with adjusted defaults.
export { logging } from './log-formatter';
export type {
  FormatterConfig,
  FormatterConfigInput,
  FormatterFields,
  CustomField,
  CustomFields,
} from './log-formatter';
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
} from './config';
export type { InfraServiceName, Register, ServiceConfig, ServiceName } from './register';
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
} from './infra/types';
// A test suite's stack: a detached headless session, started or reused, waited on until healthy.
export { startStack, stackEnvironment } from './stack';
export type { StartStackOptions, Stack } from './stack';
// One command with a service's directory and environment, as `stackctl exec` and `stackctl run` run
// it, or in several services at once.
export { exec, run } from './one-off/sdk';
export { showConfig } from './sdk/show-config';
export { infra } from './sdk/infra';
export { events, logs, resetProfile, service, status, stop } from './sdk/session';
export type {
  EventsOptions,
  FollowOptions,
  LogsResult,
  ResetProfileOptions,
  ServiceCommandResult,
  ServiceResult,
  ServiceSelection,
  ServiceStartOptions,
  StackServiceOptions,
  StackServiceStartOptions,
  StatusReport,
} from './sdk/session';
export { init } from './sdk/init';
export type { InitOptions } from './sdk/init';
export { attach, wait } from './sdk/attach';
export type { AttachOptions, WaitOptions } from './sdk/attach';
export type {
  InfraComposeOptions,
  InfraComposeResult,
  InfraResult,
  InfraSelection,
  InfraStartOptions,
} from './sdk/infra';
export type {
  OneOffOptions,
  ExecOptions,
  RunOptions,
  OneOffResult,
  OneOffManyOptions,
  ExecManyOptions,
  RunManyOptions,
  OneOffManyResult,
} from './one-off/sdk';
// What an infra callback's `control` is: a client for the running session's control API.
export type {
  ControlClient,
  SessionEvent,
  SessionStatus,
  SessionServiceStatus,
} from './control-client';
export type { EventBy, EventEntry, EventEnvelope, EventLine } from './event-log';
export type { ServiceAction } from './control-server';
export type { InfraAction, InfraStatus } from './infra/control';
export {
  resolveEnv,
  ambientEnv,
  envFileNames,
  currentProfile,
  DEFAULT_PROFILE,
  type Profile,
  type ProfileSource,
  type EnvOverride,
  type Envs,
  type StackctlEnv,
  type EnvAdditionalFile,
  type EnvFileAnchor,
  type EnvFileBefore,
  type EnvFileAfter,
} from './env';
export type { EnvResolution } from './env';

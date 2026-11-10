import type { AnyServiceConfig } from './config.js';

// Augmentation target — intentionally empty. Consumers augment it from stackctl.config.ts.
// oxlint-disable-next-line typescript/no-empty-object-type
export interface Register {}

/** The resolved services a `Register` names, or any when it names none. */
type ResolvedIn<R> = R extends { serviceConfigs: infer T extends Record<string, AnyServiceConfig> }
  ? T
  : Record<string, AnyServiceConfig>;

type Resolved = ResolvedIn<Register>;

/**
 * The resolved config of one service. Index it by name — `ServiceConfig<'api'>` — to get that
 * service's own type, including its `tokens`; bare `ServiceConfig` is the union of them all.
 */
export type ServiceConfig<N extends ServiceName = ServiceName> = N extends keyof Resolved
  ? Resolved[N]
  : never;

/** Your service names, once `Register` is augmented; `string` otherwise. */
export type ServiceName = ServiceNameIn<Register>;

/**
 * Your infra service names, across every provider, once `Register` is augmented with
 * `infraServices: typeof config.infra`; `string` otherwise.
 */
export type InfraServiceName = InfraServiceNameIn<Register>;

/** {@link ServiceName} for a given `Register` shape. */
export type ServiceNameIn<R> = Extract<keyof ResolvedIn<R>, string>;

/** {@link InfraServiceName} for a given `Register` shape. */
export type InfraServiceNameIn<R> = R extends { infraServices: infer T }
  ? InfraNamesOf<NonNullable<T>>
  : string;

/** The infra services' names in a resolved `infra` block, across every provider. */
type InfraNamesOf<T> = {
  [Provider in keyof T]-?: NonNullable<T[Provider]> extends { services: infer S }
    ? Extract<keyof S, string>
    : never;
}[keyof T];

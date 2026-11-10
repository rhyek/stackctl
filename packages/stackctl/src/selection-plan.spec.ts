import { describe, expect, test } from 'vitest';
import { defineConfig, getRegisteredPackages } from './config.js';
import {
  dependentScores,
  dependentsOf,
  depsOf,
  displayOrder,
  planSelection,
} from './selection-plan.js';

type Services = Record<string, Record<string, unknown>>;

/** Registers `services` (and `infra`) as the loaded config, as a config file would. */
function load(services: Services, infra?: Record<string, unknown>): void {
  defineConfig({
    serviceRootDir: 'packages',
    ...(infra ? { infra } : {}),
    services,
  } as unknown as Parameters<typeof defineConfig>[0]);
}

const why = (selected: string[]) =>
  Object.fromEntries(planSelection(selected).services.map((s) => [s.name, s.why]));

describe('planSelection: what a selection runs (D2)', () => {
  test('a selection runs the selected services and their direct deps, nothing further', () => {
    load({ 'reverse-proxy': {}, backend: { deps: ['reverse-proxy'] }, web: { deps: ['backend'] } });
    const plan = planSelection(['web']);
    expect(plan.order).toEqual(['backend', 'web']);
    expect(why(['web'])).toEqual({ web: null, backend: 'runtime dep of web' });
  });

  test('a dep that is also selected is a selected service, listed once', () => {
    load({ api: {}, web: { deps: ['api'] } });
    expect(planSelection(['web', 'api']).services).toEqual([
      { name: 'api', why: null },
      { name: 'web', why: null },
    ]);
    expect(planSelection(['web', 'web']).order).toEqual(['api', 'web']);
  });

  test('a dep runs whatever its own fields say: selectable: false and command: null still run', () => {
    load({
      proxy: { selectable: false },
      codegen: { command: null },
      web: { deps: ['proxy', 'codegen'] },
    });
    expect(why(['web'])).toEqual({
      web: null,
      proxy: 'runtime dep of web',
      codegen: 'runtime dep of web',
    });
  });

  test('a selected name that is not a registered service is ignored, never thrown on', () => {
    load({ api: {}, web: { deps: ['api'] } });
    expect(() => planSelection(['ghost'])).not.toThrow();
    expect(planSelection(['ghost', 'web']).order).toEqual(['api', 'web']);
    expect(planSelection(['ghost']).services).toEqual([]);
  });

  test('a wait dep runs like any other dep', () => {
    load({ db: { port: 5432, healthcheck: '/health' }, api: { deps: [{ service: 'db', wait: true }] } }); // oxfmt-ignore
    expect(why(['api'])).toEqual({ api: null, db: 'runtime dep of api' });
  });
});

describe('planSelection: what it returns (D3)', () => {
  test('services are listed in the order of `order`', () => {
    load({ proxy: { selectable: false }, api: { deps: ['proxy'] }, web: { deps: ['api', 'proxy'] }, 'lib-x': {} }); // oxfmt-ignore
    const plan = planSelection(['web', 'lib-x']);
    expect(plan.order).toEqual(['proxy', 'api', 'lib-x', 'web']);
    expect(plan.services.map((s) => s.name)).toEqual(plan.order);
  });

  test('the plan does not depend on the order the names are given in', () => {
    load({ db: {}, api: { deps: ['db'] }, web: { deps: ['api'] }, worker: { deps: ['db'] } });
    const a = planSelection(['web', 'worker']);
    const b = planSelection(['worker', 'web']);
    expect(b).toEqual(a);
    expect(a.order).toEqual(['db', 'api', 'web', 'worker']);
  });

  test('the plan marks the selected names and lists the services in order', () => {
    load({ db: {}, api: { deps: ['db'] }, web: { deps: ['api'] } });
    expect(planSelection(['web', 'db']).services).toEqual([
      { name: 'db', why: null },
      { name: 'api', why: 'runtime dep of web' },
      { name: 'web', why: null },
    ]);
  });
});

describe('display order (D4)', () => {
  test('scores count every registered service that needs one, directly or through others', () => {
    load({ app: { deps: ['mid'] }, mid: { deps: ['leaf'] }, leaf: {} });
    expect(Object.fromEntries(dependentScores())).toEqual({ app: 0, mid: 1, leaf: 2 });
  });

  test('a cycle ends, and a service never counts itself', () => {
    load({ a: { deps: ['b'] }, b: { deps: ['a'] }, c: { deps: ['a'] } });
    expect(Object.fromEntries(dependentScores())).toEqual({ a: 2, b: 2, c: 0 });
  });

  test('the most depended-on first, ties broken by name', () => {
    load({ proxy: { selectable: false }, api: { deps: ['proxy'] }, web: { deps: ['api', 'proxy'] }, 'lib-x': {} }); // oxfmt-ignore
    expect(Object.fromEntries(dependentScores())).toEqual({ proxy: 2, api: 1, web: 0, 'lib-x': 0 }); // oxfmt-ignore
    expect(displayOrder(['web', 'lib-x', 'api', 'proxy'])).toEqual([
      'proxy',
      'api',
      'lib-x',
      'web',
    ]);
  });

  test('among equals, a selected service comes before one only pulled in', () => {
    load({ proxy: { selectable: false }, api: { deps: ['proxy'] }, web: { deps: ['api', 'proxy'] }, 'lib-x': {} }); // oxfmt-ignore
    expect(displayOrder(['web', 'lib-x', 'api', 'proxy'], ['web'])).toEqual(['proxy', 'api', 'web', 'lib-x']); // oxfmt-ignore
  });

  test('scores are stable across calls and leave the config untouched', () => {
    load({ app: { deps: ['mid'] }, mid: { deps: ['leaf'] }, leaf: {} });
    const before = JSON.stringify(getRegisteredPackages().map((p) => [p.name, p.deps]));
    const first = dependentScores();
    expect(dependentScores()).toEqual(first);
    expect(displayOrder(['app', 'mid', 'leaf'])).toEqual(displayOrder(['leaf', 'app', 'mid']));
    expect(JSON.stringify(getRegisteredPackages().map((p) => [p.name, p.deps]))).toBe(before);
  });
});

describe('why each dep runs (D5)', () => {
  test('the reason names the first selected dependent in display order, whatever the given order', () => {
    // `admin` needs `web` too, so `web` scores higher and comes first.
    load({ db: {}, web: { deps: ['db'] }, admin: { deps: ['db', 'web'] } });
    expect(why(['admin', 'web']).db).toBe('runtime dep of web');
    expect(why(['web', 'admin']).db).toBe('runtime dep of web');
  });

  test('among equal scores the dependent is the first by name, and only one is named', () => {
    load({ db: {}, worker: { deps: ['db'] }, api: { deps: ['db'] } });
    expect(why(['worker', 'api'])).toEqual({ db: 'runtime dep of api', api: null, worker: null });
  });

  test('a selected service gets no reason', () => {
    load({ api: {}, web: { deps: ['api'] } });
    expect(why(['web', 'api'])).toEqual({ api: null, web: null });
  });
});

describe('autostart, command: null and selectable (D6)', () => {
  test('never change what a plan contains', () => {
    load({
      later: { autostart: false },
      none: { command: null },
      hidden: { selectable: false },
      web: { deps: ['later'] },
    });
    expect(planSelection(['later', 'none', 'hidden']).order).toEqual(['later', 'hidden', 'none']);
    expect(planSelection(['web']).order).toEqual(['later', 'web']);
  });
});

describe('infra (D7)', () => {
  test('the declared infra services, in declaration order, whatever is selected', () => {
    load(
      { web: {} },
      {
        'docker-compose': { services: { db: {}, mail: { port: 3100 } } },
      },
    );
    expect(planSelection(['web']).infra).toEqual(['db', 'mail']);
    expect(planSelection([]).infra).toEqual(['db', 'mail']);
  });

  test('empty when the config declares no infra', () => {
    load({ web: {} });
    expect(planSelection(['web']).infra).toEqual([]);
  });

  test('a provider block that names no services lists none', () => {
    load({ web: {} }, { 'docker-compose': {} });
    expect(planSelection(['web']).infra).toEqual([]);
  });
});

describe('adding a service mid-session (D8)', () => {
  test("a service's joining deps come in the config's order, not by score", () => {
    load({ cache: {}, db: {}, other: { deps: ['db'] }, api: { deps: ['cache', 'db'] } });
    expect(depsOf('api')).toEqual(['cache', 'db']);
    expect(planSelection(['api']).order).toEqual(['db', 'cache', 'api']);
  });
});

describe('self and circular deps', () => {
  test('a service listed in its own deps is not its own dep', () => {
    load({ a: { deps: ['a', 'b'] }, b: {} });
    expect(depsOf('a')).toEqual(['b']);
    expect(planSelection(['a']).order).toEqual(['b', 'a']);
  });

  test('a cycle runs each side once, the unselected one as a dep of the selected', () => {
    load({ a: { deps: ['b'] }, b: { deps: ['a'] } });
    expect(why(['a'])).toEqual({ a: null, b: 'runtime dep of a' });
  });
});

describe("the picker's helpers (D9)", () => {
  test("depsOf: direct deps in the config's order; empty for none or an unknown name", () => {
    load({ db: {}, api: { deps: ['db'] }, web: { deps: ['api'] } });
    expect(depsOf('db')).toEqual([]);
    expect(depsOf('api')).toEqual(['db']);
    expect(depsOf('web')).toEqual(['api']);
    expect(depsOf('ghost')).toEqual([]);
  });

  test('dependentsOf: the services that list it directly, in display order', () => {
    load({ db: {}, worker: { deps: ['db'] }, api: { deps: ['db'] }, web: { deps: ['api'] } });
    expect(dependentsOf('db')).toEqual(['api', 'worker']);
    expect(dependentsOf('api')).toEqual(['web']);
    expect(dependentsOf('web')).toEqual([]);
    expect(dependentsOf('ghost')).toEqual([]);
  });

  test('both helpers include services the picker shows no row for', () => {
    load({ proxy: { selectable: false }, codegen: { command: null, deps: ['proxy'] }, web: { deps: ['proxy'] } }); // oxfmt-ignore
    expect(dependentsOf('proxy')).toEqual(['codegen', 'web']);
    expect(depsOf('codegen')).toEqual(['proxy']);
  });

  test('with no selection the picker order is the most depended-on first, then by name', () => {
    load({ frontend: { deps: ['backend'] }, worker: {}, backend: {} });
    const names = getRegisteredPackages().map((p) => p.name);
    expect(displayOrder(names)).toEqual(['backend', 'frontend', 'worker']);
  });
});

describe('dependency locking, as the plan sees it (Review Focus 2)', () => {
  test('a dep picked by hand stays selected when its dependent goes', () => {
    load({ backend: {}, frontend: { deps: ['backend'] }, worker: {} });
    expect(why(['frontend', 'backend'])).toEqual({ backend: null, frontend: null });
    expect(why(['backend'])).toEqual({ backend: null });
  });

  test('a dep only pulled in leaves with its last dependent', () => {
    load({ backend: {}, frontend: { deps: ['backend'] }, admin: { deps: ['backend'] } });
    expect(why(['frontend', 'admin']).backend).toBe('runtime dep of admin');
    expect(why(['frontend'])).toEqual({ backend: 'runtime dep of frontend', frontend: null });
    expect(planSelection([]).services).toEqual([]);
  });

  test('the services that need a dep are its dependents, whatever is picked', () => {
    load({ backend: {}, frontend: { deps: ['backend'] }, worker: {} });
    expect(dependentsOf('backend')).toEqual(['frontend']);
    expect(depsOf('frontend')).toEqual(['backend']);
    expect(dependentsOf('worker')).toEqual([]);
  });
});

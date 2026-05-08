import {
  ArrowRuntimeNotInjectedError,
  type ArrowMemoryRuntime,
} from './memory-context-loader-types.js'

/**
 * Default Arrow runtime loader.
 *
 * ADR-0005 made the loader a first-class injectable: callers SHOULD pass
 * `config.loadArrowRuntime` (typically `() => import('@dzupagent/memory-ipc')`)
 * so the dependency is visible at the construction site. For backwards
 * compatibility this default retains a dynamic import behind a runtime
 * feature flag so existing call-sites and tests that rely on
 * `vi.mock('@dzupagent/memory-ipc', ...)` continue to work unchanged.
 *
 * Set `DZUPAGENT_REQUIRE_ARROW_INJECTION=1` to enforce explicit injection;
 * the loader will throw `ArrowRuntimeNotInjectedError` instead of falling
 * back to dynamic import. This flag will become the default in a future
 * major release.
 */
export async function defaultLoadArrowRuntime(): Promise<ArrowMemoryRuntime> {
  if (
    typeof process !== 'undefined' &&
    process.env != null &&
    process.env['DZUPAGENT_REQUIRE_ARROW_INJECTION'] === '1'
  ) {
    throw new ArrowRuntimeNotInjectedError()
  }
  // Back-compat dynamic import (ADR-0005). The module name is held in a
  // local variable so the loader source can be statically scanned for
  // unintended dynamic imports of memory-ipc.
  const moduleName = '@dzupagent/memory-ipc'
  return (await import(moduleName)) as unknown as ArrowMemoryRuntime
}

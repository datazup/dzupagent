/**
 * Leaf RBAC type definitions.
 *
 * Extracted from `./rbac.ts` to break a circular import between
 * `../types.ts` (which needs `ForgeRole` for `AppVariables.forgeRole`)
 * and `./rbac.ts` (which needs `AppEnv` for its `MiddlewareHandler`
 * return types). Keeping this file dependency-free preserves the cycle
 * fix even if either side grows new imports.
 */

export type ForgeRole = 'admin' | 'operator' | 'viewer' | 'agent'

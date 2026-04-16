/**
 * A2A protocol routes — re-export from modular split.
 *
 * This file preserves backward compatibility for existing imports.
 * The implementation now lives in ./a2a/ sub-modules.
 */
export { createA2ARoutes } from './a2a/index.js'
export type { A2ARoutesConfig } from './a2a/index.js'

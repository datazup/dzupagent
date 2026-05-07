// Re-export everything from the split modules for backwards compatibility.
//
// The original 1410-LOC `validate.ts` was split into per-node-kind modules
// under `./validate/` (MC-001). This file remains as the public entry point
// so all historical imports — including `import { flowNodeSchema } from
// '@dzupagent/flow-ast'` (via the package barrel) and any direct
// `from '.../validate.js'` imports — continue to resolve unchanged.
export * from './validate/index.js'

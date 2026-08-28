/**
 * @dzupagent/agent/pipeline — pipeline runtime, validation, checkpoint stores,
 * loop execution, retry policy, analytics, and pre-built templates.
 *
 * Use this subpath when embedding or extending the pipeline runtime without
 * pulling the full agent root barrel.
 *
 * Single authority: `./pipeline/index.ts` (ARCH27-T-08). This file must stay a
 * verbatim re-export so the `.`, `./pipeline`, and `./runtime` surfaces cannot
 * drift; parity is enforced by `__tests__/pipeline-barrel-parity.test.ts`.
 */

export * from './pipeline/index.js'

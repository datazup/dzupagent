/**
 * StructuredOutputAdapter public surface.
 *
 * The implementation is split across focused modules:
 *  - structured-output-types.ts     (public config/result types)
 *  - structured-output-parser.ts    (schema parse + observability helpers)
 *  - structured-output-retry.ts     (retry prompt + fallback collection helpers)
 *  - structured-output-executor.ts  (StructuredOutputAdapter)
 */

export { JsonOutputSchema, RegexOutputSchema } from '@dzupagent/core/pipeline'
export { StructuredOutputAdapter } from './structured-output-executor.js'
export type {
  OutputSchema,
  ParseResult,
  StructuredOutputConfig,
  StructuredRunResult,
} from './structured-output-types.js'

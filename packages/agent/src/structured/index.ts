/**
 * Structured output engine — barrel export.
 */
export type {
  StructuredOutputStrategy,
  StructuredOutputConfig,
  StructuredOutputResult,
} from './structured-output-types.js'

export {
  generateStructured,
  detectStrategy,
} from './structured-output-engine.js'

export type {
  StructuredLLM,
  StructuredLLMWithMeta,
} from './structured-output-engine.js'

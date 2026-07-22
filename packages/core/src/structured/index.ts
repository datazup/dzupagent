/**
 * Shared structured-output primitives — barrel export.
 */
export {
  JsonOutputSchema,
  RegexOutputSchema,
  extractJsonFromMarkdown,
  extractJsonFromText,
  toSchemaRef,
  createZodStructuredValidator,
} from './output-schema.js'
export type {
  OutputSchema,
  ParseResult,
} from './output-schema.js'

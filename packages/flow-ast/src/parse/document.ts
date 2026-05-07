/**
 * Top-level `parseFlow` entry point. Wraps {@link parseNode} with input
 * normalisation (JSON string vs. pre-parsed object) and aggregates errors.
 */

import {
  type ParseContext,
  type ParseError,
  type ParseInput,
  type ParseResult,
  describeJsType,
  extractJsonErrorPosition,
  isPlainObject,
} from './shared.js'
import { parseNode, parseNodeArray } from './dispatch.js'

/**
 * Parse a flow definition into a FlowNode AST.
 *
 * Accepts JSON (string) or a pre-parsed plain object. Errors are aggregated, not thrown —
 * the parser walks the entire structure and reports every issue it can recognise in one pass.
 *
 * If `ast` is non-null and `errors` is non-empty, the AST is partial: shape-recoverable
 * subtrees were preserved, unrecoverable nodes were dropped (and reported).
 */
export function parseFlow(input: ParseInput): ParseResult {
  const ctx: ParseContext = {
    errors: [],
    hasPositions: typeof input === 'string',
    parseNodeArray,
  }

  let raw: unknown
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const position = extractJsonErrorPosition(message, input)
      const error: ParseError = {
        code: 'INVALID_JSON',
        message,
        pointer: '',
      }
      if (position) error.position = position
      return { ast: null, errors: [error] }
    }
  } else {
    raw = input
  }

  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: 'NOT_AN_OBJECT',
      message: `Expected top-level value to be an object, received ${describeJsType(raw)}`,
      pointer: '',
    })
    return { ast: null, errors: ctx.errors }
  }

  const ast = parseNode(raw, '', ctx)
  return { ast, errors: ctx.errors }
}

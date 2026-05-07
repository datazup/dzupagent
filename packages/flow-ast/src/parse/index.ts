/**
 * Public barrel for the per-node-kind parse split.
 *
 * Re-exports cover the entire historical surface of the original `parse.ts`:
 *   - the `ParseInput` / `ParseErrorCode` / `ParseError` / `ParseResult` types
 *   - the `parseFlow(input)` entry point
 *
 * Per-node-kind parser functions (`parseAction`, `parseSequence`, etc.) and
 * the shared `ParseContext` / helper utilities live in sibling files but are
 * intentionally NOT re-exported — the historical `parse.ts` kept those
 * private and we preserve that surface contract here.
 */

export type { ParseInput, ParseErrorCode, ParseError, ParseResult } from './shared.js'
export { parseFlow } from './document.js'

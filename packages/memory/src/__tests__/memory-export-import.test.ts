import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held ~65 table rows (348 lines) that imported NOTHING
 * but vitest. `exportMemories`, `parseDump`, `importMemories` and `roundTrip`
 * were all defined locally at lines 41-118, and the central table asserted
 *
 *     expect(read(parseDump(exportMemories(fixtures)))).toBeTruthy()
 *
 * on values the test itself had just constructed (`dump.version` is the literal
 * `1`, `dump.encoding` the literal `'utf-8-json'`). The whole file was
 * tautological: it could not fail even against its own local implementation.
 *
 * UNTESTED PRODUCTION SYMBOLS this file appeared to cover:
 *   - `AgentFileExporter` — packages/memory/src/agent-file/exporter.ts:63
 *   - `AgentFileImporter` — packages/memory/src/agent-file/importer.ts:29
 * Neither was ever imported here. Export/import round-tripping, dump-version
 * handling and encoding negotiation are genuinely uncovered.
 *
 * Removed 2026-07-27.
 */
describe.skip('memory export/import (production exporter/importer untested)', () => {
  it('needs tests against AgentFileExporter / AgentFileImporter', () => {})
})

import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 60 `it()` blocks (1141 lines) against a
 * `SemanticChunker` DEFINED AT LINE 111. Its own header said so: "using a
 * self-contained SemanticChunker implementation that mirrors the SmartChunker
 * contract in @dzupagent/rag".
 *
 * The production symbol is `SmartChunker`, exported from
 * packages/rag/src/index.ts:10. Unlike the other files in this cleanup,
 * `SmartChunker` DOES have genuine coverage of its own in
 * packages/rag/src/__tests__/chunker.test.ts and neighbours — so the shipped
 * code is not wholly untested. These 60 tests simply contributed nothing to
 * that coverage while appearing to.
 *
 * NOTE: packages/rag/src/__tests__/minimal-chunker.test.ts has its own
 * weakness — several assertions sit inside `for (const chunk of result)` with
 * no non-empty guard, so an empty return turns them green. Worth closing,
 * since that file carries the real SmartChunker coverage.
 *
 * Removed 2026-07-27.
 */
describe.skip('semantic chunking (real coverage lives in @dzupagent/rag)', () => {
  it('duplicated SmartChunker locally; see rag/__tests__/chunker.test.ts', () => {})
})

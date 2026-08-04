import { describe, it } from "vitest";

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 90 `it()` blocks (1,279 lines) exercising a
 * `ContextManager` class DEFINED LOCALLY at line 72 (token counting, window
 * overflow detection, oldest-first/summary/priority-based truncation,
 * role-based priority assignment, retention guarantees, snapshot
 * serialize/deserialize, reserve-token budgeting, and overflow callbacks).
 * The only production import in the file was `HeuristicTokenizer`
 * (`../llm/tokenizer.js`) — a single dependency, never the subject under
 * test. A repo-wide grep for `ContextManager` returns zero non-test source
 * files across all 36 packages: no such class ships anywhere. This is the
 * DZUPAGENT-TEST-C-14 sweep the `3ce9fedd` cleanup missed — same pathology,
 * same fix, applied here 2026-07-31.
 *
 * UNTESTED PRODUCTION SYMBOLS — real context-window management ships in
 * `@dzupagent/context`, none of it imported here:
 *   - `PhaseAwareWindowManager` — packages/context/src/phase-window.ts
 *     (configurable window size, phase-aware retention — closest real
 *     analog to this file's "window overflow" / "multi-turn preservation"
 *     claims)
 *   - `evictIfNeeded` / `evictWithOffload` — packages/context/src/context-eviction.ts
 *     (the real truncation/eviction strategies this file's local
 *     oldest-first/priority-based truncation claimed to cover)
 *   - `shouldSummarize` / `summarizeAndTrim` — packages/context/src/message-manager.ts
 *     (the real summary-truncation strategy this file's local
 *     `TruncationStrategy: "summary"` branch claimed to cover)
 *   - `autoCompress` / `FrozenSnapshot` — packages/context/src/auto-compress.ts
 *     (the real compression pipeline and snapshot type this file's local
 *     `snapshot()`/`restore()` claimed to cover)
 * None of the four are imported here, so their token-budget, retention, and
 * overflow-callback behaviour as actually shipped is genuinely uncovered by
 * this suite (they may or may not be covered elsewhere in `@dzupagent/context`'s
 * own `__tests__` — not verified as part of this pass).
 *
 * Removed 2026-07-31 (DZUPAGENT-TEST-C-14).
 */
describe.skip("context management (production window/truncation/compression logic in @dzupagent/context untested by this suite)", () => {
  it("needs tests against PhaseAwareWindowManager (packages/context/src/phase-window.ts)", () => {});
  it("needs tests against evictIfNeeded / evictWithOffload (packages/context/src/context-eviction.ts)", () => {});
  it("needs tests against shouldSummarize / summarizeAndTrim (packages/context/src/message-manager.ts)", () => {});
  it("needs tests against autoCompress / FrozenSnapshot (packages/context/src/auto-compress.ts)", () => {});
});

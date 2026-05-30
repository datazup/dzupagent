# Code Quality — Quick Fixes (P1, < 2h slices)

Each task is a self-contained slice from a larger P1 finding. Apply one at a time.

---

## QF-001: Hoist `mcp.ts` console errors to `defaultLogger`

**Finding:** CODE-009
**Files:** `packages/server/src/routes/mcp.ts:171,267,285,301,320,350,399,430`
**Change:**
1. Import `defaultLogger` from `@dzupagent/core/utils/logger` (or the right subpath).
2. Replace each `console.error(\`[mcp] ${internal}\`)` with `defaultLogger.error('[mcp]', internal)` (or extract a `logMcpError(internal: string)` local helper at the top of the file).
3. Do not change behaviour — only the routing.

**Validation:**
```bash
yarn workspace @dzupagent/server lint
yarn workspace @dzupagent/server typecheck
yarn workspace @dzupagent/server test
grep -c "console\." packages/server/src/routes/mcp.ts   # expect 0
```

**Target agent:** dzupagent-core-dev (server is in maintenance mode but logger swap is allowed maintenance per CLAUDE.md).

---

## QF-002: Replace `config.mcpManager!.…` with a narrow `requireMcp(config)` helper

**Finding:** CODE-010
**Files:** `packages/server/src/routes/mcp.ts` (14 occurrences across lines 118-430)
**Change:**
1. Add at top of file:
   ```ts
   function requireMcp(config: ServerConfig): NonNullable<ServerConfig['mcpManager']> {
     if (!config.mcpManager) {
       throw new ForgeError('MCP_NOT_CONFIGURED', 'mcp routes registered without mcpManager')
     }
     return config.mcpManager
   }
   ```
2. At the start of each route handler, replace `config.mcpManager!.method(...)` with:
   ```ts
   const mcp = requireMcp(config)
   await mcp.method(...)
   ```
3. Run grep to confirm no `!\.` remain.

**Validation:**
```bash
yarn workspace @dzupagent/server typecheck
yarn workspace @dzupagent/server test
grep -cE "config\.mcpManager\!" packages/server/src/routes/mcp.ts   # expect 0
```

**Target agent:** dzupagent-core-dev

---

## QF-003: Replace non-null `!.` in `memory/retrieval/void-filter.ts`

**Finding:** CODE-011
**Files:** `packages/memory/src/retrieval/void-filter.ts` (6 occurrences)
**Change:** For each `arr[i]!.field` or `map.get(k)!`, introduce an explicit guard:
```ts
const item = arr[i]
if (!item) continue   // or: throw new Error('invariant: ...') if truly impossible
// ... use item.field
```
For map lookups: `const v = map.get(k); if (v === undefined) { … }`

**Validation:**
```bash
yarn workspace @dzupagent/memory typecheck
yarn workspace @dzupagent/memory test
grep -cE "[a-zA-Z_0-9\)\]]\![\.\[]" packages/memory/src/retrieval/void-filter.ts   # expect 0
```

**Target agent:** dzupagent-core-dev

---

## QF-004: Replace `composition/middleware.ts` `config.X!` with destructure-and-guard

**Finding:** CODE-010
**Files:** `packages/server/src/composition/middleware.ts:188,355,373,378`
**Change:** At each handler, destructure: `const { apiKeyStore, shutdown, metrics } = config`; check `if (!apiKeyStore) throw new ForgeError('MISSING_API_KEY_STORE', …)` once at the top of the closure. Use unboxed names afterwards.

**Validation:**
```bash
yarn workspace @dzupagent/server lint
yarn workspace @dzupagent/server test
```

**Target agent:** dzupagent-core-dev

---

## QF-005: Add `MdMemoryEntry` rename in agent-adapters memory-loader

**Finding:** CODE-004
**Files:** `packages/agent-adapters/src/dzupagent/memory-loader.ts:30`
**Change:** Rename `export interface MemoryEntry` → `export interface MdMemoryEntry`. Update all references inside the same package; then re-export it from `agent-adapters/src/index.ts` aliased as `MemoryEntry` if any external consumer relies on the old name (verify by greping `apps/` and `shared-kit/` workspace).

**Validation:**
```bash
yarn typecheck
grep -rn "export interface MemoryEntry" packages/*/src   # expect ≤ 1 result (memory/consolidation-types.ts only)
```

**Target agent:** dzupagent-core-dev

---

## QF-006: Wire `eval-contracts` shared schema into existing test

**Finding:** CODE-023
**Files:** `packages/eval-contracts/src/__tests__/contracts.test.ts`
**Change:** Add per-file assertions: import each of `benchmark-types.ts`, `eval-types.ts`, `orchestrator-contracts.ts`, `store-contracts.ts` and assert their type-shape via small example values. Confirms each barrel exports remain stable.

**Validation:**
```bash
yarn workspace @dzupagent/eval-contracts test
```

**Target agent:** dzupagent-test-dev

---

## QF-007: Extract `defaults.retry` validation in `flow-ast/validate.ts`

**Finding:** CODE-017 (slice)
**Files:** `packages/flow-ast/src/validate.ts:1370-1410`
**Change:** Pull the inner `if 'retry' in value` block out into `validateRetryDefaults(retry: unknown, parentPath: string, issues: SchemaIssue[]): void`. Replace the inline body with a call.

**Validation:**
```bash
yarn workspace @dzupagent/flow-ast test
yarn workspace @dzupagent/flow-ast typecheck
```

**Target agent:** dzupagent-core-dev

---

## QF-008: Append removal milestone to `agent/src/index.ts` `@deprecated` lines

**Finding:** CODE-020
**Files:** `packages/agent/src/index.ts:495-586`
**Change:** Open the file. For each `/** @deprecated Import from … */` line, append ` (removing in next major)` or use the actual planned version. The exact text must include `REMOVING in` so future grepping is consistent. Pure documentation — no code change.

**Validation:**
```bash
grep -c "@deprecated.*REMOVING in" packages/agent/src/index.ts   # expect ≥ 30
```

**Target agent:** dzupagent-core-dev

---

## QF-009: Add `confidence-calculator.ts` smoke test

**Finding:** CODE-006 (slice)
**Files:**
- New: `packages/server/src/__tests__/deploy/confidence-calculator.test.ts`
- SUT: `packages/server/src/deploy/confidence-calculator.ts`
**Change:** Add at minimum 6 cases:
1. Zero history → confidence below threshold
2. All recent successes → confidence at max
3. Single recent failure → confidence drops proportional to weight
4. Mixed signals (success + degradation alert) → confidence below "all clear"
5. Stale data older than window → ignored
6. Invalid input shape → throws or returns `{ confidence: 0, reasons: [...] }` per current contract

**Validation:**
```bash
yarn workspace @dzupagent/server test confidence-calculator
```

**Target agent:** dzupagent-test-dev

---

## QF-010: Add `probe-collector.ts` smoke test

**Finding:** CODE-006 (slice)
**Files:**
- New: `packages/server/src/__tests__/scorecard/probe-collector.test.ts`
- SUT: `packages/server/src/scorecard/probe-collector.ts`
**Change:** Mock 3+ probe sources; assert aggregation correctness, error swallowing, and timeout behaviour for one source not responding.

**Validation:**
```bash
yarn workspace @dzupagent/server test probe-collector
```

**Target agent:** dzupagent-test-dev

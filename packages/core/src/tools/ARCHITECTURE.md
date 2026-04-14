# Tools Subsystem Architecture (`packages/core/src/tools`)

## Scope
This folder contains two reusable framework utilities:

1. `ToolGovernance` (`tool-governance.ts`)
2. `ToolStatsTracker` (`tool-stats-tracker.ts`)

Both are exported from `@dzupagent/core` and intended for use by higher-level runtime packages.

---

## Public API Surface

### `ToolGovernance`
Exported symbols:

- `ToolGovernance`
- `ToolGovernanceConfig`
- `ToolValidationResult`
- `ToolAuditHandler`
- `ToolAuditEntry`
- `ToolResultAuditEntry`
- `ToolAccessResult`

### `ToolStatsTracker`
Exported symbols:

- `ToolStatsTracker`
- `ToolCallRecord`
- `ToolStats`
- `ToolRanking`
- `ToolStatsTrackerConfig`

### Re-export location
These are re-exported in:

- `packages/core/src/index.ts` (lines 834-851)

---

## Design Intent

### 1) Governance plane (`ToolGovernance`)
`ToolGovernance` is a synchronous policy gate around tool invocation decisions:

- Blocklist enforcement
- Approval requirement tagging
- Per-tool rate limiting
- Custom validation hook
- Audit callbacks for call/result logging

It is intentionally lightweight and framework-agnostic.

### 2) Feedback plane (`ToolStatsTracker`)
`ToolStatsTracker` is an in-memory analytics component for adaptive tool preference:

- Tracks per-tool outcomes (success/failure, latency, optional intent)
- Produces aggregate stats (success rate, avg latency, p95, top errors)
- Ranks tools with a weighted success/speed score
- Formats rankings into a prompt hint string for LLM guidance

---

## Component Deep Dive

## A) `ToolGovernance`

Source: `packages/core/src/tools/tool-governance.ts`

### Configuration contract

- `blockedTools?: string[]`
- `approvalRequired?: string[]`
- `rateLimits?: Record<string, number>` (max calls/minute per tool)
- `maxExecutionMs?: number`
- `validator?: (toolName, input) => ToolValidationResult`
- `auditHandler?: ToolAuditHandler`

### Access-check order
`checkAccess(toolName, input)` evaluates in strict order:

1. Blocklist (`blockedTools`)
2. Rate limit (`rateLimits`)
3. Custom validator (`validator`)
4. Approval tagging (`approvalRequired`)
5. Allow

The first rejecting condition returns immediately.

### Runtime state

- Maintains `rateCounts: Map<string, { count: number; windowStart: number }>`
- Window length is fixed at 60 seconds
- Rate limits are isolated per tool key
- `resetRateLimits()` clears all counters

### Audit semantics

- `audit(entry)` calls `auditHandler.onToolCall(entry)`
- `auditResult(entry)` calls `auditHandler.onToolResult?.(entry)`
- Any audit-handler exception is swallowed intentionally (non-fatal telemetry path)

### Current limitation

- `maxExecutionMs` exists in `ToolGovernanceConfig` but is not enforced by this class.
- Callers that need timeout enforcement must implement it around actual tool execution.

### Call flow

```text
Caller -> checkAccess(toolName, input)
  -> blockedTools?            yes => deny
  -> rateLimits exceeded?     yes => deny
  -> validator returns invalid? yes => deny
  -> approvalRequired match?  yes => allow + requiresApproval=true
  -> allow
Caller (optional) -> audit(...)
Caller (optional) -> auditResult(...)
```

### Example usage

```ts
import { ToolGovernance } from '@dzupagent/core'

const governance = new ToolGovernance({
  blockedTools: ['rm_rf'],
  approvalRequired: ['deploy_prod'],
  rateLimits: { search_web: 30 },
  validator: (toolName, input) => {
    if (toolName === 'shell_exec' && typeof input === 'object' && input !== null) {
      const cmd = String((input as { cmd?: unknown }).cmd ?? '')
      if (cmd.includes('sudo')) return { valid: false, reason: 'sudo is not allowed' }
    }
    return { valid: true }
  },
})

const access = governance.checkAccess('deploy_prod', { env: 'prod' })
if (!access.allowed) throw new Error(access.reason)
if (access.requiresApproval) {
  // trigger human approval workflow here
}
```

---

## B) `ToolStatsTracker`

Source: `packages/core/src/tools/tool-stats-tracker.ts`

### Data model

Each record (`ToolCallRecord`) captures:

- `toolName`
- `intent?` (optional scenario label such as `debug`, `codegen`, `deploy`)
- `success`
- `durationMs`
- `timestamp`
- `errorType?`

Per-tool history is stored in a map:

- `Map<string, ToolCallRecord[]>`

### Sliding-window behavior

- Default max records per tool: `200`
- Configurable via `windowSize`
- On overflow, oldest records are removed first

### Aggregate metrics (`getStats`)

For a tool, returns:

- `totalCalls`, `successCount`, `failureCount`
- `successRate`
- `avgDurationMs`
- `p95DurationMs`
- `lastUsed`
- `topErrors` sorted by frequency descending

### Ranking algorithm (`getTopTools`)

For each tool (optionally filtered by `intent`):

1. Compute success rate
2. Compute average latency
3. Normalize speed as `1 - avgLatency / maxAvgLatency` (clamped to `[0,1]`)
4. Combine:

```text
score = successRate * successWeight + normalizedSpeed * latencyWeight
```

Defaults:

- `successWeight = 0.7`
- `latencyWeight = 0.3`

Output is sorted descending by score.

### Prompt-hint generation
`formatAsPromptHint(limit?, intent?)` returns:

- `''` when no ranking data exists
- Otherwise:
  - Header: `Preferred tools for this task:`
  - Numbered list with `toolName` and rounded success %

### Call flow

```text
Tool execution completed
  -> recordCall(...)
  -> (later) getTopTools(limit, intent)
  -> (optional) formatAsPromptHint(limit, intent)
  -> inject into system prompt
```

### Example usage

```ts
import { ToolStatsTracker } from '@dzupagent/core'

const tracker = new ToolStatsTracker({
  windowSize: 300,
  successWeight: 0.8,
  latencyWeight: 0.2,
})

tracker.recordCall({
  toolName: 'read_file',
  intent: 'debug',
  success: true,
  durationMs: 42,
  timestamp: Date.now(),
})

tracker.recordCall({
  toolName: 'run_tests',
  intent: 'debug',
  success: false,
  durationMs: 2500,
  timestamp: Date.now(),
  errorType: 'TIMEOUT',
})

const hint = tracker.formatAsPromptHint(5, 'debug')
// "Preferred tools for this task:\n1. read_file (100% success)\n..."
```

---

## Cross-Package References and Usage

## Where this tools subsystem is consumed

### 1) `@dzupagent/agent` tool-loop hint injection path (active runtime integration)

Relevant files:

- `packages/agent/src/agent/agent-types.ts`
- `packages/agent/src/agent/run-engine.ts`
- `packages/agent/src/agent/tool-loop.ts`

How it works:

1. `DzupAgentConfig` accepts:
   - `toolStatsTracker?: { formatAsPromptHint(limit?, intent?) => string }`
2. `run-engine.ts` forwards `config.toolStatsTracker` and call-level `intent` into `runToolLoop`.
3. `tool-loop.ts` invokes `formatAsPromptHint(5, intent)` on each iteration.
4. If non-empty, it inserts a system message prefixed by `Tool performance hint:`.
5. Before each new iteration, previous hint is removed and replaced (no accumulation).

Key point:

- Agent package uses structural typing and does not import `ToolStatsTracker` directly.
- Any compatible object can be supplied, including `new ToolStatsTracker()`.

### 2) `ToolGovernance` runtime adoption status

Search results show:

- Exported by core
- Directly tested in `packages/core`
- No current integration in other package runtime paths in this repo snapshot

This means governance is currently an available building block, not a default-enforced runtime layer.

### 3) `recordCall` producer status for `ToolStatsTracker`

Current repo state:

- `ToolStatsTracker.recordCall(...)` is exercised in core tests
- No runtime caller found in non-test package code

Practical implication:

- If you pass a fresh tracker to `DzupAgentConfig.toolStatsTracker` without externally recording calls, hints remain empty.
- To realize adaptive ranking, callers must feed records into tracker from tool execution telemetry.

---

## Usage Patterns

## Pattern A: Governance wrapper around tool execution

Use `ToolGovernance` before invoking a tool:

```ts
const access = governance.checkAccess(toolName, input)
await governance.audit({
  toolName,
  input,
  callerAgent: agentId,
  timestamp: Date.now(),
  allowed: access.allowed,
  blockedReason: access.reason,
})
if (!access.allowed) throw new Error(access.reason)
```

Then audit result:

```ts
await governance.auditResult({
  toolName,
  output,
  callerAgent: agentId,
  durationMs,
  success,
  timestamp: Date.now(),
})
```

## Pattern B: Adaptive prompt hints in agent runs

```ts
import { DzupAgent } from '@dzupagent/agent'
import { ToolStatsTracker } from '@dzupagent/core'

const tracker = new ToolStatsTracker()

const agent = new DzupAgent({
  id: 'assistant',
  instructions: '...',
  model,
  tools,
  toolStatsTracker: tracker,
})

// IMPORTANT: ensure tracker.recordCall(...) is fed by your runtime telemetry
```

---

## Test Coverage

## Test files directly covering this folder

- `packages/core/src/__tests__/tool-governance.test.ts` (9 tests)
- `packages/core/src/__tests__/tool-stats-tracker.test.ts` (20 tests)

Validated via focused run:

- Core tool tests: 29/29 passing

Command:

- `yarn workspace @dzupagent/core test -- src/__tests__/tool-governance.test.ts src/__tests__/tool-stats-tracker.test.ts`

## Cross-package integration tests for tool hint wiring

- `packages/agent/src/__tests__/tool-stats-wiring.test.ts` (8 tests)

Validated via focused run:

- Agent wiring tests: 8/8 passing

Command:

- `yarn workspace @dzupagent/agent test -- src/__tests__/tool-stats-wiring.test.ts`

## Focused per-module coverage metrics

A focused `--coverage` run for the two core tool tests produced:

- `src/tools/tool-governance.ts`
  - Statements: `95.77%`
  - Branches: `96.00%`
  - Functions: `85.71%`
  - Lines: `95.77%`
  - Uncovered lines: `114-119` (`auditResult` exception-swallow path detail)

- `src/tools/tool-stats-tracker.ts`
  - Statements: `99.54%`
  - Branches: `93.10%`
  - Functions: `100%`
  - Lines: `99.54%`
  - Uncovered line: `137` (one normalization branch path)

Note on command exit:

- The focused coverage command exits non-zero due to global package thresholds being evaluated across all `core` files, not just `src/tools`.
- The per-file metrics above are still valid and extracted from that run output.

Command used:

- `yarn workspace @dzupagent/core test:coverage -- src/__tests__/tool-governance.test.ts src/__tests__/tool-stats-tracker.test.ts`

---

## Risk and Gap Summary

1. `ToolGovernanceConfig.maxExecutionMs` is declared but not implemented in governance logic.
2. `ToolGovernance` is not yet wired into non-test runtime flows across other packages.
3. `ToolStatsTracker` hint consumer exists in `@dzupagent/agent`, but no built-in runtime producer currently records tool calls into tracker.

If these gaps are intentional (opt-in architecture), current behavior is consistent. If not, they are the highest-value integration opportunities.

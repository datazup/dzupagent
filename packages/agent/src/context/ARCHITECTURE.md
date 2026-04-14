# Context Module Architecture (`packages/agent/src/context`)

Last updated: 2026-04-04

## 1. Scope and Responsibility

`packages/agent/src/context` is a thin compatibility layer in `@dzupagent/agent`.

It does not implement compression logic directly. Instead, it re-exports context compression primitives from `@dzupagent/context` so existing consumers can continue importing these APIs from `@dzupagent/agent`.

Current file in this folder:
- `auto-compress.ts`

## 2. File-Level Behavior

### 2.1 `auto-compress.ts`

Implementation:
- Re-exports runtime APIs:
  - `autoCompress`
  - `FrozenSnapshot`
- Re-exports types:
  - `AutoCompressConfig`
  - `CompressResult`

Source reference:
- `packages/agent/src/context/auto-compress.ts:1-6`

Design intent explicitly stated in file header:
- "This module exists for backward compatibility with existing agent imports."

## 3. Public API Surface Exposed via `@dzupagent/agent`

The root `@dzupagent/agent` entrypoint re-exports this folder under the `// --- Context ---` section:
- `packages/agent/src/index.ts:131-133`

Because `packages/agent/package.json` only exports `"."` (no subpath export), consumers should import from the package root:

```ts
import { autoCompress, FrozenSnapshot } from '@dzupagent/agent'
import type { AutoCompressConfig, CompressResult } from '@dzupagent/agent'
```

References:
- `packages/agent/package.json:7-12`
- `packages/agent/src/index.ts:131-133`

## 4. Runtime Architecture (Delegated Implementation)

Although this folder is a shim, the behavior it exposes comes from:
- `packages/context/src/auto-compress.ts`
- `packages/context/src/message-manager.ts`

### 4.1 Flow: `autoCompress`

`autoCompress(messages, existingSummary, model, config)` pipeline:

1. Trigger check (`shouldSummarize`)
- Compression runs only if thresholds are exceeded.
- Thresholds include message-count and estimated token budget.

2. Optional pre-summarize hook
- If compression triggers and there are old messages beyond `keepRecentMessages`, `onBeforeSummarize` is called with messages that are about to be summarized away.
- Hook failures are swallowed (non-fatal).

3. Summarize-and-trim pipeline (`summarizeAndTrim`)
- Prune older tool result payloads.
- Align split boundary to avoid breaking tool-call/result groups.
- Repair orphaned tool pairs in retained messages.
- Summarize historical messages using a structured summary template.
- Fall back to trimming-only if LLM summarization fails.

4. Return
- `messages`: trimmed/repaired retained message list
- `summary`: updated summary (or existing/fallback summary)
- `compressed: true` when summarize path executed

Primary references:
- `packages/context/src/auto-compress.ts:47-82`
- `packages/context/src/message-manager.ts:249-262`
- `packages/context/src/message-manager.ts:276-338`

### 4.2 Flow: `FrozenSnapshot`

`FrozenSnapshot` is a tiny state holder used by callers to freeze a context prefix across turns:
- `freeze(context)` stores context and marks active
- `get()` returns stored context (or `null`)
- `isActive()` returns freeze state
- `thaw()` clears state

Reference:
- `packages/context/src/auto-compress.ts:92-117`

## 5. Feature Matrix (What This Folder Exposes)

### 5.1 `autoCompress`

Description:
- One-call orchestration entrypoint for context compression.

Key behaviors:
- Threshold-based activation.
- Tool-output pruning and tool-call boundary safety.
- Structured summarization update workflow.
- Failure-tolerant hook and LLM fallback behavior.

Config inherited from `MessageManagerConfig` includes:
- `maxMessages` (default 30)
- `keepRecentMessages` (default 10)
- `maxMessageTokens` (default 12000)
- `charsPerToken` (default 4)
- `preserveRecentToolResults` (default 6)
- `prunedToolResultMaxChars` (default 120)

References:
- `packages/context/src/message-manager.ts:22-44`
- `packages/context/src/auto-compress.ts:22-33`

### 5.2 `FrozenSnapshot`

Description:
- Session-local context freeze/thaw utility to stabilize prompt prefixes.

Typical benefits:
- Helps preserve cache-friendly prefixes in repeated calls.
- Useful when memory context should not mutate mid-session.

Reference:
- `packages/context/src/auto-compress.ts:84-117`

## 6. Usage Examples

### 6.1 Basic auto-compress via `@dzupagent/agent`

```ts
import { autoCompress } from '@dzupagent/agent'

const result = await autoCompress(messages, summary, model, {
  maxMessages: 30,
  keepRecentMessages: 10,
})

messages = result.messages
summary = result.summary
```

### 6.2 Capture "about-to-be-lost" context before summarization

```ts
import { autoCompress } from '@dzupagent/agent'

const extracted: string[] = []

await autoCompress(messages, summary, model, {
  onBeforeSummarize: (oldMessages) => {
    extracted.push(...oldMessages.map(m => String(m.content)))
  },
})
```

### 6.3 Frozen snapshot lifecycle

```ts
import { FrozenSnapshot } from '@dzupagent/agent'

const snapshot = new FrozenSnapshot()

if (!snapshot.isActive()) {
  snapshot.freeze(systemAndMemoryContext)
}

const stablePrefix = snapshot.get()

// At session end:
snapshot.thaw()
```

## 7. Use Cases

1. Long-running coding sessions
- Frequent tool outputs and iterative turns can exceed context limits.
- `autoCompress` keeps recent context while summarizing older history.

2. Tool-heavy workflows
- Old tool payloads are expensive in tokens.
- Pruning + boundary repair keeps protocol-safe message history.

3. Memory extraction before compression
- `onBeforeSummarize` allows persisting observations before old turns are compacted.

4. Prompt-cache-oriented sessions
- `FrozenSnapshot` allows caller-controlled stable context prefixes across turns.

## 8. Cross-Package References and Usage

### 8.1 Direct references to this folder

- `packages/agent/src/index.ts:132-133`
  - Re-exports this folder's APIs as part of `@dzupagent/agent` root API.

No other source file imports `packages/agent/src/context/auto-compress.ts` directly.

### 8.2 Upstream implementation provider

- `packages/context/src/index.ts:20-21`
  - Exports `autoCompress`, `FrozenSnapshot`, and types consumed by this shim.

### 8.3 Related re-export hub usage in other package

- `packages/core/src/index.ts:248-290`
  - `@dzupagent/core` also re-exports these context primitives directly from `@dzupagent/context`.

### 8.4 Template-level ecosystem usage

Scaffolding templates and feature overlays declare `@dzupagent/context` dependency, indicating intended usage in generated apps:
- `packages/create-dzupagent/src/features.ts:184-187`
- `packages/create-dzupagent/src/templates/package-json.ts:73-76`
- `packages/create-dzupagent/src/templates/full-stack.ts:91-97`
- `packages/create-dzupagent/src/templates/production-saas-agent.ts:305`
- `packages/create-dzupagent/src/templates/secure-internal-assistant.ts:218`

### 8.5 Observed in-repo import usage from `@dzupagent/agent`

No direct imports of `autoCompress` or `FrozenSnapshot` from `@dzupagent/agent` were found in workspace TypeScript sources at analysis time.

Implication:
- This module currently serves primarily as stable API compatibility surface for external consumers.

## 9. Test Coverage and Validation

## 9.1 Tests that validate exposed behavior (in upstream `@dzupagent/context`)

Primary suites:
- `packages/context/src/__tests__/auto-compress-extended.test.ts`
  - Covers threshold behavior, token-triggered compression, existing-summary handling, hook semantics, LLM-failure fallback, tool-message handling, custom config behavior, and full `FrozenSnapshot` lifecycle.
- `packages/context/src/__tests__/context.integration.test.ts`
  - Covers integration of pruning + compression + freeze/thaw behavior.

References:
- `packages/context/src/__tests__/auto-compress-extended.test.ts:52-217`
- `packages/context/src/__tests__/auto-compress-extended.test.ts:223-284`
- `packages/context/src/__tests__/context.integration.test.ts:49-97`

### 9.2 Executed verification in this analysis

Command:
```bash
yarn workspace @dzupagent/context test src/__tests__/auto-compress-extended.test.ts src/__tests__/context.integration.test.ts
```

Result:
- 2 test files passed
- 23 tests passed

Command:
```bash
yarn workspace @dzupagent/context test:coverage
```

Result summary:
- 9 test files passed
- 224 tests passed
- Package coverage (`@dzupagent/context`):
  - Statements: 91.46%
  - Branches: 93.11%
  - Functions: 95.31%
  - Lines: 91.46%
- File-level coverage relevant to this folder's exports:
  - `auto-compress.ts`: 100% statements/branches/functions/lines
  - `message-manager.ts`: 97.98% statements, 90.16% branches, 100% functions, 97.98% lines

### 9.3 Coverage posture for `packages/agent/src/context`

- No dedicated tests in `packages/agent/src/__tests__` target the shim file directly.
- Risk is low because shim logic is re-export-only, but there is no explicit contract test in `@dzupagent/agent` that asserts these exports remain wired.

Suggested hardening:
- Add a lightweight export-contract test in `packages/agent/src/__tests__` asserting `autoCompress` and `FrozenSnapshot` are available from `@dzupagent/agent`.

## 10. Findings and Design Notes

1. This folder is intentionally minimal and stable.
- Good for backward compatibility and public API continuity.

2. `AutoCompressConfig.frozenSnapshot` exists but is not used by runtime logic.
- Declared at `packages/context/src/auto-compress.ts:24`.
- No implementation references were found in `packages/context` or `packages/agent` source.
- Current freeze behavior is driven by explicit caller-managed `FrozenSnapshot` usage.

3. Functionality ownership is clearly separated.
- `@dzupagent/agent` exposes context compression ergonomically.
- `@dzupagent/context` owns implementation and tests.

## 11. Practical Guidance

When to use this API from `@dzupagent/agent`:
- You want a single import surface for agent runtime + context compression utilities.
- You need backward-compatible imports without moving call sites to `@dzupagent/context`.

When to import directly from `@dzupagent/context` instead:
- You need additional context utilities not re-exported through this folder (for example `createExtractionHook`, `PhaseAwareWindowManager`, progressive compression helpers).

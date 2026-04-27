# `src/instructions` Architecture

## Scope
This document describes `packages/agent/src/instructions` in `@dzupagent/agent` and how it is used by the runtime instruction resolver in `packages/agent/src/agent/instruction-resolution.ts`.

The scope includes:
- Parsing AGENTS.md text into a typed hierarchy.
- Discovering AGENTS.md files from the filesystem.
- Merging static `DzupAgentConfig.instructions` with AGENTS-derived sections.
- Utility hierarchy discovery/merging helpers exported from the package surface.

Out of scope:
- Caching, concurrency deduplication, and fallback behavior policy (implemented in `AgentInstructionResolver`).
- Message preparation/memory wiring (implemented in `DzupAgent`).

## Responsibilities
`src/instructions` is a pure composition layer for instruction content:
- `parseAgentsMd` converts markdown heading sections into `AgentsMdSection[]` trees.
- `mergeAgentsMd` merges multiple section layers (later layers override scalar fields; list fields are union-deduped).
- `discoverAgentsMdHierarchy` discovers AGENTS.md files from optional global dir and cwd ancestors.
- `loadAgentsFiles` recursively scans a project subtree for AGENTS files and parses each file.
- `mergeInstructions` renders a final system prompt by combining static instructions with relevant AGENTS sections.

It intentionally does not hold state or emit events.

## Structure
| File | Role |
| --- | --- |
| `agents-md-parser.ts` | Core parser plus layer merge (`mergeAgentsMd`) and ancestor/global discovery (`discoverAgentsMdHierarchy`). |
| `instruction-loader.ts` | Recursive filesystem loader for AGENTS files (`loadAgentsFiles`). |
| `instruction-merger.ts` | Prompt composer (`mergeInstructions`) and agent-target filtering. |
| `index.ts` | Local barrel for this module. |

Related integration files outside this folder:
- `src/agent/instruction-resolution.ts`: runtime orchestration, caching, and fallback.
- `src/agent/agent-types.ts`: `instructionsMode` and `agentsDir` config surface.
- `src/index.ts`: package-level exports for all instruction APIs/types.

## Runtime and Control Flow
Normal runtime path when `DzupAgent` is configured with `instructionsMode: 'static+agents'`:
1. `DzupAgent` creates `AgentInstructionResolver` with `agentId`, static `instructions`, mode, and optional `agentsDir`.
2. `AgentInstructionResolver.resolve()` executes `loadAndMergeInstructions()` on first call and caches the merged result.
3. `loadAgentsFiles()` scans `agentsDir` (or `process.cwd()`) up to `maxDepth` (default `5`), skipping known heavy dirs and simple `.gitignore` matches.
4. Each discovered file is parsed via `parseAgentsMd()` into section trees.
5. Resolver flattens sections from all files and calls `mergeInstructions(static, allSections, agentId, filePaths)`.
6. `mergeInstructions()` optionally filters to the target agent subtree, renders markdown-like sections, and returns `systemPrompt` + metadata.
7. Resolver returns the merged `systemPrompt`; subsequent calls reuse cache.

Fallback path:
- Any loader/merge error is caught in resolver and runtime falls back to the static instructions string.

Standalone utility path:
- `discoverAgentsMdHierarchy(cwd, globalDir?)` + `mergeAgentsMd(layers)` can be used directly without `loadAgentsFiles()`.

## Key APIs and Types
Parser and hierarchy utilities (`agents-md-parser.ts`):
- `parseAgentsMd(content: string): AgentsMdSection[]`
- `mergeAgentsMd(layers: AgentsMdSection[][]): AgentsMdSection[]`
- `discoverAgentsMdHierarchy(cwd: string, globalDir?: string): Promise<AgentsMdSection[][]>`
- `AgentsMdSection`
  - `agentId: string`
  - `instructions: string`
  - optional `role`, `tools`, `constraints`, `childSections`

Loader (`instruction-loader.ts`):
- `loadAgentsFiles(projectDir: string, options?: LoadAgentsOptions): Promise<LoadedAgentsFile[]>`
- `LoadAgentsOptions`
  - `maxDepth?: number`
  - `fileNames?: string[]` (default `['AGENTS.md']`)
- `LoadedAgentsFile`
  - `path: string`
  - `sections: AgentsMdSection[]`

Merger (`instruction-merger.ts`):
- `mergeInstructions(staticInstructions, agentsSections, agentId?, sources?): MergedInstructions`
- `MergedInstructions`
  - `systemPrompt: string`
  - `agentHierarchy: AgentsMdSection[]`
  - `sources: string[]`

Package exports:
- Re-exported from `src/instructions/index.ts`.
- Also re-exported from package root `src/index.ts` for consumer imports from `@dzupagent/agent`.

## Dependencies
Direct runtime dependencies in this module:
- Node.js built-ins:
  - `node:fs/promises` (`readFile`, `readdir`)
  - `node:path` (`join`, `resolve`, `dirname`)
- Internal dependency:
  - `instruction-loader.ts` imports `parseAgentsMd` from `agents-md-parser.ts`.
  - `instruction-merger.ts` depends on `AgentsMdSection` type.

Package-level context (`packages/agent/package.json`):
- This module ships inside `@dzupagent/agent` and relies on the package build/test toolchain (`tsup`, `vitest`, `typescript`).
- No external runtime libraries are imported directly by files in `src/instructions`.

## Integration Points
Primary runtime integration:
- `AgentInstructionResolver` (`src/agent/instruction-resolution.ts`) calls:
  - `loadAgentsFiles()`
  - `mergeInstructions()`
- `DzupAgent` (`src/agent/dzip-agent.ts`) delegates instruction resolution entirely to `AgentInstructionResolver`.

Configuration integration:
- `DzupAgentConfig` (`src/agent/agent-types.ts`) exposes:
  - `instructionsMode?: 'static' | 'static+agents'`
  - `agentsDir?: string`

Package surface integration:
- `src/index.ts` re-exports all instruction APIs/types, so app/framework consumers can use parser/loader/merger directly.

Notable non-integration:
- `discoverAgentsMdHierarchy`/`mergeAgentsMd` are currently utility exports and are not used by `AgentInstructionResolver`, which uses `loadAgentsFiles` + `mergeInstructions`.

## Testing and Observability
Test coverage in `packages/agent/src/__tests__`:
- `agents-md-parser.test.ts`
  - parser behavior, heading normalization, malformed input, deep nesting, merge precedence (`mergeAgentsMd`), and hierarchy discovery (`discoverAgentsMdHierarchy`).
- `instruction-loader.test.ts`
  - recursion, `maxDepth`, skip directories, custom filenames, and simple `.gitignore` behavior.
- `instruction-merger.test.ts`
  - full render, agent filtering, parent-context retention, and metadata fields.
- `instruction-resolution.test.ts`
  - static mode bypass, cache behavior, concurrent load deduplication, and fallback on loader failure.

Current local verification run:
- `yarn workspace @dzupagent/agent test src/__tests__/agents-md-parser.test.ts src/__tests__/instruction-loader.test.ts src/__tests__/instruction-merger.test.ts src/__tests__/instruction-resolution.test.ts`
- Result: 4 test files passed, 82 tests passed.

Observability:
- `src/instructions` has no logging or event emission.
- Runtime failures are intentionally swallowed at loader and resolver boundaries; behavior is fail-open to static instructions.

## Risks and TODOs
- `.gitignore` support is intentionally minimal in loader (no wildcard/glob semantics); ignored paths may diverge from real Git behavior in complex repos.
- Loader and resolver catch-and-skip/catch-and-fallback without diagnostics; debugging bad AGENTS content or unreadable files can be opaque.
- Parser field extraction expects `Field: value` starting at line start; indented/tab-prefixed fields are not recognized as structured fields.
- Parser CRLF handling is not normalized internally; callers with raw CRLF content may need normalization for consistent field parsing.
- `mergeInstructions` filtering is exact `agentId` match only; no aliasing/case-flex matching after normalization.
- `mergeAgentsMd` merges by `agentId` across layers without source provenance in result objects; troubleshooting “which layer won” requires external tracing.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.
- 2026-04-26: updated to match current `src/instructions` code, runtime resolver wiring, and instruction-focused test suite status.


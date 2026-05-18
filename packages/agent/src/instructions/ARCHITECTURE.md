# `src/instructions` Architecture

## Scope
This document covers `packages/agent/src/instructions` in `@dzupagent/agent` and its runtime usage through `src/agent/instruction-resolution.ts`.

Included:
- Parsing `AGENTS.md` content into structured section trees.
- Layer merging for parsed `AGENTS.md` sections.
- Filesystem discovery/loading of `AGENTS.md` files under a project tree.
- Rendering merged static + AGENTS-derived instructions into a system prompt.
- Export surface for these utilities from `src/instructions/index.ts`, `src/index.ts`, and `src/compat.ts`.

Not included:
- Resolver cache lifecycle/concurrency coordination beyond how it consumes this module.
- Message assembly, memory loading, and token summarization logic outside `src/instructions`.

## Responsibilities
`src/instructions` is a stateless instruction-processing layer with four concrete jobs:
- Parse markdown headings and known fields (`Role`, `Instructions`, `Tools`, `Constraints`) into `AgentsMdSection` trees.
- Merge multiple parsed layers by `agentId`, with scalar override semantics and deduped union semantics for list fields.
- Load and parse `AGENTS.md` files from disk (`loadAgentsFiles`) with depth/filename controls and skip rules.
- Compose final instruction text (`mergeInstructions`) by combining static instructions with rendered AGENTS sections, optionally filtered to one target agent subtree.

## Structure
- `agents-md-parser.ts`
  - Defines `AgentsMdSection`.
  - Implements `parseAgentsMd`, `mergeAgentsMd`, and `discoverAgentsMdHierarchy`.
  - Includes tree-building, field extraction, id normalization, and hierarchical filesystem discovery helpers.
- `instruction-loader.ts`
  - Defines `LoadAgentsOptions` and `LoadedAgentsFile`.
  - Implements `loadAgentsFiles` (recursive walk, skip directories, simple `.gitignore` support, depth sort).
- `instruction-merger.ts`
  - Defines `MergedInstructions`.
  - Implements `mergeInstructions`, plus internal filtering/rendering helpers.
- `index.ts`
  - Barrel export for all parser/loader/merger APIs and types.

Related runtime files outside this folder:
- `src/agent/instruction-resolution.ts`: runtime loader/merger orchestration, caching, and static fallback.
- `src/agent/event-bus-installer.ts`: instantiates `AgentInstructionResolver` from `DzupAgentConfig`.
- `src/agent/message-preparation.ts`: calls `instructionResolver.resolve()` before building prepared messages.
- `src/agent/agent-types-config.ts`: owns `instructionsMode` and `agentsDir` config fields.

## Runtime and Control Flow
Main runtime path (`instructionsMode: 'static+agents'`):
1. `installEventBus(...)` creates `AgentInstructionResolver` with `agentId`, base `instructions`, optional `instructionsMode`, and optional `agentsDir`.
2. `DzupAgent` uses that resolver from message preparation (`prepareMessages`), which calls `instructionResolver.resolve()`.
3. First `resolve()` call triggers `loadAndMergeInstructions()` and stores the in-flight promise to dedupe concurrent callers.
4. `loadAndMergeInstructions()` chooses scan root: `config.agentsDir ?? process.cwd()`.
5. `loadAgentsFiles(...)` walks the tree (default `maxDepth=5`, default filenames `['AGENTS.md']`), skipping known heavy/hidden directories and simple `.gitignore` segment matches.
6. Loader parses each file with `parseAgentsMd(...)`; files with zero parsed sections are ignored.
7. Resolver flattens all `sections` and calls `mergeInstructions(static, allSections, agentId, sourcePaths)`.
8. `mergeInstructions(...)` optionally filters tree scope to the requested agent context, renders section blocks, and returns `MergedInstructions`.
9. Resolver caches the merged result and returns `systemPrompt`; later calls return cached output.

Fallback behavior:
- `instructionsMode !== 'static+agents'`: resolver returns static instructions immediately (no file I/O).
- Any loader/merge error: resolver falls back to static instructions.
- No AGENTS files discovered: resolver returns static instructions result object.

Standalone utility flow:
- `discoverAgentsMdHierarchy(...)` + `mergeAgentsMd(...)` are exported for callers that want explicit global/root/cwd layer merging without using `loadAgentsFiles(...)`.

## Key APIs and Types
- `parseAgentsMd(content: string): AgentsMdSection[]`
  - Parses heading-based agent sections into a tree (`childSections`).
- `mergeAgentsMd(layers: AgentsMdSection[][]): AgentsMdSection[]`
  - Merges layers in order; later layers override scalar values when present, list fields are dedupe-unioned.
- `discoverAgentsMdHierarchy(cwd: string, globalDir?: string): Promise<AgentsMdSection[][]>`
  - Reads AGENTS layers in order: optional global dir, then filesystem ancestors root -> cwd.
- `loadAgentsFiles(projectDir: string, options?: LoadAgentsOptions): Promise<LoadedAgentsFile[]>`
  - Recursively discovers and parses AGENTS files; returns shallowest-first path ordering.
- `mergeInstructions(staticInstructions, agentsSections, agentId?, sources?): MergedInstructions`
  - Produces:
    - `systemPrompt: string`
    - `agentHierarchy: AgentsMdSection[]`
    - `sources: string[]`

Primary types:
- `AgentsMdSection`
  - `agentId: string`
  - `instructions: string`
  - `role?: string`
  - `tools?: string[]`
  - `constraints?: string[]`
  - `childSections?: AgentsMdSection[]`
- `LoadAgentsOptions`
  - `maxDepth?: number`
  - `fileNames?: string[]`
- `LoadedAgentsFile`
  - `path: string`
  - `sections: AgentsMdSection[]`
- `MergedInstructions`
  - `systemPrompt: string`
  - `agentHierarchy: AgentsMdSection[]`
  - `sources: string[]`

## Dependencies
Direct dependencies inside `src/instructions`:
- Node built-ins:
  - `node:fs/promises` (`readFile`, `readdir`)
  - `node:path` (`join`, `resolve`, `dirname`)
  - `node:fs` types (`Dirent`)
- Internal package links:
  - `instruction-loader.ts` depends on parser exports from `agents-md-parser.ts`.
  - `instruction-merger.ts` depends on `AgentsMdSection` type from parser.

Package context from `packages/agent/package.json`:
- Runtime dependencies are package-level (`@dzupagent/core`, `@dzupagent/context`, etc.), but this folder itself does not import those runtime packages directly.
- Build/test toolchain for this module is the package standard (`tsup`, `typescript`, `vitest`).

## Integration Points
- Runtime integration:
  - `AgentInstructionResolver` (`src/agent/instruction-resolution.ts`) is the main consumer of `loadAgentsFiles` and `mergeInstructions`.
  - `DzupAgent` consumes resolved instructions through message-preparation coordination.
- Config integration:
  - `DzupAgentConfig` (`src/agent/agent-types-config.ts`) defines:
    - `instructionsMode?: 'static' | 'static+agents'`
    - `agentsDir?: string`
- Export integration:
  - `src/instructions/index.ts` exports parser/loader/merger APIs.
  - `src/index.ts` re-exports the same instruction APIs at package root.
  - `src/compat.ts` re-exports `./instructions/index.js` for transitional compatibility consumers.
- Not currently wired in runtime resolver:
  - `discoverAgentsMdHierarchy` and `mergeAgentsMd` are available to consumers but not used by `AgentInstructionResolver`.

## Testing and Observability
Instruction-focused tests:
- `src/__tests__/agents-md-parser.test.ts`
  - Parse behavior, normalization, malformed input handling, deep nesting, merge precedence, hierarchy discovery.
- `src/__tests__/instruction-loader.test.ts`
  - Recursive loading, `maxDepth`, skip rules, custom filenames, simple `.gitignore` behavior.
- `src/__tests__/instruction-merger.test.ts`
  - Static-only behavior, full merge rendering, agent filtering, parent-context inclusion, source metadata.
- `src/__tests__/instruction-resolution.test.ts`
  - Static bypass, successful caching, concurrent load dedupe, fallback on loader failure.

Current local validation:
- Command:
  - `yarn workspace @dzupagent/agent test src/__tests__/agents-md-parser.test.ts src/__tests__/instruction-loader.test.ts src/__tests__/instruction-merger.test.ts src/__tests__/instruction-resolution.test.ts`
- Result:
  - 4 test files passed
  - 82 tests passed

Observability:
- `src/instructions` has no direct logging, metrics, or event emission.
- Operational visibility is indirect through resolver behavior in the agent runtime; many parse/load failures are intentionally silent and degrade to static instructions.

## Risks and TODOs
- Loader `.gitignore` handling is intentionally simplified (no wildcard/glob support), so discovery can diverge from full Git ignore semantics.
- Loader/read failures are swallowed; resolver-level failures also fall back silently, which reduces diagnostics for operators.
- Parser field extraction requires unindented `Field: value` lines; tab/space-indented field lines are not interpreted as structured fields.
- CRLF normalization is not automatic inside parser internals; behavior is most predictable with normalized `\n` input.
- `mergeInstructions` agent filtering is exact `agentId` equality and does not apply alias/case-flex matching.
- Render format always uses `###` headings plus indentation for nested sections, so markdown depth semantics are visual rather than heading-level strict.
- `loadAgentsFiles` depth sort uses `path.split('/')`; behavior is consistent in this Linux-targeted repo but path-separator assumptions are embedded.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

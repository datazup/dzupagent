# `src/instructions` Architecture

This document covers the implementation in `packages/agent/src/instructions` as of **April 4, 2026**.

## 1. Scope

This module provides AGENTS.md-driven instruction composition for `@dzupagent/agent`.

It has three responsibilities:

1. Parse AGENTS markdown into a typed hierarchical tree (`parseAgentsMd`).
2. Discover and load AGENTS files from disk (`loadAgentsFiles`).
3. Merge static runtime instructions with parsed AGENTS sections (`mergeInstructions`).

The module itself is intentionally stateless. Runtime caching and error-fallback behavior live in `src/agent/instruction-resolution.ts`.

## 2. File Map

| File | Responsibility |
|---|---|
| `agents-md-parser.ts` | Converts AGENTS markdown headings/fields into `AgentsMdSection[]` tree |
| `instruction-loader.ts` | Recursively scans a project tree, filters directories, loads + parses AGENTS files |
| `instruction-merger.ts` | Builds final system prompt text from static instructions and filtered section tree |
| `index.ts` | Local barrel exports |

## 3. Public API

### 3.1 Types

1. `AgentsMdSection` (`agents-md-parser.ts:23`)
   - `agentId: string`
   - `role?: string`
   - `instructions: string`
   - `tools?: string[]`
   - `constraints?: string[]`
   - `childSections?: AgentsMdSection[]`
2. `LoadedAgentsFile` (`instruction-loader.ts:14`)
   - `path: string` (absolute path)
   - `sections: AgentsMdSection[]`
3. `LoadAgentsOptions` (`instruction-loader.ts:22`)
   - `maxDepth?: number` (default `5`)
   - `fileNames?: string[]` (default `['AGENTS.md']`)
4. `MergedInstructions` (`instruction-merger.ts:12`)
   - `systemPrompt: string`
   - `agentHierarchy: AgentsMdSection[]`
   - `sources: string[]`

### 3.2 Functions

1. `parseAgentsMd(content)` (`agents-md-parser.ts:50`)
2. `loadAgentsFiles(projectDir, options?)` (`instruction-loader.ts:51`)
3. `mergeInstructions(staticInstructions, agentsSections, agentId?, sources?)` (`instruction-merger.ts:30`)

All are re-exported from:

1. `packages/agent/src/instructions/index.ts`
2. package-level `packages/agent/src/index.ts:344-349` (so consumers can import from `@dzupagent/agent`)

## 4. End-to-End Flow

Runtime path in the package:

1. `DzupAgent` creates `AgentInstructionResolver` with:
   - `id -> agentId`
   - static `instructions`
   - optional `instructionsMode` and `agentsDir`
   - Source: `packages/agent/src/agent/dzip-agent.ts:74-79`.
2. On message preparation, `DzupAgent.prepareMessages()` calls `resolveInstructions()`.
   - Source: `packages/agent/src/agent/dzip-agent.ts:480-512`.
3. `AgentInstructionResolver.resolve()` decides behavior:
   - `static` mode: return static instructions immediately.
   - `static+agents` mode: load+merge once, cache result.
   - Source: `packages/agent/src/agent/instruction-resolution.ts:25-42`.
4. In `static+agents` mode:
   - `loadAgentsFiles(dir)` scans filesystem and parses each matched file.
   - all parsed sections are flattened and passed to `mergeInstructions(...)`.
   - merged `systemPrompt` is cached and reused by later calls.
   - Source: `packages/agent/src/agent/instruction-resolution.ts:44-64`.
5. If load/merge fails, resolver falls back to static instructions without throwing.
   - Source: `packages/agent/src/agent/instruction-resolution.ts:62-63`.

## 5. Feature Breakdown

### 5.1 Parser (`agents-md-parser.ts`)

Core behavior:

1. Ignores empty input (`trim()` check).
2. Treats markdown headings `#`..`######` as section boundaries.
3. Derives normalized `agentId` from heading text using kebab-case conversion.
4. Extracts typed fields:
   - `Role: ...` -> `role`
   - `Tools: a, b` -> `tools: string[]`
   - `Constraints: a, b` -> `constraints: string[]`
   - `Instructions: ...` -> `instructions`
5. If explicit `Instructions:` is missing, uses remaining non-field body text as instructions.
6. Builds parent/child hierarchy by heading depth (`#`, `##`, `###`, ...).

Implementation references:

1. Heading scan and block formation: `agents-md-parser.ts:58-70`
2. Tree construction stack algorithm: `agents-md-parser.ts:82-105`
3. Field extraction helpers: `agents-md-parser.ts:151-166`
4. Fallback instruction extraction: `agents-md-parser.ts:132-149`
5. Agent ID normalization: `agents-md-parser.ts:172-180`

### 5.2 Loader (`instruction-loader.ts`)

Core behavior:

1. Recursively walks from a root directory (`resolve(projectDir)`).
2. Stops recursion when `depth > maxDepth`.
3. Skips known heavy/build dirs via `SKIP_DIRS` (`node_modules`, `.git`, `dist`, etc.).
4. Skips hidden directories (`entry.name.startsWith('.')`) except `"."`.
5. Loads simple `.gitignore` patterns from root and skips matching segments.
6. Reads matching filenames case-insensitively (`fileNames` lowercased).
7. Parses each file via `parseAgentsMd`.
8. Keeps only files with at least one parsed section.
9. Returns files sorted shallow-first by path depth.
10. Swallows read/access errors and continues scanning.

Implementation references:

1. defaults + setup: `instruction-loader.ts:55-63`
2. recursive walk and skip rules: `instruction-loader.ts:79-116`
3. simple `.gitignore` parser: `instruction-loader.ts:125-137`
4. path segment ignore check: `instruction-loader.ts:140-154`

### 5.3 Merger (`instruction-merger.ts`)

Core behavior:

1. Starts with static base instructions.
2. Optionally filters section tree to a specific `agentId`:
   - exact match keeps full subtree
   - ancestor of matching descendant is retained as context
3. If relevant sections exist, appends:
   - `## Agent Configuration (from AGENTS.md)`
   - rendered section blocks with nested indentation
4. Returns `systemPrompt` plus metadata:
   - full unfiltered `agentHierarchy`
   - source file list

Rendering details:

1. Section heading: `### <agentId>`
2. Optional `**Role:** ...`
3. Instructions text
4. Optional `**Tools:** tool1, tool2`
5. Optional constraints bullet list
6. Recursively rendered child sections

Implementation references:

1. merge entrypoint: `instruction-merger.ts:30-56`
2. subtree filtering: `instruction-merger.ts:69-100`
3. text rendering: `instruction-merger.ts:103-133`

## 6. Usage

### 6.1 Runtime usage through `DzupAgent` (recommended)

```ts
import { DzupAgent } from '@dzupagent/agent'

const agent = new DzupAgent({
  id: 'code-reviewer',
  instructions: 'You review code for correctness and risk.',
  model: modelInstance,
  instructionsMode: 'static+agents',
  agentsDir: process.cwd(), // optional; default is process.cwd()
})
```

Expected behavior:

1. First call to `generate()`/`stream()` loads and merges AGENTS instructions.
2. Subsequent calls reuse cached merged instructions in the same agent instance.
3. If AGENTS loading fails, static `instructions` continue to work.

### 6.2 Direct parser usage

```ts
import { parseAgentsMd } from '@dzupagent/agent'

const sections = parseAgentsMd(`
# TeamLead
Role: Coordinates work
Instructions: Delegate and review.
Tools: plan, review
Constraints: Stay scoped

## Implementer
Instructions: Write the code changes.
`)

console.log(sections[0]?.agentId) // "team-lead"
console.log(sections[0]?.childSections?.[0]?.agentId) // "implementer"
```

### 6.3 Direct loader + merger usage

```ts
import { loadAgentsFiles, mergeInstructions } from '@dzupagent/agent'

const files = await loadAgentsFiles('/repo', { maxDepth: 4 })
const sections = files.flatMap(f => f.sections)
const sources = files.map(f => f.path)

const merged = mergeInstructions(
  'Base policy: be concise and safe.',
  sections,
  'implementer',
  sources,
)

console.log(merged.systemPrompt)
```

### 6.4 Minimal AGENTS.md example

```md
# CodeReviewer
Role: Reviews pull requests
Instructions: Prioritize correctness and security.
Tools: read_file, search_code
Constraints: Never modify files directly

## StyleChecker
Instructions: Enforce naming and formatting conventions.
```

## 7. References Across Packages

### 7.1 Internal runtime integration (`@dzupagent/agent`)

Direct usage is in the agent runtime layer:

1. `packages/agent/src/agent/instruction-resolution.ts:1-2`
   - imports `loadAgentsFiles` and `mergeInstructions`.
2. `packages/agent/src/agent/dzip-agent.ts:74-79`
   - wires `AgentInstructionResolver`.
3. `packages/agent/src/agent/dzip-agent.ts:480-512`
   - resolves effective instructions during message preparation.
4. `packages/agent/src/agent/agent-types.ts:90-99`
   - exposes config knobs (`instructionsMode`, `agentsDir`) to users.

### 7.2 Package-level export surface

`packages/agent/src/index.ts:344-349` re-exports this module, making it available to other workspaces/apps via `@dzupagent/agent`.

### 7.3 Cross-package direct imports (current state)

Static code search across TypeScript/JavaScript sources outside `packages/agent` found:

1. No direct imports of `parseAgentsMd`, `loadAgentsFiles`, `mergeInstructions`, or their associated types from `@dzupagent/agent`.
2. Other packages use `@dzupagent/agent` for other features (`DzupAgent`, pipeline runtime, tool helpers), but not this instruction API directly.

Related note:

1. `@dzupagent/core` contains a separate AGENTS parser implementation (`packages/core/src/skills/agents-md-parser.ts`) with different shape/semantics.

## 8. Test Coverage

### 8.1 Tests that cover this module

Primary direct tests:

1. `packages/agent/src/__tests__/agents-md-parser.test.ts`
2. `packages/agent/src/__tests__/instruction-loader.test.ts`
3. `packages/agent/src/__tests__/instruction-merger.test.ts`
4. `packages/agent/src/__tests__/instruction-resolution.test.ts` (indirect integration with loader+merger)

Feature coverage by test:

1. Parser:
   - empty input handling, single/multi-root sections, nested hierarchy, sibling depth transitions, fallback instructions body behavior, heading normalization, and pre-heading text ignore.
2. Loader:
   - root and nested discovery, skip directories (`node_modules`, `.git`), `maxDepth`, custom filenames, invalid-file skip, and simple `.gitignore` filtering.
3. Merger:
   - static-only behavior, full merge behavior, agent filtering, parent-context retention for child matches, not-found fallback, source propagation, and role/tools/constraints rendering.
4. Resolver:
   - static-mode bypass, merge caching, concurrent load deduplication, and failure fallback.

### 8.2 Verification runs executed

Executed on **April 4, 2026**:

```bash
yarn workspace @dzupagent/agent test \
  src/__tests__/agents-md-parser.test.ts \
  src/__tests__/instruction-loader.test.ts \
  src/__tests__/instruction-merger.test.ts \
  src/__tests__/instruction-resolution.test.ts
```

Result:

1. `4` test files passed.
2. `31` tests passed.

Focused coverage run (same files):

```bash
yarn workspace @dzupagent/agent test:coverage \
  src/__tests__/agents-md-parser.test.ts \
  src/__tests__/instruction-loader.test.ts \
  src/__tests__/instruction-merger.test.ts \
  src/__tests__/instruction-resolution.test.ts
```

Observed coverage for `src/instructions/*` and resolver:

1. `instructions` folder aggregate:
   - statements `99.14%`
   - branches `92.23%`
   - functions `100%`
   - lines `99.14%`
2. `agents-md-parser.ts`: `100%` statements/branches/functions/lines
3. `instruction-loader.ts`: `97.4%` statements/lines, `83.78%` branches, `100%` functions
4. `instruction-merger.ts`: `100%` statements/lines/functions, `92%` branches
5. `agent/instruction-resolution.ts`: `96.96%` statements/lines, `88.88%` branches, `100%` functions

Important coverage caveat:

1. The focused coverage command fails package-wide thresholds because only a subset of files is exercised (global package thresholds in `packages/agent/vitest.config.ts:19-24` still apply).
2. This failure does not indicate failures in instruction tests; it is an expected threshold effect of partial-suite coverage runs.

## 9. Behavioral Notes and Current Limits

1. Loader `.gitignore` support is intentionally simplified:
   - wildcard patterns (`*`) are ignored (`instruction-loader.ts:132`).
   - matching is segment equality-based, not full gitignore semantics.
2. Hidden directories are skipped aggressively (`instruction-loader.ts:102`), which includes most dot-directories.
3. Loader ignores unreadable files/directories silently (`instruction-loader.ts:93-95`, `112-114`) by design for resilience.
4. Merger always returns full original `agentHierarchy` even when `agentId` filter narrows rendered prompt (`instruction-merger.ts:53`).
5. Parser is line-oriented and field extraction is single-line (`extractField` regex), so multiline field value continuation is not a first-class format.

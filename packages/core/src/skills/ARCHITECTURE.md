# Skills Architecture (`packages/core/src/skills`)

## Scope
This document covers the skills subsystem in `packages/core/src/skills` and its direct package-level integrations inside `packages/core`.

In-scope files:
- `skill-types.ts`
- `skill-loader.ts`
- `skill-injector.ts`
- `skill-registry.ts`
- `skill-directory-loader.ts`
- `skill-manager.ts`
- `skill-learner.ts`
- `skill-chain.ts`
- `skill-model-v2.ts`
- `agents-md-parser.ts`
- `hierarchical-walker.ts`
- `workflow-command-parser.ts`
- `workflow-registry.ts`
- `index.ts` (module barrel)

Out of scope:
- The execution engine for skill chains (this module defines/validates chains, but does not execute them).
- Full AGENTS v2 format implementation (`src/formats/agents-md-parser-v2.ts`), except where it imports `AgentsMdConfig` from this module.

## Responsibilities
The skills subsystem currently provides:

1. Filesystem skill discovery and content loading.
2. In-memory skill registration, lookup, ranking, and prompt formatting.
3. Skill prompt injection helpers.
4. Skill lifecycle writes (`create`, `edit`, `patch`, `readSkill`) with validation, content limits, security scan, and atomic file writes.
5. In-memory skill telemetry and optimization/review candidate selection.
6. Declarative skill chain modeling, fluent construction, and missing-skill validation.
7. Workflow command parsing (separator heuristics, aliases, optional intent-router fallback).
8. Workflow registry management (CRUD, search, snapshot serialization/deserialization).
9. AGENTS/CLAUDE markdown parsing and multi-level config discovery.
10. Canonical skill lifecycle/domain types (V2) and transition checks.

## Structure
Core organization is utility-first; there is no single skills orchestrator.

| File | Purpose |
| --- | --- |
| `skill-types.ts` | Base interfaces (`SkillDefinition`, `SkillRegistryEntry`, `LoadedSkill`, `SkillMatch`). |
| `skill-loader.ts` | Async loader for directory-based `SKILL.md` discovery + body loading. |
| `skill-injector.ts` | Lightweight system-prompt appender for discovered skills. |
| `skill-registry.ts` | In-memory registry with ranking/search and prompt formatting. |
| `skill-directory-loader.ts` | Sync recursive loader for `SKILL.md` and `*.skill.json` into `SkillRegistry`. |
| `skill-manager.ts` | Safe write/edit/patch/read operations for `SKILL.md` files. |
| `skill-learner.ts` | Execution metric tracking and optimization/review selection. |
| `skill-chain.ts` | Chain types + factory + fluent builder + validation. |
| `workflow-command-parser.ts` | Command text -> normalized workflow step tokens. |
| `workflow-registry.ts` | Named workflow storage/search/snapshot I/O. |
| `agents-md-parser.ts` | AGENTS/CLAUDE parser + config merge utility. |
| `hierarchical-walker.ts` | Global/project/directory AGENTS config discovery. |
| `skill-model-v2.ts` | Lifecycle state model and domain interfaces for V2 skill governance. |
| `index.ts` | Submodule export barrel (does not expose every file in this folder). |

## Runtime and Control Flow
Primary runtime flows in current code:

1. Skill discovery and prompt injection (lightweight path):
   - `SkillLoader.discoverSkills()` scans immediate subdirectories under configured roots for `SKILL.md`.
   - `injectSkills(systemPrompt, skills)` appends a `## Skills Available` section.
   - `SubAgentSpawner` can append full skill bodies via `SkillLoader.loadSkillContent()` when `config.skills` is set and a loader was injected.

2. Registry-driven loading and retrieval:
   - `SkillDirectoryLoader.loadFromDirectory()` recursively scans for `SKILL.md` and `*.skill.json`.
   - Parsed entries are normalized via `parseMarkdownSkill` / `parseJsonSkill`.
   - Entries are inserted into `SkillRegistry`.
   - Callers use `search`, `findByTags`, `listByCategory`, and `formatForPrompt`.

3. Skill file lifecycle updates:
   - `SkillManager.create/edit/patch` validates names and size limits.
   - Content is scanned with `sanitizeMemoryContent`.
   - Writes are atomic (`write temp -> rename`), with temp cleanup if rename fails.
   - `readSkill` parses frontmatter and returns `SkillDefinition` when valid.

4. Skill telemetry loop:
   - `SkillLearner.recordExecution` updates counters and rolling averages.
   - `getSkillsNeedingReview` and `getOptimizableSkills` apply configured thresholds.
   - `buildOptimizationPrompt` formats metrics + current prompt into an optimization instruction block.

5. Workflow parsing and registration:
   - `WorkflowCommandParser.parse` tries alias resolution, separator-based tokenization, then single-token default.
   - `parseAsync` optionally falls back to `IntentRouter.classify` if sync parse fails.
   - Parsed/constructed chains can be stored in `WorkflowRegistry`, searched (`name/tag/description` confidence tiers), and serialized via `toJSON`.

6. AGENTS config layering:
   - `discoverAgentConfigs(cwd)` reads global config (`~/.config/dzupagent/*`), git-root config, then directory configs between git root and CWD.
   - Each file is parsed by `parseAgentsMd`.
   - `mergeAgentsMdConfigs` merges instructions/rules and deduplicates allow/block tool lists.

## Key APIs and Types
Main runtime APIs:

- `SkillLoader`
  - `discoverSkills(): Promise<SkillDefinition[]>`
  - `loadSkillContent(skillName: string): Promise<string | null>`
  - `formatSkillList(skills: SkillDefinition[]): string`

- `injectSkills(systemPrompt: string, skills: SkillDefinition[]): string`

- `SkillRegistry`
  - `register`, `unregister`, `get`, `has`, `list`, `clear`, `size`
  - `listByCategory`, `categories`, `allTags`
  - `findByTags(tags)`, `search(query)`
  - `formatForPrompt(skills)`

- `SkillDirectoryLoader`
  - `loadFromDirectory`, `loadFromDirectories`
  - `loadMarkdownFile`, `loadJsonFile`
  - Parser helpers: `parseMarkdownSkill`, `parseJsonSkill`

- `SkillManager`
  - `create(input)`, `edit(input)`, `patch(skillName, patch)`
  - `readSkill(skillName)`
  - `shouldCreateSkill(metrics)`

- `SkillLearner`
  - `recordExecution`, `getMetrics`, `getAllMetrics`
  - `getSkillsNeedingReview`, `getOptimizableSkills`
  - `buildOptimizationPrompt`, `resetMetrics`

- `SkillChain` utilities
  - `createSkillChain`, `SkillChainBuilder`, `validateChain`
  - Step options include conditional execution metadata (`condition`, `suspendBefore`, `stateTransformer`, `timeoutMs`, `retryPolicy`).

- `WorkflowCommandParser`
  - `parse(text)`, `parseAsync(text)`
  - `addAlias`, `listAliases`
  - Supports separator styles: `arrow`, `pipe`, `comma`, `then-keyword`, `alias`, `unknown`.

- `WorkflowRegistry`
  - `register`, `unregister`, `get`, `find`, `list`, `clear`, `size`
  - `toJSON`, `fromJSON`

- AGENTS utilities
  - `parseAgentsMd(content)`
  - `mergeAgentsMdConfigs(configs)`
  - `discoverAgentConfigs(cwd)`

- V2 model utilities
  - `SKILL_LIFECYCLE_TRANSITIONS`
  - `isValidSkillTransition(from, to)`
  - Types: `SkillDefinitionV2`, `SkillUsageRecord`, `SkillReviewRecord`, `SkillResolutionContext`, etc.

## Dependencies
Direct dependencies used by `src/skills` today:

- Node built-ins:
  - `node:fs/promises` (`readdir`, `readFile`, `writeFile`, `rename`, `mkdir`, `unlink`)
  - `node:fs` (`readFileSync`, `readdirSync`, `existsSync`, `statSync`)
  - `node:path` (`join`, `dirname`)
  - `node:crypto` (`randomBytes`)
  - `node:child_process` (`execSync`)

- Workspace packages:
  - `@dzupagent/memory` (only `sanitizeMemoryContent` in `skill-manager.ts`)
  - `@dzupagent/runtime-contracts` (type re-exports in `skill-model-v2.ts`)

- Internal cross-module types:
  - `IntentRouter` type from `src/router/intent-router.ts` for optional async fallback in `WorkflowCommandParser`.

No external third-party libraries are imported directly inside `src/skills/*`.

## Integration Points
Current integrations in `packages/core`:

1. Root export surface (`src/index.ts`):
   - Exposes all major skills APIs, including workflow parser/registry and V2 lifecycle types.

2. Orchestration facade (`src/facades/orchestration.ts`):
   - Exposes operational skills APIs (`SkillLoader`, `SkillManager`, `SkillLearner`, chain helpers, AGENTS parser/walker).
   - Does not currently expose `WorkflowCommandParser`, `WorkflowRegistry`, or `skill-model-v2` types through this facade.

3. Sub-agent runtime (`src/subagent/subagent-spawner.ts`):
   - Accepts injected `SkillLoader`.
   - Uses discovered skills + `config.skills` to append skill body content into sub-agent system prompts.

4. Formats module (`src/formats/agents-md-parser-v2.ts`):
   - Imports `AgentsMdConfig` type from this module for v2-to-legacy conversion.

5. Submodule barrel (`src/skills/index.ts`):
   - Exports core loader/registry/manager/learner/chain APIs.
   - Does not include workflow parser/registry or V2 lifecycle model exports, so it is not equivalent to the root `src/index.ts` skills export set.

## Testing and Observability
Skill subsystem test coverage in `src/__tests__` includes:

- `skill-loader.test.ts`
  - `parseMarkdownSkill`, `parseJsonSkill`, and `SkillDirectoryLoader` behavior (recursive scan, maxDepth, sourcePath, format validity).
- `skill-registry.test.ts`
  - registration semantics, sorting, matching confidence, prompt formatting, categories/tags.
- `skill-manager.test.ts`
  - validation, create/edit/patch/read paths, security-scan failure path, atomic rename cleanup.
- `skill-learner.test.ts`
  - running averages, threshold filtering, custom config, optimization-prompt output, reset behavior.
- `skill-chain.test.ts`
  - factory/builder validation and missing-skill detection.
- `workflow-command-parser.test.ts`
  - separator parsing, aliases, async fallback behavior, regex safety checks.
- `workflow-registry.test.ts`
  - registration/search/list semantics and snapshot validation.
- `agents-md-parser.test.ts`
  - section parsing and merged config behavior.
- `skill-injector.test.ts`
  - prompt appending behavior with one/many skills and empty prompt handling.

Cross-module validation:
- `subagent-spawner.test.ts` validates sub-agent execution loops; skills branch exists in implementation but does not have a dedicated assertion for full loader-driven prompt append.

Observability characteristics:
- `src/skills` does not emit structured events or metrics directly.
- `WorkflowCommandParser` supports optional warning logs via injected `logger.warn` when async intent fallback fails.
- Operational observability is expected to be provided by higher layers (event bus, metrics collectors, middleware).

## Risks and TODOs
1. `SubAgentSpawner` skill selection ambiguity:
   - It filters discovered skills by `skill.name` but loads content by directory key (`loadSkillContent(skill.name)`), which assumes `name` equals folder name.
   - TODO: align on a stable identifier (directory slug or explicit `id`) for both filtering and content retrieval.

2. Two overlapping loader strategies:
   - `SkillLoader` (async, immediate subdirs, markdown only) and `SkillDirectoryLoader` (sync, recursive, markdown+json) can diverge in behavior.
   - TODO: define a single preferred runtime path or a shared parser abstraction to reduce drift.

3. Blocking filesystem calls:
   - `SkillDirectoryLoader` and `hierarchical-walker` use sync fs APIs (and `execSync` for git root).
   - TODO: provide async variants for latency-sensitive server paths.

4. Frontmatter parsing is intentionally minimal:
   - Markdown parsing in loaders/managers is line-based and not full YAML.
   - TODO: document accepted frontmatter grammar more strictly or adopt a dedicated parser.

5. Serialization limits for workflow chains:
   - `WorkflowRegistry.toJSON/fromJSON` is structurally validated, but function fields in chain steps (`condition`, `stateTransformer`) are not serializable in durable JSON snapshots.
   - TODO: define a serializable workflow schema profile for persisted workflows.

6. Export surface inconsistency:
   - Root index exports workflow/V2 symbols that `src/skills/index.ts` does not.
   - TODO: either expand `src/skills/index.ts` or explicitly document it as a curated subset.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js
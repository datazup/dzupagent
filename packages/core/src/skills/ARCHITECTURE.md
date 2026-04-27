# Skills Architecture (`packages/core/src/skills`)

## Scope
This document covers the `packages/core/src/skills` module in `@dzupagent/core`.

In scope:
- `skill-types.ts`
- `skill-loader.ts`
- `skill-injector.ts`
- `skill-registry.ts`
- `skill-directory-loader.ts`
- `skill-manager.ts`
- `skill-learner.ts`
- `skill-chain.ts`
- `workflow-command-parser.ts`
- `workflow-registry.ts`
- `agents-md-parser.ts`
- `hierarchical-walker.ts`
- `skill-model-v2.ts`
- `index.ts` (skills sub-barrel)

Also covered where directly integrated:
- root `src/index.ts` exports
- `src/facades/orchestration.ts` facade exports
- `src/subagent/subagent-spawner.ts` skill prompt hydration path
- `src/formats/agents-md-parser-v2.ts` legacy type bridge import

Out of scope:
- execution engine for `SkillChain` (this module defines/builds/validates chains)
- full AGENTS v2 parser internals in `src/formats/*` beyond the legacy config type dependency

## Responsibilities
The skills module currently provides:

1. Skill definitions and registry data types (`SkillDefinition`, `SkillRegistryEntry`, `LoadedSkill`, `SkillMatch`).
2. Filesystem discovery of skill metadata/content from `SKILL.md` files (`SkillLoader`).
3. Prompt augmentation helpers (`injectSkills`, registry prompt formatting).
4. In-memory skill registry with ranking/search by text, category, and tags (`SkillRegistry`).
5. Recursive directory loading for markdown and JSON skill definitions (`SkillDirectoryLoader`).
6. Skill lifecycle file operations (create/edit/patch/read) with validation, content-size guardrails, sanitizer scan, and atomic writes (`SkillManager`).
7. In-memory execution telemetry and optimization/review candidate selection (`SkillLearner`).
8. Declarative skill-chain modeling via typed steps + fluent builder (`createSkillChain`, `SkillChainBuilder`, `validateChain`).
9. Workflow command parsing with alias support, separator heuristics, regex safety checks, and optional `IntentRouter` fallback (`WorkflowCommandParser`).
10. Named workflow storage, search, composition, and JSON snapshot import/export (`WorkflowRegistry`).
11. AGENTS/CLAUDE markdown parsing and hierarchical config discovery (`parseAgentsMd`, `mergeAgentsMdConfigs`, `discoverAgentConfigs`).
12. Skill lifecycle/domain types v2 and transition checks (`skill-model-v2.ts`).

## Structure
- `skill-types.ts`
Defines the minimal skill type used by `SkillLoader`/injectors and the richer registry entry shape.

- `skill-loader.ts`
Async, shallow loader: scans immediate subdirectories under configured roots for `SKILL.md`, parses lightweight frontmatter (`name`, `description`, optional compatibility/tool fields), and can load body content by skill name.

- `skill-injector.ts`
Pure helper: appends a markdown `## Skills Available` section to an existing system prompt.

- `skill-registry.ts`
In-memory map keyed by `id` with ordered listing, category/tag discovery, confidence-based matching, and prompt formatting.

- `skill-directory-loader.ts`
Sync recursive loader with parser helpers:
  - `parseMarkdownSkill(...)` for `SKILL.md`
  - `parseJsonSkill(...)` for `*.skill.json`
  - `SkillDirectoryLoader` to register parsed entries into `SkillRegistry`

- `skill-manager.ts`
Persistent write path for user-managed skills under `skillsDir`; includes name validation, max content limit, sanitizer checks, and atomic temp-file rename.

- `skill-learner.ts`
Tracks per-skill execution metrics in memory and exposes review/optimization selectors plus optimization prompt generation.

- `skill-chain.ts`
Typed chain model (including conditional/parallel metadata), chain builder, and missing-skill validation.

- `workflow-command-parser.ts`
Parses command text into normalized step tokens, supports aliases and configurable keyword regex patterns, and defends against unsafe regex patterns.

- `workflow-registry.ts`
Stores named `SkillChain` entries with optional tags/description, supports case-insensitive lookup, search scoring, composition, and snapshot serialization.

- `agents-md-parser.ts`
Parses AGENTS-style markdown into instructions, glob rules, and allow/block tool lists; merges multiple configs with tool deduplication.

- `hierarchical-walker.ts`
Discovers AGENTS config files from global config to git root to subdirectories between root and CWD.

- `skill-model-v2.ts`
Defines lifecycle statuses/transitions and canonical V2 skill/persona usage/review context types; re-exports selected runtime contract types.

- `index.ts`
Skills submodule barrel (curated subset; does not export workflow parser/registry or V2 lifecycle model symbols).

## Runtime and Control Flow
1. Skill discovery for prompt context:
- Caller constructs `SkillLoader(sourcePaths)`.
- `discoverSkills()` scans `<sourcePath>/<dir>/SKILL.md` and returns parsed `SkillDefinition[]`.
- `injectSkills(systemPrompt, skills)` appends a short list reference.

2. Sub-agent skill hydration path:
- `SubAgentSpawner.buildSystemPrompt(...)` calls injected `SkillLoader` when `config.skills` is non-empty.
- It discovers all skills, filters by `config.skills.includes(skill.name)`, loads each skill body with `loadSkillContent(skill.name)`, and appends `## Skill: <name>` sections to the system prompt.

3. Registry-driven loading/search:
- `SkillDirectoryLoader.loadFromDirectory(...)` recursively scans for `SKILL.md` and `*.skill.json`.
- Parsed entries are registered into `SkillRegistry`.
- Consumers use `search`, `findByTags`, `listByCategory`, `categories`, `allTags`, and `formatForPrompt`.

4. Skill file lifecycle writes:
- `SkillManager.create/edit/patch` validates name and size limits.
- Content is scanned via `scanContent` (imported as `sanitizeMemoryContent`) from `security/content-sanitizer`.
- Writes use atomic temp-file + `rename`, with temp cleanup on rename failure.
- `readSkill` parses stored frontmatter back to a `SkillDefinition`.

5. Skill telemetry/optimization loop:
- `SkillLearner.recordExecution(...)` updates running averages and success rate.
- `getSkillsNeedingReview()` selects low-success skills over thresholded execution count.
- `getOptimizableSkills()` selects high-success skills over thresholded execution count.
- `buildOptimizationPrompt(...)` emits a ready-to-send optimization prompt.

6. Workflow command parsing:
- `WorkflowCommandParser.parse(text)` performs alias lookup, separator-based split, then single-token fallback.
- `parseAsync(text)` optionally invokes `IntentRouter.classify(...)` when sync parse fails and converts non-`default` confidence intents into steps.

7. Workflow registry flow:
- Register named chains via `register(...)`.
- Query with `get/find/list`.
- Compose larger workflows with `compose(...)` by concatenating steps from registered chains.
- Persist/restore with `toJSON()` / `WorkflowRegistry.fromJSON(...)` (schema version `1.0.0`).

8. AGENTS config layering:
- `discoverAgentConfigs(cwd)` reads global `~/.config/dzupagent/*`, project-root config files at git root, then directory-level files from root toward `cwd`.
- Each file is parsed with `parseAgentsMd`.
- `mergeAgentsMdConfigs` combines instructions/rules and de-duplicates tool allow/block lists.

## Key APIs and Types
- Loader/injection:
  - `class SkillLoader`
  - `injectSkills(systemPrompt, skills): string`

- Registry/loading:
  - `class SkillRegistry`
  - `class SkillDirectoryLoader`
  - `parseMarkdownSkill(content, sourcePath?)`
  - `parseJsonSkill(content)`

- Skill lifecycle management:
  - `class SkillManager`
  - `type SkillManagerConfig`
  - `type CreateSkillInput`
  - `type PatchSkillInput`
  - `type SkillWriteResult`

- Metrics/learning:
  - `class SkillLearner`
  - `type SkillMetrics`
  - `type SkillExecutionResult`
  - `type SkillLearnerConfig`

- Chaining/workflows:
  - `createSkillChain(name, steps)`
  - `class SkillChainBuilder`
  - `validateChain(chain, availableSkills)`
  - `class WorkflowCommandParser`
  - `class WorkflowRegistry`

- AGENTS config:
  - `parseAgentsMd(content)`
  - `mergeAgentsMdConfigs(configs)`
  - `discoverAgentConfigs(cwd)`
  - `type AgentsMdConfig`
  - `type HierarchyLevel`

- V2 lifecycle/domain model:
  - `type SkillLifecycleStatus`
  - `const SKILL_LIFECYCLE_TRANSITIONS`
  - `isValidSkillTransition(from, to)`
  - `type SkillScope`
  - `interface SkillDefinitionV2`
  - `interface SkillUsageRecord`
  - `interface SkillReviewRecord`
  - `interface SkillResolutionContext`

## Dependencies
Direct dependencies used by `src/skills/*`:

- Node built-ins:
  - `node:fs/promises`
  - `node:fs`
  - `node:path`
  - `node:crypto`
  - `node:child_process`

- Workspace packages:
  - `@dzupagent/agent-types` (retry policy base type in `skill-chain.ts`)
  - `@dzupagent/runtime-contracts` (V2 type re-exports in `skill-model-v2.ts`)

- Internal package modules:
  - `../security/content-sanitizer.js` (`scanContent`) in `skill-manager.ts`
  - `../router/intent-router.js` type (optional parser fallback) in `workflow-command-parser.ts`

Package-level notes (`packages/core/package.json`):
- Runtime dependencies are minimal (`@dzupagent/agent-types`, `@dzupagent/runtime-contracts`).
- No third-party libraries are imported directly inside `src/skills/*` implementation files.

## Integration Points
- Root package exports (`src/index.ts`):
Exports all major skills, workflow parser/registry APIs, AGENTS parser/walker, and V2 lifecycle types/utilities.

- Skills sub-barrel (`src/skills/index.ts`):
Exports loader/registry/manager/learner/chain APIs, but does not export workflow parser/registry or V2 model symbols.

- Orchestration facade (`src/facades/orchestration.ts`):
Re-exports selected skills features (`SkillLoader`, `injectSkills`, `SkillManager`, `SkillLearner`, chain helpers, AGENTS parser/walker).

- Subagent integration (`src/subagent/subagent-spawner.ts`):
Uses `SkillLoader` to enrich sub-agent system prompts when `config.skills` is provided.

- Formats compatibility bridge (`src/formats/agents-md-parser-v2.ts`):
Imports `AgentsMdConfig` from `skills/agents-md-parser` for `toLegacyConfig(...)` output typing.

## Testing and Observability
Primary tests under `src/__tests__`:
- `skill-loader.test.ts`
- `skill-injector.test.ts`
- `skill-registry.test.ts`
- `skill-manager.test.ts`
- `skill-learner.test.ts`
- `skill-chain.test.ts`
- `workflow-command-parser.test.ts`
- `workflow-registry.test.ts`
- `agents-md-parser.test.ts`

Observed coverage areas from tests:
- parser correctness for markdown/json skill formats
- registry ranking/matching/sorting behavior
- manager validation, sanitizer failure path, and atomic-write behavior
- learner thresholds and prompt-generation output
- chain builder and missing-skill validation
- workflow parser alias/separator behavior, async fallback, and regex safety checks
- workflow snapshot schema validation paths
- AGENTS parse + merge semantics

Cross-module runtime coverage:
- `subagent-spawner.test.ts` validates sub-agent loops and prompt/context assembly behavior; skills are integrated in implementation via injected loader path.

Observability characteristics:
- `src/skills/*` does not emit dedicated metrics/events.
- `WorkflowCommandParser` accepts optional `logger.warn` for non-fatal LLM fallback failures.
- Operational observability is expected from higher-level modules (events, telemetry, middleware).

## Risks and TODOs
1. Skill identifier mismatch risk in sub-agent hydration:
- `SubAgentSpawner` filters discovered skills by `skill.name` and then resolves body by `loadSkillContent(skill.name)`, which assumes directory name == `name` field.

2. Overlapping loader implementations:
- `SkillLoader` (async, shallow, markdown-only metadata shape) and `SkillDirectoryLoader` (sync, recursive, markdown+json registry shape) have different behavior and output contracts.

3. Blocking filesystem/git calls in configuration traversal:
- `SkillDirectoryLoader` and `hierarchical-walker` use sync FS calls and `execSync` for git root detection.

4. Lightweight frontmatter parsing:
- Skill and AGENTS parsers use line-based parsing, not full YAML support.

5. Workflow snapshot limitations:
- `WorkflowRegistry.toJSON()` stores chains structurally, but function-valued fields in `SkillChainStep` (e.g., `condition`, `stateTransformer`) are not durable JSON payloads.

6. Export-surface inconsistency across entry points:
- root `src/index.ts` exports workflow parser/registry and V2 lifecycle symbols; `src/skills/index.ts` does not.

7. Potential stale type branch in parser separator enum:
- `WorkflowSeparatorStyle` includes `'whitespace'`, but current parse paths do not emit that style.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
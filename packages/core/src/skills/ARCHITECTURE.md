# Skills Architecture (`packages/core/src/skills`)

## Scope
This document covers the current code in `packages/core/src/skills` within `@dzupagent/core`.

Files in scope:
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
- `index.ts` (skills-local barrel)

Adjacent integration surfaces validated while refreshing this document:
- `packages/core/src/index.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/subagent/subagent-spawner.ts`
- `packages/core/src/formats/agents-md-parser-v2.ts`
- `packages/core/package.json`

Out of scope:
- execution engines outside this module (for example pipeline runtime internals, event buses, LLM invocation internals)
- non-skills domains in `@dzupagent/core` (MCP, persistence internals, broader security subsystems)

## Responsibilities
`src/skills` currently provides these capabilities:
- Skill discovery metadata shape (`SkillDefinition`) and registry-centric skill shapes (`SkillRegistryEntry`, `LoadedSkill`, `SkillMatch`).
- Filesystem skill discovery and body loading from `SKILL.md` (`SkillLoader`).
- Prompt augmentation with discovered skills (`injectSkills`).
- In-memory registration, search, filtering, and prompt formatting (`SkillRegistry`).
- Recursive skill ingestion from `SKILL.md` and `*.skill.json` (`SkillDirectoryLoader`, `parseMarkdownSkill`, `parseJsonSkill`).
- Managed skill authoring with validation, security scan, and atomic write semantics (`SkillManager`).
- In-memory skill execution telemetry and optimization/review candidate selection (`SkillLearner`).
- Declarative chain modeling and validation (`createSkillChain`, `SkillChainBuilder`, `validateChain`).
- Natural-language workflow command parsing with alias support, separator heuristics, and optional intent-router fallback (`WorkflowCommandParser`).
- Named workflow storage/search/compose/serialize helpers (`WorkflowRegistry`).
- AGENTS-style config parsing and merge behavior (`parseAgentsMd`, `mergeAgentsMdConfigs`).
- Hierarchical discovery of `AGENTS.md`, `.agents.md`, and `CLAUDE.md` from global to local scope (`discoverAgentConfigs`).
- Canonical v2 lifecycle/usage/review domain model for skills (`skill-model-v2.ts`).

## Structure
- `skill-types.ts`: lightweight shared types for discovery (`SkillDefinition`) and registry storage/search (`SkillRegistryEntry`, `LoadedSkill`, `SkillMatch`).
- `skill-loader.ts`: async, shallow loader over configured source roots. Requires frontmatter with `name` and `description` for discovery; loads body content by stripping frontmatter fences.
- `skill-injector.ts`: appends a `## Skills Available` section to an existing system prompt; returns prompt unchanged when no skills are provided.
- `skill-registry.ts`: `Map<string, LoadedSkill>`-backed registry with register/unregister/get/list/search/tag/category utilities and prompt rendering via `formatForPrompt`.
- `skill-directory-loader.ts`: sync recursive scanner (default `maxDepth=10`) with two parsers: markdown frontmatter and JSON skill file format.
- `skill-manager.ts`: write-side manager for `SKILL.md` lifecycle (`create`, `edit`, `patch`, `readSkill`, `shouldCreateSkill`) with strict name/content limits and atomic temp-write then rename.
- `skill-learner.ts`: in-memory aggregate metrics store with rolling averages and threshold-based review/optimization views; generates optimization prompt text.
- `skill-chain.ts`: chain/step contracts, retry-policy extension over `@dzupagent/agent-types`, fluent builder, parallel-step representation, and availability validation.
- `workflow-command-parser.ts`: tokenization and normalization pipeline with alias lookup, separator detection (`→`, `->`, `|`, `,`, `then`), basic failure reporting, and optional async LLM intent fallback.
- `workflow-registry.ts`: case-insensitive workflow registry with search confidence scoring, compose-by-concatenation, and strict snapshot schema checks (`schemaVersion: '1.0.0'`).
- `agents-md-parser.ts`: line/heading-based parser for top-level instructions, named sections, glob-rule sections, and tools allow/block lists.
- `hierarchical-walker.ts`: config discovery pipeline using sync file checks and `git rev-parse --show-toplevel` to locate project root before directory traversal.
- `skill-model-v2.ts`: lifecycle transition map (`SKILL_LIFECYCLE_TRANSITIONS`), transition guard (`isValidSkillTransition`), scope/lifecycle enums, and v2 records for definition/usage/review/resolution.
- `index.ts`: local barrel exporting discovery/registry/manager/learner/chain surfaces; intentionally narrower than package root and pipeline entrypoints.

## Runtime and Control Flow
1. Discovery + prompt listing path.
- `SkillLoader.discoverSkills()` scans each configured source directory one level deep.
- Each candidate folder is accepted only when `<folder>/SKILL.md` exists and frontmatter includes `name` and `description`.
- `injectSkills(systemPrompt, skills)` appends a human-readable inventory block.

2. Sub-agent prompt hydration path.
- `SubAgentSpawner` accepts optional constructor option `{ skillLoader }`.
- During `buildSystemPrompt`, when `config.skills` is non-empty, spawner calls `discoverSkills()`, filters by matching `SkillDefinition.name`, then calls `loadSkillContent(skill.name)` and appends content as `## Skill: <name>` blocks.

3. Registry loading path.
- `SkillDirectoryLoader.loadFromDirectory/loadFromDirectories` recursively scans for `SKILL.md` and `*.skill.json`.
- Parsers convert file content into `SkillRegistryEntry`.
- Valid entries are registered into `SkillRegistry` with optional `sourcePath`.

4. Skill authoring path.
- `SkillManager.create/edit/patch` enforces name regex (`^[a-z0-9][a-z0-9._-]*$`), max name length (`64`), and content limit (default `50_000`).
- All writes pass `scanContent` from `../security/content-sanitizer.js`.
- Write strategy uses temp file write and `rename` for atomic replacement.
- `readSkill` parses frontmatter-only metadata back to `SkillDefinition`.

5. Learning path.
- `SkillLearner.recordExecution` updates cumulative counts and rolling averages.
- `getSkillsNeedingReview` and `getOptimizableSkills` derive candidate sets from configured thresholds.
- `buildOptimizationPrompt` renders an optimization prompt with current metrics (if any).

6. Workflow command parsing path.
- `parse(text)` does alias lookup first, then separator-pattern split, then single-token normalization fallback.
- `parseAsync(text)` returns sync result when successful; otherwise optionally calls `intentRouter.classify(text)`.
- If fallback classification is non-default confidence, parser returns one normalized step; fallback failures are non-fatal and only optionally logged.

7. Workflow registry path.
- Workflows are keyed case-insensitively (`name.toLowerCase().trim()`).
- `compose` concatenates steps from named workflows and can optionally re-register the result.
- `toJSON/fromJSON` provide snapshot export/import with structural validation and schema-version check.

8. Hierarchical instruction-config path.
- `discoverAgentConfigs(cwd)` checks global config directory first (`~/.config/dzupagent`).
- Then checks git root config files.
- Then walks directories from git root toward `cwd` and parses each discovered config file.

## Key APIs and Types
- Discovery and prompt injection: `SkillLoader`, `injectSkills`, `SkillDefinition`.
- Registry and ingestion: `SkillRegistry`, `SkillDirectoryLoader`, `parseMarkdownSkill`, `parseJsonSkill`, `SkillRegistryEntry`, `LoadedSkill`, `SkillMatch`.
- Authoring and lifecycle helpers: `SkillManager`, `SkillManagerConfig`, `CreateSkillInput`, `PatchSkillInput`, `SkillWriteResult`.
- Learning telemetry: `SkillLearner`, `SkillMetrics`, `SkillExecutionResult`, `SkillLearnerConfig`.
- Chains and workflow parsing: `createSkillChain`, `SkillChainBuilder`, `validateChain`, `SkillChainStep`, `SkillChain`, `ChainValidationResult`, `RetryPolicy`, `ParallelMergeStrategy`, `WorkflowCommandParser`, `WorkflowCommandParseResult` family.
- Workflow registry: `WorkflowRegistry`, `WorkflowRegistryEntry`, `WorkflowRegistrySnapshot`, `WorkflowFindResult`, `WorkflowComposeOptions`.
- AGENTS parsing and hierarchy discovery: `parseAgentsMd`, `mergeAgentsMdConfigs`, `discoverAgentConfigs`, `AgentsMdConfig`, `HierarchyLevel`.
- V2 domain model: `SkillLifecycleStatus`, `SKILL_LIFECYCLE_TRANSITIONS`, `isValidSkillTransition`, `SkillScope`, `SkillDefinitionV2`, `SkillUsageRecord`, `SkillReviewRecord`, `SkillResolutionContext`, `SkillReviewPolicy`.

## Dependencies
Direct dependencies used from `src/skills/*`:
- Node built-ins: `node:fs/promises`, `node:fs`, `node:path`, `node:crypto`, `node:child_process`.
- Workspace packages: `@dzupagent/agent-types` (retry policy extension source), `@dzupagent/runtime-contracts` (type re-exports in `skill-model-v2.ts`).
- Internal core modules: `../security/content-sanitizer.js`, `../router/intent-router.js` (type-level integration).

Package-level dependency context from `packages/core/package.json`:
- Runtime dependencies include `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, and `@dzupagent/security`.
- No third-party runtime package is imported directly inside files under `src/skills`.

## Integration Points
- Package root entrypoint (`packages/core/src/index.ts`) exports the full skills surface, including workflow parser/registry, AGENTS parser/discovery, and v2 lifecycle model.
- Pipeline entrypoint (`packages/core/src/pipeline.ts`) mirrors that broader skills surface for `@dzupagent/core/pipeline` consumers.
- Orchestration facade (`packages/core/src/facades/orchestration.ts`) exports a curated subset: `SkillLoader`, `injectSkills`, `SkillManager`, `SkillLearner`, chain helpers, and AGENTS parser/discovery. It does not export workflow parser/registry, directory loader, or v2 model contracts.
- Local skills barrel (`packages/core/src/skills/index.ts`) is also intentionally narrower than root/pipeline entrypoints.
- Sub-agent integration (`packages/core/src/subagent/subagent-spawner.ts`) consumes `SkillLoader` to append selected skill content to child system prompts.
- Formats bridge (`packages/core/src/formats/agents-md-parser-v2.ts`) imports legacy `AgentsMdConfig` from `skills/agents-md-parser` for compatibility conversion (`toLegacyConfig`).
- Package exports (`packages/core/package.json`) do not define a dedicated `./skills` subpath; consumers import through `@dzupagent/core`, `@dzupagent/core/pipeline`, or `@dzupagent/core/orchestration`.

## Testing and Observability
Skill-related tests currently present in `packages/core/src/__tests__`:
- `skill-loader.test.ts`: covers `parseMarkdownSkill`, `parseJsonSkill`, and `SkillDirectoryLoader` behavior with filesystem fixtures.
- `skill-injector.test.ts`: covers prompt append behavior and formatting edge cases.
- `skill-registry.test.ts`: covers registration semantics, sorting, search confidence, categories/tags, and prompt formatting output.
- `skill-manager.test.ts`: covers validation, security scan rejection, create/edit/patch/read behaviors, and atomic-write failure cleanup via mocked fs.
- `skill-learner.test.ts`: covers metric accumulation, threshold filtering, optimization prompt text generation, and reset behavior.
- `skill-chain.test.ts`: covers chain creation validation, builder flows, and missing-skill detection.
- `workflow-command-parser.test.ts`: covers separators, aliases, async intent-router fallback, custom normalizer, and regex safety checks.
- `workflow-registry.test.ts`: covers registration/lookups, confidence-based find, serialization round-trip, and snapshot validation failures.
- `subagent-spawner.test.ts`: primarily tests sub-agent flow; indirectly covers skill prompt hydration behavior shape.
- `w15-h2-branch-coverage.test.ts`: includes additional branch tests for `parseAgentsMd` and `mergeAgentsMdConfigs`.

Current observability characteristics in this module:
- No dedicated event emission pipeline exists in `src/skills`.
- `WorkflowCommandParser` supports optional warning logs through injected `logger.warn` when async intent fallback fails.
- `SkillLearner` stores runtime metrics in-memory only; persistence/aggregation must be handled by higher-level modules.

## Risks and TODOs
- Sub-agent skill name/path coupling: `SubAgentSpawner` filters by discovered `SkillDefinition.name`, but `SkillLoader.loadSkillContent` resolves by directory name. If frontmatter name differs from folder name, hydration can miss content.
- Dual loader behavior drift: `SkillLoader` (async, shallow, `SkillDefinition`) and `SkillDirectoryLoader` (sync, recursive, `SkillRegistryEntry`) can return different effective skill sets for the same root.
- Synchronous filesystem and process calls: `SkillDirectoryLoader` and `hierarchical-walker` rely on sync operations (`readdirSync/statSync/readFileSync/execSync`), which can block in high-throughput hosts.
- Parser simplicity limits: frontmatter and AGENTS parsing are intentionally lightweight and line-based, so advanced YAML/markdown constructs are not fully interpreted.
- Workflow snapshot lossiness: function-valued fields in `SkillChainStep` (for example `condition`, `stateTransformer`) are not JSON-serializable in a meaningful way during `toJSON/fromJSON` workflows.
- Export-surface asymmetry: root/pipeline exports are broader than orchestration and local skills barrel exports, so import-path choice changes available API surface.
- Dead enum branch risk: `WorkflowSeparatorStyle` includes `'whitespace'`, but parser outputs currently use `alias`, `arrow`, `pipe`, `comma`, `then-keyword`, and `unknown`.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


# Skills Module Architecture (`packages/core/src/skills`)

## Scope and Intent

This module provides the core "skills" primitives used across DzupAgent for:

- discovering and loading skill definitions from disk,
- registering and searching skills in-memory,
- injecting skill instructions into prompts,
- managing skill lifecycle writes (create/edit/patch),
- tracking skill execution performance for optimization decisions,
- parsing AGENTS.md-style instruction files, and
- discovering hierarchical AGENTS config files from global -> project -> local directories.

It is intentionally split into small, composable utilities rather than one orchestrator.

---

## Component Map

- `skill-types.ts`
  - Canonical types for skill metadata and registry/search responses.
- `skill-loader.ts`
  - Async, simple discovery of `SKILL.md` folders into `SkillDefinition[]`.
  - Designed for prompt-time discovery/content loading.
- `skill-directory-loader.ts`
  - Recursive sync loader that feeds a `SkillRegistry`.
  - Supports both `SKILL.md` and `*.skill.json`.
- `skill-registry.ts`
  - In-memory registry with lookup, search, category/tag queries, and prompt formatting.
- `skill-injector.ts`
  - Appends a lightweight "Skills Available" section to a system prompt.
- `skill-manager.ts`
  - Atomic write API for create/edit/patch/read of `SKILL.md`.
  - Includes content limits and security scanning via `sanitizeMemoryContent`.
- `skill-learner.ts`
  - In-memory execution telemetry and optimization/review candidate selection.
- `skill-chain.ts`
  - Lightweight declarative chain definition and validation helpers.
- `agents-md-parser.ts`
  - Parses AGENTS/CLAUDE markdown content to instructions/rules/tool allow/deny lists.
- `hierarchical-walker.ts`
  - Finds AGENTS/CLAUDE files across hierarchy and parses each into config objects.
- `index.ts`
  - Re-export surface for this module.

---

## Data Model

### `SkillDefinition` (lightweight file skill)

Used by `SkillLoader` and prompt injection flows.

- `name`, `description`, `path` are required.
- Optional `compatibility`, `allowedTools`, `metadata`.

### `SkillRegistryEntry` (full registry skill)

Used by `SkillRegistry` and adapter projection pipelines.

- required: `id`, `name`, `description`, `instructions`
- optional: `category`, `version`, `requiredTools`, `tags`, `priority`

### `LoadedSkill`

`SkillRegistryEntry` + runtime metadata:

- `sourcePath?`
- `loadedAt` (epoch ms)

### `SkillMatch`

Search result wrapper:

- `skill` (`LoadedSkill`)
- `confidence` (`0..1`)
- `reason`

---

## Main Features and Flows

## 1) Skill Discovery and Loading

### A. `SkillLoader` (async, simple)

Primary methods:

- `discoverSkills(): Promise<SkillDefinition[]>`
  - scans each configured base path,
  - only inspects immediate subdirectories,
  - expects `SKILL.md` in each subdir,
  - parses frontmatter and returns lightweight definitions.
- `loadSkillContent(skillName): Promise<string | null>`
  - loads one skill body (content after frontmatter) by folder name.
- `formatSkillList(skills): string`
  - creates a markdown listing of discovered skills.

Flow:

1. Iterate configured directories.
2. For each subdir, read `SKILL.md`.
3. Parse frontmatter (`name`, `description`, optional fields).
4. Return valid definitions; skip unreadable/invalid entries.

### B. `SkillDirectoryLoader` (registry-first)

Primary methods:

- `loadFromDirectory(dirPath): number`
- `loadFromDirectories(dirPaths): number`
- `loadMarkdownFile(filePath): boolean`
- `loadJsonFile(filePath): boolean`

Flow:

1. Recursively traverse directory tree (bounded by `maxDepth`, default `10`).
2. Parse:
   - `SKILL.md` via `parseMarkdownSkill`,
   - `*.skill.json` via `parseJsonSkill`.
3. Register parsed entries into `SkillRegistry`.
4. Return number of successfully loaded skills.

Key difference vs `SkillLoader`:

- `SkillLoader` is async + lightweight + folder-oriented.
- `SkillDirectoryLoader` is sync + recursive + registry-oriented + JSON-capable.

---

## 2) In-Memory Skill Registry

`SkillRegistry` responsibilities:

- `register`, `unregister`, `get`, `has`, `clear`, `size`
- sorted listing (`priority desc`, then `name asc`)
- `listByCategory`
- `findByTags` (case-insensitive overlap + confidence score)
- `search` (name/description/tag text matching)
- `categories`, `allTags`
- `formatForPrompt(skills)` for richer prompt injection including `requiredTools`.

Matching/scoring:

- `findByTags`: `matchingTags / max(skillTags, queryTags)`; sorted by priority then confidence.
- `search`: name match (`1.0`) > tag (`0.7`) > description (`0.4`); sorted by priority then confidence.

---

## 3) Prompt Injection

There are two injection styles in this module:

- `injectSkills(systemPrompt, skills: SkillDefinition[])`
  - simple section (`## Skills Available`) with name + description + path.
- `SkillRegistry.formatForPrompt(skills: LoadedSkill[])`
  - richer per-skill blocks with full instructions and required tools.

Additionally, `SubAgentSpawner` uses `SkillLoader` directly:

- It discovers available skills.
- Filters by `config.skills`.
- Appends full skill body to sub-agent system prompt as `## Skill: <name>`.

---

## 4) Skill Lifecycle Management (`SkillManager`)

Write operations:

- `create(input)`
  - validate name and limits,
  - security scan content,
  - fail on existing skill collision,
  - atomic write (`temp + rename`).
- `edit(input)`
  - full rewrite of existing skill with rebuilt frontmatter.
- `patch(skillName, { find, replace })`
  - targeted one-occurrence replacement; rejects zero or multiple matches.
- `readSkill(skillName)`
  - parse `SKILL.md` to `SkillDefinition`.

Auxiliary:

- `shouldCreateSkill(metrics)` heuristic:
  - true on novel pattern,
  - or higher complexity thresholds (`phasesExecuted`, `fixIterations`, `llmCalls`).

Safety controls:

- strict name pattern (`[a-z0-9][a-z0-9._-]*`)
- max content length (default `50_000`)
- `sanitizeMemoryContent` security scan before persist
- atomic write path with cleanup on rename failure

---

## 5) Skill Learning and Optimization Signals (`SkillLearner`)

Core behavior:

- `recordExecution(name, { success, tokens, latencyMs })`
  - stores/upserts in-memory metrics,
  - updates rolling averages and success rate.
- `getMetrics`, `getAllMetrics`
- `getSkillsNeedingReview()`
  - below review threshold and enough samples.
- `getOptimizableSkills()`
  - above optimization threshold and enough samples.
- `buildOptimizationPrompt(skillName, currentPrompt)`
  - generates a prompt template for LLM-based instruction refinement.
- `resetMetrics(name)`

This is an in-memory telemetry helper; persistence is owned by callers.

---

## 6) Skill Chains (`skill-chain.ts`)

Purpose:

- define small declarative multi-step skill pipelines.

APIs:

- `createSkillChain(name, steps)` with non-empty validations.
- `validateChain(chain, availableSkills)` returns:
  - `valid`
  - deduplicated `missingSkills`.

No executor is included here; this module only models and validates chain structure.

---

## 7) AGENTS.md Parsing and Hierarchical Discovery

### `parseAgentsMd(content)`

Produces `AgentsMdConfig`:

- `instructions[]` (top-level + named sections),
- `rules[]` (glob headings like `*.ts`),
- `allowedTools[]`/`blockedTools[]` from `## Tools`.

### `mergeAgentsMdConfigs(configs)`

- merges instruction and rule arrays in order,
- merges+deduplicates tool lists.

### `discoverAgentConfigs(cwd)`

Search order:

1. global config (`~/.config/dzupagent/{AGENTS.md,.agents.md,CLAUDE.md}`)
2. project root config (git root)
3. directories between git root and current directory

Each found file is parsed and returned as `HierarchyLevel`.

---

## Cross-Package References and Usage

## `packages/agent`

- `packages/agent/src/agent/tool-loop-learning.ts`
  - imports and instantiates `SkillLearner`,
  - records tool execution as "skill" metrics,
  - exposes review/optimization candidate lists in run-level learnings.

Impact:

- this is the primary runtime consumer of `SkillLearner` outside `core`.

## `packages/agent-adapters`

- `packages/agent-adapters/src/skills/skill-projector.ts`
  - imports `SkillRegistryEntry` type from `@dzupagent/core`,
  - projects core skill entries into provider-specific system-prompt formats
    (Claude, Codex, Gemini, generic providers),
  - aggregates required tools.

Impact:

- skill schema consistency across packages depends on `SkillRegistryEntry`.

## `packages/core` (other internal modules)

- `packages/core/src/subagent/subagent-spawner.ts`
  - uses `SkillLoader` to append selected skill instructions into sub-agent prompts.
- `packages/core/src/formats/agents-md-parser-v2.ts`
  - depends on `AgentsMdConfig` type for v2 -> legacy conversion.
- `packages/core/src/facades/orchestration.ts` and `packages/core/src/index.ts`
  - export this module's APIs as public package surface.

Note:

- `packages/agent` has a separate AGENTS parser (`agent/src/instructions/agents-md-parser.ts`), so not all AGENTS parsing flows use `core/src/skills/agents-md-parser.ts`.

---

## Usage Examples

### 1) Load skills into registry and build prompt context

```ts
import { SkillRegistry, SkillDirectoryLoader } from '@dzupagent/core'

const registry = new SkillRegistry()
const loader = new SkillDirectoryLoader(registry)

loader.loadFromDirectory('/path/to/skills')

const matches = registry.findByTags(['database', 'migration'])
const topSkills = matches.slice(0, 2).map(m => m.skill)
const promptSection = registry.formatForPrompt(topSkills)
```

### 2) Simple discovery + injection for system prompt

```ts
import { SkillLoader, injectSkills } from '@dzupagent/core'

const loader = new SkillLoader(['/path/to/skills'])
const skills = await loader.discoverSkills()
const systemPrompt = injectSkills('You are a coding agent.', skills)
```

### 3) Create and patch a skill safely

```ts
import { SkillManager } from '@dzupagent/core'

const manager = new SkillManager({ skillsDir: '/home/user/.dzupagent/skills' })

await manager.create({
  name: 'sql-review',
  description: 'Review SQL for safety and performance',
  allowedTools: ['read_file', 'search_code'],
  body: '## Checklist\n- Validate indexes\n- Check unsafe dynamic SQL',
})

await manager.patch('sql-review', {
  find: '- Validate indexes',
  replace: '- Validate indexes and query plans',
})
```

### 4) Track execution quality and decide optimization candidates

```ts
import { SkillLearner } from '@dzupagent/core'

const learner = new SkillLearner({ minExecutionsForOptimization: 5 })

learner.recordExecution('sql-review', { success: true, tokens: 120, latencyMs: 450 })
learner.recordExecution('sql-review', { success: false, tokens: 95, latencyMs: 500 })

const reviewQueue = learner.getSkillsNeedingReview()
const optimizeQueue = learner.getOptimizableSkills()
```

### 5) Parse and merge AGENTS config

```ts
import { parseAgentsMd, mergeAgentsMdConfigs } from '@dzupagent/core'

const project = parseAgentsMd('Use strict typing.\n## Tools\n- read_file\n- !rm_rf')
const local = parseAgentsMd('## *.test.ts\nAlways add edge-case tests.')

const merged = mergeAgentsMdConfigs([project, local])
```

---

## Test Coverage (Current State)

## Directly covered by tests

- `skill-registry.ts`
  - `packages/core/src/__tests__/skill-registry.test.ts`
  - covers CRUD, sorting, tag/keyword matching, prompt formatting, categories/tags.
- `skill-directory-loader.ts`
  - `packages/core/src/__tests__/skill-loader.test.ts`
  - covers markdown/json parsing and recursive directory loading behaviors.
- `agents-md-parser.ts`
  - `packages/core/src/__tests__/agents-md-parser.test.ts`
  - covers top-level/named/glob/tools parsing + merge behavior.
- export surface checks
  - `packages/core/src/__tests__/facades.test.ts` validates facade exports.

## Cross-package coverage related to skills

- `packages/agent-adapters/src/__tests__/skill-projector.test.ts`
  - validates provider-specific prompt projection using `SkillRegistryEntry` schema.

## Not directly covered (gaps)

- `skill-loader.ts` (legacy async loader) lacks direct tests in `core`.
- `skill-injector.ts` lacks direct tests.
- `skill-manager.ts` lacks direct tests (create/edit/patch/read + atomic-write paths + scan failures).
- `skill-learner.ts` lacks direct tests.
- `skill-chain.ts` lacks direct tests.
- `hierarchical-walker.ts` lacks direct tests.
- `SubAgentSpawner` has strong loop tests, but no dedicated assertions for skill-loading branch behavior.

---

## Practical Notes and Risks

- `SkillLoader.loadSkillContent(skillName)` resolves by directory name, while `SubAgentSpawner` filters by parsed `skill.name`; this assumes `skill.name` matches folder name.
- The module currently has two loader paradigms (`SkillLoader` vs `SkillDirectoryLoader`) with overlapping purpose; callers should pick one based on whether they need lightweight prompt listing or registry-driven matching.
- `SkillLearner` metrics are process-local; multi-run or distributed learning requires external snapshot/persistence.

---

## Recommended Test Additions

1. Add focused tests for `skill-manager.ts` covering:
   - name validation failures,
   - duplicate create, missing edit target,
   - patch uniqueness checks,
   - security scan rejection path,
   - atomic rename failure handling.
2. Add unit tests for `skill-learner.ts`:
   - incremental average math,
   - thresholds and boundary values,
   - optimization prompt formatting.
3. Add tests for `hierarchical-walker.ts`:
   - global/project/directory ordering,
   - git-root fallback behavior,
   - unreadable file handling.
4. Add a `SubAgentSpawner` test specifically for configured skills loading and prompt append behavior.


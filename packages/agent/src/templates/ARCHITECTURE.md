# `src/templates` Architecture

This document describes the template subsystem in `packages/agent/src/templates` as of **April 4, 2026**.

## Scope

The module provides a declarative template layer for reusable agent personas and discovery metadata. It does **not** execute agents.

Owned files:

- `agent-templates.ts`: type definitions + 22 built-in templates + lookup helpers.
- `template-composer.ts`: deterministic merge logic for composing multiple templates.
- `template-registry.ts`: mutable runtime registry for built-in and custom templates.
- `index.ts`: local barrel exports.

Public exposure:

- Root package exports are re-exported from `packages/agent/src/index.ts` so consumers can import from `@dzupagent/agent`.
- `packages/agent/package.json` only exposes the root entrypoint (`"."`), so template APIs are consumed via root exports, not via deep import paths.

## Core Design

### 1. `AgentTemplate` is metadata, not runtime wiring

`AgentTemplate` is defined in `agent-templates.ts` and intentionally stores **hints**:

- `instructions`: persona/system prompt text.
- `modelTier`: `'fast' | 'balanced' | 'powerful'` (advisory tier).
- `suggestedTools`: tool name hints (strings), not tool instances.
- `guardrails`: optional budget defaults (`maxTokens`, `maxCostCents`, `maxIterations`).
- `tags` + `category`: discovery dimensions.

This is intentionally decoupled from `DzupAgentConfig` in `src/agent/agent-types.ts`, where:

- `model` is a real model instance or registry tier/name.
- `tools` are concrete `StructuredToolInterface[]`.

### 2. Built-in catalog shape

`ALL_AGENT_TEMPLATES` currently ships **22** templates across 6 categories:

- `code` (7): `code-reviewer`, `code-generator`, `refactoring-specialist`, `test-writer`, `bug-fixer`, `security-auditor`, `migration-agent`.
- `data` (3): `data-analyst`, `etl-pipeline-builder`, `schema-designer`.
- `infrastructure` (3): `devops-engineer`, `monitoring-specialist`, `ci-cd-builder`.
- `content` (3): `technical-writer`, `api-doc-generator`, `changelog-writer`.
- `research` (3): `literature-reviewer`, `competitive-analyst`, `technology-scout`.
- `automation` (3): `workflow-automator`, `notification-manager`, `report-generator`.

A backward-compatible record index is also exported:

- `AGENT_TEMPLATES: Record<string, AgentTemplate>`.
- `getAgentTemplate(id)` and `listAgentTemplates()` convenience helpers.

### 3. Composition semantics (`composeTemplates`)

`composeTemplates(templates)` applies deterministic merge rules:

- `id`: joined with `+`.
- `name`: joined with ` + `.
- `description`: joined with ` | `.
- `category`: first template wins.
- `instructions`: joined with `\n\n---\n\n`.
- `modelTier`: highest rank wins (`powerful > balanced > fast`).
- `suggestedTools`: set union (deduplicated).
- `guardrails`: field-wise max.
- `tags`: set union.

Edge handling:

- Empty input throws.
- Single input returns a shallow copy.

### 4. Runtime registry semantics (`TemplateRegistry`)

`TemplateRegistry` is mutable and map-backed:

- Constructor preloads built-ins by default (`new TemplateRegistry()`), or starts empty (`new TemplateRegistry(false)`).
- `register` upserts by ID.
- `get`, `list`, `listByTag`, `listByCategory`, `remove`, and `size` are provided.
- Tag matching is case-sensitive.

## Feature Catalog with Use Cases

### Code templates

- `code-reviewer`: PR review, static risk triage, secure code checks.
- `code-generator`: spec-to-code implementation tasks.
- `refactoring-specialist`: non-functional refactors with behavior preservation.
- `test-writer`: unit/integration test authoring.
- `bug-fixer`: stack-trace-driven bug diagnosis and patching.
- `security-auditor`: OWASP/CVE-oriented static assessment.
- `migration-agent`: framework/version migration planning and execution.

### Data templates

- `data-analyst`: exploratory data analysis and SQL insight generation.
- `etl-pipeline-builder`: pipeline design with idempotency/error recovery.
- `schema-designer`: schema/index/migration design.

### Infrastructure templates

- `devops-engineer`: deployment, IaC, CI/CD troubleshooting.
- `monitoring-specialist`: observability stack and SLO/SLI alert design.
- `ci-cd-builder`: optimized pipeline authoring and hardening.

### Content templates

- `technical-writer`: technical docs, READMEs, architecture docs.
- `api-doc-generator`: API reference synthesis from code/specs.
- `changelog-writer`: release notes from git artifacts.

### Research templates

- `literature-reviewer`: source synthesis across papers/docs/RFCs.
- `competitive-analyst`: market/framework comparisons and SWOT.
- `technology-scout`: adoption readiness and integration risk assessment.

### Automation templates

- `workflow-automator`: repetitive engineering task automation.
- `notification-manager`: channel routing + dedupe/escalation policy definition.
- `report-generator`: periodic deterministic report generation.

## Consumption Flow

```mermaid
flowchart TD
  A[Select built-in or custom template] --> B[Resolve template metadata]
  B --> C[Map modelTier hint to concrete model or registry tier]
  B --> D[Resolve suggestedTools names to concrete tool instances]
  B --> E[Apply guardrails to DzupAgentConfig]
  C --> F[Construct DzupAgentConfig]
  D --> F
  E --> F
  F --> G[new DzupAgent(config)]
```

Important boundary:

- Step C and D are caller-owned. This module does not provide a built-in `template -> DzupAgentConfig` adapter.

## Usage Examples

### 1) Lookup and instantiate a template-backed agent

```ts
import { DzupAgent, getAgentTemplate } from '@dzupagent/agent'
import type { StructuredToolInterface } from '@langchain/core/tools'

function mapTemplateTierToModel(tier: 'fast' | 'balanced' | 'powerful') {
  if (tier === 'fast') return 'chat'
  if (tier === 'balanced') return 'reasoning'
  return 'codegen'
}

function selectTools(
  allTools: StructuredToolInterface[],
  names: string[] | undefined,
): StructuredToolInterface[] {
  if (!names || names.length === 0) return []
  const wanted = new Set(names)
  return allTools.filter(t => wanted.has(t.name))
}

const template = getAgentTemplate('code-reviewer')
if (!template) throw new Error('Unknown template')

const agent = new DzupAgent({
  id: `tmpl-${template.id}`,
  name: template.name,
  description: template.description,
  instructions: template.instructions,
  model: mapTemplateTierToModel(template.modelTier),
  tools: selectTools(toolCatalog, template.suggestedTools),
  guardrails: template.guardrails,
})
```

### 2) Compose specialized personas

```ts
import { composeTemplates, getAgentTemplate } from '@dzupagent/agent'

const reviewer = getAgentTemplate('code-reviewer')!
const security = getAgentTemplate('security-auditor')!
const merged = composeTemplates([reviewer, security])

// merged.id -> "code-reviewer+security-auditor"
// merged.modelTier -> "powerful"
// merged.suggestedTools -> union of both templates
```

### 3) Runtime custom registry

```ts
import { TemplateRegistry } from '@dzupagent/agent'

const registry = new TemplateRegistry() // includes built-ins

registry.register({
  id: 'incident-commander',
  name: 'Incident Commander',
  description: 'Coordinates production incidents and comms.',
  category: 'automation',
  instructions: 'Lead incident triage, assign owners, track timeline, and publish status updates.',
  modelTier: 'balanced',
  suggestedTools: ['read_file', 'write_file', 'search_code'],
  guardrails: { maxIterations: 10, maxTokens: 80_000, maxCostCents: 40 },
  tags: ['incident-response', 'operations'],
})

const opsTemplates = registry.listByTag('incident-response')
```

## Cross-Package References and Current Usage

### Direct code usage of template APIs

As of this analysis, `rg` over `packages/**` shows:

- Template APIs (`getAgentTemplate`, `listAgentTemplates`, `composeTemplates`, `TemplateRegistry`) are used directly in:
  - `packages/agent/src/templates/*` (their own implementation),
  - `packages/agent/src/__tests__/agent-templates.test.ts` (verification),
  - and re-exported in `packages/agent/src/index.ts`.
- No other package currently imports these APIs in runtime TypeScript code.

### How other packages use `@dzupagent/agent`

Other packages commonly instantiate `new DzupAgent({...})` directly from their own config sources, for example:

- `packages/server/src/runtime/dzip-agent-run-executor.ts`: builds config from run metadata (`ctx.agent.*`) and resolved tools.
- `packages/create-dzupagent/src/templates/*.ts`: scaffolds starter projects with direct `DzupAgent` construction snippets.

Implication:

- The template subsystem is currently a reusable catalog/utility layer, not yet a shared, enforced config source across packages.

## Test Coverage and Verification

### Unit test scope

Primary test file:

- `packages/agent/src/__tests__/agent-templates.test.ts`.

Validated behaviors:

- Structural integrity of all templates.
- Unique IDs.
- Minimum per-category template counts.
- Lookup/index helpers.
- Full `composeTemplates` behavior (empty/single/multi, tool/tag unions, tier precedence, guardrail maxing, category and id semantics).
- Full `TemplateRegistry` behavior (init modes, register overwrite, get/list/filter/remove/size).

Execution result:

- Command: `yarn workspace @dzupagent/agent test src/__tests__/agent-templates.test.ts`
- Result: **36/36 tests passing**.

### Focused coverage result for `src/templates`

Command used:

- `yarn workspace @dzupagent/agent test --coverage --coverage.include=src/templates/*.ts --coverage.thresholds.lines=0 --coverage.thresholds.statements=0 --coverage.thresholds.functions=0 --coverage.thresholds.branches=0 src/__tests__/agent-templates.test.ts`

Coverage:

- `agent-templates.ts`: 100 statements / 100 branches / 100 functions / 100 lines.
- `template-registry.ts`: 100 statements / 100 branches / 100 functions / 100 lines.
- `template-composer.ts`: 100 statements / 87.87 branches / 100 functions / 100 lines.
- Aggregate (`src/templates/*.ts`): 100 statements / 91.83 branches / 100 functions / 100 lines.

Uncovered branch points in `template-composer.ts`:

- line 59 (`RANK_TO_TIER[maxRank] ?? 'fast'` fallback branch).
- lines 95-97 (conditional object spread branches for partial guardrail field presence).

## Architecture Observations

1. Strong points

- Clear separation between declarative template metadata and runtime agent execution.
- Deterministic composition rules with predictable merge behavior.
- Good test depth for this subsystem relative to its complexity.

2. Integration gap (intentional but important)

- No first-party adapter converts `AgentTemplate` into `DzupAgentConfig` with concrete model/tool resolution.
- Consumers must duplicate mapping logic (especially `modelTier` and `suggestedTools`).

3. Mutability caveat

- Registry and lookup paths return object references, not deep clones.
- External mutation of returned template objects can affect shared in-memory state.

4. Categorization caveat in composition

- `composeTemplates` keeps the category of the first template, even for mixed-category composition.
- This is deterministic, but can misrepresent a truly hybrid composed persona in UI/filtering.

## Practical Recommendations

- Add an optional helper such as `buildAgentConfigFromTemplate(template, deps)` (similar to presets factory) to standardize model/tool mapping.
- Consider defensive cloning or immutable freezing for built-ins/registry returns to prevent accidental shared-state mutation.
- If mixed-category composition is expected in product surfaces, add explicit metadata (for example `sourceCategories`) in composed templates.

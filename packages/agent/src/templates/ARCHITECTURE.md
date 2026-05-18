# Templates Subsystem Architecture

## Scope
This document covers `packages/agent/src/templates` in `@dzupagent/agent`:

- `agent-templates-types.ts`
- `agent-templates-code.ts`
- `agent-templates-data.ts`
- `agent-templates-ops.ts`
- `agent-templates.ts`
- `template-composer.ts`
- `template-registry.ts`
- `index.ts`

The subsystem is a metadata and composition layer. It defines reusable template objects, provides deterministic merge behavior, and exposes a mutable in-memory registry. It does not instantiate `DzupAgent`, bind real tools, or resolve model objects.

## Responsibilities
- Define the canonical template type system:
  - `AgentTemplateCategory`
  - `AgentTemplate`
- Publish built-in template data and accessors:
  - `ALL_AGENT_TEMPLATES`
  - `AGENT_TEMPLATES`
  - `getAgentTemplate(id)`
  - `listAgentTemplates()`
- Provide deterministic template composition via `composeTemplates`.
- Provide runtime registration/query/remove behavior via `TemplateRegistry`.
- Re-export templates APIs from the templates barrel and package root for external consumption.

## Structure
- `agent-templates-types.ts`
  - Contains category union and `AgentTemplate` interface.
  - `modelTier` is constrained to `'fast' | 'balanced' | 'powerful'`.
  - `suggestedTools` are string hints; `guardrails` are optional numeric limits.
- `agent-templates-code.ts`
  - Defines 7 code templates and `CODE_TEMPLATES`.
- `agent-templates-data.ts`
  - Defines 3 data templates and `DATA_TEMPLATES`.
- `agent-templates-ops.ts`
  - Defines 12 templates across infrastructure/content/research/automation:
    - `INFRASTRUCTURE_TEMPLATES` (3)
    - `CONTENT_TEMPLATES` (3)
    - `RESEARCH_TEMPLATES` (3)
    - `AUTOMATION_TEMPLATES` (3)
  - Exposes flattened `OPS_TEMPLATES`.
- `agent-templates.ts`
  - Re-exports types and individual template constants.
  - Builds:
    - `ALL_AGENT_TEMPLATES = [...CODE_TEMPLATES, ...DATA_TEMPLATES, ...OPS_TEMPLATES]` (22 total)
    - `AGENT_TEMPLATES` record via `Object.fromEntries`.
  - Exposes lookup helpers.
- `template-composer.ts`
  - Implements `composeTemplates(templates)` merge rules.
  - Uses `omitUndefined` from `../utils/exact-optional.js` to drop undefined optional fields.
- `template-registry.ts`
  - Implements `TemplateRegistry` with internal `Map<string, AgentTemplate>`.
  - Optional built-in preloading through constructor flag.
- `index.ts`
  - Templates subsystem barrel exports.
  - Package root also re-exports these APIs from `src/index.ts`.

## Runtime and Control Flow
1. Template definition and aggregation:
   - Category files export immutable template objects.
   - `agent-templates.ts` concatenates category arrays into `ALL_AGENT_TEMPLATES`.
   - `AGENT_TEMPLATES` provides O(1)-style lookup by ID through an object map.
2. Read path:
   - Callers use `getAgentTemplate(id)` or `listAgentTemplates()`.
   - `getAgentTemplate` reads from `AGENT_TEMPLATES` and may return `undefined`.
3. Composition path:
   - `composeTemplates` throws if input is empty.
   - Single template input returns a shallow copy.
   - Multi-template input merges fields with fixed rules:
     - ID/name/description/instructions concatenate with fixed separators.
     - Category is taken from the first template only.
     - `modelTier` picks highest rank (`powerful > balanced > fast`).
     - `suggestedTools` and `tags` are deduplicated using insertion-order `Set`.
     - `guardrails` are merged per numeric key using max semantics.
4. Registry path:
   - `new TemplateRegistry()` preloads built-ins.
   - `new TemplateRegistry(false)` starts empty.
   - `register` overwrites by ID.
   - `listByTag` and `listByCategory` filter current map values.
   - `remove` deletes by ID and returns boolean.

No file I/O, network, telemetry emission, or persistence is performed in this subsystem.

## Key APIs and Types
- `type AgentTemplateCategory = 'code' | 'data' | 'infrastructure' | 'content' | 'research' | 'automation'`
- `interface AgentTemplate`
  - Required: `id`, `name`, `description`, `category`, `instructions`, `modelTier`, `tags`
  - Optional: `suggestedTools?: string[]`, `guardrails?: { maxTokens?: number; maxCostCents?: number; maxIterations?: number }`
- Built-in catalog:
  - `ALL_AGENT_TEMPLATES: readonly AgentTemplate[]` (22 templates)
  - `AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>>`
  - `getAgentTemplate(id: string): AgentTemplate | undefined`
  - `listAgentTemplates(): string[]`
- Composition:
  - `composeTemplates(templates: AgentTemplate[]): AgentTemplate`
  - Throws `Error('composeTemplates requires at least one template')` on empty input.
- Registry:
  - `class TemplateRegistry`
  - `constructor(includeBuiltins = true)`
  - `register(template)`, `get(id)`, `list()`, `listByTag(tag)`, `listByCategory(category)`, `remove(id)`, `size`

## Dependencies
- Internal code dependencies:
  - `template-registry.ts` depends on `ALL_AGENT_TEMPLATES`.
  - `template-composer.ts` depends on template types and `omitUndefined` helper (`../utils/exact-optional.js`).
  - `agent-templates.ts` composes exports from `agent-templates-code.ts`, `agent-templates-data.ts`, and `agent-templates-ops.ts`.
- External/package dependencies:
  - Templates code itself introduces no direct third-party imports.
  - The only cross-package helper call is `omitUndefined` re-exported from `@dzupagent/core/utils`.
- Packaging/export context (`package.json`):
  - Templates API is available through package root export `"."` (`@dzupagent/agent`).
  - There is no dedicated `./templates` subpath export.

## Integration Points
- Package root exports in `src/index.ts`:
  - `AGENT_TEMPLATES`, `ALL_AGENT_TEMPLATES`, `getAgentTemplate`, `listAgentTemplates`, `composeTemplates`, `TemplateRegistry`.
- Pipeline integration in `src/pipeline/pipeline-templates.ts`:
  - Uses built-in-compatible IDs such as `code-reviewer`, `test-writer`, `bug-fixer`, `refactoring-specialist`, `report-generator`.
  - Also references IDs not provided by built-ins (`static-analyzer`, `feature-planner`, `code-analyzer`, `publisher`, `error-handler`), so runtime registries must provide these when executing those pipelines.
- README/docs integration:
  - `packages/agent/README.md` documents templates APIs and template count.

## Testing and Observability
- Template-focused test suites:
  - `src/__tests__/agent-templates.test.ts`
  - `src/__tests__/template-composer.test.ts`
  - `src/__tests__/template-registry-extended.test.ts`
- Covered behaviors include:
  - Built-in template structural validity, uniqueness, and category minimum counts.
  - Lookup helper behavior (`getAgentTemplate`, `listAgentTemplates`).
  - Full composition semantics (delimiters, tier precedence, dedup order, guardrail merge edge cases, immutability).
  - Registry semantics (preload toggle, overwrite behavior, ordering stability, mutation/query interactions).
- Local verification (current workspace):
  - Command: `yarn workspace @dzupagent/agent test src/__tests__/agent-templates.test.ts src/__tests__/template-composer.test.ts src/__tests__/template-registry-extended.test.ts`
  - Result: 3 test files passed, 113 tests passed.
- Observability:
  - No dedicated logs, metrics, spans, or events are emitted by templates modules.
  - Runtime confidence is primarily test-based.

## Risks and TODOs
- Shared-reference mutability:
  - Built-ins and registry entries are returned by reference (`get`, `list`), so consumer mutation can alter in-memory template objects.
- Built-in/runtime ID drift:
  - Pipeline template factories reference some agent IDs that are not part of `ALL_AGENT_TEMPLATES`; execution depends on external registration/config.
- Category semantics in composition:
  - `composeTemplates` always keeps the first template category, even for mixed-category compositions.
- Guardrail merge edge cases:
  - Empty guardrail objects can produce `{}`.
  - Negative numeric values are effectively floored by `Math.max(seed, value)` seed behavior.
- Tag filtering strictness:
  - `listByTag` is exact and case-sensitive; there is no normalization or aliasing.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


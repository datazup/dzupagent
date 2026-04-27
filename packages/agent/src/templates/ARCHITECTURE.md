# Templates Subsystem Architecture

## Scope
This document covers `packages/agent/src/templates`:

- `agent-templates.ts`
- `template-composer.ts`
- `template-registry.ts`
- `index.ts`

This subsystem provides declarative template metadata and composition/registry utilities. It does not instantiate `DzupAgent`, resolve model instances, or resolve concrete tool implementations.

## Responsibilities
- Define the `AgentTemplate` contract and category taxonomy.
- Publish the built-in template catalog (`ALL_AGENT_TEMPLATES` and record form `AGENT_TEMPLATES`).
- Provide lookup helpers (`getAgentTemplate`, `listAgentTemplates`).
- Compose multiple templates deterministically (`composeTemplates`).
- Provide a mutable in-memory registry for built-ins and custom templates (`TemplateRegistry`).
- Re-export the templates API through package root exports (`src/index.ts`).

## Structure
- `agent-templates.ts`
  - Declares:
    - `AgentTemplateCategory` union: `code | data | infrastructure | content | research | automation`
    - `AgentTemplate` interface with `id`, `name`, `description`, `category`, `instructions`, `modelTier`, optional `suggestedTools`, optional `guardrails`, and `tags`
  - Defines 22 built-in templates:
    - `code` (7): `code-reviewer`, `code-generator`, `refactoring-specialist`, `test-writer`, `bug-fixer`, `security-auditor`, `migration-agent`
    - `data` (3): `data-analyst`, `etl-pipeline-builder`, `schema-designer`
    - `infrastructure` (3): `devops-engineer`, `monitoring-specialist`, `ci-cd-builder`
    - `content` (3): `technical-writer`, `api-doc-generator`, `changelog-writer`
    - `research` (3): `literature-reviewer`, `competitive-analyst`, `technology-scout`
    - `automation` (3): `workflow-automator`, `notification-manager`, `report-generator`
  - Exposes:
    - `ALL_AGENT_TEMPLATES` (array form)
    - `AGENT_TEMPLATES` (ID-keyed record built from the array)
    - `getAgentTemplate(id)`
    - `listAgentTemplates()`

- `template-composer.ts`
  - Exposes `composeTemplates(templates: AgentTemplate[]): AgentTemplate`.
  - Implements merge policy for IDs/names/descriptions/instructions, model-tier precedence, union/dedup for tools/tags, and max-merge for guardrails.

- `template-registry.ts`
  - Exposes `TemplateRegistry` backed by `Map<string, AgentTemplate>`.
  - Constructor supports `includeBuiltins` (default `true`).
  - Supports `register`, `get`, `list`, `listByTag`, `listByCategory`, `remove`, and `size`.

- `index.ts`
  - Barrel export of the templates subsystem.
  - Package root (`src/index.ts`) re-exports these symbols, and `package.json` exports only `"."`, so consumers use `@dzupagent/agent` imports.

## Runtime and Control Flow
1. Read path:
   - Caller requests built-ins via `ALL_AGENT_TEMPLATES`, `AGENT_TEMPLATES`, `getAgentTemplate`, or `listAgentTemplates`.
2. Composition path:
   - Caller passes one or more templates to `composeTemplates`.
   - Empty array throws `Error('composeTemplates requires at least one template')`.
   - Single entry returns a shallow copy.
   - Multi-entry merges fields with deterministic rules.
3. Registry path:
   - `new TemplateRegistry()` seeds from `ALL_AGENT_TEMPLATES`.
   - `new TemplateRegistry(false)` starts empty.
   - `register` upserts by ID, `remove` deletes by ID.
   - `listByTag` uses case-sensitive tag matching, `listByCategory` performs exact union-member matching.

This module ends at metadata selection/composition/registration. Model and tool resolution into executable agent config are caller-owned.

## Key APIs and Types
- `type AgentTemplateCategory = 'code' | 'data' | 'infrastructure' | 'content' | 'research' | 'automation'`
- `interface AgentTemplate`
  - `modelTier: 'fast' | 'balanced' | 'powerful'`
  - `suggestedTools?: string[]` (string hints, not tool objects)
  - `guardrails?: { maxTokens?: number; maxCostCents?: number; maxIterations?: number }`
- `const ALL_AGENT_TEMPLATES: readonly AgentTemplate[]`
- `const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>>`
- `function getAgentTemplate(id: string): AgentTemplate | undefined`
- `function listAgentTemplates(): string[]`
- `function composeTemplates(templates: AgentTemplate[]): AgentTemplate`
  - Merge specifics:
    - `id`: `+` join
    - `name`: ` + ` join
    - `description`: ` | ` join
    - `category`: first template category
    - `instructions`: `\n\n---\n\n` join
    - `modelTier`: highest rank (`powerful > balanced > fast`)
    - `suggestedTools`: insertion-order set union, omitted when union is empty
    - `guardrails`: per-field max; if any template has `guardrails: {}` then output may contain empty `{}` guardrails
    - `tags`: insertion-order set union
- `class TemplateRegistry`
  - `constructor(includeBuiltins = true)`
  - `register(template)`, `get(id)`, `list()`, `listByTag(tag)`, `listByCategory(category)`, `remove(id)`, `size`

## Dependencies
- Internal module dependency graph:
  - `template-registry.ts` imports `ALL_AGENT_TEMPLATES` from `agent-templates.ts`.
  - `template-composer.ts` imports only `AgentTemplate` types.
  - `index.ts` re-exports all three modules.
- Package-level dependencies:
  - No additional external runtime dependency is introduced by `src/templates/*`.
  - Distribution/consumption follows `@dzupagent/agent` root export (`package.json` `"exports": { ".": ... }`).

## Integration Points
- Package root re-exports in `packages/agent/src/index.ts`:
  - `AGENT_TEMPLATES`, `ALL_AGENT_TEMPLATES`, `getAgentTemplate`, `listAgentTemplates`, `composeTemplates`, `TemplateRegistry`.
- Adjacent package features reference template IDs semantically:
  - `src/pipeline/pipeline-templates.ts` uses agent IDs such as `code-reviewer`, `test-writer`, `bug-fixer`, and `report-generator`, which align with built-in template IDs.
- Direct runtime usage inside `packages/agent/src` (excluding tests/docs) is limited to the templates module and re-exports; there is no built-in resolver that maps template metadata directly to `DzupAgent` executable config.

## Testing and Observability
- Test files covering this subsystem:
  - `src/__tests__/agent-templates.test.ts`
  - `src/__tests__/template-composer.test.ts`
  - `src/__tests__/template-registry-extended.test.ts`
- Verified behaviors include:
  - Built-in template structure and uniqueness.
  - Category minimums and lookup helpers.
  - Detailed composer semantics (all merge fields, edge cases, input immutability).
  - Registry behaviors (ordering, overwrite semantics, mutation/query interactions, built-in integration).
- Local verification run:
  - `yarn workspace @dzupagent/agent test src/__tests__/agent-templates.test.ts src/__tests__/template-composer.test.ts src/__tests__/template-registry-extended.test.ts`
  - Result: 3 files passed, 113 tests passed.
- Observability:
  - The templates subsystem does not emit telemetry/events/logs; observability is currently test-driven.

## Risks and TODOs
- Mutable object references:
  - `getAgentTemplate`, `TemplateRegistry.get`, and `TemplateRegistry.list` return stored object references. Caller mutation can alter shared in-memory template state.
- No first-party template-to-runtime adapter:
  - `modelTier` and `suggestedTools` are hints only; each consumer must implement mapping to concrete model/tool wiring.
- Composition category semantics:
  - `composeTemplates` keeps the first template category even for mixed-category compositions, which can be misleading for downstream filtering.
- Guardrail edge semantics:
  - `composeTemplates` max-merge uses `Math.max(max ?? 0, value)`; negative guardrail values collapse to `0` and empty guardrail objects can produce `{}`.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


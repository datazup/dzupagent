# `@dzupagent/core` Config Architecture

## Scope
This document describes the configuration and DI container subsystem in `packages/core/src/config`:
- `config-types.ts`
- `config-schema.ts`
- `config-loader.ts`
- `container.ts`
- `index.ts`

It also covers direct integration surfaces that expose this subsystem:
- `src/index.ts`
- `src/facades/quick-start.ts`
- `src/plugins.ts`
- `src/advanced.ts` (re-export path via root index)

Out of scope:
- broader runtime modules (LLM, persistence, routing, etc.) except where they are direct dependencies of config loading/normalization.

## Responsibilities
The subsystem has two primary responsibilities.

1. Runtime configuration resolution.
- Defines the config contracts (`ForgeConfig`, `ProviderConfig`, `ConfigLayer`, `RateLimitConfig`).
- Provides defaults (`DEFAULT_CONFIG`).
- Loads partial overrides from environment (`DZIP_*`) and optional JSON file.
- Merges layered config with deterministic precedence.
- Normalizes provider structured-output defaults so known providers gain capability metadata even when omitted.

2. Lightweight service container.
- `ForgeContainer` provides lazy singleton service registration and resolution.
- `createContainer()` returns a fresh container instance for bootstrapping.

## Structure
- `config-types.ts`
Defines the config domain model:
- provider entries (`provider`, `apiKey`, `baseUrl`, `priority`, optional `structuredOutputDefaults`)
- model tier names (`chat`, `codegen`, `reasoning`)
- memory backend (`postgres` or `in-memory`)
- server, security, plugin, MCP, and `custom` sections.

- `config-schema.ts`
Runtime validation and read helpers:
- `validateConfig(config)` performs manual structural checks.
- `getConfigValue(config, path, fallback)` performs dot-path traversal with fallback.
- Structured-output validation is constrained to the allowlist:
  `anthropic-tool-use`, `openai-json-schema`, `generic-parse`, `fallback-prompt`.

- `config-loader.ts`
Layering and normalization engine:
- `DEFAULT_CONFIG`
- `loadEnvConfig()`
- `loadFileConfig(filePath)`
- `mergeConfigs(...layers)`
- `resolveConfig(options)`

Internally, this file contains:
- `deepMerge` (object deep-merge, arrays replaced)
- provider normalization hooks via `llm/structured-output-capabilities.ts`

- `container.ts`
Minimal DI implementation:
- `ForgeContainer` with `register`, `get`, `has`, `list`, `reset`
- `createContainer()`

- `index.ts`
Config barrel exports only:
- loader functions/constants
- config types
- schema helpers

Note: `ForgeContainer` is intentionally not exported from `config/index.ts`; it is exported via `config/container.ts` by higher-level entrypoints.

## Runtime and Control Flow
Config resolution path in `resolveConfig`:

1. Start with a default layer marker: `{ name: 'defaults', priority: 10, config: {} }`.
2. If `options.configFile` exists, call `loadFileConfig(...)` and append priority `20`.
3. Always read `loadEnvConfig()` and append priority `30`.
4. If `options.runtimeOverrides` exists, append priority `40`.
5. Call `mergeConfigs(...layers)`.

`mergeConfigs` behavior:
- Sorts layers ascending by `priority`.
- Seeds merge with a shallow copy of `DEFAULT_CONFIG`.
- Applies `deepMerge` for each layer.
- Replaces arrays instead of concatenating.
- Re-normalizes provider structured-output defaults on final output.

`loadFileConfig` behavior:
- Reads JSON (`readFile`), parses, requires plain object root.
- Validates with `validateConfig`.
- Returns `{}` on any read/parse/validation failure.
- Normalizes provider structured-output defaults before returning.

`loadEnvConfig` behavior:
- Supports these env vars:
  - `DZIP_PROVIDERS` (JSON array)
  - `DZIP_MODEL_CHAT`, `DZIP_MODEL_CODEGEN`, `DZIP_MODEL_REASONING`
  - `DZIP_MEMORY_STORE`, `DZIP_MEMORY_CONN`
  - `DZIP_PORT`, `DZIP_CORS_ORIGINS`
  - `DZIP_PLUGINS`
  - `DZIP_SECURITY_RISK_CLASSIFICATION`, `DZIP_SECURITY_SECRETS_SCANNING`, `DZIP_SECURITY_OUTPUT_SANITIZATION`
- Hydrates missing model tiers from defaults when any `DZIP_MODEL_*` is set.
- Accepts only `postgres` and `in-memory` for memory store.
- Coerces `DZIP_PORT` via `Number(...)`.
- Splits CORS origins and plugin paths by comma.
- Parses security flags as strict `'true'` checks.

Container control flow:
- `register(name, factory)` stores factory and invalidates cached instance for that name.
- `get(name)` lazily creates singleton instance on first access and caches it.
- `reset()` clears only instantiated cache, not registrations.

## Key APIs and Types
Primary exports from this subsystem:

- Config loader/schemas:
  - `DEFAULT_CONFIG: ForgeConfig`
  - `loadEnvConfig(): Partial<ForgeConfig>`
  - `loadFileConfig(filePath: string): Promise<Partial<ForgeConfig>>`
  - `mergeConfigs(...layers: ConfigLayer[]): ForgeConfig`
  - `resolveConfig(options?): Promise<ForgeConfig>`
  - `validateConfig(config: unknown): { valid: boolean; errors: string[] }`
  - `getConfigValue<T>(config: ForgeConfig, path: string, fallback: T): T`

- Types:
  - `ForgeConfig`
  - `ProviderConfig`
  - `RateLimitConfig`
  - `ConfigLayer`

- Container:
  - `class ForgeContainer`
  - `createContainer(): ForgeContainer`

Notable type constraints in current code:
- `ForgeConfig.memory.store` is `'postgres' | 'in-memory'`.
- `ForgeConfig.server.rateLimit` is required and includes `maxRequests`/`windowMs`.
- `ProviderConfig.structuredOutputDefaults` uses `StructuredOutputModelCapabilities` from `llm/model-config.ts`.

## Dependencies
Direct runtime dependencies used in `src/config`:
- Node built-in: `node:fs/promises` (`readFile`) in `config-loader.ts`.
- Process env: `process.env` in `loadEnvConfig()`.

Internal module dependencies:
- `config-loader.ts` depends on:
  - `config-schema.ts` (`validateConfig`)
  - `config-types.ts`
  - `llm/structured-output-capabilities.ts` (provider capability normalization)
- `config-schema.ts` depends on:
  - `config-types.ts`
  - `llm/model-config.ts` (strategy typing)

Package-level dependency context (`packages/core/package.json`):
- `@dzupagent/core` runtime deps are `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`.
- Config module itself does not directly import those runtime deps.
- `zod` is a peer dependency but config validation is manual (no zod usage in `src/config`).

## Integration Points
Export integration:
- `src/index.ts` exports config APIs from `./config/index.js` and container APIs from `./config/container.js`.
- `src/facades/quick-start.ts` re-exports `DEFAULT_CONFIG`, `resolveConfig`, `mergeConfigs`, and container APIs.
- `src/plugins.ts` re-exports config APIs/types plus container APIs for plugin-centric consumers.
- `src/advanced.ts` re-exports root entrypoint; config and container exports flow through unchanged.

Runtime usage inside core package:
- `createQuickAgent` (`src/facades/quick-start.ts`) creates a container and registers `eventBus` and `registry` services.

Behavioral compatibility checks:
- `src/__tests__/facades.test.ts` and `src/__tests__/w15-b1-facades.test.ts` verify that config/container helpers remain available through expected entrypoints.

## Testing and Observability
Config-focused test coverage:
- `src/__tests__/config-loader.test.ts`
- `src/__tests__/config.test.ts`

Validated behavior includes:
- env parsing for all supported `DZIP_*` keys
- file read/parse/shape validation behavior
- priority-based override ordering (`runtime > env > file > defaults`)
- deep merge semantics and array replacement semantics
- provider structured-output default hydration/normalization
- `validateConfig` accept/reject paths
- dot-path fallback behavior in `getConfigValue`

Container behavior tests:
- `src/__tests__/facade-quick-start.test.ts`
- `src/__tests__/w15-b1-facades.test.ts`

Validated container behavior includes:
- throw on unregistered service
- chaining from `register`
- singleton caching
- re-registration cache invalidation
- dependency resolution through container argument
- `reset` preserving registrations while clearing instances

Observability status:
- `src/config/*` emits no dedicated metrics/events/traces.
- Failures are generally reflected as empty partial config outputs (`{}`) rather than structured diagnostics.

## Risks and TODOs
- `resolveConfig` does not re-run schema validation after merging env/runtime layers.
  - `loadFileConfig` validates file input, but env/runtime overrides can still produce invalid merged values.

- `DZIP_PORT` is numeric-coerced without finite/range guard.
  - Non-numeric input produces `NaN`, which can flow into `server.port`.

- `loadFileConfig` swallows read/parse/validation errors.
  - It returns `{}` for all failures, with no reason propagation.

- `DZIP_PROVIDERS` parsing has no explicit runtime schema check before assignment.
  - Invalid provider element shapes are not rejected at load time unless they originate from file config validation path.

- Merge initialization is shallow against defaults.
  - Nested default objects can remain shared references when not overridden, so downstream mutation of returned config can mutate default nested branches.

- Validation is intentionally partial.
  - `validateConfig` checks selected structural invariants, but is not a complete semantic validator for every nested section.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten against current `src/config` implementation, package entrypoints, and active tests.
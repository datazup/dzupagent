# `@dzupagent/core` Config Architecture

## Scope
This document covers the config subsystem in `packages/core/src/config`:
- `config-loader.ts`
- `config-schema.ts`
- `container.ts`
- `index.ts`

It describes what is currently implemented in this folder and how it is exposed through `@dzupagent/core`, `@dzupagent/core/advanced`, and `@dzupagent/core/quick-start`.

## Responsibilities
The config subsystem has two distinct responsibilities:

1. Runtime configuration assembly and validation
- Defines `ForgeConfig` and default values (`DEFAULT_CONFIG`).
- Loads partial config from JSON file (`loadFileConfig`) and `DZIP_*` environment variables (`loadEnvConfig`).
- Merges config layers by priority (`mergeConfigs`) and provides a convenience orchestrator (`resolveConfig`).
- Validates config shape (`validateConfig`) and offers typed dot-path reads (`getConfigValue`).
- Normalizes provider structured-output defaults using LLM helper utilities.

2. Lightweight service container
- Provides `ForgeContainer` and `createContainer` for lazy singleton service wiring.
- Used by quick-start bootstrap code (`createQuickAgent`) to register `eventBus` and `registry`.

## Structure
- `config-loader.ts`
  - Types: `ProviderConfig`, `RateLimitConfig`, `ForgeConfig`, `ConfigLayer`
  - Constants: `DEFAULT_CONFIG`
  - Helpers: `deepMerge`, `tryParseJson`, provider normalization helpers
  - Public API: `loadEnvConfig`, `loadFileConfig`, `mergeConfigs`, `resolveConfig`

- `config-schema.ts`
  - Validation helpers: `isPlainObject`, `pushIf`
  - Strategy allowlist for structured output
  - Public API: `validateConfig`, `getConfigValue`

- `container.ts`
  - Internal `Factory<T>` type
  - `ForgeContainer` class with registration, lookup, listing, and reset
  - Public API: `createContainer`

- `index.ts`
  - Re-exports config loader APIs/types plus schema helpers.

## Runtime and Control Flow
Config resolution flow (`resolveConfig`):

1. Start with an implicit defaults layer (`priority: 10`, empty config object).
2. If `options.configFile` is provided, load JSON via `loadFileConfig` and add as file layer (`priority: 20`).
3. Always load env overrides via `loadEnvConfig` and add env layer (`priority: 30`).
4. If `options.runtimeOverrides` is provided, add runtime layer (`priority: 40`).
5. Call `mergeConfigs(...layers)`; layers are sorted by numeric priority, not call order.
6. Return normalized merged `ForgeConfig`.

Merge semantics (`deepMerge` used by `mergeConfigs`):
- Plain objects are merged recursively.
- Arrays are replaced by higher-priority arrays (not concatenated).
- `undefined` source values are ignored.

Provider normalization behavior:
- Provider entries are normalized in `loadEnvConfig`, `loadFileConfig`, and once more on final merge result.
- If `structuredOutputDefaults` is omitted for known providers, defaults are inferred through `getStructuredOutputDefaultsForProviderName`.
- Explicit provider capabilities are normalized with `normalizeStructuredOutputCapabilities`.

Validation behavior:
- `loadFileConfig` validates parsed file JSON via `validateConfig`; invalid file config is dropped (`{}`).
- `resolveConfig` does not perform a final validation pass after env/runtime merges.

DI container flow (`ForgeContainer`):
- `register(name, factory)` stores factory and invalidates cached instance for that name.
- `get(name)` returns cached instance if present; otherwise executes factory once and caches result.
- `reset()` clears instance cache but keeps factory registrations.

## Key APIs and Types
Primary APIs:
- `DEFAULT_CONFIG: ForgeConfig`
- `loadEnvConfig(): Partial<ForgeConfig>`
- `loadFileConfig(filePath: string): Promise<Partial<ForgeConfig>>`
- `mergeConfigs(...layers: ConfigLayer[]): ForgeConfig`
- `resolveConfig(options?): Promise<ForgeConfig>`
- `validateConfig(config: unknown): { valid: boolean; errors: string[] }`
- `getConfigValue<T>(config: ForgeConfig, path: string, fallback: T): T`
- `ForgeContainer`
- `createContainer(): ForgeContainer`

Config model details:
- `ForgeConfig.providers`: `ProviderConfig[]` with optional `apiKey`, `baseUrl`, `priority`, and `structuredOutputDefaults`.
- `ForgeConfig.models`: `{ chat; codegen; reasoning }` string model IDs.
- `ForgeConfig.memory.store`: `'postgres' | 'in-memory'`.
- `ForgeConfig.server`: `port`, `corsOrigins`, and `rateLimit`.
- Additional top-level domains: `mcp`, `security`, `plugins`, `custom`.

Environment inputs currently parsed by `loadEnvConfig`:
- `DZIP_PROVIDERS` (JSON)
- `DZIP_MODEL_CHAT`, `DZIP_MODEL_CODEGEN`, `DZIP_MODEL_REASONING`
- `DZIP_MEMORY_STORE`, `DZIP_MEMORY_CONN`
- `DZIP_PORT`, `DZIP_CORS_ORIGINS`
- `DZIP_PLUGINS`
- `DZIP_SECURITY_RISK_CLASSIFICATION`, `DZIP_SECURITY_SECRETS_SCANNING`, `DZIP_SECURITY_OUTPUT_SANITIZATION`

## Dependencies
Internal dependencies inside `@dzupagent/core`:
- `config-loader.ts` depends on `config-schema.ts` and `llm/structured-output-capabilities.ts`.
- `config-schema.ts` depends on config types from `config-loader.ts` and `StructuredOutputStrategy` from `llm/model-config.ts`.
- `quick-start` facade depends on `container.ts` and selected config exports for public API exposure.

External/runtime dependencies used directly in config module:
- Node.js `fs/promises` (`readFile`) for file config loading.
- `process.env` for environment configuration.

Package-level dependency posture from `package.json`:
- No additional third-party package is required specifically by `src/config/*`.
- `zod` is a peer dependency for the package, but this config module currently performs manual validation logic rather than Zod-based schema parsing.

## Integration Points
Public export surface:
- Root entrypoint (`src/index.ts`) re-exports config APIs (`DEFAULT_CONFIG`, loaders, merge/resolve, schema helpers, and config types) and re-exports `ForgeContainer`/`createContainer`.
- `src/advanced.ts` mirrors root via `export * from './index.js'`.
- `src/facades/quick-start.ts` re-exports `ForgeContainer`, `createContainer`, and selected config APIs (`DEFAULT_CONFIG`, `resolveConfig`, `mergeConfigs`, plus `ForgeConfig`/`ProviderConfig` types).

Direct in-package usage:
- `createQuickAgent` uses `createContainer()` directly to wire `eventBus` and `registry` singletons.

Test-driven integration checks:
- `src/__tests__/facades.test.ts` verifies quick-start facade exports config helpers and container APIs.
- `src/__tests__/facade-quick-start.test.ts` and `src/__tests__/w15-b1-facades.test.ts` exercise container behavior through facade imports.

## Testing and Observability
Primary config test files:
- `src/__tests__/config-loader.test.ts`
- `src/__tests__/config.test.ts`

What is covered:
- `DZIP_*` env parsing and fallback behavior.
- File-load success and failure paths (missing file, invalid JSON, non-object JSON).
- Merge precedence and deep-merge behavior.
- Provider structured-output default hydration/normalization for known providers.
- `resolveConfig` precedence across defaults/file/env/runtime.
- Validation accept/reject cases and typed value lookup.

Container/facade coverage:
- Unregistered `get` error path.
- Singleton caching behavior.
- Re-registration invalidating cache.
- `has`, `list`, `reset`, and dependency resolution through factory callbacks.

Observability notes:
- The config module itself does not emit metrics, logs, or events.
- Observability for config-related behavior is currently indirect, via higher-level tests and consumer instrumentation.

## Risks and TODOs
1. Post-merge validation gap
- `resolveConfig` does not re-run `validateConfig` on the final merged output.
- Invalid runtime/env values can propagate (for example, `DZIP_PORT` parses via `Number(...)` without rejecting `NaN`).

2. Error visibility gap in file loading
- `loadFileConfig` swallows parse/read/validation failures and returns `{}`.
- This fail-closed behavior is safe but opaque for troubleshooting without external logging.

3. Partial schema checks
- `validateConfig` covers key structure and selected constraints, but it is not a full semantic validator for every nested field/domain.

4. Documentation drift risk in README facade list
- Package README quick-start “Key exports” list still mentions memory/context helpers that are no longer re-exported by quick-start code.
- The source of truth is `src/facades/quick-start.ts`; docs should stay aligned with that file.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten from current `src/config` implementation, root/facade exports, and active tests in `packages/core`.


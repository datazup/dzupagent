# `@dzupagent/core` Config Architecture

## Scope
This document describes the architecture of `packages/core/src/config`:
- `config-loader.ts`
- `config-schema.ts`
- `container.ts`
- `index.ts`

It covers features, control flow, usage patterns, references from other packages, and current test coverage.

## Purpose
The config module provides three capabilities:
1. Layered runtime configuration resolution (`defaults -> file -> env -> runtime`).
2. Lightweight structural validation and typed lookup helpers.
3. A minimal dependency-injection container (`ForgeContainer`) used by quick-start bootstrapping.

## File Responsibilities

### `config-loader.ts`
Main orchestration for configuration data:
- Defines `ForgeConfig` and related types.
- Defines `DEFAULT_CONFIG`.
- Loads env-derived partial config (`loadEnvConfig`).
- Loads file-derived partial config (`loadFileConfig`).
- Merges prioritized layers (`mergeConfigs`).
- Resolves final config (`resolveConfig`).

### `config-schema.ts`
Validation and value-access helpers:
- `validateConfig(config)` returns `{ valid, errors }`.
- `getConfigValue(config, path, fallback)` resolves dot-path values safely.

### `container.ts`
Service registry with lazy singleton semantics:
- `ForgeContainer.register(name, factory)`
- `ForgeContainer.get(name)`
- `ForgeContainer.has(name)`
- `ForgeContainer.list()`
- `ForgeContainer.reset()`
- `createContainer()` constructor helper

### `index.ts`
Public barrel for this module.

## Data Model

### `ForgeConfig`
`ForgeConfig` is intentionally broad enough to support framework-level defaults while allowing custom extension:
- `providers: ProviderConfig[]`
- `models: { chat; codegen; reasoning }`
- `memory: { store; connectionString? }`
- `mcp: { id; url; transport }[]`
- `security: { riskClassification; secretsScanning; outputSanitization }`
- `server: { port; corsOrigins; rateLimit }`
- `plugins: string[]`
- `custom: Record<string, unknown>`

### `DEFAULT_CONFIG`
Safe baseline defaults are provided for all top-level config domains:
- No providers/plugins/MCP entries.
- In-memory storage.
- Security booleans enabled.
- Server defaults: port `3000`, localhost CORS, and default rate-limit window.

## Feature Breakdown

### 1) Layered Resolution
`resolveConfig()` builds layers with fixed priorities:
- `defaults`: `10`
- `file`: `20` (if `options.configFile` is provided)
- `env`: `30` (always evaluated)
- `runtime`: `40` (if `options.runtimeOverrides` is provided)

`mergeConfigs()` sorts by `priority` before merge, so caller argument order does not affect precedence.

### 2) Deep Merge Semantics
`deepMerge()` behavior:
- Plain objects are recursively merged.
- Arrays are replaced, not concatenated.
- `undefined` source values are ignored.

Implication: high-priority layers can surgically override object leaves, but list-like settings (`plugins`, `providers`, etc.) replace lower-priority lists entirely.

### 3) Environment Variable Mapping
`loadEnvConfig()` supports:
- `DZIP_PROVIDERS` (JSON array)
- `DZIP_MODEL_CHAT`
- `DZIP_MODEL_CODEGEN`
- `DZIP_MODEL_REASONING`
- `DZIP_MEMORY_STORE` (`postgres | in-memory`)
- `DZIP_MEMORY_CONN`
- `DZIP_PORT`
- `DZIP_CORS_ORIGINS` (comma-separated)
- `DZIP_PLUGINS` (comma-separated)
- `DZIP_SECURITY_RISK_CLASSIFICATION`
- `DZIP_SECURITY_SECRETS_SCANNING`
- `DZIP_SECURITY_OUTPUT_SANITIZATION`

Design detail: when only part of a composite setting is provided (for example one model tier), remaining values are filled from defaults.

### 4) File Loading and Validation
`loadFileConfig(filePath)`:
- Reads JSON.
- Requires top-level plain object.
- Validates structure via `validateConfig`.
- Returns `{}` on parse/read/validation failure.

This makes config files fail-closed instead of partially applying invalid data.

### 5) Schema Validation
`validateConfig` performs shape/type checks for key fields:
- `providers` is array and each item includes `provider: string`.
- `models.*` entries are strings.
- `memory.store` is one of allowed values.
- `server.port` is numeric and in `0..65535`.
- `server.corsOrigins` is array when present.
- `plugins` is array when present.

Validation is partial-friendly: `{}` is valid.

### 6) Typed Config Lookup
`getConfigValue<T>(config, path, fallback)`:
- Traverses dot-path segments.
- Returns fallback for missing/null/invalid traversal.
- Preserves caller-provided type contract through generic fallback.

### 7) DI Container
`ForgeContainer` is intentionally minimal:
- Lazy singleton instantiation on first `get`.
- Re-registering service invalidates cached instance for that key.
- Missing dependency access throws with clear error.
- `reset` clears instance cache while preserving registrations (good for tests).

## Flow

```text
resolveConfig(options)
  -> start from DEFAULT_CONFIG baseline via merge engine
  -> if configFile provided: loadFileConfig(configFile)
       -> read JSON
       -> validateConfig
       -> valid ? parsed partial : {}
  -> loadEnvConfig() from DZIP_* vars
  -> append runtimeOverrides (if provided)
  -> mergeConfigs(layers sorted by priority ascending)
  -> return ForgeConfig
```

## Usage Examples

### A) Full resolution with file + runtime override
```ts
import { resolveConfig } from '@dzupagent/core'

const config = await resolveConfig({
  configFile: './dzip.config.json',
  runtimeOverrides: {
    server: {
      port: 8081,
      corsOrigins: ['https://app.example.com'],
      rateLimit: { maxRequests: 300, windowMs: 60_000 },
    },
  },
})
```

### B) Deterministic layer merge
```ts
import { mergeConfigs, type ConfigLayer } from '@dzupagent/core'

const fileLayer: ConfigLayer = {
  name: 'file',
  priority: 20,
  config: { plugins: ['./plugins/file.js'] },
}

const runtimeLayer: ConfigLayer = {
  name: 'runtime',
  priority: 40,
  config: { plugins: ['./plugins/runtime.js'] },
}

const resolved = mergeConfigs(runtimeLayer, fileLayer)
// resolved.plugins === ['./plugins/runtime.js']
```

### C) Safe dot-path lookup
```ts
import { getConfigValue, DEFAULT_CONFIG } from '@dzupagent/core'

const port = getConfigValue(DEFAULT_CONFIG, 'server.port', 3000)
const missing = getConfigValue(DEFAULT_CONFIG, 'security.nonexistent', false)
```

### D) Container wiring
```ts
import { createContainer } from '@dzupagent/core/quick-start'
import { createEventBus, ModelRegistry } from '@dzupagent/core'

const container = createContainer()
  .register('eventBus', () => createEventBus())
  .register('registry', () => new ModelRegistry())

const bus = container.get('eventBus')
const registry = container.get('registry')
```

## References and Usage Across Packages

### Internal to `core`
- Re-exported from root API in `packages/core/src/index.ts`.
- Re-exported via `packages/core/src/facades/quick-start.ts`.
- `createQuickAgent()` uses `createContainer()` directly.

### Other packages in this monorepo
Current state from repository search:
- No non-`core` package imports `resolveConfig`, `mergeConfigs`, `loadEnvConfig`, `loadFileConfig`, `validateConfig`, `getConfigValue`, or `createContainer` from `@dzupagent/core`.
- Some packages define local config interfaces independently (for example server CLI and adapter-local rate limiting).

Interpretation: the config subsystem is currently a public/shared API surface but primarily exercised in `core` itself (plus external consumers outside this monorepo).

## Test Coverage

## Executed test runs
1. `yarn workspace @dzupagent/core test src/__tests__/config.test.ts src/__tests__/config-loader.test.ts src/__tests__/facades.test.ts`
- Result: `88/88` tests passed.

2. Scoped coverage run:
`yarn workspace @dzupagent/core test:coverage src/__tests__/config.test.ts src/__tests__/config-loader.test.ts src/__tests__/facades.test.ts --coverage.include=src/config/**/*.ts --coverage.include=src/facades/quick-start.ts`
- Result: passed.

## File-level coverage (scoped run)
- `src/config/config-loader.ts`: `100%` statements, `90.19%` branches, `100%` functions, `100%` lines.
- `src/config/config-schema.ts`: `100%` statements/branches/functions/lines.
- `src/config/container.ts`: `87.69%` statements, `71.42%` branches/functions, `87.69%` lines.
- `src/facades/quick-start.ts`: `100%` statements/lines/functions, `77.77%` branches.

## What is well-covered
- Env var parsing and fallback behavior.
- File-loading happy path + malformed/missing file behavior.
- Merge precedence and array replacement semantics.
- Validation for major schema branches.
- Resolution precedence (`defaults < file < env < runtime`).
- Quick-start integration path that verifies container wiring.

## Remaining coverage gaps (notably in `container.ts`)
Uncovered branches correspond to:
- Cached instance retrieval branch (`get` when instance already exists).
- Error branch when requesting unregistered service.
- `list()` and `reset()` utility methods.

These are small but meaningful unit-test opportunities.

## Behavioral Notes and Risks
1. Merged output is not re-validated in `resolveConfig`.
- `loadFileConfig` validates file input, but env/runtime layers can still inject structurally invalid values.
- Example: `DZIP_PORT=abc` yields `Number('abc')` => `NaN` and is not rejected at resolve time.

2. Validation coverage is structural, not semantic.
- Example: providers are checked for `provider` string, but not for provider-specific requirements (API key presence, supported provider IDs).

3. Array replacement is explicit.
- This is predictable and tested, but consumers expecting additive merges must compose arrays before passing high-priority overrides.

## Suggested Next Tests
1. Add dedicated `container.test.ts` covering singleton caching, missing-service error, `list`, and `reset`.
2. Add a `resolveConfig` test that feeds invalid env/runtime values and asserts desired behavior (either fail-fast or documented permissiveness).
3. Add tests for edge parsing of env booleans and numeric fields (`'TRUE'`, whitespace, non-integer ports) to lock parsing policy.

## Summary
`packages/core/src/config` is a compact, deterministic configuration subsystem with clear precedence rules and strong base test coverage, especially around loading/merging/validation. The main architectural gap is post-merge validation of env/runtime-influenced values, and the main test gap is complete branch coverage of container utility behavior.

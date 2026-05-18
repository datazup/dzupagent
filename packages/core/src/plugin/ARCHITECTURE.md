# Plugin Architecture (`@dzupagent/core/src/plugin`)

## Scope
This document covers the plugin subsystem in `packages/core/src/plugin`:
- `plugin-types.ts`
- `plugin-registry.ts`
- `plugin-discovery.ts`
- `plugin-manifest.ts`
- `index.ts`

It also covers where these plugin APIs are exposed from `@dzupagent/core`:
- `src/index.ts` (main package entry)
- `src/plugins.ts` (`@dzupagent/core/plugins` subpath)
- `src/facades/orchestration.ts` (`@dzupagent/core/orchestration` subpath)

Out of scope for this slice:
- Loading/importing plugin code from `manifest.entryPoint`
- Plugin unload/unregister lifecycle
- Any runtime that consumes `ForgeConfig.plugins` paths

## Responsibilities
- Define the plugin contract (`DzupPlugin`) and registration context (`PluginContext`).
- Register plugins into a deterministic in-memory registry keyed by plugin name.
- Wire plugin-declared event handlers to the shared `DzupEventBus`.
- Emit `plugin:registered` platform events after successful registration.
- Aggregate plugin-provided middleware and hooks for downstream assembly.
- Discover plugin manifests from local directories and optional built-in manifests.
- Validate manifest structure and compute dependency-respecting load order.
- Provide helpers to construct and serialize manifest objects.

## Structure
- `plugin-types.ts`
- Defines `PluginContext` with:
- `eventBus: DzupEventBus`
- `modelRegistry: ModelRegistry`
- `memoryService?: unknown` (kept `unknown` to avoid a core-to-memory type dependency)
- Defines `DzupPlugin`:
- required `name`, `version`
- optional `onRegister`, `middleware`, `hooks`, `eventHandlers`

- `plugin-registry.ts`
- `PluginRegistry` stores plugins in `Map<string, DzupPlugin>`.
- Constructor takes a `DzupEventBus`.
- `register()` enforces unique names, awaits `onRegister`, subscribes function-valued event handlers, stores plugin, then emits `plugin:registered`.
- Read APIs: `has`, `listPlugins`, `get`, plus aggregation APIs `getMiddleware`, `getHooks`.

- `plugin-discovery.ts`
- Defines `PluginManifest`, `DiscoveredPlugin`, `PluginDiscoveryConfig`.
- `validateManifest()` performs required-field and primitive shape checks.
- `discoverPlugins()`:
- starts with optional `builtinPlugins`
- scans local directories for `dzupagent-plugin.json`
- validates each parsed manifest
- includes only valid manifests
- uses default scan roots:
- `~/.dzupagent/plugins`
- `resolve('dzupagent-plugins')`
- `resolvePluginOrder()` performs DFS topological ordering over `manifest.dependencies`.

- `plugin-manifest.ts`
- `createManifest()` builds a manifest with defaults:
- `capabilities: []`
- `entryPoint: './index.js'`
- `serializeManifest()` returns formatted JSON via `JSON.stringify(manifest, null, 2)`.

- `index.ts`
- Local barrel exporting only:
- `DzupPlugin`, `PluginContext`
- `PluginRegistry`

## Runtime and Control Flow
Registration path (`PluginRegistry.register`):
1. Caller creates a `PluginRegistry` with a `DzupEventBus` and passes `PluginContext` during registration.
2. Duplicate plugin names are rejected (`Plugin "<name>" is already registered`).
3. If defined, `plugin.onRegister(ctx)` is awaited.
4. `plugin.eventHandlers` entries are iterated; only function values are subscribed with `eventBus.on(...)`.
5. Plugin is stored in the internal map.
6. `eventBus.emit({ type: 'plugin:registered', pluginName })` is emitted.

Discovery path (`discoverPlugins`):
1. Compute scan roots from `config.localDirs` or defaults.
2. Append `builtinPlugins` first as discovered entries (`source: 'builtin'`, `path: '<builtin>'`).
3. For each scan root, call `readdir`; unreadable/missing directories are skipped.
4. For each directory entry, attempt to read `<entry>/dzupagent-plugin.json`.
5. Parse JSON, validate with `validateManifest`, and append valid entries as `source: 'local'`.
6. Missing file, malformed JSON, or invalid manifest entries are silently skipped.

Ordering path (`resolvePluginOrder`):
1. Build a name-index map from discovered plugins.
2. DFS each plugin through declared `dependencies`.
3. External dependencies (not present in the set) are ignored.
4. Circular dependency detection throws `Circular plugin dependency detected involving "<name>"`.
5. Return sorted plugins where dependencies appear before dependents.

## Key APIs and Types
- `PluginContext`
- `eventBus: DzupEventBus`
- `modelRegistry: ModelRegistry`
- `memoryService?: unknown`

- `DzupPlugin`
- `name: string`
- `version: string`
- `onRegister?(ctx): void | Promise<void>`
- `middleware?: AgentMiddleware[]`
- `hooks?: Partial<AgentHooks>`
- `eventHandlers?: Partial<Record<DzupEvent['type'], (event: DzupEvent) => void | Promise<void>>>`

- `PluginRegistry`
- `new PluginRegistry(eventBus: DzupEventBus)`
- `register(plugin: DzupPlugin, ctx: PluginContext): Promise<void>`
- `has(name: string): boolean`
- `listPlugins(): string[]`
- `get(name: string): DzupPlugin | undefined`
- `getMiddleware(): AgentMiddleware[]`
- `getHooks(): Partial<AgentHooks>[]`

- `PluginManifest`
- required: `name`, `version`, `description`, `capabilities`, `entryPoint`
- optional: `author`, `dependencies`

- `DiscoveredPlugin`
- `{ manifest: PluginManifest; path: string; source: 'local' | 'npm' | 'builtin' }`
- current implementation produces `source` values `local` and `builtin`.

- `PluginDiscoveryConfig`
- `localDirs?: string[]`
- `builtinPlugins?: PluginManifest[]`

- Helper functions
- `validateManifest(manifest: unknown): { valid: boolean; errors: string[] }`
- `discoverPlugins(config?: PluginDiscoveryConfig): Promise<DiscoveredPlugin[]>`
- `resolvePluginOrder(plugins: DiscoveredPlugin[]): DiscoveredPlugin[]`
- `createManifest(opts): PluginManifest`
- `serializeManifest(manifest: PluginManifest): string`

## Dependencies
Direct runtime dependencies inside `src/plugin/*`:
- Node built-ins:
- `node:fs/promises` (`readdir`, `readFile`)
- `node:path` (`join`, `resolve`)
- `node:os` (`homedir`)
- Internal core modules:
- `../events/event-bus.js`
- `../events/event-types.js`
- `../hooks/hook-types.js`
- `../llm/model-registry.js`
- `../middleware/types.js`

Package-level context (`packages/core/package.json`):
- Runtime deps: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`.
- The plugin folder itself does not directly consume optional peer dependencies such as `@langchain/*`, tokenizer libs, vector DB libs, or `zod`.

## Integration Points
- Public exports:
- `src/index.ts` exports plugin types, registry, discovery helpers/types, and manifest helpers from the main `@dzupagent/core` entry.
- `src/plugins.ts` re-exports the same plugin APIs under `@dzupagent/core/plugins`, alongside config/container/i18n APIs.
- `src/facades/orchestration.ts` re-exports plugin APIs under `@dzupagent/core/orchestration`.

- Event system:
- `plugin:registered` is declared in `PlatformDomainEvent` (`src/events/event-types-platform.ts`) and therefore part of `DzupEvent`.
- `PluginRegistry.register()` emits this event after successful registration.

- Config system:
- `ForgeConfig` includes `plugins: string[]` (`src/config/config-types.ts`).
- `loadEnvConfig()` maps `DZIP_PLUGINS` (comma-separated) into `config.plugins` (`src/config/config-loader.ts`).
- This plugin module does not resolve or execute those plugin paths; it only provides registry/discovery primitives.

- Adjacent internal docs reference this module as the plugin integration seam for hooks, events, middleware, and facades (`src/hooks/ARCHITECTURE.md`, `src/events/ARCHITECTURE.md`, `src/middleware/ARCHITECTURE.md`).

## Testing and Observability
Primary plugin behavior coverage is in `src/__tests__/plugin-mcp-deep.test.ts`:
- `PluginRegistry`:
- successful registration and lookup (`has`, `get`, `listPlugins`)
- duplicate registration rejection
- `onRegister` invocation, await semantics, and failure propagation
- plugin not persisted when `onRegister` throws
- event handler subscription (single and multiple handlers)
- runtime guard that ignores non-function `eventHandlers` values
- middleware and hook aggregation order
- registration-order preservation in `listPlugins`
- `validateManifest`:
- valid manifests, required-field failures, null/non-object rejection
- type-shape checks for `name`, `capabilities`, `dependencies`
- `discoverPlugins`:
- builtin-first behavior
- local discovery of valid manifests
- skipping missing/invalid/malformed entries
- unreadable/nonexistent directory handling
- `resolvePluginOrder`:
- empty input
- no-dependency stability
- declared/transitive dependency ordering
- missing external dependency tolerance
- circular dependency error path

Additional event-bus coverage for `plugin:registered` is present in:
- `src/__tests__/event-bus.test.ts`
- `src/__tests__/w15-h2-branch-coverage.test.ts`

Observability provided by this module:
- Emission of `plugin:registered` on successful registration.
- Plugin-provided handlers can observe any `DzupEvent` type via the shared event bus.
- No plugin-specific metrics/logging hooks are emitted from discovery/ordering code paths.

## Risks and TODOs
- No plugin unload path:
- `PluginRegistry` does not expose `unregister()` or `dispose()`.
- Event-bus unsubscribe callbacks are not retained, so handler teardown is not available.

- Discovery is metadata-only and shallow:
- scans one directory level under each root
- requires `dzupagent-plugin.json` at `<root>/<entry>/`
- does not load or execute `entryPoint`

- Validation is structural, not semantic:
- no semver validation for `version`
- no element-type validation for `capabilities[]` or `dependencies[]`
- no `entryPoint` existence/safety checks

- Silent skip behavior:
- `discoverPlugins` swallows directory/read/parse/validation errors and provides no telemetry.

- Duplicate-name handling differs by stage:
- registry registration rejects duplicates explicitly.
- ordering builds a `Map` by manifest name; duplicate names in discovery input can overwrite earlier entries during sort preparation.

- `DiscoveredPlugin.source` includes `'npm'` in its type union, but there is no npm discovery implementation in this module.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


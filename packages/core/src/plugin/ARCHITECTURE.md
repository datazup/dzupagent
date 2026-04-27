# Plugin Architecture (`@dzupagent/core/src/plugin`)

## Scope
This document covers only the plugin subsystem implemented in `packages/core/src/plugin`:
- `plugin-types.ts`
- `plugin-registry.ts`
- `plugin-discovery.ts`
- `plugin-manifest.ts`
- `index.ts`

It does not define a full plugin bootstrap/runtime loader. In current code, discovery returns manifest metadata, while actual module loading from `entryPoint` is expected to be handled by consuming code.

## Responsibilities
The plugin subsystem currently provides four responsibilities:
- Define the plugin contract (`DzupPlugin`) and registration context (`PluginContext`).
- Register plugin instances at runtime and aggregate contributed middleware/hooks.
- Discover and validate plugin manifests from local directories (plus optional builtin manifests).
- Create and serialize manifest objects for authoring/tooling workflows.

## Structure
- `plugin-types.ts`
- Exports `PluginContext` with `eventBus`, `modelRegistry`, and optional `memoryService?: unknown`.
- Exports `DzupPlugin` with `name`, `version`, and optional `onRegister`, `middleware`, `hooks`, `eventHandlers`.

- `plugin-registry.ts`
- `PluginRegistry` stores plugins in a `Map<string, DzupPlugin>`.
- `register()` enforces unique names, runs `onRegister`, subscribes `eventHandlers`, stores plugin, then emits `plugin:registered`.
- Read APIs: `has()`, `listPlugins()`, `getMiddleware()`, `getHooks()`, `get()`.

- `plugin-discovery.ts`
- Defines `PluginManifest`, `DiscoveredPlugin`, and `PluginDiscoveryConfig`.
- `validateManifest()` performs required-field and basic type checks.
- `discoverPlugins()` scans plugin directories for `dzupagent-plugin.json` and appends optional `builtinPlugins`.
- `resolvePluginOrder()` topologically sorts discovered plugins by `manifest.dependencies` and throws on cycles.

- `plugin-manifest.ts`
- `createManifest()` builds a manifest with defaults (`capabilities: []`, `entryPoint: './index.js'`).
- `serializeManifest()` returns formatted JSON (`JSON.stringify(..., null, 2)`).

- `index.ts`
- Local barrel exports only `DzupPlugin`, `PluginContext`, and `PluginRegistry`.

## Runtime and Control Flow
1. Runtime code creates shared context (`eventBus`, `modelRegistry`, optional `memoryService`).
2. Runtime code instantiates `PluginRegistry` with a `DzupEventBus`.
3. Each plugin instance is registered via `await registry.register(plugin, context)`.
4. `register()` performs this sequence:
- Reject duplicate plugin names.
- Await `plugin.onRegister(context)` when present.
- Subscribe `plugin.eventHandlers` into the event bus.
- Store plugin in registry map.
- Emit `{ type: 'plugin:registered', pluginName }`.
5. Agent composition code consumes `registry.getMiddleware()` and `registry.getHooks()`.

Discovery and ordering flow:
1. `discoverPlugins(config?)` resolves directories (defaults to `~/.dzupagent/plugins` and `./dzupagent-plugins`).
2. For each subdirectory, it reads `dzupagent-plugin.json`, validates it, and appends valid entries as `source: 'local'`.
3. Optional `builtinPlugins` are inserted first as `source: 'builtin'`.
4. `resolvePluginOrder(discovered)` returns dependency-resolved order or throws on cycles.

## Key APIs and Types
- `PluginContext`
- `eventBus: DzupEventBus`
- `modelRegistry: ModelRegistry`
- `memoryService?: unknown` (intentionally untyped to avoid core->memory package inversion)

- `DzupPlugin`
- Required: `name`, `version`
- Optional: `onRegister`, `middleware`, `hooks`, `eventHandlers`

- `PluginRegistry`
- `register(plugin, ctx): Promise<void>`
- `has(name): boolean`
- `listPlugins(): string[]`
- `getMiddleware(): AgentMiddleware[]`
- `getHooks(): Partial<AgentHooks>[]`
- `get(name): DzupPlugin | undefined`

- `PluginManifest`
- `name`, `version`, `description`, `capabilities`, `entryPoint`
- Optional: `author`, `dependencies`

- `DiscoveredPlugin`
- `{ manifest, path, source }`
- `source` type includes `'local' | 'npm' | 'builtin'` (current discovery code emits `local` and `builtin`; `npm` is type-level only here)

- `PluginDiscoveryConfig`
- `localDirs?: string[]`
- `builtinPlugins?: PluginManifest[]`

- Discovery helpers
- `validateManifest(manifest)`
- `discoverPlugins(config?)`
- `resolvePluginOrder(plugins)`

- Manifest helpers
- `createManifest(opts)`
- `serializeManifest(manifest)`

## Dependencies
Direct runtime dependencies inside this subsystem:
- Node built-ins in discovery: `node:fs/promises`, `node:path`, `node:os`.
- Core package modules:
- `../events/event-bus.js` and `../events/event-types.js`
- `../llm/model-registry.js`
- `../middleware/types.js`
- `../hooks/hook-types.js`

Package-level note (`packages/core/package.json`):
- No external runtime dependency is required specifically for plugin files beyond the package baseline.
- External libraries (`@langchain/*`, `zod`, etc.) are not used directly by `src/plugin/*`.

## Integration Points
Current export surfaces:
- Root package (`src/index.ts`) exports full plugin API:
- Types: `DzupPlugin`, `PluginContext`, `PluginManifest`, `DiscoveredPlugin`, `PluginDiscoveryConfig`
- Classes/functions: `PluginRegistry`, `discoverPlugins`, `validateManifest`, `resolvePluginOrder`, `createManifest`, `serializeManifest`

- Orchestration facade (`src/facades/orchestration.ts`) exports:
- `DzupPlugin`, `PluginContext`
- `PluginRegistry`
- `discoverPlugins`, `validateManifest`, `resolvePluginOrder`
- `PluginManifest`, `DiscoveredPlugin`, `PluginDiscoveryConfig`

- Local plugin barrel (`src/plugin/index.ts`) is intentionally narrower:
- `DzupPlugin`, `PluginContext`, `PluginRegistry`

Event integration:
- `PluginRegistry.register()` subscribes handlers on `DzupEventBus` and emits `plugin:registered` (event type declared in `src/events/event-types.ts`).

## Testing and Observability
Core test coverage for plugin subsystem behavior exists in:
- `src/__tests__/plugin-mcp-deep.test.ts`

Covered behaviors include:
- `PluginRegistry` registration lifecycle, duplicate detection, callback ordering, event handler subscription, middleware/hook aggregation, and lookup/list semantics.
- `validateManifest` required fields and type checks.
- `discoverPlugins` directory scanning, malformed/invalid manifest skipping, builtin inclusion, and missing directory handling.
- `resolvePluginOrder` no-dependency ordering, dependency ordering, transitive ordering, cycle detection, and missing external dependency handling.

Observability hooks available through this subsystem:
- `plugin:registered` event emission on successful registration.
- Plugin-defined handlers can subscribe to any `DzupEvent['type']` via `eventHandlers`.

## Risks and TODOs
- No plugin unload/dispose path: event subscriptions are registered but not tracked for unsubscription.
- Manifest validation is intentionally shallow: it does not enforce semver format, item-level array typing, or entry point path safety.
- Discovery is manifest-only: module import/instantiation from `entryPoint` is not implemented here.
- Duplicate discovered plugin names are effectively last-write-wins in `resolvePluginOrder()` because it indexes by name in a `Map`.
- `DiscoveredPlugin.source` includes `'npm'`, but current discovery implementation does not produce npm-sourced entries.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


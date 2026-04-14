# Plugin Subsystem Architecture (`@dzupagent/core/src/plugin`)

## Scope and Intent
This folder defines the core plugin primitives for DzupAgent runtime extensibility:
- Plugin contract and runtime registration context.
- In-memory plugin registry and event subscription wiring.
- Manifest schema/validation/discovery for local plugin packages.
- Dependency-aware ordering for discovered plugins.
- Manifest authoring helpers.

This is a low-level subsystem. It exposes primitives, not a full bootstrap pipeline.

## Module Map

### `plugin-types.ts`
Defines:
- `PluginContext`
  - `eventBus: DzupEventBus`
  - `modelRegistry: ModelRegistry`
  - `memoryService?: MemoryService`
- `DzupPlugin`
  - Required: `name`, `version`
  - Optional: `onRegister`, `middleware`, `hooks`, `eventHandlers`

### `plugin-registry.ts`
Defines:
- `PluginRegistry`
  - `register(plugin, ctx)`
  - `has(name)`
  - `listPlugins()`
  - `getMiddleware()`
  - `getHooks()`
  - `get(name)`

Runtime behavior:
- Rejects duplicate plugin names.
- Executes `plugin.onRegister(ctx)` if present.
- Subscribes plugin `eventHandlers` to `eventBus`.
- Stores plugin in map and emits `{ type: 'plugin:registered', pluginName }`.

### `plugin-discovery.ts`
Defines:
- `PluginManifest`
- `DiscoveredPlugin`
- `PluginDiscoveryConfig`
- `validateManifest(manifest)`
- `discoverPlugins(config?)`
- `resolvePluginOrder(plugins)`

Runtime behavior:
- Discovery scans default dirs:
  - `~/.dzupagent/plugins`
  - `./dzupagent-plugins`
- Looks for `dzupagent-plugin.json` inside each plugin subdirectory.
- Includes optional in-memory `builtinPlugins` first.
- Silently skips unreadable dirs, missing manifests, invalid JSON, invalid manifest fields.
- Orders plugins via DFS topological sort by `manifest.dependencies`.
- Throws on dependency cycles.

### `plugin-manifest.ts`
Defines:
- `createManifest(opts)`
- `serializeManifest(manifest)`

Runtime behavior:
- Builds a minimal manifest object with defaults:
  - `capabilities: []`
  - `entryPoint: './index.js'`
- Serializes as pretty JSON (`2` spaces).

### `index.ts`
Submodule barrel exports only:
- `DzupPlugin`, `PluginContext`
- `PluginRegistry`

Note: discovery/manifest helpers are exported from root/core facades, not this local barrel.

## Public Surfaces and Import Paths

### Root package exports
`packages/core/src/index.ts` exports:
- `DzupPlugin`, `PluginContext`
- `PluginRegistry`
- `discoverPlugins`, `validateManifest`, `resolvePluginOrder`
- `PluginManifest`, `DiscoveredPlugin`, `PluginDiscoveryConfig`
- `createManifest`, `serializeManifest`

### Orchestration facade exports
`packages/core/src/facades/orchestration.ts` exports:
- `DzupPlugin`, `PluginContext`
- `PluginRegistry`
- `discoverPlugins`, `validateManifest`, `resolvePluginOrder`
- `PluginManifest`, `DiscoveredPlugin`, `PluginDiscoveryConfig`

## Feature Breakdown

### 1. Plugin contract model
`DzupPlugin` supports five extension modes:
- Registration hook (`onRegister`) for startup wiring.
- Middleware contribution (`middleware`) for runtime pipeline interception.
- Lifecycle hooks (`hooks`) for hook-runner integration.
- Event bus subscriptions (`eventHandlers`).
- Versioned identity (`name`, `version`).

Design property:
- Structural typing enables third-party plugin objects to be compatible without strict class inheritance.

### 2. Registration and aggregation
`PluginRegistry` centralizes:
- Plugin uniqueness checks.
- Registration callback execution.
- Event handler subscription wiring.
- Aggregate reads for middleware/hooks to apply at agent creation.

Behavior details:
- Registration order determines middleware and hooks aggregation order.
- `eventHandlers` are wired immediately during registration.
- `plugin:registered` event is emitted after plugin is stored.

### 3. Manifest validation
`validateManifest` checks:
- Presence of required fields:
  - `name`, `version`, `description`, `capabilities`, `entryPoint`
- Field-level type checks for all manifest fields.

Current validation depth:
- Validates `capabilities`/`dependencies` are arrays.
- Does not validate array item types (e.g., string-only), semver format, or path safety.

### 4. Local discovery
`discoverPlugins` provides filesystem discovery primitives:
- Builtin manifest injection (for code-defined plugin manifests).
- Directory scan for `dzupagent-plugin.json`.
- Non-fatal skip semantics for inaccessible/malformed entries.

Design property:
- Discovery is resilient and best-effort; it avoids hard-failing on partial environment issues.

### 5. Dependency ordering
`resolvePluginOrder` computes load order:
- Uses depth-first traversal.
- Dependencies load before dependents.
- Detects cycles via `visiting` set.
- Ignores dependencies not present in current discovered set.

### 6. Manifest authoring helpers
`createManifest` + `serializeManifest` reduce boilerplate for plugin authors and tooling.

## End-to-End Flow

### Runtime registration flow
1. Create shared runtime context (`eventBus`, `modelRegistry`, optional `memoryService`).
2. Instantiate `PluginRegistry` with `eventBus`.
3. For each plugin, call `await registry.register(plugin, ctx)`.
4. `register` sequence:
   - Check duplicate by plugin name.
   - Execute `onRegister`.
   - Wire `eventHandlers` on event bus.
   - Store plugin and emit `plugin:registered`.
5. At agent/runtime composition time, pull:
   - `registry.getMiddleware()`
   - `registry.getHooks()`

### Discovery + order resolution flow
1. Call `discoverPlugins(config?)`.
2. Optionally merge discovered plugins with builtin manifests.
3. Call `resolvePluginOrder(discovered)`.
4. For each ordered plugin:
   - Load module from `manifest.entryPoint`.
   - Materialize `DzupPlugin` object.
   - Register via `PluginRegistry.register`.

Important: step 4 (module loading from manifest entryPoint) is not implemented in this folder and must be handled by consumer code.

## Usage Examples

### Example A: Register an in-process plugin
```ts
import {
  createEventBus,
  ModelRegistry,
  PluginRegistry,
  type DzupPlugin,
  type PluginContext,
} from '@dzupagent/core'

const eventBus = createEventBus()
const modelRegistry = new ModelRegistry()

const plugin: DzupPlugin = {
  name: 'sample-observability',
  version: '1.0.0',
  onRegister(ctx) {
    ctx.eventBus.emit({
      type: 'system:degraded',
      subsystem: 'sample-plugin',
      reason: 'startup-check',
      timestamp: Date.now(),
      recoverable: true,
    })
  },
  eventHandlers: {
    'agent:failed': async (event) => {
      console.error('agent failed', event.agentId)
    },
  },
}

const ctx: PluginContext = { eventBus, modelRegistry }
const registry = new PluginRegistry(eventBus)
await registry.register(plugin, ctx)
```

### Example B: Discover manifests and resolve order
```ts
import { discoverPlugins, resolvePluginOrder } from '@dzupagent/core'

const discovered = await discoverPlugins({
  localDirs: ['/opt/dzupagent/plugins'],
})

const ordered = resolvePluginOrder(discovered)
for (const p of ordered) {
  console.log(p.manifest.name, p.path, p.manifest.entryPoint)
}
```

### Example C: Create and serialize a manifest
```ts
import { createManifest, serializeManifest } from '@dzupagent/core'

const manifest = createManifest({
  name: '@acme/my-plugin',
  version: '0.2.0',
  description: 'Acme plugin',
  capabilities: ['observability', 'audit'],
  dependencies: ['@dzupagent/otel'],
  entryPoint: './dist/index.js',
})

const json = serializeManifest(manifest)
// write json to dzupagent-plugin.json
```

## Cross-Package References and Current Usage

### `@dzupagent/otel`
- `packages/otel/src/otel-plugin.ts`
  - Imports `DzupPlugin` and `PluginContext` from `@dzupagent/core`.
  - Exposes `createOTelPlugin(config?)` returning a `DzupPlugin`.
  - Uses `onRegister(ctx)` to attach OTel bridge/safety/cost/audit features to `eventBus`.
- `packages/otel/src/__tests__/otel-plugin.test.ts`
  - Uses `PluginContext` and `createEventBus` to validate plugin registration paths.

### `@dzupagent/agent-adapters`
- `packages/agent-adapters/src/plugin/adapter-plugin.ts`
  - Implements a structurally compatible plugin object (`AdapterPluginInstance`) instead of directly importing `DzupPlugin`.
  - Commented reason: avoid transitive dependency pull-in.
  - Example uses `pluginRegistry.register(plugin, ctx)`.
- `packages/agent-adapters/src/__tests__/adapter-plugin.test.ts`
  - Validates plugin-like behavior around registration and event handling.

### `@dzupagent/core` export paths
- Root `@dzupagent/core` exposes full plugin API.
- `@dzupagent/core/orchestration` facade exposes plugin/discovery APIs.
- `packages/core/src/plugin/index.ts` only exposes contract + registry (not discovery utilities).

### `@dzupagent/server` (related but separate concern)
- `packages/server/src/cli/plugins-command.ts` manages config-file plugin entries (`name`, `version`) and local validation.
- This is config orchestration; it does not instantiate `PluginRegistry` or call discovery APIs.

## Test Coverage Assessment

Coverage run executed:
- Command: `yarn workspace @dzupagent/core test:coverage`
- Result: 72 test files, 1595 tests, all passing.

Plugin folder coverage from that run:
- `src/plugin` overall: statements `32.32%`, branches `100%`, functions `0%`, lines `32.32%`.
- `src/plugin/plugin-registry.ts`: statements `26.37%`, functions `0%`.
- `src/plugin/plugin-discovery.ts`: statements `34.85%`, functions `0%`.
- `src/plugin/plugin-manifest.ts`: statements `35.48%`, functions `0%`.

Interpretation:
- There are currently no direct tests targeting `src/plugin/*` behavior.
- Coverage shown is incidental/import-side coverage, not behavioral validation of plugin subsystem logic.

Indirect validation exists in other packages:
- `packages/otel/src/__tests__/otel-plugin.test.ts`
- `packages/agent-adapters/src/__tests__/adapter-plugin.test.ts`

These validate consumer plugin implementations, not `PluginRegistry`/`discoverPlugins` correctness in `@dzupagent/core` itself.

## Gaps and Risks

### 1. No unregister/dispose lifecycle
`PluginRegistry` wires event handlers but does not retain unsubscribe functions; there is no `unregister()` or `dispose()`.
Risk:
- Long-running processes can accumulate handlers when reloading plugins.

### 2. Discovery does not load plugin modules
`discoverPlugins` only returns manifest metadata and path.
Risk:
- Consumers must implement module loading/entryPoint resolution, which can diverge across packages.

### 3. Manifest validation is shallow
No semver validation, dependency item typing, entryPoint path constraints, or capability schema checks.
Risk:
- Invalid manifests pass validation and fail later at runtime.

### 4. Duplicate-name behavior in ordering
`resolvePluginOrder` stores by plugin name in a map; duplicate names overwrite previous entries silently.
Risk:
- Ambiguous results if duplicate manifests are discovered.

### 5. Split export ergonomics
`src/plugin/index.ts` does not export discovery/manifest helpers, while root and facade entrypoints do.
Risk:
- Import path inconsistency for consumers using submodule imports.

## Recommended Next Tests (highest value)
1. `plugin-registry.test.ts`
- Duplicate rejection.
- `onRegister` error propagation.
- Event handler subscription and invocation.
- Middleware/hook aggregation order.
- `plugin:registered` emission.

2. `plugin-discovery.test.ts`
- Valid/invalid manifest validation matrix.
- Directory discovery with missing dirs and malformed JSON.
- Builtin plugins inclusion.
- Dependency ordering and cycle detection.
- Duplicate-name behavior expectations.

3. `plugin-manifest.test.ts`
- Default field behavior in `createManifest`.
- Stable JSON output shape in `serializeManifest`.

## Practical Adoption Notes
- If you need plugin loading today, treat this subsystem as primitives and implement an explicit bootstrap layer in consumer packages.
- Prefer importing from `@dzupagent/core` or `@dzupagent/core/orchestration` to access the full plugin + discovery API.
- For production plugin environments, add explicit tests and unsubscription lifecycle management before dynamic reload scenarios.

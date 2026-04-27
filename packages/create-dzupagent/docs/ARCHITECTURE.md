# create-dzupagent Architecture

## Scope
This document describes the current implementation of `packages/create-dzupagent` in the `dzupagent` monorepo.

Included:
- CLI entrypoint, argument parsing, and command routing in `src/cli.ts`
- Interactive project configuration in `src/wizard.ts`
- Project generation pipeline in `src/generator.ts`
- Legacy scaffold API in `src/scaffold-engine.ts`
- Template, feature, and preset registries in `src/templates/*`, `src/features.ts`, and `src/presets.ts`
- Optional adapter wiring in `src/bridge.ts`
- Native-agent sync command implementation in `src/sync.ts`
- Shared utilities and rendering/logger helpers in `src/utils.ts`, `src/template-renderer.ts`, and `src/logger.ts`
- Public package exports in `src/index.ts`
- Tests under `src/__tests__/` and package-level build/test config

Excluded:
- Runtime behavior of generated projects after scaffolding
- Internal behavior of external dependencies (`@dzupagent/*`, `commander`, `@inquirer/prompts`, etc.)

## Responsibilities
`create-dzupagent` is a scaffold CLI/package responsible for:
- Creating DzupAgent project skeletons from built-in template manifests
- Supporting two configuration entry points:
  - non-interactive CLI flags
  - interactive wizard prompts
- Applying optional feature overlays (`auth`, `dashboard`, `billing`, `teams`, `ai`) on top of templates
- Generating normalized `package.json`, `.env.example`, `README.md`, and conditional `docker-compose.yml`
- Running optional post-generation tasks (`git init`, dependency install)
- Optionally wiring a generated project into `@dzupagent/agent-adapters` (`--wire`)
- Providing a `sync` command that maps `.dzupagent/` definitions into native agent files via `@dzupagent/agent-adapters`
- Exposing programmatic scaffold APIs for external tooling

## Structure
Package layout and roles:
- `src/cli.ts`
  - Defines main command (`create-dzupagent [project-name]`) and `sync <target>` subcommand
  - Handles list commands (`--list`, `--list-presets`, `--list-features`)
  - Validates template/preset/package-manager values
  - Calls `runWizard()` when no name/template/preset is passed
  - Calls `generateProject()` for scaffold execution
- `src/wizard.ts`
  - Dynamically imports `@inquirer/prompts`
  - Supports preset path and custom path
  - Returns normalized `ProjectConfig`
- `src/generator.ts`
  - Main generation orchestrator used by CLI
  - Writes template files, applies feature overlays, synthesizes generated config/docs, and runs optional post-steps
- `src/scaffold-engine.ts`
  - Legacy engine that directly renders every template-manifest file
  - Does not run overlay logic or synthesized file generation pipeline
- `src/sync.ts`
  - Implements `dzupagent sync <target>` with plan/apply/dry-run support
  - Targets: `claude`, `codex`, `gemini`, `qwen`, `goose`, `crush`
- `src/bridge.ts`
  - Optional bridge to `@dzupagent/agent-adapters` importer
  - Dynamic import to avoid hard runtime dependency
- `src/features.ts`
  - Built-in overlay registry and lookup/list helpers
- `src/presets.ts`
  - Built-in preset registry (`minimal`, `starter`, `full`, `api-only`, `research`)
- `src/templates/`
  - Template manifests and helper generators for synthesized files
- `src/utils.ts`
  - Validation, shell execution, package manager detection, overlay file writing, marketplace fetch helper, and command string helpers
- `src/template-renderer.ts`
  - `{{variable}}` interpolation helper
- `src/logger.ts`
  - ANSI-based color helpers and spinner implementation
- `src/index.ts`
  - Public export surface for programmatic use

Built-in template registry (`src/templates/index.ts`) currently includes 9 template IDs:
- `minimal`
- `full-stack`
- `codegen`
- `multi-agent`
- `server`
- `production-saas-agent`
- `secure-internal-assistant`
- `cost-constrained-worker`
- `research`

Note on exported template constants:
- `src/index.ts` re-exports `templateRegistry`, `getTemplate`, and `listTemplates`
- It also re-exports individual constants for: `minimal`, `full-stack`, `codegen`, `multi-agent`, `server`, `research`
- It does not currently re-export individual constants for `production-saas-agent`, `secure-internal-assistant`, or `cost-constrained-worker`

## Runtime and Control Flow
Primary CLI flow (`src/cli.ts` + `src/generator.ts`):
1. Parse CLI args via `commander`.
2. Route list commands (`--list*`) if requested.
3. Resolve config:
   - interactive wizard mode when no project name/template/preset
   - validated CLI mode otherwise
4. Call `generateProject(config, outputDir, callbacks, options)`.
5. In `generateProject`:
   - create project directory
   - resolve template manifest
   - render/write template files except `package.json`, `.env.example`, `README.md`, `docker-compose.yml`
   - apply selected feature overlays
   - generate `package.json` via `generatePackageJson()`
   - generate `.env.example` via `generateEnvExample()`
   - generate `docker-compose.yml` when `database !== 'none'` or `ai` is selected
   - generate `README.md` via `generateReadme()`
   - optionally run `initGitRepo()`
   - optionally run `installDependencies()`
   - optionally run `wireProject()` when `--wire`
6. Return `GenerationResult` including status flags: `gitInitialized`, `depsInstalled`, `wired`.

Wizard flow (`src/wizard.ts`):
1. Prompt for project name with npm-style validation.
2. Prompt preset vs custom path.
3. Preset path:
   - choose package manager
   - choose git/install flags
   - confirm and return preset-derived config
4. Custom path:
   - select template
   - select features (checkbox)
   - choose database/auth/package manager/git/install
   - confirm and return config
5. On user cancellation, calls `process.exit(0)`.

Sync flow (`src/cli.ts` + `src/sync.ts`):
1. Validate target name against `VALID_SYNC_TARGETS`.
2. Dynamically import `@dzupagent/agent-adapters`.
3. Build resolver/loaders/syncer objects.
4. Create sync plan and print planned writes/diverged files.
5. Behavior by flags:
   - default (no `--execute`, no `--dry-run`): print plan only
   - `--dry-run`: execute sync in dry-run mode for diagnostics/diffs without writes
   - `--execute`: apply writes (with optional `--force` for diverged files)
6. Print result summary.

Optional bridge wiring flow (`src/bridge.ts`):
1. Dynamically import `@dzupagent/agent-adapters`.
2. Resolve workspace/project paths.
3. Plan and execute importer.
4. Return `WireBridgeResult`.
5. Never throw to caller; failures return `success: false` with `error`.

## Key APIs and Types
Public package APIs (`src/index.ts`):
- Generation and wiring:
  - `generateProject(config, outputDir, callbacks?, options?)`
  - `wireProject(options)`
  - `runWizard()`
  - `ScaffoldEngine` (legacy)
- Template/preset/feature access:
  - `templateRegistry`, `getTemplate`, `listTemplates`
  - `presets`, `getPreset`, `listPresets`, `PRESET_NAMES`
  - `getFeatureOverlay`, `listFeatures`, `getFeatureSlugs`
- Template helpers:
  - `generatePackageJson`, `generateEnvExample`, `generateDockerCompose`, `generateReadme`
- Utilities:
  - `validateProjectName`, `detectPackageManager`, `runCommand`, `installDependencies`, `initGitRepo`, `applyOverlay`, `fetchMarketplaceTemplates`, `getInstallCommand`, `getDevCommand`
- Renderer:
  - `renderTemplate(content, variables)`

Important types (`src/types.ts` and related modules):
- `TemplateType` (9-template union)
- `ProjectConfig`
- `GenerationResult`
- `ScaffoldOptions`, `ScaffoldResult` (legacy path)
- `TemplateManifest`
- `FeatureDefinition`
- `DatabaseProvider`, `AuthProvider`, `PackageManagerType`, `PresetName`
- `MarketplaceTemplate`
- `GenerateCallbacks`, `GenerateOptions` (`src/generator.ts`)
- `WireBridgeOptions`, `WireBridgeResult` (`src/bridge.ts`)
- `CLIOptions` (`src/cli.ts`)
- `SyncTargetName`, `SyncCommandOptions` (`src/sync.ts`)

## Dependencies
Runtime dependencies (`package.json`):
- `commander` for CLI parsing and command registration
- `@inquirer/prompts` for interactive wizard input (dynamic import)
- `chalk` and `ora` are declared, but current implementation uses `src/logger.ts` ANSI utilities instead

Build/test dependencies:
- `typescript`
- `tsup`
- `vitest`

Node built-ins heavily used:
- `node:fs`, `node:fs/promises`, `node:path`, `node:child_process`, `node:util`, `node:url`

Optional runtime dependency (dynamic import):
- `@dzupagent/agent-adapters` used by:
  - `wireProject()`
  - `runSyncCommand()`

Generated project dependency synthesis (`src/templates/package-json.ts`):
- Base: `@dzupagent/core`, `@dzupagent/agent`
- Feature/database additions (for example `@dzupagent/server`, `@dzupagent/memory`, `@dzupagent/context`, `stripe`, `bullmq`, `ioredis`, `drizzle-orm`)
- Template manifest dependencies/devDependencies are merged in
- Dependency objects are key-sorted before serialization

## Integration Points
Filesystem integration:
- Writes full project tree into `join(outputDir, projectName)`
- Applies feature overlays as direct file writes relative to project root
- Creates nested directories as needed

Process execution:
- Uses `execFile` in `runCommand()`
- Optional post-steps:
  - `git init`, `git add .`, `git commit -m "Initial commit from create-dzupagent"`
  - package manager install (`npm install`, `pnpm install`, or `yarn`)

Adapter ecosystem integration:
- `--wire` bridges scaffold output into `.dzupagent/` import path through adapter importer APIs
- `sync <target>` maps `.dzupagent/` definitions into native agent files (plan/apply/dry-run)

Network integration:
- `fetchMarketplaceTemplates(baseUrl)` calls `${baseUrl}/api/marketplace/templates` with abort timeout (5s)
- This helper is exported but not currently used in CLI or wizard control flow

Packaging/binary integration:
- Package publishes `dist` and exposes executable via `bin: ./dist/cli.js`
- Supports invocation via `npm create dzupagent ...` / `npx create-dzupagent ...`

## Testing and Observability
Current test suites (`src/__tests__/`):
- `generator.test.ts`: generation pipeline behavior, conditional files, callbacks
- `scaffold.test.ts`: template registry integrity, renderer behavior, legacy `ScaffoldEngine`, E2E scaffold checks
- `wizard.test.ts`: preset/custom prompt flows, validation hooks, abort behavior
- `cli-args.test.ts`: argument parsing and invalid input handling
- `features.test.ts`: feature registry/overlay structure
- `presets.test.ts`: preset registry correctness and ordering
- `research-preset.test.ts`: research preset/template behavior
- `bridge.test.ts`: wiring success/failure and CLI `--wire` behavior
- `preset-registry-bridge.test.ts`: scaffold-preset alignment checks against `@dzupagent/agent` preset registry
- `utils.test.ts`: validation, overlay writing, package manager helpers

Coverage and execution config (`vitest.config.ts`):
- Environment: `node`
- Timeout: `30_000`
- Coverage provider: `v8`
- Reporters: `text`, `json-summary`
- Thresholds: statements 40, branches 30, functions 30, lines 40

Observability in this package:
- User-facing progress/status output via `Spinner` and `colors`
- Hook callbacks in `generateProject()`:
  - `onStep(step)`
  - `onFileCreated(filePath)`
- No structured telemetry, tracing, or metrics emitted by `create-dzupagent` itself

## Risks and TODOs
- Drift between `README.md` and implementation: top-level README still references only exported template constants up to `research` and does not document the `sync` command.
- Export-surface mismatch: `src/index.ts` does not re-export individual constants for three templates that exist in registry (`production-saas-agent`, `secure-internal-assistant`, `cost-constrained-worker`).
- Dual generation paths: `generateProject()` and `ScaffoldEngine.generate()` intentionally differ; consumers can get different scaffold outputs depending on API choice.
- Non-fatal failures can be opaque: git/dependency/wire failures are swallowed into boolean flags without surfaced error details in the final CLI summary.
- `sync.ts` has no dedicated unit tests in `src/__tests__/` despite being user-facing CLI functionality.
- Declared-but-unused runtime deps (`chalk`, `ora`) increase dependency surface without current runtime use.
- `fetchMarketplaceTemplates()` is exported but currently disconnected from wizard/CLI selection paths.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


# create-dzupagent Architecture

## Scope
This document describes the architecture of `packages/create-dzupagent` as implemented in the local codebase.

In scope:
- CLI entrypoint and argument handling in `src/cli.ts`.
- Interactive configuration flow in `src/wizard.ts`.
- Project generation pipeline in `src/generator.ts`.
- Legacy scaffolding API in `src/scaffold-engine.ts`.
- Template, preset, and feature registries in `src/templates/*`, `src/presets.ts`, and `src/features.ts`.
- Runtime utilities (`src/utils.ts`), template renderer (`src/template-renderer.ts`), logger/spinner (`src/logger.ts`), and optional bridge wiring (`src/bridge.ts`).
- Public package exports in `src/index.ts`.
- Test suite under `src/__tests__/`.

Out of scope:
- Runtime behavior of generated projects after scaffold completion.
- Internals of external packages such as `@dzupagent/*`, `@inquirer/prompts`, and `commander`.

## Responsibilities
`create-dzupagent` is responsible for:
- Collecting scaffold configuration from CLI flags or an interactive wizard.
- Resolving one of 9 built-in templates and optionally applying feature overlays.
- Generating scaffold output files with `{{variable}}` interpolation.
- Synthesizing standardized `package.json`, `.env.example`, `README.md`, and optional `docker-compose.yml` based on selected options.
- Optionally running post-generation setup steps: git initialization, dependency installation, and project wiring into `@dzupagent/agent-adapters`.
- Exposing a programmatic API for embedding scaffold logic in other tools.

## Structure
Top-level package layout:
- `src/cli.ts`: CLI program definition (`commander`), flag parsing, validation, list commands, and invocation of generation flow.
- `src/wizard.ts`: interactive flow using dynamic `@inquirer/prompts` import.
- `src/generator.ts`: current orchestration pipeline used by CLI.
- `src/scaffold-engine.ts`: legacy engine that writes template manifests directly.
- `src/template-renderer.ts`: placeholder substitution (`{{key}}`).
- `src/logger.ts`: ANSI color helpers and spinner implementation.
- `src/types.ts`: shared contracts and union types.
- `src/presets.ts`: 5 built-in presets (`minimal`, `starter`, `full`, `api-only`, `research`).
- `src/features.ts`: 5 built-in overlays (`auth`, `dashboard`, `billing`, `teams`, `ai`).
- `src/templates/`: template manifests and generated-file helpers.
- `src/bridge.ts`: optional bridge to `@dzupagent/agent-adapters` via dynamic import.
- `src/utils.ts`: validation, process execution, overlay writing, package-manager detection, and helper command strings.
- `src/index.ts`: public API/export surface.
- `src/__tests__/`: Vitest suites for CLI args, wizard, generator, bridge, templates, presets, features, and utils.

Template registry (`src/templates/index.ts`) currently includes 9 templates:
- `minimal`
- `full-stack`
- `codegen`
- `multi-agent`
- `server`
- `production-saas-agent`
- `secure-internal-assistant`
- `cost-constrained-worker`
- `research`

Helper generators in `src/templates/` used by `generateProject`:
- `generatePackageJson`
- `generateEnvExample`
- `generateDockerCompose`
- `generateReadme`

## Runtime and Control Flow
CLI execution (`src/cli.ts`):
1. `runCli()` creates a `Command` and parses argv.
2. If `--list`, `--list-presets`, or `--list-features` is passed, CLI prints metadata and exits.
3. If no project name and no template/preset flags are provided, CLI launches interactive `runWizard()`.
4. Otherwise CLI validates project name, template, preset, and package-manager inputs.
5. CLI builds a `ProjectConfig` and calls `executeGeneration()`, which invokes `generateProject()`.

Interactive wizard (`src/wizard.ts`):
1. Dynamically imports `@inquirer/prompts`.
2. Prompts for project name, then preset-or-custom path.
3. Preset path applies preset template/features/database/auth and collects package-manager/git/install confirmations.
4. Custom path collects template, features, database, auth, package manager, git/install confirmations.
5. User confirmation gates final config; cancel path exits with `process.exit(0)`.

Generation pipeline (`src/generator.ts`):
1. Creates `projectDir`.
2. Resolves template manifest from registry.
3. Renders and writes manifest files, skipping `package.json`, `.env.example`, `README.md`, and `docker-compose.yml` (these are synthesized later).
4. Applies selected feature overlays from `features.ts`.
5. Generates `package.json` via `generatePackageJson()`.
6. Generates `.env.example` via `generateEnvExample()`.
7. Generates `docker-compose.yml` when `database !== 'none'` or `ai` feature is selected.
8. Generates `README.md` via `generateReadme()`.
9. Optionally initializes git and installs dependencies.
10. Optionally runs bridge wiring when `{ wire: true }`.
11. Returns `GenerationResult` including created files and status booleans (`gitInitialized`, `depsInstalled`, `wired`).

Bridge wiring flow (`src/bridge.ts`):
1. Dynamically imports `@dzupagent/agent-adapters`.
2. Resolves workspace paths with `WorkspaceResolver`.
3. Executes importer plan and import.
4. Returns `WireBridgeResult` with counts and summaries.
5. Never throws to caller; failures become `success: false` plus `error` message.

Legacy API path (`src/scaffold-engine.ts`):
1. Reads a template manifest.
2. Renders all manifest files directly (no skip list, no generated helper files).
3. Writes output and returns `ScaffoldResult`.

## Key APIs and Types
Primary public exports (`src/index.ts`):
- `generateProject(config, outputDir, callbacks?, options?)`
- `wireProject(options)`
- `runWizard()`
- `ScaffoldEngine` (legacy)
- `renderTemplate(content, variables)`
- Template registry helpers: `templateRegistry`, `getTemplate`, `listTemplates`
- Preset helpers: `presets`, `getPreset`, `listPresets`, `PRESET_NAMES`
- Feature helpers: `getFeatureOverlay`, `listFeatures`, `getFeatureSlugs`
- Utility helpers including `validateProjectName`, `detectPackageManager`, `installDependencies`, `initGitRepo`, `applyOverlay`, and marketplace fetch helper.

Core type contracts (`src/types.ts`):
- `TemplateType`: union of 9 template IDs.
- `ProjectConfig`: normalized configuration used by generation.
- `GenerationResult`: scaffold output plus post-step status flags.
- `TemplateManifest`: template metadata, files, and dependency maps.
- `FeatureDefinition`: overlay files/dependencies/env var metadata.
- `DatabaseProvider`, `AuthProvider`, `PackageManagerType`, `PresetName`.

CLI-specific contracts (`src/cli.ts`):
- `CLIOptions`: parsed command-line flag shape.

Bridge contracts (`src/bridge.ts`):
- `WireBridgeOptions`
- `WireBridgeResult`

## Dependencies
Package runtime dependencies (`package.json`):
- `commander`: CLI parsing and option handling.
- `@inquirer/prompts`: interactive wizard prompts (loaded dynamically in wizard path).
- `chalk`, `ora`: declared dependencies, but current implementation uses custom ANSI logger/spinner (`src/logger.ts`) instead of these packages.

Build/test dependencies:
- `typescript`, `tsup`, `vitest`.

Node built-ins used heavily:
- `node:fs/promises`, `node:path`, `node:child_process`, `node:url`, `node:util`, and `node:fs`.

Generated-project dependency logic:
- Base generated dependencies include `@dzupagent/core` and `@dzupagent/agent`.
- Additional dependencies are merged from selected features/database and template manifest dependency maps in `generatePackageJson()`.
- Template-specific manifests can override feature dependency versions because template dependencies are merged last.

Optional integration dependency:
- `@dzupagent/agent-adapters` is loaded dynamically only for `--wire` behavior and is intentionally not a hard dependency.

## Integration Points
Filesystem:
- Scaffolding writes project files/directories directly to local disk.
- Overlay application writes additional files relative to generated project root.

System commands:
- `runCommand()` executes package manager commands and git commands.
- `initGitRepo()` runs `git init`, `git add .`, and initial commit.

Optional adapter runtime:
- `wireProject()` integrates scaffolded output into adapter-managed `.dzupagent/` structure via `@dzupagent/agent-adapters`.

Network:
- `fetchMarketplaceTemplates()` performs HTTP GET to `${baseUrl}/api/marketplace/templates` with 5s timeout.
- This function is exported but not currently called by CLI/generation flow.

Package manager ecosystem:
- Designed to run as `npm create dzupagent`, `npx create-dzupagent`, or direct binary execution.

## Testing and Observability
Test coverage shape (`src/__tests__/`):
- `scaffold.test.ts`: renderer behavior, template registry integrity, legacy `ScaffoldEngine`, and E2E file generation checks.
- `generator.test.ts`: modern generation pipeline, callback steps, feature overlays, and generated helper files.
- `bridge.test.ts`: bridge success/failure contract, idempotence, and generator `wire` option behavior.
- `cli-args.test.ts`: command parsing matrix and invalid argument handling.
- `wizard.test.ts`: mocked prompt flows for preset and custom paths.
- `features.test.ts`, `presets.test.ts`, `utils.test.ts`, `research-preset.test.ts`: focused unit checks.

Test config (`vitest.config.ts`):
- Node environment.
- Coverage provider `v8`.
- Global thresholds: statements 40, branches 30, functions 30, lines 40.

Runtime observability:
- Human-readable terminal output via custom color/spinner utilities.
- `generateProject()` supports `onStep` and `onFileCreated` callbacks for embedding in external tooling.
- No structured logging, tracing, or metrics in this package itself.

## Risks and TODOs
- Documentation drift: package README still documents five-template-era behavior, but registry currently has nine templates and expanded flows.
- Dual generation paths: `generateProject()` and legacy `ScaffoldEngine` produce different outputs (skip/synthesize behavior exists only in `generateProject`), which can confuse programmatic users.
- Silent non-fatal step failures: git/dependency install/wire failures are swallowed and represented only by boolean flags; CLI does not print explicit failure reasons.
- Feature validation gap: unknown feature slugs are silently ignored by generation because `getFeatureOverlay()` can return `undefined` and no validation error is raised.
- Unused declared runtime deps: `chalk` and `ora` are present in package dependencies but not used by current logger implementation.
- Marketplace integration incomplete: `fetchMarketplaceTemplates()` exists and is exported but is not wired into CLI/wizard selection and has no direct tests.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js

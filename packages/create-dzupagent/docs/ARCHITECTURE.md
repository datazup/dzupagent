# create-dzupagent Architecture

## Scope
This document covers the current implementation of `packages/create-dzupagent`.

Included:
- CLI entrypoint and command routing in `src/cli.ts`.
- Interactive configuration flow in `src/wizard.ts`.
- Project generation pipeline in `src/generator.ts`.
- Legacy scaffold path in `src/scaffold-engine.ts`.
- Template registry and manifests in `src/templates/*`.
- Feature and preset registries in `src/features.ts` and `src/presets.ts`.
- Optional adapter bridge wiring in `src/bridge.ts`.
- Native-agent sync command in `src/sync.ts`.
- Public exports in `src/index.ts`.
- Build/test configuration in `package.json`, `tsup.config.ts`, `tsconfig.json`, and `vitest.config.ts`.

Excluded:
- Runtime behavior of generated projects after scaffold completion.
- Internal behavior of external packages (for example `@dzupagent/agent-adapters`, `@dzupagent/agent`, `commander`, `@inquirer/prompts`).

## Responsibilities
`create-dzupagent` provides a scaffold toolchain for DzupAgent projects.

Primary responsibilities:
- Generate new project directories from built-in template manifests.
- Support non-interactive setup (CLI flags) and interactive setup (wizard prompts).
- Apply optional feature overlays (`auth`, `dashboard`, `billing`, `teams`, `ai`) on top of a selected template.
- Synthesize generated files (`package.json`, `.env.example`, `README.md`, and conditional `docker-compose.yml`) instead of copying those directly from template manifests.
- Optionally run post-generation tasks (`git init` + first commit, package-manager install).
- Optionally wire scaffold output into the `@dzupagent/agent-adapters` importer flow (`--wire`).
- Provide `sync <target>` to map `.dzupagent/` definitions into native target files for `claude`, `codex`, `gemini`, `qwen`, `goose`, and `crush`.
- Expose a programmatic API for generation, template access, overlays, and utility helpers.

## Structure
Top-level package structure:
- `src/cli.ts`: CLI setup using `commander`, list commands, scaffold execution path, and `sync` subcommand.
- `src/wizard.ts`: interactive prompt flow with preset/custom branches and final `ProjectConfig` assembly.
- `src/generator.ts`: end-to-end generation orchestrator (`generateProject`).
- `src/scaffold-engine.ts`: legacy engine that renders every template file directly.
- `src/sync.ts`: `runSyncCommand()` and sync plan/result formatting.
- `src/bridge.ts`: `wireProject()` bridge to `@dzupagent/agent-adapters/dzupagent` via dynamic import.
- `src/features.ts`: built-in feature overlay registry and lookup/list helpers.
- `src/presets.ts`: built-in presets (`minimal`, `starter`, `full`, `api-only`, `research`).
- `src/templates/*.ts`: template manifests plus synthesized-file generators.
- `src/utils.ts`: validation, command execution, package-manager detection, overlay writing, and helper command strings.
- `src/template-renderer.ts`: `{{variable}}` substitution logic.
- `src/logger.ts`: ANSI color helpers and a simple spinner.
- `src/index.ts`: public export surface.
- `src/__tests__/*.test.ts`: 10 test files covering registry integrity, generation flow, wizard paths, CLI args, bridge wiring, and utilities.

Template registry (`src/templates/index.ts`) currently includes 9 template IDs:
- `minimal`
- `full-stack`
- `codegen`
- `multi-agent`
- `server`
- `production-saas-agent`
- `secure-internal-assistant`
- `cost-constrained-worker`
- `research`

## Runtime and Control Flow
Scaffold CLI flow (`create-dzupagent [project-name]`):
1. `createProgram()` defines options/commands and calls `run(projectName, options)`.
2. `run()` handles list commands early (`--list`, `--list-presets`, `--list-features`).
3. If no project name/template/preset is provided, `runWizard()` collects config interactively.
4. CLI mode validates project name, template, preset, and package manager.
5. `executeGeneration()` calls `generateProject(config, resolve(process.cwd()), callbacks, { wire })`.
6. `generateProject()` executes the pipeline:
   - create project directory.
   - load template manifest.
   - render/write template files except `package.json`, `.env.example`, `README.md`, `docker-compose.yml`.
   - apply selected feature overlay files.
   - generate and write `package.json` (`generatePackageJson`).
   - generate and write `.env.example` (`generateEnvExample`).
   - generate and write `docker-compose.yml` when `database !== 'none'` or `ai` is selected.
   - generate and write `README.md` (`generateReadme`).
   - optionally initialize git (`initGitRepo`), non-fatal on failure.
   - optionally install dependencies (`installDependencies`), non-fatal on failure.
   - optionally wire project (`wireProject`) when `options.wire` is true, non-fatal on failure.
7. CLI prints file list, completion flags, and next steps.

Sync command flow (`create-dzupagent sync <target>`):
1. Validate `target` against `VALID_SYNC_TARGETS`.
2. Dynamically import `@dzupagent/agent-adapters/dzupagent`.
3. Resolve workspace paths, construct file loader + skill registry + agent loader + syncer.
4. Build sync plan (`planSync`), print write/divergence summary.
5. If neither `--execute` nor `--dry-run` is set, stop after plan preview.
6. Otherwise call `executeSync(plan, { force, dryRun, dryRunFormat })` and print result summary.

Wizard flow (`runWizard`):
1. Prompt for project name (validated with `validateProjectName`).
2. Prompt for preset vs custom setup.
3. Preset branch: choose package manager + git/install flags, confirm, return preset-derived config.
4. Custom branch: choose template/features/database/auth/package manager/git/install, confirm, return config.
5. User cancellation exits process via `process.exit(0)`.

Legacy programmatic flow (`ScaffoldEngine.generate`):
1. Resolve template manifest.
2. Render every manifest file with `renderTemplate`.
3. Write files directly under `outputDir/projectName`.
4. Return basic scaffold result.

## Key APIs and Types
Main exports from `src/index.ts`:
- Generation and wizard:
  - `generateProject(config, outputDir, callbacks?, options?)`
  - `runWizard()`
  - `ScaffoldEngine`
- Adapter integration:
  - `wireProject(options)`
- Template access:
  - `templateRegistry`, `getTemplate(id)`, `listTemplates()`
  - individual template constants (`minimalTemplate`, `fullStackTemplate`, `codegenTemplate`, `multiAgentTemplate`, `serverTemplate`, `researchTemplate`)
- Presets and features:
  - `presets`, `getPreset`, `listPresets`, `PRESET_NAMES`
  - `getFeatureOverlay`, `listFeatures`, `getFeatureSlugs`
- Template/file helpers:
  - `renderTemplate`
  - `generatePackageJson`, `generateEnvExample`, `generateDockerCompose`, `generateReadme`
- Utilities:
  - `validateProjectName`, `detectPackageManager`, `runCommand`, `installDependencies`, `initGitRepo`, `applyOverlay`, `fetchMarketplaceTemplates`, `getInstallCommand`, `getDevCommand`

Core types (`src/types.ts` and related modules):
- `TemplateType`: union of 9 supported template IDs.
- `ProjectConfig`: scaffold configuration shape used by CLI/wizard/generator.
- `GenerationResult`: scaffold pipeline result including `gitInitialized`, `depsInstalled`, `wired` flags.
- `ScaffoldOptions` and `ScaffoldResult`: legacy `ScaffoldEngine` interfaces.
- `TemplateManifest`: template metadata, file list, dependency maps, optional `availableFeatures`.
- `FeatureDefinition`: overlay file/dependency/env-var definition.
- `PresetName` and `PresetConfig`.
- `SyncTargetName` and `SyncCommandOptions`.
- `WireBridgeOptions` and `WireBridgeResult`.

## Dependencies
Runtime dependencies declared in `package.json`:
- `commander`: CLI parser and command router.
- `@inquirer/prompts`: interactive wizard prompts (loaded dynamically in `runWizard`).
- `chalk`, `ora`: declared dependencies, but runtime output currently uses local `src/logger.ts`.

Optional runtime dependency:
- `@dzupagent/agent-adapters` (optional dependency + tsup external).
- Used through dynamic import by `src/bridge.ts` and `src/sync.ts`.

Development/build dependencies:
- `typescript`, `tsup`, `vitest`.
- `@dzupagent/agent` is used in tests (preset bridge checks).

Node built-ins used across modules:
- `node:fs`, `node:fs/promises`, `node:path`, `node:child_process`, `node:util`, `node:url`.

Build/package behavior:
- `tsup` builds ESM outputs for `src/index.ts` and `src/cli.ts` into `dist/`.
- `bin` points to `dist/cli.js`.
- Published files include `dist` only.

## Integration Points
Filesystem integration:
- Scaffolds into `join(outputDir, projectName)`.
- Creates directories recursively and writes all generated/template/overlay files.

Process execution integration:
- `initGitRepo()` runs `git init`, `git add .`, and initial commit.
- `installDependencies()` runs `npm install`, `pnpm install`, or `yarn`.
- Both are invoked conditionally by `generateProject()` and failures are treated as non-fatal.

Adapter integration:
- `--wire` path calls `wireProject()` to run importer plan/execute against generated output.
- `sync` path calls sync planner/executor to produce and optionally apply native target file updates.

Network integration:
- `fetchMarketplaceTemplates(baseUrl)` requests `${baseUrl}/api/marketplace/templates` with a 5-second abort timeout and returns `null` on failures.

CLI integration:
- `create-dzupagent` supports template/preset/feature listing commands.
- `create-dzupagent sync` supports plan preview, dry-run diagnostics (`console` or `json`), and execute mode.

## Testing and Observability
Test coverage surface:
- `scaffold.test.ts`: template registry, template rendering, and legacy scaffold engine behavior.
- `generator.test.ts`: generated files, feature overlays, docker compose conditions, callbacks, and configuration outcomes.
- `wizard.test.ts`: preset/custom prompt flows and cancellation behavior with prompt mocks.
- `cli-args.test.ts`: argument parsing and invalid-input handling.
- `features.test.ts`: feature registry correctness.
- `presets.test.ts`: preset registry correctness.
- `research-preset.test.ts`: research preset/template scaffold checks.
- `bridge.test.ts`: wiring behavior and generator `wire` option behavior.
- `preset-registry-bridge.test.ts`: scaffold preset/tool references against `@dzupagent/agent` preset registry.
- `utils.test.ts`: validation/helpers/overlay writer behavior.

Current gap:
- No dedicated `sync.test.ts` suite for `runSyncCommand` and sync output behavior.

Vitest configuration (`vitest.config.ts`):
- Node environment, 30s timeout.
- Coverage provider `v8`; reporters `text` and `json-summary`.
- Coverage thresholds: statements 40, branches 30, functions 30, lines 40.

Observability characteristics:
- Human-readable terminal status from `Spinner` and ANSI color helpers.
- `generateProject()` emits callback hooks (`onStep`, `onFileCreated`) for host-side progress instrumentation.
- No native structured telemetry, tracing, or metrics stream.

## Risks and TODOs
- CLI/README drift: package README documents template usage and API basics but does not document the `sync` command path.
- Export-surface mismatch: all 9 templates exist in the registry, but `src/index.ts` only re-exports individual constants for 6 templates.
- Dual generation behavior: `generateProject()` (synthesized files + overlays + optional post-steps) and `ScaffoldEngine.generate()` (manifest-only rendering) can produce different results for the same template.
- Feature metadata underuse: `FeatureDefinition.dependencies` and `FeatureDefinition.envVars` are not directly consumed by generation logic; package/env synthesis is hardcoded in template generator modules.
- Template capability metadata underuse: `TemplateManifest.availableFeatures` exists in type shape but is not populated or enforced in current flow.
- Non-fatal post-step failures are intentionally swallowed into boolean result flags; detailed failure context is not persisted beyond immediate CLI output.
- `ProjectConfig.marketplaceUrl` and `fetchMarketplaceTemplates()` exist, but marketplace templates are not currently integrated into CLI/wizard selection flow.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten from current `create-dzupagent` source, tests, and package configuration.


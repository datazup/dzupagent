# create-dzipagent Architecture

## Purpose
`create-dzipagent` is a CLI scaffolding package that generates DzipAgent projects from bundled template manifests. It provides both command-line and programmatic interfaces for bootstrapping opinionated project structures.

## Main Responsibilities
- Parse CLI arguments and validate template choices.
- Expose built-in template registry and template lookup helpers.
- Render template files via variable interpolation.
- Generate project directory/file tree on disk through scaffold engine.
- Expose a small public API for embedding in other tooling.

## Module Structure
Top-level modules under `src/`:
- `cli.ts`: executable entrypoint, argument parsing, command dispatch.
- `scaffold-engine.ts`: file generation orchestration.
- `template-renderer.ts`: `{{variable}}` replacement behavior.
- `templates/`: built-in template manifests (`minimal`, `full-stack`, `codegen`, `multi-agent`, `server`) and registry functions.
- `types.ts`: shared data contracts (`TemplateType`, `ScaffoldOptions`, `TemplateManifest`, etc.).
- `index.ts`: programmatic export surface.

## How It Works (CLI Flow)
1. Parse command (`--help`, `--list`, or generation) and options.
2. Validate selected template against allowed IDs.
3. Resolve output path from current working directory.
4. `ScaffoldEngine.generate()` loads manifest and iterates template files.
5. `renderTemplate()` interpolates project-level variables.
6. Engine creates directories/files and returns generation summary.
7. CLI prints created files and next steps.

## How It Works (Programmatic Flow)
1. Consumer imports `ScaffoldEngine` and optional template helpers.
2. Consumer selects template ID or retrieves full manifest.
3. Engine generates files into requested output directory.
4. Result contains project path, template id, and created file list.

## Main Features
- Five built-in starter templates targeting common DzipAgent setups.
- Simple deterministic variable interpolation semantics.
- Small dependency footprint and easy embedding in automation.
- Dual interface: CLI binary + typed programmatic API.

## Integration Boundaries
- Uses local filesystem for writes.
- Template manifests are internal to package (`src/templates/*`).
- Intended as entrypoint for new projects that later consume DzipAgent workspace packages.

## Extensibility Points
- Add new template manifests to `src/templates` and registry.
- Extend CLI options (feature flags, package manager choice, non-interactive presets).
- Add richer renderer behavior if templates evolve beyond current token replacement model.

## Quality and Test Posture
- Package includes scaffold tests validating generation behavior and template wiring.

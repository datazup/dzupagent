# create-dzupagent

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 3

| Metric | Value |
|--------|-------|
| Source Files | 14 |
| Lines of Code | 2,075 |
| Test Files | 1 |
| Internal Dependencies | None |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install create-dzupagent
```
<!-- AUTO-GENERATED-END -->

CLI scaffolding tool for creating new DzupAgent projects. Generates project files from template manifests with `{{variable}}` interpolation. Ships with five built-in templates covering common agent architectures.

## Usage

```bash
# Using npm create (recommended)
npm create dzupagent my-project

# Using npx
npx create-dzupagent my-project

# Specify a template
npx create-dzupagent my-project --template full-stack
npx create-dzupagent my-project --template codegen
npx create-dzupagent my-project --template multi-agent
npx create-dzupagent my-project --template server
npx create-dzupagent my-project --template minimal
```

## Installation

For programmatic use in other tools:

```bash
npm install create-dzupagent
```

## Templates

Five built-in project templates are available:

| Template | Description |
|----------|-------------|
| `minimal` | Single-agent project with minimal dependencies. Good starting point for simple agents. |
| `full-stack` | Agent with server, memory, and context management. Includes `@dzupagent/agent`, `@dzupagent/server`, `@dzupagent/memory`, and `@dzupagent/context`. |
| `codegen` | Code generation agent with VFS, sandbox, and git tooling. Built on `@dzupagent/codegen`. |
| `multi-agent` | Multi-agent orchestration with supervisor pattern. Multiple agents coordinating via the event bus. |
| `server` | Standalone DzupAgent server deployment. REST API and WebSocket server with persistence. |

Each template defines its own set of files, dependencies, and dev dependencies through a `TemplateManifest`.

## Programmatic API

The scaffold engine can be used programmatically in build tools, CLIs, or other automation:

```ts
import { ScaffoldEngine, listTemplates, getTemplate } from 'create-dzupagent'

// List all available templates
const templates = listTemplates()
for (const t of templates) {
  console.log(`${t.id}: ${t.name} -- ${t.description}`)
}

// Get a specific template manifest
const manifest = getTemplate('full-stack')
console.log(`Files: ${manifest.files.length}`)
console.log(`Dependencies:`, manifest.dependencies)

// Generate a project
const engine = new ScaffoldEngine()
const result = await engine.generate({
  projectName: 'my-agent',
  template: 'full-stack',
  outputDir: '/path/to/output',
})

console.log(`Created ${result.filesCreated.length} files in ${result.projectDir}`)
// result.filesCreated: ['package.json', 'src/index.ts', 'tsconfig.json', ...]
// result.projectDir: '/path/to/output/my-agent'
// result.template: 'full-stack'
```

### Template Rendering

The `renderTemplate` function handles `{{variable}}` interpolation. Unknown variables are left as-is (no error thrown):

```ts
import { renderTemplate } from 'create-dzupagent'

const content = renderTemplate(
  'Hello {{projectName}}, version {{version}}!',
  { projectName: 'my-agent' },
)
// "Hello my-agent, version {{version}}!"
```

### Template Registry

Access individual templates directly:

```ts
import {
  templateRegistry,
  minimalTemplate,
  fullStackTemplate,
  codegenTemplate,
  multiAgentTemplate,
  serverTemplate,
} from 'create-dzupagent'

// templateRegistry is Record<TemplateType, TemplateManifest>
const minimal = templateRegistry['minimal']
```

## API Reference

### Classes

- `ScaffoldEngine` -- generates project files from a template manifest
  - `generate(options: ScaffoldOptions): Promise<ScaffoldResult>` -- create a project directory, render all template files with variable substitution, and write them to disk

### Functions

- `renderTemplate(content, variables)` -- replace `{{variable}}` placeholders in a string with values from a variables map
- `getTemplate(id)` -- retrieve a `TemplateManifest` by template type. Throws if the template ID is unknown.
- `listTemplates()` -- return all registered template manifests as an array

### Constants

- `templateRegistry` -- `Record<TemplateType, TemplateManifest>` mapping all template IDs to their manifests
- `minimalTemplate` -- manifest for the `minimal` template
- `fullStackTemplate` -- manifest for the `full-stack` template
- `codegenTemplate` -- manifest for the `codegen` template
- `multiAgentTemplate` -- manifest for the `multi-agent` template
- `serverTemplate` -- manifest for the `server` template

### Types

```ts
// Supported template identifiers
type TemplateType = 'minimal' | 'full-stack' | 'codegen' | 'multi-agent' | 'server'

// Options passed to ScaffoldEngine.generate()
interface ScaffoldOptions {
  projectName: string      // Name of the project (used as directory name)
  template: TemplateType   // Which template to use
  features?: string[]      // Optional feature flags
  outputDir: string        // Parent directory for the generated project
}

// Result returned after scaffolding completes
interface ScaffoldResult {
  filesCreated: string[]   // Relative paths of all created files
  projectDir: string       // Absolute path to the generated project directory
  template: TemplateType   // Which template was used
}

// Describes a template's file structure and dependencies
interface TemplateManifest {
  id: TemplateType
  name: string
  description: string
  files: Array<{
    path: string              // Relative file path within the project
    templateContent: string   // File content with {{variable}} placeholders
  }>
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
}
```

## How It Works

1. The CLI parses the project name and `--template` flag (defaults to `minimal`)
2. The `ScaffoldEngine` resolves the template manifest from the registry
3. For each file in the manifest:
   - The `renderTemplate` function replaces `{{projectName}}` and `{{template}}` placeholders
   - The file is written to `outputDir/projectName/path`
   - Intermediate directories are created automatically
4. The result lists all created files and the project directory path

## License

MIT

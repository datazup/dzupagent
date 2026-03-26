# @forgeagent/codegen

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 202

| Metric | Value |
|--------|-------|
| Source Files | 101 |
| Lines of Code | 16,463 |
| Test Files | 9 |
| Internal Dependencies | `@forgeagent/core` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/codegen
```
<!-- AUTO-GENERATED-END -->

Code generation engine built on `@forgeagent/core`. Provides a virtual filesystem, code generation services, sandbox execution, quality scoring, framework adaptation, pipeline builder, generic LangGraph tools, and API contract extraction.

## Installation

```bash
yarn add @forgeagent/codegen
# or
npm install @forgeagent/codegen
```

## Quick Start

```ts
import {
  VirtualFS,
  CodeGenService,
  QualityScorer,
  GenPipelineBuilder,
  builtinDimensions,
} from '@forgeagent/codegen'

// 1. Create an in-memory filesystem
const vfs = new VirtualFS()

// 2. Generate a file using an LLM
const codegen = new CodeGenService(model, vfs)
const result = await codegen.generateFile({
  path: 'src/services/user.service.ts',
  description: 'CRUD service for users with Prisma',
  context: existingFiles,
})

// 3. Score the output
const scorer = new QualityScorer(builtinDimensions)
const quality = await scorer.score(vfs, { phase: 'backend' })
console.log(`Quality: ${quality.overall}/100`)

// 4. Build a full generation pipeline
const pipeline = new GenPipelineBuilder()
  .addPhase('gen_backend', backendNode)
  .addPhase('gen_frontend', frontendNode)
  .addPhase('validate', validateNode)
  .addPhase('fix', fixNode)
  .build()
```

## API Reference

### VFS (Virtual Filesystem)

- `VirtualFS` -- in-memory virtual filesystem for staging generated files before writing to disk
- `saveSnapshot(vfs, store): Promise<void>` -- persist a VFS snapshot to a store
- `loadSnapshot(store, id): Promise<VirtualFS>` -- restore a VFS from a stored snapshot

**Types:** `FileDiff`, `SnapshotStore`

### Generation

- `CodeGenService` -- orchestrates LLM-based code generation with context injection and file writing
- `parseCodeBlocks(text): CodeBlock[]` -- parse fenced code blocks from LLM output
- `extractLargestCodeBlock(text): string` -- extract the largest code block from LLM output
- `detectLanguage(filename): string` -- detect programming language from a file extension

**Types:** `GenerateFileParams`, `GenerateFileResult`, `CodeBlock`

### Sandbox

- `DockerSandbox` -- execute commands in a Docker container for safe test/build execution
- `MockSandbox` -- in-memory sandbox for testing (implements `SandboxProtocol`)

**Types:** `SandboxProtocol`, `ExecOptions`, `ExecResult`, `DockerSandboxConfig`

### Quality

- `QualityScorer` -- scores generated code across multiple quality dimensions
- `typeStrictness: QualityDimension` -- checks for TypeScript strict compliance
- `eslintClean: QualityDimension` -- checks for zero ESLint errors
- `hasTests: QualityDimension` -- checks that test files exist
- `codeCompleteness: QualityDimension` -- checks for TODO/placeholder markers
- `hasJsDoc: QualityDimension` -- checks for JSDoc documentation
- `builtinDimensions: QualityDimension[]` -- all built-in dimensions as an array

**Types:** `QualityDimension`, `DimensionResult`, `QualityResult`, `QualityContext`

### Adaptation

- `PathMapper` -- maps file paths between different framework conventions (e.g., `src/pages` vs `src/views`)
- `FrameworkAdapter` -- adapts generated code content for different frameworks (Vue 3, React, Express, Fastify)

### Contract

- `ApiExtractor` -- extracts API endpoint definitions from source code (Express routes, controller decorators)

**Types:** `ApiEndpoint`, `ApiContract`

### Context (Token Budget)

- `TokenBudgetManager` -- manages which files to include in LLM context within a token budget
- `DefaultRoleDetector: FileRoleDetector` -- default file role detection (config, model, service, test, etc.)
- `DefaultPriorityMatrix: PhasePriorityMatrix` -- default priority weights per generation phase
- `summarizeFile(content): string` -- produce a compact summary of a file's contents
- `extractInterfaceSummary(content): string` -- extract interface/type signatures from TypeScript source

**Types:** `FileRoleDetector`, `PhasePriorityMatrix`, `FileEntry`, `TokenBudgetOptions`

### Pipeline

- `GenPipelineBuilder` -- fluent builder for multi-phase LangGraph generation pipelines
- `DEFAULT_ESCALATION: EscalationConfig` -- default fix escalation configuration
- `getEscalationStrategy(attempt, config): EscalationStrategy` -- determine the fix strategy for a given retry attempt

**Types:** `PipelinePhase`, `EscalationConfig`, `EscalationStrategy`, `BaseGenState`, `PhaseConfig`, `SubAgentPhaseConfig`, `ValidationPhaseConfig`, `FixPhaseConfig`, `ReviewPhaseConfig`

### Tools

LangGraph-compatible tool factories for use inside agent nodes:

- `createWriteFileTool(vfs): StructuredTool` -- write a file to the VFS
- `createEditFileTool(vfs): StructuredTool` -- edit an existing file in the VFS
- `createGenerateFileTool(codegen): StructuredTool` -- generate a file via LLM
- `createRunTestsTool(sandbox): StructuredTool` -- run tests in a sandbox
- `createValidateTool(sandbox): StructuredTool` -- run validation (typecheck, lint) in a sandbox

### Version

- `FORGEAGENT_CODEGEN_VERSION: string` -- current package version (`'0.1.0'`)

## Configuration

This package relies on `@forgeagent/core` for LLM and persistence configuration. Additional sandbox-specific options:

| Option | Used by | Description |
|--------|---------|-------------|
| `image` | `DockerSandbox` | Docker image to use for sandbox execution |
| `workDir` | `DockerSandbox` | Working directory inside the container |
| `timeoutMs` | `DockerSandbox` | Max execution time per command |
| `memoryMB` | `DockerSandbox` | Memory limit for the container |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | Base LangChain types (tools, messages) |
| `@langchain/langgraph` | `>=1.0.0` | Graph builder, state annotations |
| `zod` | `>=4.0.0` | Schema validation for tool parameters |

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@forgeagent/core` | `0.1.0` | Core agent infrastructure (LLM, memory, prompts) |

## License

MIT

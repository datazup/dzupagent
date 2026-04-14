# `src/quality` Architecture

## 1. Scope and Responsibility

`packages/codegen/src/quality` provides static, fast quality gates for generated code in `@dzupagent/codegen`.

It covers six capability areas:

1. Composite quality scoring (`quality-scorer.ts`)
2. Built-in scoring dimensions (`quality-dimensions.ts`)
3. Test-coverage approximation (`coverage-analyzer.ts`)
4. Multi-file import coherence validation (`import-validator.ts`)
5. Backend/frontend API contract coherence (`contract-validator.ts`)
6. Convention enforcement with confidence gating (`convention-gate.ts`)

These are intentionally heuristic and filesystem-map based (`Record<string, string>` or file lists), so they run without invoking build tools, compilers, or test runners.

## 2. Module Map

- `quality-types.ts`
  - Shared interfaces: `QualityContext`, `DimensionResult`, `QualityResult`, `QualityDimension`.
- `quality-scorer.ts`
  - Orchestrator that executes dimensions and normalizes score to `0-100`.
- `quality-dimensions.ts`
  - Default dimensions: `typeStrictness`, `eslintClean`, `hasTests`, `codeCompleteness`, `hasJsDoc`, and `builtinDimensions`.
- `coverage-analyzer.ts`
  - Static source/test matching and uncovered file prioritization.
- `import-validator.ts`
  - Relative import resolution + self-import + cycle detection across file graph.
- `contract-validator.ts`
  - Endpoint extraction, API call extraction, and contract mismatch detection.
- `convention-gate.ts`
  - Configurable convention checker with built-in and custom rules.

## 3. Core Data Model

### `QualityDimension` contract

Each dimension is pluggable and must implement:

```ts
interface QualityDimension {
  name: string
  maxPoints: number
  evaluate(vfs: Record<string, string>, context?: QualityContext): Promise<DimensionResult>
}
```

### Scoring model

- Each dimension returns `score` + `maxScore`.
- `QualityScorer` aggregates and normalizes:
  - `quality = round((sum(score) / sum(maxScore)) * 100)`.
- `success` is strict:
  - `true` only when no dimension produced `errors`.
  - `warnings` do not fail `success`.

## 4. Features and Behavior

### 4.1 `QualityScorer` (`quality-scorer.ts`)

**Purpose**
- Compose multiple `QualityDimension` implementations.
- Run all dimensions concurrently via `Promise.all`.
- Produce a single quality report object.

**Key behavior**
- Empty dimension set returns `quality = 0`, `success = true`.
- Error and warning lists are flattened from all dimensions.

### 4.2 Built-in dimensions (`quality-dimensions.ts`)

`builtinDimensions` total max points = `50`.

1. `typeStrictness` (15 pts)
- Flags `: any`, `<any>`, `as any`, `@ts-ignore`, `@ts-nocheck`.
- Evaluates `.ts/.tsx` excluding `.d.ts`.
- Violations are emitted as `errors`.

2. `eslintClean` (10 pts)
- Flags debug patterns in non-test source files:
  - `console.log(...)`
  - `debugger`
  - `alert(...)`
- Emits `warnings` (not `errors`).

3. `hasTests` (10 pts)
- Verifies source file has sibling `.test.ts/.tsx` or `.spec.ts/.tsx`.
- Skips test files and `index.*`.
- Emits missing test warnings and scores proportionally by coverage ratio.

4. `codeCompleteness` (10 pts)
- Flags empty function bodies (`{}` patterns) as `errors`.
- Flags inline `TODO` / `FIXME` in code lines as `warnings`.
- Ignores comment-only and JSDoc lines for TODO/FIXME checks.

5. `hasJsDoc` (5 pts)
- Checks exported `function|class|const` declarations for nearby JSDoc.
- Scores by documented export ratio.
- Missing docs are `warnings`.

### 4.3 Coverage analyzer (`coverage-analyzer.ts`)

**Functions**
- `analyzeCoverage(files, config?)`
  - Returns `coveredFiles`, `uncoveredFiles`, `ratio`.
- `findUncoveredFiles(files, config?)`
  - Sorts uncovered files by priority (`lineCount * max(exportCount, 1)`).

**Design notes**
- Static naming-based approximation only.
- Configurable source/test/exclude glob-like patterns.
- Useful for backlog generation and risk triage.

### 4.4 Import coherence validator (`import-validator.ts`)

**Purpose**
- Validate relative imports resolve inside a generated multi-file snapshot.
- Detect:
  - `unresolved`
  - `self-import`
  - `circular`

**Algorithm**
1. Parse static `import/export ... from './x'` and dynamic `import('./x')`.
2. Resolve paths relative to importer.
3. Try extension/index fallbacks (`.ts/.tsx/.js/.jsx/.vue`, plus `.js -> .ts/.tsx` mapping).
4. Build adjacency graph and run DFS cycle detection.

### 4.5 Contract validator (`contract-validator.ts`)

**Purpose**
- Check frontend API calls against backend endpoint definitions.

**Extraction**
- Endpoints:
  - `app|router|route.<method>('path')`
- Calls:
  - `axios|api|http|client.<method>('path')`
  - `fetch('path', { method: ... })` (`GET` default)

**Validation**
- `unmatched-call` (invalid)
- `method-mismatch` (invalid)
- `unmatched-endpoint` (informational; does not invalidate result)

**Normalization**
- Lowercases path.
- Collapses duplicate slashes.
- Trims trailing slash.

### 4.6 Convention gate (`convention-gate.ts`)

**Purpose**
- Enforce conventions from learned or built-in rule sets.

**Built-in conventions include**
- kebab-case file names
- ESM relative import `.js` extension
- no `any`
- no `@ts-ignore`/`@ts-nocheck`
- no `console.log` in non-test code
- no `var`
- exported classes in PascalCase
- exported functions in camelCase

**Config controls**
- `minConfidence` (default `0.7`)
- `warningsOnly` to downgrade all violations
- Add custom `test` functions or regex `pattern` conventions

## 5. Execution Flow and Integration

### 5.1 Typical quality flow

1. Generation produces VFS snapshot (`Record<path, content>`).
2. `QualityScorer` evaluates selected dimensions.
3. Score and diagnostics are attached to state/tool response.
4. Pipeline/self-correction decides pass/fail using thresholds.

### 5.2 Current integration points in `@dzupagent/codegen`

- Public exports: `src/index.ts` re-exports all `quality/*` APIs.
- Tool surface:
  - `src/tools/validate.tool.ts` uses `QualityScorer.evaluate(...)` and exposes `validate_feature`.
- Pipeline config typing:
  - `src/pipeline/phase-types.ts` and `src/pipeline/gen-pipeline-builder.ts` accept `QualityDimension[]` + threshold.
- Self-correction:
  - `src/correction/correction-types.ts` and `src/correction/self-correction-loop.ts` consume `qualityScore` and `qualityThreshold`.

Note: `pipeline` types carry quality config; actual scoring execution is currently done by injected nodes/tools (for example, `createValidateTool`), not by a built-in scorer call in `pipeline-executor.ts`.

## 6. Usage Examples

### 6.1 Score with built-in dimensions

```ts
import { QualityScorer, builtinDimensions } from '@dzupagent/codegen'

const scorer = new QualityScorer().addDimensions(builtinDimensions)

const result = await scorer.evaluate({
  'src/service.ts': 'export function run(): number { return 42 }',
  'src/service.test.ts': 'test("run", () => {})',
})

console.log(result.quality, result.success, result.errors, result.warnings)
```

### 6.2 Add custom dimension

```ts
import { QualityScorer, type QualityDimension } from '@dzupagent/codegen'

const noEval: QualityDimension = {
  name: 'noEval',
  maxPoints: 10,
  async evaluate(vfs) {
    const errors = Object.entries(vfs)
      .filter(([, content]) => /\beval\s*\(/.test(content))
      .map(([path]) => `${path}: eval() usage`)
    return {
      name: 'noEval',
      score: errors.length === 0 ? 10 : 0,
      maxScore: 10,
      passed: errors.length === 0,
      errors,
      warnings: [],
    }
  },
}

const scorer = new QualityScorer().addDimension(noEval)
```

### 6.3 Find uncovered files with priorities

```ts
import { analyzeCoverage, findUncoveredFiles } from '@dzupagent/codegen'

const files = {
  'src/a.ts': 'export const a = 1',
  'src/b.ts': 'export function b() {}',
  'src/a.test.ts': 'test("a", () => {})',
}

const report = analyzeCoverage(files)
const backlog = findUncoveredFiles(files)
```

### 6.4 Validate import coherence

```ts
import { validateImportCoherence } from '@dzupagent/codegen'

const result = validateImportCoherence({
  'src/main.ts': "import { x } from './lib.js'",
  'src/lib.ts': 'export const x = 1',
})

if (!result.valid) console.log(result.issues)
```

### 6.5 Validate API contracts

```ts
import { validateContracts } from '@dzupagent/codegen'

const backend = { 'src/routes.ts': "router.get('/api/users', h)" }
const frontend = { 'src/api.ts': "axios.post('/api/users', body)" }

const result = validateContracts(backend, frontend)
// method-mismatch issue expected
```

### 6.6 Enforce conventions

```ts
import { ConventionGate } from '@dzupagent/codegen'

const gate = ConventionGate.withDefaults({ minConfidence: 0.8 })
const result = gate.evaluate([
  { path: 'src/MyService.ts', content: 'export class myService {}' },
])

console.log(result.passed, result.violations)
```

## 7. Use Cases

1. Pre-write safety checks on generated code before touching disk.
2. Fast quality feedback loop inside iterative codegen/correction workflows.
3. Regression gating in CI for generated patch quality standards.
4. Contract drift detection between generated frontend and backend slices.
5. Convention enforcement for multi-agent code generation consistency.
6. Test-gap prioritization for auto-generated backlog creation.

## 8. References in Other Packages

### 8.1 Direct code references outside `packages/codegen`

Current repository search shows no direct imports of `quality/*` APIs from other packages.

### 8.2 Indirect package-level usage

- `packages/server/src/runtime/tool-resolver.ts`
  - Dynamically imports `@dzupagent/codegen`, currently for git tooling resolution.
- `packages/evals/src/__tests__/sandbox-contracts.test.ts`
  - Optional dynamic import of `@dzupagent/codegen` sandbox implementations.
- `packages/create-dzupagent/src/templates/codegen.ts`
  - Includes `@dzupagent/codegen` dependency in scaffolded templates.

This means `src/quality` is currently primarily consumed inside `@dzupagent/codegen` and via its public exports for external consumers.

## 9. Test Coverage (Current State)

Validated on `2026-04-04` with:

```bash
yarn workspace @dzupagent/codegen test -- \
  src/__tests__/quality-scorer.test.ts \
  src/__tests__/quality-dimensions.test.ts \
  src/__tests__/convention-gate.test.ts \
  src/__tests__/validate-tool.test.ts \
  src/__tests__/code-review.test.ts \
  src/__tests__/import-validator.test.ts
```

Result: `6` files passed, `162` tests passed.

### 9.1 Coverage by module

- `quality-scorer.ts`
  - Directly tested in `quality-scorer.test.ts` (aggregation, success semantics, warning/error flattening).
- `quality-dimensions.ts`
  - Tested in both `quality-scorer.test.ts` and `quality-dimensions.test.ts`.
  - Covers positive/negative paths and edge cases for all built-ins.
- `convention-gate.ts`
  - Thoroughly tested in `convention-gate.test.ts` including defaults, confidence filtering, warnings-only mode, custom conventions, and violation metadata.
- `contract-validator.ts`
  - Tested via `code-review.test.ts` section `Contract Validator`.
- `tools/validate.tool.ts` integration
  - Tested via `validate-tool.test.ts` to confirm scorer invocation and output shape.

### 9.2 Important gaps

1. `quality/coverage-analyzer.ts`
  - No direct tests currently found.
2. `quality/import-validator.ts` (the quality variant)
  - No direct tests currently found.
  - Existing `import-validator.test.ts` targets `src/validation/import-validator.ts` instead.

## 10. Observations and Improvement Opportunities

1. Duplicate import-validator logic exists in:
  - `src/validation/import-validator.ts` (VFS-based, currently tested)
  - `src/quality/import-validator.ts` (file-map graph variant, currently exported but untested)
  - Consolidation would reduce drift risk.
2. Add dedicated tests for `coverage-analyzer.ts`:
  - glob matching edge cases
  - exclude behavior
  - cross-directory test-to-source mapping
  - uncovered priority ordering
3. Add dedicated tests for `quality/import-validator.ts`:
  - cycle detection precision
  - line-number assignment
  - self-import and `.js -> .ts` mapping edge cases


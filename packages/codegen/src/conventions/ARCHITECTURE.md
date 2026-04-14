# Conventions Module Architecture

This document describes the architecture of `packages/codegen/src/conventions`, including feature inventory, runtime flow, usage patterns, use cases, repo references, and current test coverage.

## 1. Scope

The conventions module provides lightweight, regex-based convention intelligence for generated code workflows:

1. Detect project conventions from existing source files.
2. Enforce selected conventions against candidate/generated files.
3. Convert conventions into prompt fragments for LLM steering.

Source files:

- `convention-detector.ts`
- `convention-enforcer.ts`
- `index.ts`

## 2. Public API

`index.ts` exports:

- `detectConventions(files): ConventionReport`
- `enforceConventions(files, conventions): EnforcementResult`
- `conventionsToPrompt(conventions): string`
- Types:
  - `DetectedConvention`
  - `ConventionReport`
  - `ConventionViolation`
  - `EnforcementResult`

The same exports are re-exported by `packages/codegen/src/index.ts` and become part of the `@dzupagent/codegen` package surface.

## 3. Data Model

### 3.1 `DetectedConvention`

- `name`: machine-readable convention key (for example `single-quotes`, `async-await`)
- `category`: one of `naming | structure | formatting | imports | patterns`
- `description`: human-readable summary
- `examples`: up to a few extracted examples from source
- `confidence`: `0..1` strength signal from heuristics

### 3.2 `ConventionReport`

- `conventions`: filtered list of detected conventions (`confidence >= 0.1`)
- `language`: coarse repo language guess (`typescript` or `javascript`)
- `filesAnalyzed`: count of input files

### 3.3 `EnforcementResult`

- `violations`: line-level convention mismatches
- `score`: `0..100`, computed as `(1 - violations / totalLines) * 100` (rounded, bounded at `>= 0`)

## 4. Feature Inventory

## 4.1 Detection (`convention-detector.ts`)

Detector strategy: scan all lines from all provided files and apply independent heuristic detectors. The result is additive (multiple conventions can be emitted).

### A) Naming conventions

Signals:

- Variable/function declarations: `const|let|var|function <identifier>`
- Type declarations: `class|interface|type <Identifier>`

Outputs:

- `camelCase variables` or `snake_case variables`
  - Selected by ratio of detected camel vs snake names.
- `PascalCase types`
  - Added when class/interface/type names are detected.
  - Captures up to 3 examples.

### B) Formatting conventions

Signals:

- Indentation style:
  - tab-leading lines
  - 2-space-leading lines
  - 4-space-leading lines
- Quote style from literal regex matches (single vs double)
- Semicolon usage by line endings

Outputs:

- `indent-tabs` or `indent-2spaces` or `indent-4spaces`
- `single-quotes` or `double-quotes`
- `semicolons` or `no-semicolons`

### C) Import conventions

Signals:

- Import path style:
  - relative (`from './'`, `from '../'`)
  - alias (`from '@'`, `from '~'`)
- Type imports (`import type ...`) vs value imports

Outputs:

- `relative-imports` or `alias-imports`
- `type-imports`

### D) Pattern conventions

Signals:

- Async style: `await` vs `.then(`
- Architectural style: class defs vs function defs
- Export style: named exports vs default exports

Outputs:

- `async-await` or `promise-then`
- `function-style` or `class-style`
- `named-exports` or `default-exports`

### E) Structure conventions

Signals:

- Barrel files (`index.ts`, `index.tsx`, `index.js`, `index.jsx`)
- Average directory depth across file paths

Outputs:

- `barrel-exports`
- `flat-structure` or `nested-structure`

### F) Language inference

Counts file extensions and returns:

- `typescript` when `ts/tsx` count >= `js/jsx` count
- else `javascript`

## 4.2 Enforcement (`convention-enforcer.ts`)

Enforcement strategy:

1. Convert each `DetectedConvention` into an optional line checker.
2. Run checkers over all lines of all files.
3. Emit violations for failed lines.

Currently implemented checkers:

- `single-quotes`
- `double-quotes`
- `semicolons`
- `no-semicolons`
- `indent-2spaces`
- `indent-4spaces`
- `indent-tabs`
- `type-imports`

Important behavior:

- Unknown convention names are ignored (no checker built).
- Multiple checkers can emit violations for the same line.
- If no checkers are active, result is `score: 100` with zero violations.

## 4.3 Prompt generation (`conventionsToPrompt`)

Prompt builder behavior:

1. Group conventions by `category`.
2. Keep only `confidence >= 0.5` entries.
3. Emit sectioned markdown:
   - Header: `Follow these coding conventions:`
   - Category blocks (`NAMING`, `FORMATTING`, etc.)
   - Bullet lines with optional examples (`(e.g. ...)`)
4. Return empty string when no strong conventions are available.

## 5. End-to-End Flow

Typical runtime flow for generation-time convention alignment:

1. Collect representative existing files from target repository.
2. Run `detectConventions(existingFiles)` to infer house style.
3. Build prompt context with `conventionsToPrompt(report.conventions)`.
4. Generate candidate code with an LLM.
5. Run `enforceConventions(generatedFiles, report.conventions)` as a fast quality gate.
6. If score is low or violations exist, either:
   - auto-fix formatting/style,
   - regenerate with stricter prompt constraints,
   - or fail the pipeline step.

## 6. Usage Examples

## 6.1 Basic detection

```ts
import { detectConventions } from '@dzupagent/codegen'

const report = detectConventions({
  'src/user-service.ts': `
    export class UserService {}
    const apiClient = createClient()
  `,
  'src/index.ts': `export * from './user-service.js'`,
})

console.log(report.language) // 'typescript'
console.log(report.filesAnalyzed) // 2
console.log(report.conventions.map(c => c.name))
```

## 6.2 Prompt injection for generation

```ts
import { detectConventions, conventionsToPrompt } from '@dzupagent/codegen'

const report = detectConventions(existingRepoFiles)
const conventionPrompt = conventionsToPrompt(report.conventions)

const finalPrompt = `
${systemPrompt}

${conventionPrompt}
`.trim()
```

## 6.3 Enforce generated files

```ts
import { detectConventions, enforceConventions } from '@dzupagent/codegen'

const baseline = detectConventions(existingRepoFiles)
const result = enforceConventions(generatedFiles, baseline.conventions)

if (result.score < 95) {
  console.error(result.violations.slice(0, 10))
}
```

## 6.4 Minimal policy with curated conventions

```ts
import { enforceConventions, type DetectedConvention } from '@dzupagent/codegen'

const conventions: DetectedConvention[] = [
  {
    name: 'single-quotes',
    category: 'formatting',
    description: 'Strings use single quotes',
    examples: [],
    confidence: 0.9,
  },
  {
    name: 'semicolons',
    category: 'formatting',
    description: 'Statements end with semicolons',
    examples: [],
    confidence: 0.9,
  },
]

const gate = enforceConventions(candidateFiles, conventions)
```

## 7. Use Cases

1. Zero-config style bootstrap for new generation sessions.
2. Fast pre-commit or pre-PR heuristic quality checks on generated patches.
3. Prompt conditioning to improve first-pass adherence to local coding style.
4. Migration assistants that need to mirror project conventions while rewriting files.
5. “Fail fast” CI stage before heavier lint/type/test jobs.

## 8. References In Other Packages / Modules

## 8.1 Export references

- Re-exported in:
  - `packages/codegen/src/index.ts`
  - `packages/codegen/src/conventions/index.ts`

This means external consumers can import these APIs from `@dzupagent/codegen`.

## 8.2 Runtime references inside this repository

Current repo-wide symbol search shows:

- No direct runtime imports/calls of `detectConventions`, `enforceConventions`, or `conventionsToPrompt` outside `packages/codegen`.
- Inside `packages/codegen`, they are currently used by tests and public exports, not wired into pipeline/guardrail execution paths.

Implication:

- The module is production-available as a library surface, but currently acts as an opt-in utility rather than an always-on internal pipeline stage.

## 8.3 Related but separate implementation

`packages/codegen/src/quality/convention-gate.ts` is a different gate abstraction with its own convention model (`LearnedConvention`) and built-in checks. It does not currently consume `DetectedConvention` from this module directly.

## 9. Test Coverage Status

## 9.1 Existing tests

Primary test file:

- `packages/codegen/src/__tests__/convention-detector-and-adapters.test.ts`

Conventions-specific scope in that file:

- Naming detection
- Formatting detection
- Import detection
- Pattern detection
- Structure detection
- Language detection
- Report shape and confidence filtering

Observed count:

- 28 tests for `detectConventions` behavior (in this mixed test file).

## 9.2 Verified test run

Command:

- `yarn workspace @dzupagent/codegen test src/__tests__/convention-detector-and-adapters.test.ts`

Result:

- 1 test file passed
- 64 tests passed total (file includes conventions + adaptation + guardrail reporter tests)

## 9.3 Focused coverage signal

Command:

- `yarn workspace @dzupagent/codegen test:coverage src/__tests__/convention-detector-and-adapters.test.ts`

Relevant module-level coverage from output:

- `conventions/convention-detector.ts`: 100% statements, 98.31% branches, 100% functions, 100% lines
- `conventions/convention-enforcer.ts`: 0% statements/branches/functions/lines
- Folder aggregate `conventions`: 65.86% statements/lines, 97.5% branches, 88.88% functions

Note:

- The focused coverage command exits non-zero due package-global thresholds across unrelated modules, even though the targeted tests passed.

## 10. Strengths, Limits, and Risks

Strengths:

1. Fast and dependency-light (regex/heuristic only).
2. Broad convention taxonomy with confidence scoring.
3. Clear separation between detection, enforcement, and prompt shaping.
4. API is simple and easy to embed in CI/pipeline hooks.

Limits:

1. Heuristic parsing can produce false positives/negatives (not AST-aware).
2. Language detection is binary (TypeScript vs JavaScript) and extension-count based.
3. `enforceConventions` supports only a subset of detected convention names.
4. Score metric is line-based; it does not weight severity or criticality.

Risks:

1. Unenforced detected conventions may create a false sense of complete coverage.
2. Regex quote/import heuristics can misclassify complex syntax cases.
3. Without integration into pipeline stages, benefits depend on explicit adoption by consumers.

## 11. Recommended Next Steps

1. Add direct tests for `convention-enforcer.ts` (all checkers + scoring edge cases).
2. Add a compatibility map test: every enforced convention name should have a detector path or be intentionally documented.
3. Optionally bridge this module with `quality/ConventionGate` for a unified gate experience.
4. Add one pipeline integration point (for example optional convention gate phase) to move from library-only to first-class workflow.

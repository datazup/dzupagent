# Contract Extraction Architecture (`packages/codegen/src/contract`)

## 1) Scope and Purpose

This module provides a lightweight, regex-based API contract extraction utility for generated backend code snapshots.

It is designed for fast, dependency-free extraction from an in-memory virtual filesystem (`Record<string, string>`), typically during codegen workflows where:

- backend source exists only in memory,
- full AST parsing is unnecessary or too expensive,
- a compact contract summary is needed for downstream validation, prompting, or documentation.

The module currently contains two files:

- `contract-types.ts`: type contracts (`ApiEndpoint`, `ApiContract`)
- `api-extractor.ts`: runtime extraction logic (`ApiExtractor`)

## 2) Public API

### 2.1 Types

`ApiEndpoint`

- `method: string`
- `path: string`
- `auth: boolean`
- `description: string`
- `requestBody?: string`
- `responseBody?: string`

`ApiContract`

- `endpoints: ApiEndpoint[]`
- `sharedTypes: string`
- `zodSchemas: string`

### 2.2 Class

`ApiExtractor`

- `extract(vfs: Record<string, string>): ApiContract`

### 2.3 Package export surface

This module is exported via `@dzupagent/codegen` root exports (`packages/codegen/src/index.ts`):

- `ApiExtractor`
- `ApiEndpoint` / `ApiContract`

So consumers should import from package root:

```ts
import { ApiExtractor, type ApiContract } from '@dzupagent/codegen'
```

## 3) Core Features

### 3.1 Endpoint extraction from route/controller files

Extractor scans files whose path suggests routing responsibilities:

- `*.routes.*`
- `*.controller.*`
- `*/routes/*`

Route detection pattern:

- matches `(router|app).(get|post|put|patch|delete)('/path', ...)`

Captured endpoint fields:

- `method`: lowercase capture from source (`get`, `post`, ...)
- `path`: raw route path string from source
- `description`:
  - uses previous line if it starts with `//`
  - otherwise defaults to `"METHOD /path"` (uppercased method)
- `auth`: `true` if route line contains one of:
  - `auth`
  - `authenticate`
  - `protect`
  - `requireAuth`

### 3.2 Zod schema aggregation

Extractor appends full file contents into `zodSchemas` for files matching:

- `*.validator.*`
- `*.schema.*`
- `*/validators/*`
- `*/schemas/*`

Each aggregated section is prefixed with a file marker:

- `// --- <filePath> ---`

### 3.3 Shared type aggregation

Extractor appends full file contents into `sharedTypes` for files matching:

- `*.types.*`
- `*/types/*`
- `*.dto.*`

Each section uses the same file marker format.

### 3.4 Fallback type extraction when no type files exist

If `sharedTypes` remains empty after primary scan, extractor does a fallback scan over:

- `*.service.*`
- `*.controller.*`

It then identifies `export interface <Name>` / `export type <Name>` declarations and attempts to slice full exported blocks by brace balancing. These blocks are appended to `sharedTypes`.

### 3.5 Context size protection

To avoid oversized prompt/context payloads:

- `sharedTypes` and `zodSchemas` are each truncated at `MAX_SECTION_LENGTH = 6000`
- truncation suffix: `// ... (truncated)`

## 4) End-to-End Flow

1. Initialize empty collections:
   - `endpoints = []`
   - `sharedTypes = ''`
   - `zodSchemas = ''`
2. Iterate all VFS entries (`for (const [filePath, content] of Object.entries(vfs))`).
3. For route-like files, parse route endpoints and infer `description` + `auth`.
4. For schema-like files, append entire content to `zodSchemas`.
5. For type-like files, append entire content to `sharedTypes`.
6. If no explicit type files were found, run fallback exported-type extraction in service/controller files.
7. Truncate `sharedTypes` / `zodSchemas` to cap size.
8. Return `{ endpoints, sharedTypes, zodSchemas }`.

## 5) Usage Patterns and Examples

### 5.1 Basic usage with generated backend snapshot

```ts
import { ApiExtractor } from '@dzupagent/codegen'

const extractor = new ApiExtractor()

const vfs = {
  'src/routes/user.routes.ts': `
// List users
router.get('/users', authenticate, listUsers)
router.post('/users', createUser)
`,
  'src/schemas/user.schema.ts': `
import { z } from 'zod'
export const CreateUserSchema = z.object({ email: z.string().email() })
`,
  'src/types/user.types.ts': `
export interface UserDTO { id: string; email: string }
`,
}

const contract = extractor.extract(vfs)

console.log(contract.endpoints)
// [
//   { method: 'get', path: '/users', auth: true,  description: 'List users' },
//   { method: 'post', path: '/users', auth: false, description: 'POST /users' }
// ]
```

### 5.2 Pipeline use (post-generation inspection)

Typical sequence in a generation flow:

1. Generate backend files into VFS.
2. Run `ApiExtractor.extract(vfs)`.
3. Feed `contract.endpoints` + type/schema snippets to:
   - review prompts,
   - API docs generation,
   - cross-check tooling (e.g., frontend call validation).

### 5.3 Contract extraction + contract validation (complementary)

`src/contract/api-extractor.ts` and `src/quality/contract-validator.ts` are related but different:

- `ApiExtractor`: builds summary contract payloads (`endpoints`, `sharedTypes`, `zodSchemas`)
- `validateContracts(...)`: validates frontend/backend call coherence

A practical pattern is:

1. Extract contract summary from generated backend with `ApiExtractor`.
2. Validate frontend API calls with `validateContracts(...)` from `quality/contract-validator.ts`.
3. Report both semantic mismatches and rich contract context together.

## 6) Use Cases

### 6.1 LLM context enrichment

Provide compact, deterministic API summaries (routes + types + zod schemas) to generation/review prompts without re-reading full codebase.

### 6.2 Generated API documentation seed

Use endpoint list and aggregated schemas/types as seed material for docs generation pipelines.

### 6.3 Backend/frontend coherence workflows

When paired with `quality/contract-validator.ts`, it helps build end-to-end API contract checks in generated projects.

### 6.4 Fast pre-checks in CI-like loops

Because extraction is regex-only and dependency-free, it is suitable for quick iterations and repeated execution in correction loops.

## 7) Cross-Package References and Current Usage

### 7.1 Direct runtime references in monorepo

Current repository search indicates:

- `ApiExtractor` / `ApiContract` are exported from `@dzupagent/codegen` root.
- No other package currently imports or calls `ApiExtractor` directly in runtime source.

### 7.2 Documentation references

- `packages/codegen/README.md` documents `ApiExtractor` under "Contract".
- `packages/codegen/src/index.ts` re-exports this module for external consumers.

### 7.3 Related contract systems in other packages

Other packages focus on different contract domains (eval adapter contracts, orchestration contract-net, connector contracts, etc.). These are conceptually related but do not directly consume `src/contract/api-extractor.ts` today.

## 8) Testing and Coverage Status

### 8.1 Direct unit tests for this module

- No dedicated tests currently exist for:
  - `packages/codegen/src/contract/api-extractor.ts`
  - `packages/codegen/src/contract/contract-types.ts` (type-only)

### 8.2 Current measured coverage

From `yarn workspace @dzupagent/codegen test:coverage` (run on 2026-04-04):

- `contract/api-extractor.ts`: **0% statements / 0% branches / 0% functions / 0% lines**
- Contract folder aggregate appears as uncovered in coverage output.

### 8.3 Indirectly related coverage

- `src/__tests__/code-review.test.ts` contains behavioral tests for `extractEndpoints`, `extractAPICalls`, and `validateContracts` (from `src/quality/contract-validator.ts`).
- The same coverage run reports `src/quality/contract-validator.ts` as 0%, which suggests a coverage instrumentation/path-mapping anomaly for that file rather than absence of tests.
- This does not change the key finding for this folder: `ApiExtractor` itself still has no dedicated tests and remains uncovered.

### 8.4 Suggested test additions

1. Route extraction happy path:
   - route detection across `.routes.` and `.controller.` files
   - comment-derived descriptions
   - auth middleware detection
2. Schema/type aggregation:
   - matching file patterns and section headers
3. Fallback type extraction:
   - no `.types.` files, but exported interface/type in service/controller
4. Truncation behavior:
   - verify `MAX_SECTION_LENGTH` caps and truncation marker
5. Edge cases:
   - empty VFS
   - mixed quoting (`'`, `"`, `` ` ``)
   - multiple routes on single file

## 9) Strengths, Constraints, and Risks

### 9.1 Strengths

- Very fast and portable (regex-only, no parser/runtime dependency).
- Works directly on VFS snapshots.
- Deterministic output format suitable for prompt injection and machine post-processing.
- Built-in safeguards against oversized extracted payloads.

### 9.2 Constraints

- Heuristic path matching means extraction quality depends on filename conventions.
- Regex route parsing is Express-style and may miss framework-specific declarations.
- `auth` detection is line-text heuristic and can produce false positives/negatives.
- Endpoint `method` casing is lowercase in extraction output, unlike some other modules that normalize uppercase methods.

### 9.3 Risks to track

- Drift between this extractor and other contract logic (`quality/contract-validator.ts`) may create inconsistent contract views.
- Lack of dedicated tests increases regression risk for route/type parsing heuristics.

## 10) Recommended Evolution Path

1. Add dedicated unit tests for `src/contract/*` with fixture-driven cases.
2. Normalize method casing policy (`GET` vs `get`) and document it explicitly.
3. Consider optional parser-backed mode (AST) behind a feature flag for higher precision projects.
4. Define integration points where extracted `ApiContract` is consumed by pipeline/review stages in-package.
5. Align route/path normalization conventions with `quality/contract-validator.ts` to avoid divergent semantics.

---

## Quick Reference

- **Primary class:** `ApiExtractor`
- **Input:** `Record<string, string>` (VFS snapshot)
- **Output:** `ApiContract` (`endpoints`, `sharedTypes`, `zodSchemas`)
- **Performance profile:** linear scan over files + regex parsing
- **Current test coverage:** uncovered (needs dedicated tests)

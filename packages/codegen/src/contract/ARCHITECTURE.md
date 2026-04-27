# Contract Extraction Architecture (`packages/codegen/src/contract`)

## Scope
`src/contract` is the package-local API contract extraction surface in `@dzupagent/codegen`.

It is intentionally small and currently consists of:
- `contract-types.ts`: `ApiEndpoint`, `ApiContract`.
- `api-extractor.ts`: `ApiExtractor` class with `extract(vfs)`.

Input is a virtual filesystem snapshot (`Record<string, string>`). Output is a summarized contract object intended for downstream review, prompt context, or lightweight validation flows.

## Responsibilities
- Extract backend route endpoints from route/controller-like files using regex matching.
- Build a compact endpoint record with method, path, auth hint, and description.
- Aggregate schema content from validator/schema files into one string section.
- Aggregate shared type content from type/dto files into one string section.
- Provide fallback type block extraction from service/controller files when no dedicated type files are found.
- Enforce section length limits for prompt/context safety.

This module does not do AST parsing, HTTP semantic validation, or frontend/backend call matching.

## Structure
- `contract-types.ts`
  - `ApiEndpoint`:
    - `method: string`
    - `path: string`
    - `auth: boolean`
    - `description: string`
    - `requestBody?: string`
    - `responseBody?: string`
  - `ApiContract`:
    - `endpoints: ApiEndpoint[]`
    - `sharedTypes: string`
    - `zodSchemas: string`
- `api-extractor.ts`
  - `MAX_SECTION_LENGTH = 6000`
  - `ApiExtractor.extract(vfs: Record<string, string>): ApiContract`
  - Internal regexes:
    - route extraction: `(?:router|app).(get|post|put|patch|delete)(...)`
    - type export fallback detection: `export interface|type ...`

Exports are re-exposed from `src/index.ts`:
- `ApiExtractor`
- `ApiEndpoint`
- `ApiContract`

## Runtime and Control Flow
`ApiExtractor.extract` runs in one pass plus an optional fallback pass:

1. Initialize `endpoints`, `sharedTypes`, `zodSchemas`.
2. Iterate every VFS file (`Object.entries(vfs)`).
3. If path matches route/controller patterns (`.routes.`, `.controller.`, `/routes/`):
   - Parse route calls (`router.get`, `app.post`, etc.).
   - Capture `method` and `path`.
   - Build `description` from preceding `//` comment when present, else default `METHOD path`.
   - Infer `auth` by checking the route line for `auth|authenticate|protect|requireAuth`.
4. If path matches schema patterns (`.validator.`, `.schema.`, `/validators/`, `/schemas/`), append full file content to `zodSchemas` with `// --- <file> ---` headers.
5. If path matches type patterns (`.types.`, `/types/`, `.dto.`), append full file content to `sharedTypes` with `// --- <file> ---` headers.
6. If no type content was captured, run fallback extraction on `.service.` and `.controller.` files:
   - Find `export interface` / `export type`.
   - Attempt to capture a full block via brace counting.
   - Append captured snippets into `sharedTypes`.
7. Truncate `sharedTypes` and `zodSchemas` to `MAX_SECTION_LENGTH` and append `// ... (truncated)` when needed.
8. Return `{ endpoints, sharedTypes, zodSchemas }`.

## Key APIs and Types
- `class ApiExtractor`
  - `extract(vfs: Record<string, string>): ApiContract`
- `interface ApiEndpoint`
- `interface ApiContract`

Important behavior details:
- Endpoint methods are emitted in lowercase (`get`, `post`, etc.) because they come directly from regex capture.
- `requestBody` and `responseBody` exist on `ApiEndpoint` but are not populated by `ApiExtractor` today.
- Extraction relies on file naming/location heuristics plus Express-style route call syntax.

## Dependencies
Direct runtime dependencies in `src/contract` are minimal:
- No external packages are imported in this folder.
- Uses only built-in JS/TS features (`RegExp`, string operations, object iteration).
- Imports local types from `./contract-types.js`.

Package-level dependencies for `@dzupagent/codegen` are defined in `package.json` and include `@dzupagent/core` and `@dzupagent/adapter-types`, but they are not required by the `src/contract` runtime path itself.

## Integration Points
- Public package API: exported from `src/index.ts` and published via `dist/index.js` / `dist/index.d.ts`.
- Package documentation: `packages/codegen/README.md` lists `ApiExtractor` and contract types in the API reference.
- Adjacent contract logic:
  - `src/quality/contract-validator.ts` provides backend/frontend call coherence checks (`extractEndpoints`, `extractAPICalls`, `validateContracts`) and is separate from `ApiExtractor`.
  - `src/guardrails/rules/contract-compliance-rule.ts` validates class/interface implementation completeness and is also separate.

Current local search in `packages/codegen/src` shows no additional runtime consumer of `ApiExtractor` beyond exports and its dedicated test file.

## Testing and Observability
- Dedicated tests exist at `src/__tests__/api-extractor.test.ts`.
- Covered scenarios in that test file:
  - Route extraction for all supported HTTP methods.
  - Auth middleware detection.
  - Comment-based description extraction.
  - Schema/type aggregation path patterns.
  - Fallback type extraction from service files.
  - Truncation behavior for large schema/type sections.
  - Empty VFS and non-route-file behavior.
- Focused local verification run:
  - `yarn test src/__tests__/api-extractor.test.ts`
  - Result: 15 tests passed.

Observability characteristics:
- No logging, tracing, or metrics are emitted by this module.
- Operates as a pure in-memory transformation: `Record<string, string> -> ApiContract`.

## Risks and TODOs
- Regex-based route parsing only recognizes `(router|app).<method>(...)`; alternative frameworks/patterns are out of scope.
- Route detection depends on file naming/path heuristics; valid routes in differently named files are skipped.
- Auth detection is a line-level keyword heuristic and can produce false positives/negatives.
- Method casing differs from `quality/contract-validator.ts` (`lowercase` here vs `uppercase` there), which can cause integration friction if outputs are mixed.
- `requestBody` and `responseBody` fields are declared but currently unused by extractor logic.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


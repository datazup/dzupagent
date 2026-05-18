# Contract Extraction Architecture (`packages/codegen/src/contract`)

## Scope
`src/contract` is a narrow extraction utility inside `@dzupagent/codegen` for deriving backend API contract context from an in-memory file map.

Current module scope is exactly two files:
- `contract-types.ts`
- `api-extractor.ts`

Input contract:
- `Record<string, string>` virtual filesystem snapshot.

Output contract:
- `ApiContract` with endpoint metadata plus concatenated schema/type sections.

## Responsibilities
- Detect Express-style endpoint declarations (`router.*`, `app.*`) from route/controller-shaped files.
- Build `ApiEndpoint` records with `method`, `path`, `auth`, and `description`.
- Collect schema content from validator/schema file patterns.
- Collect shared type content from type/dto file patterns.
- Run a fallback type extraction pass from service/controller files when no direct type files are found.
- Enforce fixed max-length truncation (`MAX_SECTION_LENGTH`) for extracted schema/type text blocks.

Out of scope:
- AST parsing.
- OpenAPI generation.
- Frontend/backend call matching (handled by `src/quality/contract-validator.ts`).
- Runtime logging/telemetry.

## Structure
- `contract-types.ts`
  - `ApiEndpoint`
  - `ApiContract`
- `api-extractor.ts`
  - `const MAX_SECTION_LENGTH = 6000`
  - `class ApiExtractor`
  - `extract(vfs: Record<string, string>): ApiContract`

Export paths:
- Root package export via `src/index.ts`:
  - `export { ApiExtractor } from './contract/api-extractor.js'`
  - `export type { ApiEndpoint, ApiContract } from './contract/contract-types.js'`
- Compatibility export via `src/compat.ts` re-exporting both files.

## Runtime and Control Flow
`ApiExtractor.extract` executes deterministically in-memory:

1. Initialize `endpoints`, `sharedTypes`, and `zodSchemas`.
2. Iterate all `vfs` entries.
3. For files matching route/controller path hints (`.routes.`, `.controller.`, `/routes/`):
   - Run route regex `/(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi`.
   - Capture method/path from each match.
   - Build description from the immediately preceding `//` line when present, otherwise fallback to `METHOD path`.
   - Infer auth via route-line keyword check (`auth|authenticate|protect|requireAuth`).
4. For files matching schema hints (`.validator.`, `.schema.`, `/validators/`, `/schemas/`):
   - Append full file content into `zodSchemas` with file banner comments.
5. For files matching shared-type hints (`.types.`, `/types/`, `.dto.`):
   - Append full file content into `sharedTypes` with file banner comments.
6. If `sharedTypes` is still empty:
   - Scan `.service.` and `.controller.` files for `export interface` / `export type`.
   - Extract text blocks using brace counting and append to `sharedTypes`.
7. Truncate `sharedTypes` and `zodSchemas` to `6000` chars each and append `// ... (truncated)` if needed.
8. Return `ApiContract`.

## Key APIs and Types
- `interface ApiEndpoint`
  - `method: string`
  - `path: string`
  - `auth: boolean`
  - `description: string`
  - `requestBody?: string`
  - `responseBody?: string`
- `interface ApiContract`
  - `endpoints: ApiEndpoint[]`
  - `sharedTypes: string`
  - `zodSchemas: string`
- `class ApiExtractor`
  - `extract(vfs: Record<string, string>): ApiContract`

Behavioral notes:
- Extracted endpoint methods remain lowercase (`get`, `post`, etc.) because regex captures are not normalized.
- `requestBody` and `responseBody` are part of the type surface but are not populated by current extractor logic.

## Dependencies
Direct code dependencies for `src/contract`:
- Local type import: `./contract-types.js`.
- Standard JS/TS primitives only (regex, string slicing, object iteration).

No direct imports from:
- `@dzupagent/core`
- `@dzupagent/adapter-types`
- LangChain packages

Package-level context:
- `@dzupagent/codegen` declares broader dependencies/peers in `package.json`, but `src/contract` does not consume them at runtime.

## Integration Points
- Public API consumption through `@dzupagent/codegen` root export.
- Transitional compatibility consumers can import through `@dzupagent/codegen/compat`.
- README API reference documents `ApiExtractor`, `ApiEndpoint`, and `ApiContract`.
- Adjacent but separate contract-related modules:
  - `src/quality/contract-validator.ts` for endpoint/call coherence validation.
  - `src/guardrails/rules/contract-compliance-rule.ts` for class/interface implementation checks.

Current in-repo usage:
- `ApiExtractor` is referenced by package exports and dedicated tests; no additional internal runtime orchestrator currently invokes it directly.

## Testing and Observability
Tests:
- `src/__tests__/api-extractor.test.ts` covers:
  - Route extraction across supported methods.
  - Auth keyword detection.
  - Comment-based descriptions.
  - Schema/type file collection.
  - Fallback type extraction.
  - Truncation safeguards.
  - Empty and non-matching input behavior.
- Focused check run on current tree:
  - `yarn workspace @dzupagent/codegen test src/__tests__/api-extractor.test.ts`
  - Result: `1` test file passed, `15` tests passed.

Observability:
- No logging, tracing, metrics, or event bus emission in this module.
- Pure function-style behavior from input VFS to returned `ApiContract`.

## Risks and TODOs
- Regex/file-name heuristics can miss valid endpoints or types when projects use different naming/layout conventions.
- Auth detection is keyword-based and may over/under-report protection state.
- Fallback exported-type extraction is brace-counting text logic and can degrade on complex declarations.
- Method case mismatch vs `src/quality/contract-validator.ts` (`lowercase` here vs uppercase there) is an integration footgun when consumers combine both outputs.
- `requestBody` and `responseBody` fields are currently unused and can drift from actual extraction behavior unless implemented or removed.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
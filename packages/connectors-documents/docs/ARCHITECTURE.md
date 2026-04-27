# @dzupagent/connectors-documents Architecture

## Scope
`@dzupagent/connectors-documents` is a focused document-ingestion connector package inside `dzupagent/packages/connectors-documents`.

It covers three concrete concerns:
- Parse document bytes into plain text (`parseDocument` with PDF/DOCX/text/markdown routing).
- Split text into semantic chunks (`splitIntoChunks` and chunking helpers).
- Expose these capabilities as two forge tools (`createDocumentConnector`).

It does not include persistent storage, OCR, remote file fetching, or workflow orchestration.

## Responsibilities
- Maintain an allowlist of supported MIME types and normalization (`SUPPORTED_MIME_TYPES`, `isSupportedDocumentType`).
- Provide format-specific parsing:
  - PDF via `pdf-parse` (`parsePDF`).
  - DOCX via `mammoth` (`parseDOCX`).
  - Plain text/markdown via UTF-8 buffer decoding.
- Provide chunking with staged fallback (headings -> paragraphs -> sentences) and optional overlap.
- Provide tool wrappers for agent/runtime integration:
  - `parse-document`
  - `chunk-document`
- Normalize tool contracts to `BaseConnectorTool` shape (`normalizeDocumentTool`, `normalizeDocumentTools`).

## Structure
Top-level package layout:
- `src/index.ts`: public export surface.
- `src/document-connector.ts`: `createDocumentConnector`, config, tool schemas, output shaping.
- `src/connector-contract.ts`: StructuredTool -> normalized connector-tool bridge.
- `src/parse-document.ts`: MIME-based routing for parse operations.
- `src/supported-types.ts`: allowlist + MIME normalization helper.
- `src/parsers/pdf-parser.ts`: PDF extraction via `PDFParse`.
- `src/parsers/docx-parser.ts`: DOCX extraction via `mammoth.extractRawText`.
- `src/chunking/*`: chunking pipeline primitives.
- `src/__tests__/*`: unit/integration/deep tests for parsing, chunking, tool wrappers, and contract normalization.
- `README.md`: usage and API quick reference.
- `package.json`: package metadata and dependency boundary.

## Runtime and Control Flow
1. Connector creation:
- `createDocumentConnector(config?)` resolves defaults (`maxChunkSize=4000`, `overlap=200`).
- It creates two tools through `createForgeTool` from `@dzupagent/core`.

2. `parse-document` tool flow:
- Input schema: `{ content: string(base64), contentType: string }` (Zod).
- Validates type using `isSupportedDocumentType`.
- Decodes base64 to `Buffer`.
- Calls `parseDocument(buffer, contentType)`.
- Truncates output to `MAX_OUTPUT_LENGTH` (8000 chars) with `\n...[truncated]` suffix when needed.
- Returns either extracted text or `Error: <message>`.

3. `parseDocument` routing:
- Normalizes MIME by stripping parameters and lowercasing.
- Routes to:
  - `parsePDF` for `application/pdf`.
  - `parseDOCX` for DOCX MIME.
  - `buffer.toString('utf-8')` for `text/plain` and `text/markdown`.
- Throws for unsupported types.

4. `chunk-document` tool flow:
- Input schema: `{ text: string, maxChunkSize?: number, overlap?: number }`.
- Resolves runtime chunk size/overlap from input or connector defaults.
- Calls `splitIntoChunks(text, chunkSize, overlapSize)`.
- Serializes chunk array as JSON in `execute`.
- `toModelOutput` returns `<N> chunks created` when output parses as JSON array; otherwise raw text.

5. Chunking pipeline internals (`splitIntoChunks`):
- Empty/whitespace input -> `[]`.
- If whole input fits max size -> single trimmed chunk.
- Otherwise:
  - `splitOnHeadings` (`##` / `###` boundaries),
  - fallback `splitOnParagraphs` for oversized sections,
  - fallback `splitOnSentences` for still-oversized paragraph chunks,
  - optional `addOverlap` with `"\n---\n"` separator.

## Key APIs and Types
Public exports from `src/index.ts`:
- `createDocumentConnector(config?: DocumentConnectorConfig): StructuredToolInterface[]`
- `normalizeDocumentTool(tool): DocumentConnectorTool`
- `normalizeDocumentTools(tools): DocumentConnectorTool[]`
- `parseDocument(buffer: Buffer, contentType: string): Promise<string>`
- `splitIntoChunks(text: string, maxChunkSize?: number, overlapSize?: number): string[]`
- `isSupportedDocumentType(mimeType: string): boolean`
- `SUPPORTED_MIME_TYPES: Set<string>`
- `ChunkOptions` type
- `DocumentConnectorConfig` type
- `DocumentConnectorTool` type alias

Key constants and defaults used in runtime behavior:
- `MAX_OUTPUT_LENGTH = 8000` in `document-connector.ts`
- default chunk config: `maxChunkSize = 4000`, `overlap = 200`
- `MAX_PDF_PAGES = 50` in `pdf-parser.ts`

## Dependencies
Runtime dependencies:
- `@dzupagent/core`: `createForgeTool`, `normalizeBaseConnectorTool`, `BaseConnectorTool` types.
- `mammoth`: DOCX text extraction.
- `pdf-parse`: PDF text extraction (`PDFParse` API).

Peer dependency:
- `zod >=4.0.0` (tool input schemas).

Dev/testing dependencies:
- `vitest`, `typescript`, `tsup`, `@types/pdf-parse`, `zod`.

Build/runtime target:
- ESM package, Node 20 target (`tsup` config), single entry `src/index.ts` -> `dist`.

## Integration Points
- Tool-runtime integration via `createForgeTool` from `@dzupagent/core`.
- Consumer-facing tools are `StructuredToolInterface` compatible and named:
  - `parse-document`
  - `chunk-document`
- Contract normalization via `normalizeDocumentTool(s)` bridges generic structured tools to connector-specific `DocumentConnectorTool` shape.
- In current monorepo source search, runtime usage is concentrated inside this package and tests; README shows expected external consumer usage.

## Testing and Observability
Test setup:
- Framework: Vitest (`yarn workspace @dzupagent/connectors-documents test`).
- Current local run (2026-04-26) passed:
  - 11 test files
  - 164 tests
  - 0 failures

Covered areas include:
- MIME normalization and support checks.
- Parser success/failure paths (PDF/DOCX/text/markdown).
- Chunking primitives and pipeline behavior.
- Tool behavior (output truncation, error wrapping, model output formatting).
- Contract normalization behavior.
- End-to-end parse->chunk connector paths.

Observability notes:
- No dedicated telemetry, metrics, or tracing hooks are implemented in this package.
- Operational visibility is currently test-based and caller-managed (errors returned as strings in tool layer).

## Risks and TODOs
- `parse-document` truncates content at 8000 chars, which protects downstream context but can hide tail content of large documents.
- `chunk-document` returns only a summary string (`<N> chunks created`) to model output; consumers needing actual chunk payloads must rely on execution-layer output handling rather than model-facing text.
- PDF extraction depends on embedded text (`pdf-parse`) and does not provide OCR for image-only scans.
- MIME allowlist is intentionally narrow (PDF, DOCX, text/markdown); adding formats requires parser implementation and allowlist updates.
- No package-level runtime telemetry exists yet for parse latency, failure rates, or chunking volume.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


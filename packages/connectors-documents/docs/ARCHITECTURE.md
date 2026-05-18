# @dzupagent/connectors-documents Architecture

## Scope
`@dzupagent/connectors-documents` is a document ingestion package in `packages/connectors-documents` that converts supported document bytes into text and optionally splits that text into LLM-friendly chunks.

Current in-scope capabilities are:
- MIME-type gating and normalization for a fixed allowlist.
- Parsing of PDF, DOCX, Markdown, and plain text payloads.
- Chunking pipeline utilities (`headings -> paragraphs -> sentences`) with optional overlap.
- Packaging of parsing/chunking as two forge tools (`parse-document`, `chunk-document`).
- Tool contract normalization helpers for connector consumers.

Out of scope in the current code:
- OCR and image-to-text extraction.
- Remote file fetching/storage and ingestion orchestration.
- Embedding generation, vector storage, or retrieval workflows.
- OTEL or third-party tracing dependencies.

## Responsibilities
- Expose a stable package entrypoint (`src/index.ts`) for connector tools and low-level helpers.
- Validate supported MIME types via `SUPPORTED_MIME_TYPES` and `isSupportedDocumentType`.
- Route parsing by normalized MIME type in `parseDocument`.
- Parse PDF with `pdf-parse` (`PDFParse`) and DOCX with `mammoth.extractRawText`.
- Chunk large text with deterministic fallback stages and overlap injection.
- Wrap tools with `createForgeTool` and convert generic `StructuredToolInterface` into `DocumentConnectorTool` using `normalizeDocumentTool(s)`.

## Structure
- `src/index.ts`: Public exports for connector factory, parser/chunker helpers, MIME utilities, and types.
- `src/document-connector.ts`: `DocumentConnectorConfig`, `createDocumentConnector`, tool schemas, output truncation, model-output formatting.
- `src/parse-document.ts`: MIME normalization and switch-based parser dispatch.
- `src/supported-types.ts`: `SUPPORTED_MIME_TYPES` set and type-check helper.
- `src/parsers/pdf-parser.ts`: `parsePDF` with `MAX_PDF_PAGES = 50` limit passed to `PDFParse#getText`.
- `src/parsers/docx-parser.ts`: `parseDOCX` using `mammoth`.
- `src/chunking/heading-chunker.ts`: Heading split on markdown `##` and `###` boundaries.
- `src/chunking/paragraph-chunker.ts`: Paragraph merge/split based on max-size envelope.
- `src/chunking/sentence-chunker.ts`: Sentence-boundary split fallback.
- `src/chunking/overlap.ts`: Context overlap insertion with `\n---\n` separator.
- `src/chunking/split-into-chunks.ts`: Orchestrates chunking pipeline and defaults.
- `src/connector-contract.ts`: `DocumentConnectorTool` alias and normalization helpers.
- `src/validation.ts`: Boundary validation for MIME/chunk/parser limits and optional parse/chunk telemetry wrapper.
- `src/__tests__/*.test.ts`: Unit, integration, and deep behavior tests.
- `README.md`: Usage examples and feature summary.

## Runtime and Control Flow
1. Connector creation:
- `createDocumentConnector(config)` resolves defaults (`maxChunkSize = 4000`, `overlap = 200`).
- Validates connector chunk defaults (`maxChunkSize > 0`, finite integer, `<= 20000`; `overlap < maxChunkSize`).
- Returns two `StructuredToolInterface` instances via `createForgeTool`.

2. Parse tool (`parse-document`) flow:
- Accepts `{ content: base64 string, contentType: string }`.
- Validates MIME allowlist and parser size limits (`maxDocumentBytes` default: 10 MiB) before parsing.
- Decodes base64 into a `Buffer`.
- Calls `parseDocument(buffer, contentType)`.
- Truncates successful output at `MAX_OUTPUT_LENGTH = 8000` chars with `\n...[truncated]` suffix.
- Emits optional telemetry callback events with `{ operation, durationMs, success, error? }`.
- Throws parse errors after telemetry emission.

3. `parseDocument` dispatch:
- Normalizes MIME (`split(';')[0]`, trim, lowercase).
- Routes `application/pdf` to `parsePDF`.
- Routes DOCX MIME to `parseDOCX`.
- Routes `text/markdown` and `text/plain` to `buffer.toString('utf-8')`.
- Throws `Unsupported document type: ...` for all other values.

4. Chunk tool (`chunk-document`) flow:
- Accepts `{ text, maxChunkSize?, overlap? }`.
- Resolves runtime values from input or connector defaults.
- Validates `maxChunkSize` and `overlap` before chunking starts.
- Calls `splitIntoChunks`.
- `execute` returns JSON-stringified chunk arrays.
- `toModelOutput` attempts `JSON.parse`; if successful returns `"<N> chunks created"`, otherwise raw text.
- Emits optional telemetry callback events with `{ operation, durationMs, success, error? }`.

5. Chunking pipeline behavior:
- Empty or whitespace text returns `[]`.
- Text within `maxChunkSize` returns a single trimmed chunk.
- Oversized text is split by headings, then paragraphs, then sentences as needed.
- If `overlapSize > 0` and multiple chunks exist, overlap from prior chunk tail is prepended with `\n---\n`.

## Key APIs and Types
- `createDocumentConnector(config?: DocumentConnectorConfig): StructuredToolInterface[]`
- `normalizeDocumentTool(tool): DocumentConnectorTool`
- `normalizeDocumentTools(tools): DocumentConnectorTool[]`
- `parseDocument(buffer: Buffer, contentType: string): Promise<string>`
- `splitIntoChunks(text: string, maxChunkSize?: number, overlapSize?: number): string[]`
- `isSupportedDocumentType(mimeType: string): boolean`
- `SUPPORTED_MIME_TYPES: Set<string>`
- `DocumentConnectorConfig` with `maxChunkSize?: number`, `overlap?: number`, `maxDocumentBytes?: number`, and `telemetryCallback?: (event) => void`.
- `ChunkOptions` with `maxChunkSize?: number`, `overlapSize?: number`.
- `DocumentConnectorTool<Input, Output>` as alias to `BaseConnectorTool<Input, Output>`.

## Dependencies
- Runtime: `@dzupagent/core`, `pdf-parse`, `mammoth`.
- Peer: `zod >=4.0.0`.
- Dev: `vitest`, `typescript`, `tsup`, `@types/pdf-parse`, `zod`.
- Build/package shape: ESM output (`type: module`), single entry `src/index.ts`, declarations in `dist/index.d.ts`, `tsup` target `node20`, `@dzupagent/*` marked external.

## Integration Points
- Tooling surface: `parse-document` for document bytes -> text, `chunk-document` for text -> chunk summary.
- Core bridge: `createForgeTool` for tool construction in DzupAgent runtime.
- Contract bridge: `normalizeDocumentTool(s)` for converting `StructuredToolInterface` to normalized connector-tool shape.
- Consumer usage: direct helper calls (`parseDocument`, `splitIntoChunks`) or connector-tool usage via `createDocumentConnector`.

## Testing and Observability
- Test framework: Vitest (`yarn workspace @dzupagent/connectors-documents test`).
- Latest local run in this workspace:
- `11` test files passed.
- `165` tests passed.
- `0` failures.
- Coverage focus:
- MIME support and normalization.
- Parser dispatch and error propagation for PDF/DOCX/plain/markdown.
- PDF/DOCX no-extractable-text failures.
- Chunking primitives and overlap boundaries.
- Tool-level truncation, error wrapping, `toModelOutput` behavior.
- Contract normalization behavior.
- End-to-end parse->chunk integration scenarios.
- Observability status:
- Optional in-process telemetry callback is available for parse/chunk duration and failures.
- No hard dependency on OTEL or external telemetry libraries.

## Risks and TODOs
- Output truncation in `parse-document` (8000 chars) can hide tail content of long documents.
- `chunk-document` model output is a summary string, not raw chunks; callers must capture execution output when chunk payloads are needed downstream.
- PDF parsing depends on embedded text and does not cover OCR/image-only PDFs.
- Heading splitting recognizes only markdown `##` and `###`; `#` headings are not split boundaries.
- MIME support is intentionally narrow (4 types); new formats require allowlist and parser changes.
- Parser byte limits are coarse (global 10 MiB default); per-format tuning may be needed for large documents.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

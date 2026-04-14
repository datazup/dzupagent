# @dzupagent/connectors-documents Architecture

This document describes the current implementation of `packages/connectors-documents` as of April 4, 2026.

## 1) Package Purpose

`@dzupagent/connectors-documents` provides a focused ingestion layer for document content:

1. Parse supported document formats into plain text.
2. Chunk text into LLM-friendly segments with semantic boundaries and overlap.
3. Expose both capabilities as LangChain-compatible tools via `createDocumentConnector`.

Primary source entrypoint: `src/index.ts`.

## 2) Public API Surface

The package exports:

- `createDocumentConnector(config?)`
- `normalizeDocumentTool(tool)`
- `normalizeDocumentTools(tools)`
- `parseDocument(buffer, contentType)`
- `splitIntoChunks(text, maxChunkSize?, overlapSize?)`
- `isSupportedDocumentType(mimeType)`
- `SUPPORTED_MIME_TYPES`
- type `ChunkOptions`
- type `DocumentConnectorConfig`
- type `DocumentConnectorTool`

Source: `src/index.ts`.

## 3) High-Level Architecture

Implementation is split into four layers.

1. Tool adapter layer:
- `src/document-connector.ts`
- Builds two tools (`parse-document`, `chunk-document`) using `createForgeTool` from `@dzupagent/agent`.
- Validates input shape using Zod schemas.
- Converts runtime errors into tool-safe string responses.

2. Format routing and parsing:
- `src/parse-document.ts`
- `src/parsers/pdf-parser.ts`
- `src/parsers/docx-parser.ts`
- Routes by normalized MIME type and delegates to concrete parsers.

3. Chunking pipeline:
- `src/chunking/split-into-chunks.ts`
- `src/chunking/heading-chunker.ts`
- `src/chunking/paragraph-chunker.ts`
- `src/chunking/sentence-chunker.ts`
- `src/chunking/overlap.ts`
- Applies a staged semantic split strategy, then optional overlap.

4. Contract normalization:
- `src/connector-contract.ts`
- Wraps LangChain `StructuredToolInterface` into a stable `DocumentConnectorTool` shape.

## 4) Feature Breakdown

### 4.1 MIME-Type Gating and Normalization

`SUPPORTED_MIME_TYPES` currently includes:

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `text/markdown`
- `text/plain`

`isSupportedDocumentType` normalizes case, whitespace, and MIME parameters (for example `text/plain; charset=utf-8`) before lookup.

### 4.2 Document Parsing

`parseDocument(buffer, contentType)` behavior:

1. Normalizes the incoming content type.
2. Routes:
- PDF -> `parsePDF` (`pdf-parse`, first 50 pages)
- DOCX -> `parseDOCX` (`mammoth.extractRawText`)
- Markdown/plain text -> UTF-8 decode of buffer
3. Throws explicit error for unsupported types.

Parser safeguards:

- PDF: throws when no extractable text (image-only/empty docs).
- DOCX: throws when extracted value is empty/whitespace.

### 4.3 Connector Tooling (`createDocumentConnector`)

The factory returns exactly two tools:

1. `parse-document`
- Input: `{ content: base64, contentType: string }`
- Output: extracted text or `Error: ...` string
- Enforces supported MIME allowlist
- Truncates text output to `MAX_OUTPUT_LENGTH = 8000` chars to reduce context overflow risk

2. `chunk-document`
- Input: `{ text: string, maxChunkSize?: number, overlap?: number }`
- Output: model-facing summary string (`"<N> chunks created"`) via `toModelOutput`
- Internal execution serializes full chunk array as JSON string before model formatting

Default config:

- `maxChunkSize`: `4000`
- `overlap`: `200`

### 4.4 Semantic Chunking Strategy

`splitIntoChunks` uses a staged fallback strategy:

1. Split by markdown section headings (`##`, `###`).
2. Oversized section -> split by paragraph boundaries (`\n\n+`), merging where size allows.
3. Still oversized -> split by sentence boundaries (`(?<=[.!?])\s+`).
4. Optionally prepend overlap from previous chunk with separator:
- `"<last overlap chars>\n---\n<current chunk>"`

Edge handling:

- Empty/whitespace text -> `[]`
- Text shorter than `maxChunkSize` -> single trimmed chunk
- Single sentence longer than limit -> kept as-is

## 5) Runtime Flow

### 5.1 Parse Tool Flow

```text
Agent/Caller
  -> parse-document.invoke({content(base64), contentType})
     -> MIME normalization + allowlist check
     -> base64 decode -> Buffer
     -> parseDocument(buffer, contentType)
        -> route by normalized MIME
           -> parsePDF | parseDOCX | utf-8 decode
     -> truncate to 8000 chars
     -> return text (or "Error: ...")
```

### 5.2 Chunk Tool Flow

```text
Agent/Caller
  -> chunk-document.invoke({text, maxChunkSize?, overlap?})
     -> resolve defaults/config overrides
     -> splitIntoChunks(text, chunkSize, overlap)
        -> headings -> paragraphs -> sentences -> overlap
     -> JSON.stringify(chunks)
     -> toModelOutput => "<N> chunks created"
```

### 5.3 Direct Utility Flow (No Tool Wrapper)

```text
Buffer + MIME -> parseDocument -> text
text -> splitIntoChunks -> string[]
```

## 6) Usage Examples

### 6.1 Use as Agent Tools

```ts
import { DzupAgent } from '@dzupagent/agent'
import { createDocumentConnector } from '@dzupagent/connectors-documents'

const documentTools = createDocumentConnector({
  maxChunkSize: 3500,
  overlap: 150,
})

const agent = new DzupAgent({
  model: 'gpt-4o',
  tools: [...documentTools],
})
```

### 6.2 Use Helpers Directly

```ts
import { parseDocument, splitIntoChunks } from '@dzupagent/connectors-documents'

const text = await parseDocument(fileBuffer, 'application/pdf')
const chunks = splitIntoChunks(text, 3000, 120)
```

### 6.3 Normalize for a Uniform Contract

```ts
import {
  createDocumentConnector,
  normalizeDocumentTools,
} from '@dzupagent/connectors-documents'

const tools = createDocumentConnector()
const normalized = normalizeDocumentTools(tools)

// normalized[i] has { id, name, description, schema, invoke(...) }
```

### 6.4 MIME Pre-Validation

```ts
import { isSupportedDocumentType } from '@dzupagent/connectors-documents'

if (!isSupportedDocumentType(upload.mimeType)) {
  throw new Error('Unsupported upload type')
}
```

## 7) Cross-Package References and Adoption

### 7.1 Hard Dependency Boundary

This package depends on `@dzupagent/agent` only for `createForgeTool` (tool construction and LangChain compatibility). It does not depend on `@dzupagent/connectors`.

### 7.2 Current Runtime Consumers in Monorepo

As of April 4, 2026, repository-wide search shows:

- No direct imports of `@dzupagent/connectors-documents` from other `packages/*` modules.
- No runtime references to tool IDs `parse-document` or `chunk-document` outside this package.

Current references outside this package are mainly documentation/tracking notes (for example under `improvements/`) and not runtime wiring.

Implication:

- The package is production-ready as a standalone connector module, but currently has no in-repo package-level integration call sites beyond its own tests and README examples.

## 8) Test Coverage and Validation Status

Executed on April 4, 2026:

- `yarn -s workspace @dzupagent/connectors-documents test`
- `yarn -s workspace @dzupagent/connectors-documents vitest run --coverage`

Results:

- Test files: `7`
- Tests: `71` passed, `0` failed

Coverage (V8):

- Statements: `96.54%`
- Branches: `83.54%`
- Functions: `100%`
- Lines: `96.54%`

Per-area highlights:

- `src/parsers/*`: `100%` statements/branches/functions/lines
- `src/chunking/*`: `100%` statements/lines, `95.12%` branches
- `src/document-connector.ts`: `92.3%` statements/lines, `60%` branches
- `src/parse-document.ts`: `90%` statements/lines, `33.33%` branches

Interpretation:

- Core parser and chunking behavior is strongly covered.
- Lower branch coverage is concentrated in fallback/error branches of routing and connector output formatting.

## 9) Known Constraints and Practical Notes

1. Heading-aware splitting is tuned to markdown `##`/`###`; H1-only docs rely on paragraph/sentence fallback.
2. `parse-document` truncates to 8000 chars, which protects context budgets but may omit tail content for large files.
3. PDF extraction is limited to first 50 pages.
4. Tool interfaces return string outputs for model compatibility; callers needing full chunk arrays should use direct helpers or parse internal JSON output before `toModelOutput`.

## 10) Suggested Extension Points

1. Add optional OCR path for image-only PDFs.
2. Add richer chunk metadata (section title, offsets, token estimates).
3. Support additional MIME types (`text/html`, `text/csv`, `application/rtf`) behind explicit config flags.
4. Increase branch coverage in `document-connector.ts` and `parse-document.ts` for rare error/reporting paths.


# @dzipagent/connectors-documents

Document connector for DzipAgent. This package provides tools to parse various document formats and split them into semantic chunks for LLM processing.

## Installation

```bash
yarn add @dzipagent/connectors-documents @dzipagent/agent zod
```

## Features

- **Document Parsing**: Extract text from PDF, DOCX, Markdown, and plain text files.
- **Semantic Chunking**: Split text into chunks while respecting paragraph and heading boundaries.
- **Forge Tools**: Easily integrate with DzipAgent using `createDocumentConnector`.

## Supported MIME Types

- `application/pdf` (PDF)
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX)
- `text/markdown` (Markdown)
- `text/plain` (Plain text)

## Usage

### Using as DzipAgent Tools

The `createDocumentConnector` function returns an array of LangChain-compatible tools that can be passed to a DzipAgent.

```typescript
import { DzipAgent } from '@dzipagent/agent';
import { createDocumentConnector } from '@dzipagent/connectors-documents';

const documentTools = createDocumentConnector({
  maxChunkSize: 4000,
  overlap: 200
});

const agent = new DzipAgent({
  model: 'gpt-4o',
  tools: [...documentTools],
  // ... other config
});
```

The connector provides two tools to the agent:
1. `parse-document`: Extracts text from a base64-encoded document.
2. `chunk-document`: Splits plain text into manageable chunks.

### Direct Usage

You can also use the parsing and chunking utilities directly:

```typescript
import { parseDocument, splitIntoChunks } from '@dzipagent/connectors-documents';

// Parse a PDF buffer
const buffer = Buffer.from('...'); // PDF content
const text = await parseDocument(buffer, 'application/pdf');

// Split text into chunks
const chunks = splitIntoChunks(text, 4000, 200);
```

## API

### `createDocumentConnector(config?: DocumentConnectorConfig)`

Creates the document tools for DzipAgent.

- `config.maxChunkSize`: Maximum characters per chunk (default: 4000).
- `config.overlap`: Character overlap between chunks (default: 200).

### `parseDocument(buffer: Buffer, contentType: string)`

Low-level utility to extract text from a document buffer based on its MIME type.

### `splitIntoChunks(text: string, maxChunkSize: number, overlap: number)`

Splits text into an array of strings (chunks).

/**
 * Document connector — wraps document parsing utilities as LangChain-compatible
 * tools via createForgeTool from @dzupagent/core.
 */

import { createForgeTool } from '@dzupagent/core/tools'
import { z } from 'zod'
import { parseDocument } from './parse-document.js'
import { splitIntoChunks } from './chunking/split-into-chunks.js'
import {
  DEFAULT_MAX_CHUNK_SIZE,
  DEFAULT_OVERLAP_SIZE,
  type DocumentConnectorTelemetryCallback,
  type DocumentConnectorTelemetryEvent,
  validateChunkConfig,
  validateParseBoundary,
  withConnectorTelemetry,
} from './validation.js'
import type { StructuredToolInterface } from '@langchain/core/tools'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters returned from parse results to prevent context overflow. */
const MAX_OUTPUT_LENGTH = 8000

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DocumentConnectorConfig {
  /** Maximum characters per chunk (default: 4000) */
  maxChunkSize?: number
  /** Character overlap between chunks (default: 200) */
  overlap?: number
  /** Maximum accepted decoded document payload in bytes (default: 10 MiB) */
  maxDocumentBytes?: number
  /** Optional callback for parse/chunk timing and failure events */
  telemetryCallback?: DocumentConnectorTelemetryCallback
}

type DocumentToolFactory = (config: {
  id: string
  description: string
  inputSchema: unknown
  execute: (input: unknown) => Promise<unknown>
  toModelOutput?: (output: unknown) => string
}) => ReturnType<typeof createForgeTool>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to `maxLength` characters, appending a truncation notice
 * if the string exceeds the limit.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength) + '\n...[truncated]'
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Create an array of LangChain-compatible document tools.
 *
 * Returns two tools:
 * 1. `parse-document` — parse a base64-encoded document into plain text
 * 2. `chunk-document` — split plain text into semantic chunks
 */
export function createDocumentConnector(
  config: DocumentConnectorConfig = {},
): StructuredToolInterface[] {
  const createDocumentTool = createForgeTool as unknown as DocumentToolFactory

  const defaultMaxChunkSize = config.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE
  const defaultOverlap = config.overlap ?? DEFAULT_OVERLAP_SIZE
  validateChunkConfig(defaultMaxChunkSize, defaultOverlap)

  const emitTelemetry = (event: DocumentConnectorTelemetryEvent): void => {
    config.telemetryCallback?.(event)
  }

  // -------------------------------------------------------------------------
  // Tool 1: parseDocumentTool
  // -------------------------------------------------------------------------

  const parseDocumentTool = createDocumentTool({
    id: 'parse-document',
    description:
      'Parse a document (PDF, DOCX, Markdown, or plain text) and extract its text content',
    inputSchema: z.object({
      content: z.string().describe('Base64-encoded document content'),
      contentType: z
        .string()
        .describe(
          'MIME type, e.g. application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
    }),
    execute: async (rawInput: unknown): Promise<unknown> => {
      const input = rawInput as { content: string; contentType: string }
      return withConnectorTelemetry('parse', emitTelemetry, async () => {
        const buffer = Buffer.from(input.content, 'base64')
        validateParseBoundary(input.contentType, buffer, config.maxDocumentBytes)
        const text = await parseDocument(buffer, input.contentType)
        return truncate(text, MAX_OUTPUT_LENGTH)
      })
    },
    toModelOutput: (output: unknown): string => typeof output === 'string' ? output : String(output),
  })

  // -------------------------------------------------------------------------
  // Tool 2: chunkDocumentTool
  // -------------------------------------------------------------------------

  const chunkDocumentTool = createDocumentTool({
    id: 'chunk-document',
    description:
      'Split text into semantic chunks suitable for LLM processing, respecting heading and paragraph boundaries',
    inputSchema: z.object({
      text: z.string().describe('Plain text to chunk'),
      maxChunkSize: z
        .number()
        .optional()
        .describe('Maximum characters per chunk'),
      overlap: z
        .number()
        .optional()
        .describe('Character overlap between chunks'),
    }),
    execute: async (rawInput: unknown): Promise<unknown> => {
      const input = rawInput as { text: string; maxChunkSize?: number; overlap?: number }
      return withConnectorTelemetry('chunk', emitTelemetry, async () => {
        const chunkSize = input.maxChunkSize ?? defaultMaxChunkSize
        const overlapSize = input.overlap ?? defaultOverlap
        validateChunkConfig(chunkSize, overlapSize)

        const chunks = splitIntoChunks(input.text, chunkSize, overlapSize)
        return JSON.stringify(chunks, null, 2)
      })
    },
    toModelOutput: (output: unknown): string => {
      const text = typeof output === 'string' ? output : String(output)
      try {
        const chunks: unknown[] = JSON.parse(text) as unknown[]
        return `${String(chunks.length)} chunks created`
      } catch {
        return text
      }
    },
  })

  return [parseDocumentTool, chunkDocumentTool]
}

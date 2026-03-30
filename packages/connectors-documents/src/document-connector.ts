/**
 * Document connector — wraps document parsing utilities as LangChain-compatible
 * tools via createForgeTool from @dzipagent/agent.
 */

import { createForgeTool } from '@dzipagent/agent'
import { z } from 'zod'
import { parseDocument } from './parse-document.js'
import { splitIntoChunks } from './chunking/split-into-chunks.js'
import { isSupportedDocumentType, SUPPORTED_MIME_TYPES } from './supported-types.js'
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
}

type DocumentToolFactory = (config: {
  id: string
  description: string
  inputSchema: unknown
  execute: (input: any) => Promise<any>
  toModelOutput?: (output: any) => string
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

  const defaultMaxChunkSize = config.maxChunkSize ?? 4000
  const defaultOverlap = config.overlap ?? 200

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
    execute: async (input: {
      content: string
      contentType: string
    }): Promise<string> => {
      try {
        if (!isSupportedDocumentType(input.contentType)) {
          const supported = [...SUPPORTED_MIME_TYPES].join(', ')
          return `Error: Unsupported document type "${input.contentType}". Supported types: ${supported}`
        }

        const buffer = Buffer.from(input.content, 'base64')
        const text = await parseDocument(buffer, input.contentType)
        return truncate(text, MAX_OUTPUT_LENGTH)
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error parsing document'
        return `Error: ${message}`
      }
    },
    toModelOutput: (output: string): string => output,
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
    execute: async (input: {
      text: string
      maxChunkSize?: number
      overlap?: number
    }): Promise<string> => {
      try {
        const chunkSize = input.maxChunkSize ?? defaultMaxChunkSize
        const overlapSize = input.overlap ?? defaultOverlap

        const chunks = splitIntoChunks(input.text, chunkSize, overlapSize)
        return JSON.stringify(chunks, null, 2)
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error chunking text'
        return `Error: ${message}`
      }
    },
    toModelOutput: (output: string): string => {
      try {
        const chunks: unknown[] = JSON.parse(output) as unknown[]
        return `${String(chunks.length)} chunks created`
      } catch {
        return output
      }
    },
  })

  return [parseDocumentTool, chunkDocumentTool]
}

import { SUPPORTED_MIME_TYPES, isSupportedDocumentType } from './supported-types.js'

export const DEFAULT_MAX_CHUNK_SIZE = 4000
export const DEFAULT_OVERLAP_SIZE = 200
export const MAX_CHUNK_SIZE_LIMIT = 20000
export const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

const PARSER_MAX_BYTES_BY_MIME: Readonly<Record<string, number>> = {
  'application/pdf': DEFAULT_MAX_DOCUMENT_BYTES,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': DEFAULT_MAX_DOCUMENT_BYTES,
  'text/markdown': DEFAULT_MAX_DOCUMENT_BYTES,
  'text/plain': DEFAULT_MAX_DOCUMENT_BYTES,
}

export type DocumentConnectorOperation = 'parse' | 'chunk'

export interface DocumentConnectorTelemetryEvent {
  operation: DocumentConnectorOperation
  durationMs: number
  success: boolean
  error?: Error
}

export type DocumentConnectorTelemetryCallback = (
  event: DocumentConnectorTelemetryEvent,
) => void

function normalizeMimeType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? ''
}

function formatSupportedMimeTypes(): string {
  return [...SUPPORTED_MIME_TYPES].join(', ')
}

function ensureFinitePositiveInteger(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite integer.`)
  }
}

export function validateChunkConfig(maxChunkSize: number, overlap: number): void {
  ensureFinitePositiveInteger(maxChunkSize, 'maxChunkSize')

  if (maxChunkSize > MAX_CHUNK_SIZE_LIMIT) {
    throw new Error(
      `maxChunkSize must be less than or equal to ${String(MAX_CHUNK_SIZE_LIMIT)}.`,
    )
  }

  if (!Number.isFinite(overlap) || Number.isNaN(overlap) || !Number.isInteger(overlap) || overlap < 0) {
    throw new Error('overlap must be a finite non-negative integer.')
  }

  if (overlap >= maxChunkSize) {
    throw new Error('overlap must be less than maxChunkSize.')
  }
}

function resolveMaxDocumentBytes(
  normalizedMimeType: string,
  configuredMaxDocumentBytes?: number,
): number {
  if (configuredMaxDocumentBytes !== undefined) {
    ensureFinitePositiveInteger(configuredMaxDocumentBytes, 'maxDocumentBytes')
    return configuredMaxDocumentBytes
  }

  const limit = PARSER_MAX_BYTES_BY_MIME[normalizedMimeType] ?? DEFAULT_MAX_DOCUMENT_BYTES
  ensureFinitePositiveInteger(limit, 'maxDocumentBytes')
  return limit
}

export function validateParseBoundary(
  contentType: string,
  encodedBuffer: Buffer,
  maxDocumentBytes?: number,
): void {
  const normalizedType = normalizeMimeType(contentType)

  if (!isSupportedDocumentType(normalizedType)) {
    throw new Error(
      `Unsupported document type "${contentType}". Supported types: ${formatSupportedMimeTypes()}`,
    )
  }

  const byteLimit = resolveMaxDocumentBytes(normalizedType, maxDocumentBytes)

  if (encodedBuffer.byteLength > byteLimit) {
    throw new Error(
      `Document payload exceeds parser size limit for ${normalizedType}: ${String(encodedBuffer.byteLength)} bytes > ${String(byteLimit)} bytes.`,
    )
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export async function withConnectorTelemetry<T>(
  operation: DocumentConnectorOperation,
  callback: DocumentConnectorTelemetryCallback | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const startMs = Date.now()

  try {
    const result = await run()
    callback?.({
      operation,
      durationMs: Date.now() - startMs,
      success: true,
    })
    return result
  } catch (error: unknown) {
    const normalizedError = toError(error)
    callback?.({
      operation,
      durationMs: Date.now() - startMs,
      success: false,
      error: normalizedError,
    })
    throw normalizedError
  }
}

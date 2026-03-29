export const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
])

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
}

export function isSupportedDocumentType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.has(normalizeMimeType(mimeType))
}

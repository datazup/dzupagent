export {
  createDocumentConnector,
  type DocumentConnectorConfig,
} from './document-connector.js'
export {
  normalizeDocumentTool,
  normalizeDocumentTools,
  type DocumentConnectorTool,
} from './connector-contract.js'

export {
  parseDocument,
} from './parse-document.js'

export {
  splitIntoChunks,
} from './chunking/split-into-chunks.js'

export {
  isSupportedDocumentType,
  SUPPORTED_MIME_TYPES,
} from './supported-types.js'

export {
  DEFAULT_MAX_CHUNK_SIZE,
  DEFAULT_OVERLAP_SIZE,
  MAX_CHUNK_SIZE_LIMIT,
  DEFAULT_MAX_DOCUMENT_BYTES,
  type DocumentConnectorTelemetryEvent,
  type DocumentConnectorTelemetryCallback,
} from './validation.js'

export type { ChunkOptions } from './types.js'

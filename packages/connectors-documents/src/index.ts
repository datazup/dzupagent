export {
  createDocumentConnector,
  type DocumentConnectorConfig,
} from './document-connector.js'

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

export type { ChunkOptions } from './types.js'

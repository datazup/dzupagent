/**
 * Golden traces contain provider output and workspace diffs, so their byte
 * ceilings are deliberately larger than ordinary run-input envelopes. The
 * structural ceilings match the repository's bounded JSON conventions while
 * the depth ceiling is the deepest container path in the current exact schema.
 */
export const GOLDEN_TRACE_MAX_STRING_BYTES = 1_048_576;
export const GOLDEN_TRACE_MAX_COLLECTION_ITEMS = 512;
export const GOLDEN_TRACE_MAX_DEPTH = 8;
export const GOLDEN_TRACE_MAX_TOTAL_NODES = 4_096;
export const GOLDEN_TRACE_MAX_ENCODED_BYTES = 8 * 1_048_576;

export interface GoldenTraceDecodeLimits {
  readonly maxStringBytes: number;
  readonly maxCollectionItems: number;
  readonly maxDepth: number;
  readonly maxTotalNodes: number;
  readonly maxEncodedBytes: number;
}

export const GOLDEN_TRACE_DECODE_LIMITS: Readonly<GoldenTraceDecodeLimits> =
  Object.freeze({
    maxStringBytes: GOLDEN_TRACE_MAX_STRING_BYTES,
    maxCollectionItems: GOLDEN_TRACE_MAX_COLLECTION_ITEMS,
    maxDepth: GOLDEN_TRACE_MAX_DEPTH,
    maxTotalNodes: GOLDEN_TRACE_MAX_TOTAL_NODES,
    maxEncodedBytes: GOLDEN_TRACE_MAX_ENCODED_BYTES,
  });

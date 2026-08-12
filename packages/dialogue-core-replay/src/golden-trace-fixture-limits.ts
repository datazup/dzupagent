export const GOLDEN_TRACE_FIXTURE_MAX_MANIFEST_BYTES = 64 * 1_024;
export const GOLDEN_TRACE_FIXTURE_MAX_FILES = 1;
export const GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES = 8 * 1_048_576;
export const GOLDEN_TRACE_FIXTURE_MAX_AGGREGATE_BYTES = 8 * 1_048_576;
export const GOLDEN_TRACE_FIXTURE_MAX_METADATA_STRING_BYTES = 512;
export const GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES = 255;
export const GOLDEN_TRACE_FIXTURE_MAX_DEPTH = 2;
export const GOLDEN_TRACE_FIXTURE_MAX_TOTAL_NODES = 128;
export const GOLDEN_TRACE_FIXTURE_MAX_DIAGNOSTIC_BYTES = 256;

export interface GoldenTraceFixtureDecodeLimits {
  readonly maxManifestBytes: number;
  readonly maxFiles: number;
  readonly maxPayloadBytes: number;
  readonly maxAggregateBytes: number;
  readonly maxMetadataStringBytes: number;
  readonly maxPathBytes: number;
  readonly maxDepth: number;
  readonly maxTotalNodes: number;
  readonly maxDiagnosticBytes: number;
}

export const GOLDEN_TRACE_FIXTURE_DECODE_LIMITS: Readonly<GoldenTraceFixtureDecodeLimits> =
  Object.freeze({
    maxManifestBytes: GOLDEN_TRACE_FIXTURE_MAX_MANIFEST_BYTES,
    maxFiles: GOLDEN_TRACE_FIXTURE_MAX_FILES,
    maxPayloadBytes: GOLDEN_TRACE_FIXTURE_MAX_PAYLOAD_BYTES,
    maxAggregateBytes: GOLDEN_TRACE_FIXTURE_MAX_AGGREGATE_BYTES,
    maxMetadataStringBytes: GOLDEN_TRACE_FIXTURE_MAX_METADATA_STRING_BYTES,
    maxPathBytes: GOLDEN_TRACE_FIXTURE_MAX_PATH_BYTES,
    maxDepth: GOLDEN_TRACE_FIXTURE_MAX_DEPTH,
    maxTotalNodes: GOLDEN_TRACE_FIXTURE_MAX_TOTAL_NODES,
    maxDiagnosticBytes: GOLDEN_TRACE_FIXTURE_MAX_DIAGNOSTIC_BYTES,
  });

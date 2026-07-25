import type { PrimitiveDefinitionV2 } from "../primitives/types.js";

export const V2_SOURCE_LINEAGE_META_KEY = "__dzupV2SourceLineage";

export interface V2SourceLineageMarker {
  readonly authoredPath: string;
  readonly loweredPath: string;
  readonly use: string;
  readonly generated: boolean;
  readonly primitiveRef?: PrimitiveDefinitionV2["ref"];
  readonly primitiveSemanticHash?: `sha256:${string}`;
  readonly saveBindings?: Readonly<Record<string, string>>;
}

export function withV2SourceLineage(
  body: Readonly<Record<string, unknown>>,
  marker: V2SourceLineageMarker,
): Record<string, unknown> {
  const meta = isRecord(body.meta) ? body.meta : {};
  return {
    ...body,
    meta: {
      ...meta,
      [V2_SOURCE_LINEAGE_META_KEY]: marker,
    },
  };
}

export function readV2SourceLineage(
  value: unknown,
): V2SourceLineageMarker | undefined {
  if (!isRecord(value)) return undefined;
  const meta = isRecord(value.meta) ? value.meta : undefined;
  const marker = meta?.[V2_SOURCE_LINEAGE_META_KEY];
  if (!isV2SourceLineageMarker(marker)) return undefined;
  return marker as unknown as V2SourceLineageMarker;
}

export function generatedV2SourceLineage(
  marker: V2SourceLineageMarker,
): V2SourceLineageMarker {
  return Object.freeze({
    ...marker,
    generated: true,
  });
}

/** Immutably remove parser-only lineage without changing authored metadata. */
export function stripV2SourceLineage<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      stripV2SourceLineage(item),
    ) as T;
  }
  if (!isRecord(value)) return value;
  const nodeMeta =
    typeof value.type === "string" &&
    isRecord(value.meta) &&
    isV2SourceLineageMarker(value.meta[V2_SOURCE_LINEAGE_META_KEY])
      ? value.meta
      : undefined;
  const entries: Array<[string, unknown]> = [];
  for (const [key, nested] of Object.entries(value)) {
    if (key === "meta" && nodeMeta !== undefined) {
      const strippedMeta = Object.fromEntries(
        Object.entries(nodeMeta)
          .filter(([metaKey]) => metaKey !== V2_SOURCE_LINEAGE_META_KEY)
          .map(([metaKey, metaValue]) => [
            metaKey,
            stripV2SourceLineage(metaValue),
          ]),
      );
      if (Object.keys(strippedMeta).length > 0) {
        entries.push([key, strippedMeta]);
      }
      continue;
    }
    const stripped = stripV2SourceLineage(nested);
    entries.push([key, stripped]);
  }
  return Object.fromEntries(entries) as T;
}

function isV2SourceLineageMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.authoredPath === "string" &&
    typeof value.loweredPath === "string" &&
    typeof value.use === "string" &&
    typeof value.generated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

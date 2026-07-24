import { createHash } from "node:crypto";

import type { FlowDocumentV1 } from "@dzupagent/flow-ast";
import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
} from "yaml";

import { parseYamlSubset } from "./mini-yaml.js";
import {
  projectDslDocumentEntries,
  type MutableDslSourceEntry,
} from "./dsl-source-map-projection.js";
import type {
  DslSourceMap,
  DslSourceMapEntry,
  DslSourceSpan,
} from "./types.js";

export type {
  DslSourceMap,
  DslSourceMapEntry,
  DslSourceSpan,
} from "./types.js";

/** Build an immutable raw-to-canonical source index for valid subset YAML. */
export function createDslSourceMap(
  source: string,
  document?: FlowDocumentV1,
): DslSourceMap | undefined {
  const parsed = parseYamlSubset(source);
  if (!parsed.ok) return undefined;

  const lineCounter = new LineCounter();
  const yaml = parseDocument(source, {
    keepSourceTokens: true,
    lineCounter,
  });
  if (yaml.errors.length > 0 || yaml.contents === null) return undefined;

  const authored = new Map<string, MutableDslSourceEntry>();
  collectYamlEntries(
    yaml.contents,
    parsed.value,
    ["root"],
    source,
    lineCounter,
    authored,
  );

  const entries = new Map<string, DslSourceMapEntry>();
  for (const [path, entry] of authored) {
    addProjection(entries, path, entry);
  }

  if (document !== undefined && isRecord(parsed.value)) {
    projectDslDocumentEntries(document, parsed.value, authored, entries);
  }

  return Object.freeze({
    schema: "dzupagent.dslSourceMap/v1" as const,
    sourceDigest: digestSource(source),
    lineStarts: Object.freeze(collectLineStarts(source)),
    entries: Object.freeze(Object.fromEntries(entries)),
  });
}

/** Resolve a canonical field or a field-relative range into raw source. */
export function resolveDslSourceSpan(
  sourceMap: DslSourceMap,
  canonicalPath: string,
  relative?: Readonly<{ start: number; end: number }>,
): DslSourceSpan | undefined {
  const entry = sourceMap.entries[canonicalPath];
  if (entry === undefined) return undefined;
  if (relative === undefined) return entry.valueSpan ?? entry.keySpan;
  const offsets = entry.contentOffsets;
  if (
    offsets === undefined ||
    relative.start < 0 ||
    relative.end < relative.start ||
    relative.end >= offsets.length
  ) {
    return undefined;
  }
  const start = offsets[relative.start];
  const end = offsets[relative.end];
  if (start === undefined || end === undefined || end < start) return undefined;
  return spanFromOffsets(start, end, sourceMap, entry);
}

function spanFromOffsets(
  start: number,
  end: number,
  sourceMap: DslSourceMap,
  entry: DslSourceMapEntry,
): DslSourceSpan {
  if (entry.valueSpan === undefined && entry.keySpan === undefined) {
    return { start, end, lineStart: 1, columnStart: start + 1, lineEnd: 1, columnEnd: end + 1 };
  }
  const first = positionAt(sourceMap.lineStarts, start);
  const last = positionAt(sourceMap.lineStarts, end);
  return {
    start,
    end,
    lineStart: first.line,
    columnStart: first.column,
    lineEnd: last.line,
    columnEnd: last.column,
  };
}

function collectYamlEntries(
  node: Node,
  rawValue: unknown,
  segments: Array<string | number>,
  source: string,
  lineCounter: LineCounter,
  entries: Map<string, MutableDslSourceEntry>,
  keyNode?: Node,
): void {
  const path = formatPath(segments);
  const keyRange = keyNode?.range;
  const valueRange = node.range;
  const current: MutableDslSourceEntry = {
    authoredPath: path,
    ...(keyRange !== undefined && keyRange !== null
      ? { keySpan: makeSpan(keyRange[0], keyRange[1], lineCounter) }
      : {}),
    ...(valueRange !== undefined && valueRange !== null
      ? { valueSpan: makeSpan(valueRange[0], valueRange[1], lineCounter) }
      : {}),
  };
  if (
    isScalar(node) &&
    typeof rawValue === "string" &&
    valueRange !== undefined &&
    valueRange !== null
  ) {
    const contentOffsets = alignStringOffsets(
      rawValue,
      source,
      valueRange[0],
      valueRange[1],
      String(node.type ?? ""),
    );
    if (contentOffsets !== undefined) current.contentOffsets = contentOffsets;
  }
  entries.set(path, current);

  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      if (pair.value === null) continue;
      const key = pair.key.value;
      collectYamlEntries(
        pair.value as Node,
        isRecord(rawValue) ? rawValue[key] : undefined,
        [...segments, key],
        source,
        lineCounter,
        entries,
        pair.key as Node,
      );
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (item === null) return;
      collectYamlEntries(
        item as Node,
        Array.isArray(rawValue) ? rawValue[index] : undefined,
        [...segments, index],
        source,
        lineCounter,
        entries,
      );
    });
  }
}

function addProjection(
  entries: Map<string, DslSourceMapEntry>,
  canonicalPath: string,
  source: MutableDslSourceEntry,
): void {
  entries.set(canonicalPath, Object.freeze({
    canonicalPath,
    authoredPath: source.authoredPath,
    ...(source.keySpan !== undefined ? { keySpan: source.keySpan } : {}),
    ...(source.valueSpan !== undefined ? { valueSpan: source.valueSpan } : {}),
    ...(source.contentOffsets !== undefined
      ? { contentOffsets: Object.freeze([...source.contentOffsets]) }
      : {}),
  }));
}

function alignStringOffsets(
  value: string,
  source: string,
  rangeStart: number,
  rangeEnd: number,
  scalarType: string,
): readonly number[] | undefined {
  let cursor = rangeStart;
  if (scalarType === "QUOTE_DOUBLE" || scalarType === "QUOTE_SINGLE") {
    cursor += 1;
  } else if (scalarType === "BLOCK_LITERAL") {
    const newline = source.indexOf("\n", cursor);
    cursor = newline === -1 ? cursor : newline + 1;
  }
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const match = source.indexOf(value[index] ?? "", cursor);
    if (match === -1 || match >= rangeEnd) return undefined;
    offsets.push(match);
    cursor = match + 1;
  }
  offsets.push(cursor);
  return offsets;
}

function makeSpan(
  start: number,
  end: number,
  lineCounter: LineCounter,
): DslSourceSpan {
  const first = lineCounter.linePos(start);
  const last = lineCounter.linePos(end);
  return Object.freeze({
    start,
    end,
    lineStart: first.line,
    columnStart: first.col,
    lineEnd: last.line,
    columnEnd: last.col,
  });
}

function digestSource(source: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function formatPath(segments: readonly (string | number)[]): string {
  let path = String(segments[0] ?? "root");
  for (const segment of segments.slice(1)) {
    path += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionAt(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  return {
    line: index + 1,
    column: offset - (lineStarts[index] ?? 0) + 1,
  };
}

import {
  FLOW_REFERENCE_ROOTS,
  parseFlowReferenceExpression,
  type FlowReferenceBindings,
  type FlowReferencePolicy,
  type ParsedFlowReference,
} from "@dzupagent/flow-ast/expressions";

export interface ControlReferenceScanOptions {
  readonly policy: FlowReferencePolicy;
  readonly declarationBindings?: FlowReferenceBindings;
}

/** Extract canonical references while skipping quoted condition literals. */
export function scanControlReferences(
  source: string,
  options: ControlReferenceScanOptions,
): ParsedFlowReference[] {
  const references: ParsedFlowReference[] = [];
  const roots = new Set<string>(FLOW_REFERENCE_ROOTS);
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "'" || char === '"') {
      cursor = skipQuoted(source, cursor, char);
      continue;
    }
    if (source.slice(cursor, cursor + 2) === "{{") {
      const close = source.indexOf("}}", cursor + 2);
      if (close < 0) break;
      addParsedReference(
        source.slice(cursor, close + 2),
        cursor,
        options,
        references,
      );
      cursor = close + 2;
      continue;
    }
    if (!isIdentifierStart(char)) {
      cursor += 1;
      continue;
    }

    const start = cursor;
    cursor = readIdentifierEnd(source, cursor);
    const root = source.slice(start, cursor);
    while (source[cursor] === "." && isIdentifierStart(source[cursor + 1])) {
      cursor = readIdentifierEnd(source, cursor + 1);
    }
    if (roots.has(root) && cursor > start + root.length) {
      addParsedReference(
        source.slice(start, cursor),
        start,
        options,
        references,
      );
    }
  }

  return deduplicateReferences(references);
}

function addParsedReference(
  source: string,
  offset: number,
  options: ControlReferenceScanOptions,
  references: ParsedFlowReference[],
): void {
  const parsed = parseFlowReferenceExpression(source, {
    policy: options.policy,
    useSite: "boolean-control",
    ...(options.declarationBindings !== undefined
      ? { knownBindings: options.declarationBindings }
      : {}),
  });
  if (parsed.reference !== undefined) {
    references.push(shiftReference(parsed.reference, offset));
  }
}

function shiftReference(
  reference: ParsedFlowReference,
  offset: number,
): ParsedFlowReference {
  return {
    ...reference,
    start: reference.start + offset,
    end: reference.end + offset,
    segments: reference.segments.map((segment) => ({
      ...segment,
      start: segment.start + offset,
      end: segment.end + offset,
    })),
    filters: reference.filters.map((filter) => ({
      ...filter,
      start: filter.start + offset,
      end: filter.end + offset,
    })),
  };
}

function deduplicateReferences(
  references: readonly ParsedFlowReference[],
): ParsedFlowReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.source)) return false;
    seen.add(reference.source);
    return true;
  });
}

function skipQuoted(source: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function readIdentifierEnd(source: string, start: number): number {
  let cursor = start + 1;
  while (isIdentifierPart(source[cursor])) cursor += 1;
  return cursor;
}

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

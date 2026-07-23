import {
  COMPAT_REFERENCE_ROOTS,
  FLOW_REFERENCE_FILTERS,
  FLOW_REFERENCE_ROOTS,
  type FlowReferenceAnalysisOptions,
  type FlowReferenceDiagnostic,
  type FlowReferenceFilter,
  type FlowReferenceParseResult,
  type FlowReferencePolicy,
  type FlowReferenceSegment,
  type FlowReferenceUseSite,
  type ParsedFlowReference,
} from "./types.js";
import {
  createReferenceDiagnostic,
  findNextUnquotedPipe,
  isSignedInteger,
  isUnsignedInteger,
  isWhitespace,
  readIdentifier,
  referenceParseResult,
  skipWhitespace,
  unwrapReferenceSource,
} from "./internal.js";

export function parseFlowReferenceExpression(
  source: string,
  options: FlowReferenceAnalysisOptions = {},
): FlowReferenceParseResult {
  const policy = options.policy ?? "compat-v1";
  const useSite = options.useSite ?? "required-value";
  const diagnostics: FlowReferenceDiagnostic[] = [];
  const unwrapped = unwrapReferenceSource(source);

  if (!unwrapped.ok) {
    diagnostics.push(
      createReferenceDiagnostic(
        "MALFORMED_REFERENCE",
        policy,
        useSite,
        unwrapped.message,
        unwrapped.start,
        unwrapped.end,
        options.sourcePath,
      ),
    );
    return referenceParseResult(undefined, diagnostics);
  }

  const text = unwrapped.source;
  const baseOffset = unwrapped.offset;
  let cursor = skipWhitespace(text, 0);
  const rootToken = readIdentifier(text, cursor);
  if (rootToken === undefined) {
    diagnostics.push(
      createReferenceDiagnostic(
        text.trim().length === 0 ? "EMPTY_REFERENCE" : "MALFORMED_REFERENCE",
        policy,
        useSite,
        text.trim().length === 0
          ? "reference expression is empty"
          : "reference must start with an identifier",
        baseOffset + cursor,
        baseOffset + Math.max(cursor + 1, text.length),
        options.sourcePath,
      ),
    );
    return referenceParseResult(undefined, diagnostics);
  }

  cursor = rootToken.end;
  const segments: FlowReferenceSegment[] = [];
  while (cursor < text.length) {
    cursor = skipWhitespace(text, cursor);
    const char = text[cursor];
    if (char === undefined || char === "|") break;
    if (char === ".") {
      const token = readIdentifier(text, cursor + 1);
      if (token === undefined) {
        diagnostics.push(
          createReferenceDiagnostic(
            "MALFORMED_REFERENCE",
            policy,
            useSite,
            "property access must be followed by an identifier",
            baseOffset + cursor,
            baseOffset + Math.min(cursor + 2, text.length),
            options.sourcePath,
          ),
        );
        cursor += 1;
        break;
      }
      segments.push({
        kind: "property",
        key: token.value,
        start: baseOffset + cursor,
        end: baseOffset + token.end,
      });
      cursor = token.end;
      continue;
    }
    if (char === "[") {
      cursor = parseIndex(
        text,
        cursor,
        baseOffset,
        policy,
        useSite,
        options.sourcePath,
        segments,
        diagnostics,
      );
      if (cursor >= text.length) break;
      continue;
    }
    diagnostics.push(
      createReferenceDiagnostic(
        "MALFORMED_REFERENCE",
        policy,
        useSite,
        `unexpected token "${char}" in reference path`,
        baseOffset + cursor,
        baseOffset + cursor + 1,
        options.sourcePath,
      ),
    );
    break;
  }

  const filters: FlowReferenceFilter[] = [];
  while (cursor < text.length) {
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] !== "|") {
      diagnostics.push(
        createReferenceDiagnostic(
          "MALFORMED_REFERENCE",
          policy,
          useSite,
          "unexpected content after reference path",
          baseOffset + cursor,
          baseOffset + text.length,
          options.sourcePath,
        ),
      );
      break;
    }
    const filterStart = cursor;
    const filterEnd = findNextUnquotedPipe(text, cursor + 1);
    const filter = parseFilter(
      text.slice(cursor + 1, filterEnd).trim(),
      baseOffset + filterStart,
      baseOffset + filterEnd,
      policy,
      useSite,
      options.sourcePath,
      diagnostics,
    );
    if (filter !== undefined) filters.push(filter);
    cursor = filterEnd;
  }

  validateRootAndBinding(
    rootToken.value,
    rootToken.start,
    rootToken.end,
    segments,
    baseOffset,
    policy,
    useSite,
    options,
    diagnostics,
  );

  const reference: ParsedFlowReference = {
    source: text.trim(),
    root: rootToken.value,
    segments,
    filters,
    start: baseOffset + rootToken.start,
    end: baseOffset + text.trimEnd().length,
  };
  return referenceParseResult(reference, diagnostics);
}

function parseIndex(
  source: string,
  cursor: number,
  baseOffset: number,
  policy: FlowReferencePolicy,
  useSite: FlowReferenceUseSite,
  sourcePath: string | undefined,
  segments: FlowReferenceSegment[],
  diagnostics: FlowReferenceDiagnostic[],
): number {
  const close = source.indexOf("]", cursor + 1);
  if (close < 0) {
    diagnostics.push(
      createReferenceDiagnostic(
        "INVALID_REFERENCE_INDEX",
        policy,
        useSite,
        "reference index is missing a closing bracket",
        baseOffset + cursor,
        baseOffset + source.length,
        sourcePath,
      ),
    );
    return source.length;
  }
  const rawIndex = source.slice(cursor + 1, close).trim();
  if (!isUnsignedInteger(rawIndex)) {
    diagnostics.push(
      createReferenceDiagnostic(
        "INVALID_REFERENCE_INDEX",
        policy,
        useSite,
        `reference index "${rawIndex}" must be a non-negative integer`,
        baseOffset + cursor,
        baseOffset + close + 1,
        sourcePath,
      ),
    );
  } else {
    segments.push({
      kind: "index",
      index: Number(rawIndex),
      start: baseOffset + cursor,
      end: baseOffset + close + 1,
    });
  }
  return close + 1;
}

function parseFilter(
  source: string,
  start: number,
  end: number,
  policy: FlowReferencePolicy,
  useSite: FlowReferenceUseSite,
  sourcePath: string | undefined,
  diagnostics: FlowReferenceDiagnostic[],
): FlowReferenceFilter | undefined {
  const nameToken = readIdentifier(source, skipWhitespace(source, 0));
  if (nameToken === undefined) {
    diagnostics.push(
      createReferenceDiagnostic(
        "MALFORMED_REFERENCE",
        policy,
        useSite,
        "template filter must declare a name",
        start,
        end,
        sourcePath,
      ),
    );
    return undefined;
  }

  let cursor = skipWhitespace(source, nameToken.end);
  let argument: string | number | undefined;
  if (source[cursor] === ":") {
    argument = parseFilterArgument(source.slice(cursor + 1).trim());
    if (argument === undefined) {
      diagnostics.push(
        createReferenceDiagnostic(
          "INVALID_REFERENCE_FILTER_ARGUMENT",
          policy,
          useSite,
          `filter "${nameToken.value}" has an invalid argument`,
          start,
          end,
          sourcePath,
        ),
      );
    }
    cursor = source.length;
  }
  cursor = skipWhitespace(source, cursor);
  if (cursor < source.length) {
    diagnostics.push(
      createReferenceDiagnostic(
        "MALFORMED_REFERENCE",
        policy,
        useSite,
        `unexpected content in filter "${nameToken.value}"`,
        start,
        end,
        sourcePath,
      ),
    );
  }

  validateFilterContract(
    nameToken.value,
    argument,
    start,
    end,
    policy,
    useSite,
    sourcePath,
    diagnostics,
  );
  return {
    name: nameToken.value,
    ...(argument !== undefined ? { argument } : {}),
    start,
    end,
  };
}

function validateFilterContract(
  name: string,
  argument: string | number | undefined,
  start: number,
  end: number,
  policy: FlowReferencePolicy,
  useSite: FlowReferenceUseSite,
  sourcePath: string | undefined,
  diagnostics: FlowReferenceDiagnostic[],
): void {
  if (!FLOW_REFERENCE_FILTERS.some((known) => known === name)) {
    diagnostics.push(
      createReferenceDiagnostic(
        "UNKNOWN_REFERENCE_FILTER",
        policy,
        useSite,
        `unknown reference filter "${name}"`,
        start,
        end,
        sourcePath,
      ),
    );
  } else if (name === "default" && argument === undefined) {
    diagnostics.push(
      createReferenceDiagnostic(
        "INVALID_REFERENCE_FILTER_ARGUMENT",
        policy,
        useSite,
        'filter "default" requires an argument',
        start,
        end,
        sourcePath,
      ),
    );
  } else if (name !== "default" && argument !== undefined) {
    diagnostics.push(
      createReferenceDiagnostic(
        "INVALID_REFERENCE_FILTER_ARGUMENT",
        policy,
        useSite,
        `filter "${name}" does not accept an argument`,
        start,
        end,
        sourcePath,
      ),
    );
  }
}

function parseFilterArgument(source: string): string | number | undefined {
  if (source.length === 0) return undefined;
  const first = source[0];
  const last = source[source.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return source.slice(1, -1);
  }
  if (isSignedInteger(source)) return Number(source);
  for (let index = 0; index < source.length; index += 1) {
    if (isWhitespace(source[index])) return undefined;
  }
  return source;
}

function validateRootAndBinding(
  root: string,
  rootStart: number,
  rootEnd: number,
  segments: FlowReferenceSegment[],
  baseOffset: number,
  policy: FlowReferencePolicy,
  useSite: FlowReferenceUseSite,
  options: FlowReferenceAnalysisOptions,
  diagnostics: FlowReferenceDiagnostic[],
): void {
  const allowedRoots = new Set(
    options.allowedRoots ??
      (policy === "strict" ? FLOW_REFERENCE_ROOTS : COMPAT_REFERENCE_ROOTS),
  );
  if (!allowedRoots.has(root)) {
    diagnostics.push(
      createReferenceDiagnostic(
        "DISALLOWED_REFERENCE_ROOT",
        policy,
        useSite,
        `reference root "${root}" is not allowed`,
        baseOffset + rootStart,
        baseOffset + rootEnd,
        options.sourcePath,
      ),
    );
  }

  const firstSegment = segments[0];
  const bindings = options.knownBindings?.[root];
  if (
    bindings !== undefined &&
    firstSegment?.kind === "property" &&
    !bindings.includes(firstSegment.key)
  ) {
    diagnostics.push(
      createReferenceDiagnostic(
        "MISSING_REFERENCE",
        policy,
        useSite,
        `reference "${root}.${firstSegment.key}" is not declared`,
        baseOffset + rootStart,
        firstSegment.end,
        options.sourcePath,
      ),
    );
  }
}

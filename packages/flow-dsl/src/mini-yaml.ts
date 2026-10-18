/**
 * `content` lines carry structure. `blank` (whitespace-only) and `comment`
 * (whole-line `#`) lines are kept as flagged tokens so literal block scalars
 * can preserve them; every structural parser skips them via `skipFlagged`.
 */
type YamlLineKind = "content" | "blank" | "comment";

interface YamlLine {
  kind: YamlLineKind;
  indent: number;
  content: string;
  lineNo: number;
}

/** First index at or after `index` that holds a structural (content) line. */
function skipFlagged(lines: YamlLine[], index: number): number {
  let cursor = index;
  while (cursor < lines.length && lines[cursor]!.kind !== "content") {
    cursor += 1;
  }
  return cursor;
}

export interface YamlParseError {
  code: "INVALID_YAML_SUBSET";
  message: string;
  line: number;
  column: number;
}

export type YamlParseResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: YamlParseError[] };

type TokenizeResult =
  | { ok: true; value: YamlLine[] }
  | { ok: false; errors: YamlParseError[] };

function isIdentifierStart(char: string): boolean {
  return (
    (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_"
  );
}

function isIdentifierPart(char: string): boolean {
  return (
    isIdentifierStart(char) ||
    (char >= "0" && char <= "9") ||
    char === "-" ||
    char === "."
  );
}

function parseInlineMappingEntry(
  content: string
): { key: string; rawValue?: string } | null {
  const separator = content.indexOf(":");
  if (separator <= 0) return null;

  const key = content.slice(0, separator);
  if (!isIdentifierStart(key[0] ?? "")) return null;
  for (let index = 1; index < key.length; index += 1) {
    if (!isIdentifierPart(key[index] ?? "")) return null;
  }

  const remainder = content.slice(separator + 1);
  if (remainder.length === 0) return { key, rawValue: "" };
  if (remainder.startsWith(" ")) return { key, rawValue: remainder.slice(1) };
  return null;
}

function isNumericScalar(value: string): boolean {
  if (value.length === 0) return false;
  let index = 0;
  if (value[0] === "-") {
    if (value.length === 1) return false;
    index = 1;
  }

  let hasDigitsBeforeDecimal = false;
  while (index < value.length && value[index] !== ".") {
    const char = value[index];
    if (char === undefined || char < "0" || char > "9") return false;
    hasDigitsBeforeDecimal = true;
    index += 1;
  }

  if (!hasDigitsBeforeDecimal) return false;
  if (index === value.length) return true;
  if (value[index] !== "." || index === value.length - 1) return false;
  index += 1;

  while (index < value.length) {
    const char = value[index];
    if (char === undefined || char < "0" || char > "9") return false;
    index += 1;
  }
  return true;
}

export function parseYamlSubset(source: string): YamlParseResult {
  const lines = tokenize(source);
  if (!lines.ok) return lines;
  const normalizedLines = lines.value;
  const rootIndex = skipFlagged(normalizedLines, 0);
  if (rootIndex === normalizedLines.length) {
    return { ok: true, value: {} };
  }

  const parsed = parseBlock(
    normalizedLines,
    rootIndex,
    normalizedLines[rootIndex]!.indent,
  );
  if (!parsed.ok) return parsed;
  const trailingIndex = skipFlagged(normalizedLines, parsed.nextIndex);
  if (trailingIndex !== normalizedLines.length) {
    const next = normalizedLines[trailingIndex]!;
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_YAML_SUBSET",
          message: `Unexpected trailing content at line ${next.lineNo}`,
          line: next.lineNo,
          column: next.indent + 1,
        },
      ],
    };
  }
  return { ok: true, value: parsed.value };
}

function tokenize(source: string): TokenizeResult {
  const errors: YamlParseError[] = [];
  const lines: YamlLine[] = [];
  const rawLines = source.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? "";
    if (raw.includes("\t")) {
      errors.push({
        code: "INVALID_YAML_SUBSET",
        message: "Tabs are not supported in dzupflow YAML",
        line: index + 1,
        column: raw.indexOf("\t") + 1,
      });
      continue;
    }
    const trimmed = raw.trim();
    const kind: YamlLineKind =
      trimmed.length === 0
        ? "blank"
        : trimmed.startsWith("#")
          ? "comment"
          : "content";
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    lines.push({ kind, indent, content: raw.slice(indent), lineNo: index + 1 });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: lines };
}

type BlockParseResult =
  | { ok: true; value: unknown; nextIndex: number }
  | { ok: false; errors: YamlParseError[] };

function parseBlock(
  lines: YamlLine[],
  startIndex: number,
  indent: number
): BlockParseResult {
  const blockIndex = skipFlagged(lines, startIndex);
  const current = lines[blockIndex];
  if (!current) return { ok: true, value: {}, nextIndex: blockIndex };
  if (current.indent !== indent) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_YAML_SUBSET",
          message: `Unexpected indentation at line ${current.lineNo}`,
          line: current.lineNo,
          column: current.indent + 1,
        },
      ],
    };
  }
  if (current.content === "-" || current.content.startsWith("- ")) {
    return parseSequence(lines, blockIndex, indent);
  }
  return parseMapping(lines, blockIndex, indent);
}

function parseSequence(
  lines: YamlLine[],
  startIndex: number,
  indent: number
): BlockParseResult {
  const items: unknown[] = [];
  let index = skipFlagged(lines, startIndex);

  for (; index < lines.length; index = skipFlagged(lines, index)) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      return unexpectedIndent(line);
    }
    if (line.content !== "-" && !line.content.startsWith("- ")) break;

    const rest = line.content === "-" ? "" : line.content.slice(2).trimEnd();
    if (rest.length === 0) {
      const nested = parseNested(lines, index + 1, indent + 2);
      if (!nested.ok) return nested;
      items.push(nested.value);
      index = nested.nextIndex;
      continue;
    }

    const inlineEntry = parseInlineMappingEntry(rest);
    if (inlineEntry?.rawValue === "") {
      const nested = parseNested(lines, index + 1, indent + 4);
      if (!nested.ok) return nested;
      const item: Record<string, unknown> = {
        [inlineEntry.key]: nested.value,
      };
      index = nested.nextIndex;
      const continuation = parseSequenceMappingContinuation(
        lines,
        index,
        indent,
        item,
      );
      if (!continuation.ok) return continuation;
      items.push(continuation.value);
      index = continuation.nextIndex;
      continue;
    }

    if (
      inlineEntry?.rawValue !== undefined &&
      inlineEntry.rawValue.length > 0
    ) {
      const literal =
        inlineEntry.rawValue === "|"
          ? parseLiteralBlock(lines, index + 1, indent + 4)
          : undefined;
      const item: Record<string, unknown> = {
        [inlineEntry.key]:
          literal !== undefined
            ? literal.value
            : parseScalar(inlineEntry.rawValue),
      };
      index = literal?.nextIndex ?? index + 1;
      const continuation = parseSequenceMappingContinuation(
        lines,
        index,
        indent,
        item,
      );
      if (!continuation.ok) return continuation;
      items.push(continuation.value);
      index = continuation.nextIndex;
      continue;
    }

    items.push(parseScalar(rest));
    index += 1;
  }

  return { ok: true, value: items, nextIndex: index };
}

function parseSequenceMappingContinuation(
  lines: YamlLine[],
  startIndex: number,
  sequenceIndent: number,
  item: Record<string, unknown>,
): BlockParseResult {
  const nextIndex = skipFlagged(lines, startIndex);
  const next = lines[nextIndex];
  if (
    next === undefined ||
    next.indent !== sequenceIndent + 2 ||
    next.content === "-" ||
    next.content.startsWith("- ")
  ) {
    return { ok: true, value: item, nextIndex: startIndex };
  }
  const continuation = parseMapping(lines, nextIndex, sequenceIndent + 2);
  if (!continuation.ok) return continuation;
  return {
    ok: true,
    value: {
      ...item,
      ...(continuation.value as Record<string, unknown>),
    },
    nextIndex: continuation.nextIndex,
  };
}

function parseMapping(
  lines: YamlLine[],
  startIndex: number,
  indent: number
): BlockParseResult {
  const obj: Record<string, unknown> = {};
  let index = skipFlagged(lines, startIndex);

  for (; index < lines.length; index = skipFlagged(lines, index)) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      return unexpectedIndent(line);
    }
    if (line.content.startsWith("- ")) break;

    const entry = parseInlineMappingEntry(line.content);
    if (!entry) {
      return {
        ok: false,
        errors: [
          {
            code: "INVALID_YAML_SUBSET",
            message: `Invalid mapping entry at line ${line.lineNo}`,
            line: line.lineNo,
            column: line.indent + 1,
          },
        ],
      };
    }

    const { key, rawValue } = entry;
    if (rawValue === undefined || rawValue.length === 0) {
      const nested = parseNested(lines, index + 1, indent + 2);
      if (!nested.ok) return nested;
      obj[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }

    if (rawValue === "|") {
      const block = parseLiteralBlock(lines, index + 1, indent + 2);
      obj[key] = block.value;
      index = block.nextIndex;
      continue;
    }

    obj[key] = parseScalar(rawValue);
    index += 1;
  }

  return { ok: true, value: obj, nextIndex: index };
}

function parseNested(
  lines: YamlLine[],
  startIndex: number,
  indent: number
): BlockParseResult {
  const nextIndex = skipFlagged(lines, startIndex);
  const next = lines[nextIndex];
  if (!next || next.indent < indent)
    return { ok: true, value: {}, nextIndex: startIndex };
  return parseBlock(lines, nextIndex, indent);
}

/**
 * Literal (`|`) block scalar with clip chomping minus the final newline.
 * Blank lines become empty lines and never end the block; `#` lines at or
 * beyond the block indent are content (YAML has no comments inside block
 * scalars); a less-indented comment or content line ends the block. Trailing
 * empty lines are clipped.
 */
function parseLiteralBlock(
  lines: YamlLine[],
  startIndex: number,
  indent: number
): { value: string; nextIndex: number } {
  const chunks: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "blank") {
      chunks.push("");
      index += 1;
      continue;
    }
    if (line.indent < indent) break;
    chunks.push(`${" ".repeat(line.indent - indent)}${line.content}`);
    index += 1;
  }
  while (chunks.length > 0 && chunks[chunks.length - 1] === "") {
    chunks.pop();
  }
  return { value: chunks.join("\n"), nextIndex: index };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    // The formatter's quote() helper emits JSON string syntax. Decode that
    // syntax here so escaped quotes, backslashes, and newlines do not acquire
    // an extra escape layer on every format -> parse cycle. Preserve the old
    // permissive behavior for handwritten double-quoted values that are not
    // valid JSON strings.
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (isNumericScalar(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    // Prefer strict JSON (mirrors the flow-mapping branch below): the formatter
    // emits structured meta such as meta.fragmentExpansions as inline JSON, and
    // naive comma splitting shreds objects, quoted commas, and nested arrays
    // into garbage strings. Fall back to the permissive split for handwritten
    // YAML flow sequences (bare scalars, single quotes) that are not valid JSON.
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return inner.split(",").map((part) => parseScalar(part.trim()));
    }
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function unexpectedIndent(line: YamlLine): BlockParseResult {
  return {
    ok: false,
    errors: [
      {
        code: "INVALID_YAML_SUBSET",
        message: `Unexpected indentation at line ${line.lineNo}`,
        line: line.lineNo,
        column: line.indent + 1,
      },
    ],
  };
}

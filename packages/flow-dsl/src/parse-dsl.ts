import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import { parseYamlSubset } from "./mini-yaml.js";
import { expandCollabMacros } from "./expand-collab-macros.js";
import { normalizeDslDocument } from "./normalize.js";
import { validateDocument } from "./document-validate.js";
import type { ParseDslResult } from "./types.js";

export function parseDslToDocument(source: string): ParseDslResult {
  const yaml = parseYamlSubset(source);
  if (!yaml.ok) {
    return {
      document: null,
      diagnostics: yaml.errors.map((error) => ({
        phase: "parse" as const,
        code: error.code,
        message: error.message,
        path: "root",
        span: {
          lineStart: error.line,
          columnStart: error.column,
          lineEnd: error.line,
          columnEnd: error.column,
        },
      })),
      ok: false,
      partialDocument: null,
    };
  }

  // MPCO P5: expand collab.* macros into canonical nodes before normalization.
  let expandedRaw: unknown;
  try {
    expandedRaw = expandCollabMacros(yaml.value);
  } catch (error) {
    return {
      ok: false,
      document: null,
      partialDocument: null,
      diagnostics: [
        {
          phase: "normalize" as const,
          code: "INVALID_COLLAB_MACRO",
          message: error instanceof Error ? error.message : String(error),
          path: "root.steps",
        },
      ],
    };
  }

  const normalized = normalizeDslDocument(expandedRaw);
  if (!normalized.ok) {
    return {
      ok: false,
      document: null,
      partialDocument: normalized.partialDocument,
      diagnostics: normalized.diagnostics,
    };
  }

  const { document } = normalized;
  const validation = validateDocument(document);
  const allDiagnostics = validation.diagnostics;
  if (allDiagnostics.length > 0) {
    return {
      ok: false,
      document: null,
      partialDocument: document,
      diagnostics: allDiagnostics,
    };
  }

  return {
    ok: true,
    document: document as FlowDocumentV1,
    partialDocument: null,
    diagnostics: [],
  };
}

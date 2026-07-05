import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import { parseYamlSubset } from "./mini-yaml.js";
import { expandRegisteredCompositesDetailed } from "./primitives/composite-expansion.js";
import { normalizeDslDocument } from "./normalize.js";
import { validateDocument } from "./document-validate.js";
import { BUILT_IN_FRAGMENT_REGISTRY } from "./fragments/built-ins.js";
import type { ParseDslResult } from "./types.js";
import type { FragmentRegistry } from "./fragments/types.js";
import type { PrimitiveRegistry } from "./primitives/types.js";

export interface ParseDslToDocumentOptions {
  fragmentRegistry?: FragmentRegistry;
  primitiveRegistry?: PrimitiveRegistry;
  requirePinnedFragmentUses?: boolean;
}

export function parseDslToDocument(
  source: string,
  options: ParseDslToDocumentOptions = {}
): ParseDslResult {
  const fragmentRegistry =
    options.fragmentRegistry ?? BUILT_IN_FRAGMENT_REGISTRY;
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

  // MPCO P2: expand registered composite primitives before normalization.
  let expandedRaw: unknown;
  let fragmentExpansions: unknown[] = [];
  try {
    const expanded = expandRegisteredCompositesDetailed(yaml.value, {
      primitiveRegistry: options.primitiveRegistry,
      fragmentRegistry,
      requirePinnedFragmentUses: options.requirePinnedFragmentUses,
    });
    expandedRaw = expanded.raw;
    fragmentExpansions = expanded.fragmentExpansions;
  } catch (error) {
    return {
      ok: false,
      document: null,
      partialDocument: null,
      diagnostics: [
        {
          phase: "normalize" as const,
          code: "INVALID_COMPOSITE_PRIMITIVE",
          message: error instanceof Error ? error.message : String(error),
          path: "root.steps",
        },
      ],
    };
  }

  const normalized = normalizeDslDocument(expandedRaw, {
    primitiveRegistry: options.primitiveRegistry,
    fragmentRegistry,
  });
  if (!normalized.ok) {
    return {
      ok: false,
      document: null,
      partialDocument: normalized.partialDocument,
      diagnostics: normalized.diagnostics,
    };
  }

  const { document } = normalized;
  if (fragmentExpansions.length > 0) {
    document.meta = {
      ...(document.meta ?? {}),
      fragmentExpansions,
    };
  }
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

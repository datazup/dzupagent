import type { FlowDocumentV1 } from "@dzupagent/flow-ast";

import { parseYamlSubset } from "./mini-yaml.js";
import { expandRegisteredCompositesDetailed } from "./primitives/composite-expansion.js";
import { normalizeDslDocument } from "./normalize.js";
import { validateDocument } from "./document-validate.js";
import { BUILT_IN_FRAGMENT_REGISTRY } from "./fragments/built-ins.js";
import type { ParseDslResult } from "./types.js";
import type { FragmentRegistry } from "./fragments/types.js";
import type { PrimitiveRegistry } from "./primitives/types.js";
import type { PrimitiveRegistryV2 } from "./primitives/types.js";
import { BUILT_IN_PRIMITIVE_REGISTRY_V2 } from "./primitives/built-ins.js";
import { lowerDslV2Document } from "./v2/lower-v2.js";

export interface ParseDslToDocumentOptions {
  fragmentRegistry?: FragmentRegistry;
  primitiveRegistry?: PrimitiveRegistry;
  primitiveRegistryV2?: PrimitiveRegistryV2;
  requirePinnedFragmentUses?: boolean;
  requirePrimitiveLineage?: boolean;
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

  const v2 =
    yaml.value &&
    typeof yaml.value === "object" &&
    !Array.isArray(yaml.value) &&
    (yaml.value as Record<string, unknown>).dsl === "dzupflow/v2"
      ? lowerDslV2Document(yaml.value, {
          primitiveRegistryV2:
            options.primitiveRegistryV2 ??
            BUILT_IN_PRIMITIVE_REGISTRY_V2,
        })
      : undefined;
  if (v2 !== undefined && !v2.ok) {
    return {
      ok: false,
      document: null,
      partialDocument: null,
      diagnostics: [...v2.diagnostics],
    };
  }
  const authoredRaw = v2?.raw ?? yaml.value;

  // MPCO P2: expand registered composite primitives before normalization.
  let expandedRaw: unknown;
  let fragmentExpansions: unknown[] = [];
  let primitiveExpansions: unknown[] = [];
  try {
    const expanded = expandRegisteredCompositesDetailed(authoredRaw, {
      primitiveRegistry: options.primitiveRegistry,
      primitiveRegistryV2:
        options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
      fragmentRegistry,
      requirePinnedFragmentUses: options.requirePinnedFragmentUses,
      requirePrimitiveLineage:
        options.requirePrimitiveLineage ?? v2 !== undefined,
    });
    expandedRaw = expanded.raw;
    fragmentExpansions = expanded.fragmentExpansions;
    primitiveExpansions = expanded.primitiveExpansions;
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
  if (fragmentExpansions.length > 0 || primitiveExpansions.length > 0) {
    document.meta = {
      ...(document.meta ?? {}),
      ...(fragmentExpansions.length === 0 ? {} : { fragmentExpansions }),
      ...(primitiveExpansions.length === 0 ? {} : { primitiveExpansions }),
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
    ...(v2 === undefined ? {} : { frontend: v2.metadata }),
  };
}

import type {
  PrimitiveDefinitionV2,
  PrimitiveRegistryV2,
} from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import type { DslV2PrimitiveImport } from "./types.js";

const PRIMITIVE_REF =
  /^primitive:\/\/[A-Za-z][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_IMPORTS = 128;

export interface ParsedV2PrimitiveImports {
  readonly explicit: boolean;
  readonly bindings: ReadonlyMap<
    PrimitiveDefinitionV2["ref"],
    `sha256:${string}`
  >;
}

/** Parse exact, content-addressed primitive imports without selecting latest versions. */
export function parseV2PrimitiveImports(
  raw: unknown,
  registry: PrimitiveRegistryV2,
  diagnostics: DslDiagnostic[]
): ParsedV2PrimitiveImports {
  if (raw === undefined) return { explicit: false, bindings: new Map() };
  if (!isRecord(raw)) {
    diagnostics.push(invalid("imports must be an object", "root.imports"));
    return { explicit: true, bindings: new Map() };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "primitives") {
      diagnostics.push(
        unsupported(
          `unsupported v2 import catalog "${key}"`,
          `root.imports.${key}`
        )
      );
    }
  }
  if (!Array.isArray(raw.primitives)) {
    diagnostics.push(
      invalid("imports.primitives must be an array", "root.imports.primitives")
    );
    return { explicit: true, bindings: new Map() };
  }
  if (raw.primitives.length > MAX_IMPORTS) {
    diagnostics.push(
      invalid(
        `imports.primitives exceeds the ${MAX_IMPORTS}-entry limit`,
        "root.imports.primitives"
      )
    );
  }

  const bindings = new Map<PrimitiveDefinitionV2["ref"], `sha256:${string}`>();
  raw.primitives.slice(0, MAX_IMPORTS).forEach((entry, index) => {
    const path = `root.imports.primitives[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(invalid("primitive import must be an object", path));
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "ref" && key !== "semanticHash") {
        diagnostics.push(
          unsupported(
            `unsupported primitive import field "${key}"`,
            `${path}.${key}`
          )
        );
      }
    }
    if (typeof entry.ref !== "string" || !PRIMITIVE_REF.test(entry.ref)) {
      diagnostics.push(
        invalid(
          "primitive import ref must be an exact primitive://kind@version ref",
          `${path}.ref`
        )
      );
      return;
    }
    const ref = entry.ref as PrimitiveDefinitionV2["ref"];
    if (bindings.has(ref)) {
      diagnostics.push(
        invalid(`duplicate primitive import ${ref}`, `${path}.ref`)
      );
      return;
    }
    const definition = registry.get(ref);
    if (definition === undefined) {
      diagnostics.push(
        invalid(`primitive import ${ref} is not registered`, `${path}.ref`)
      );
      return;
    }
    if (
      typeof entry.semanticHash !== "string" ||
      !SHA256.test(entry.semanticHash)
    ) {
      diagnostics.push(
        invalid(
          "primitive import semanticHash must be an exact lowercase SHA-256 digest",
          `${path}.semanticHash`
        )
      );
      return;
    }
    if (entry.semanticHash !== definition.compatibility.semanticHash) {
      diagnostics.push(
        invalid(
          `primitive import ${ref} semantic hash does not match the registry`,
          `${path}.semanticHash`
        )
      );
      return;
    }
    bindings.set(ref, entry.semanticHash as `sha256:${string}`);
  });
  return { explicit: true, bindings };
}

/** Require an explicit import catalog to equal the exact primitive-use closure. */
export function validateV2PrimitiveImportClosure(
  imports: ParsedV2PrimitiveImports,
  used: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>,
  diagnostics: DslDiagnostic[]
): void {
  if (!imports.explicit) return;
  for (const ref of used.keys()) {
    if (!imports.bindings.has(ref)) {
      diagnostics.push(
        invalid(
          `used primitive ${ref} is missing from imports.primitives`,
          "root.imports.primitives"
        )
      );
    }
  }
  for (const ref of imports.bindings.keys()) {
    if (!used.has(ref)) {
      diagnostics.push(
        invalid(`primitive import ${ref} is unused`, "root.imports.primitives")
      );
    }
  }
}

export function effectiveV2PrimitiveImports(
  imports: ParsedV2PrimitiveImports,
  used: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>
): readonly DslV2PrimitiveImport[] {
  const source = imports.explicit ? imports.bindings : used;
  return [...source.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, semanticHash]) => ({ ref, semanticHash }));
}

function invalid(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "V2_INVALID_IMPORT", message, path };
}

function unsupported(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "UNSUPPORTED_FIELD", message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

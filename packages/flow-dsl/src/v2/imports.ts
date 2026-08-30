import { canonicalDigestPrefixed } from "@datazup/canonical-json";

import type {
  PrimitiveDefinitionV2,
  PrimitiveRegistryV2,
} from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import {
  DSL_V2_EXTERNAL_IMPORT_CATALOGS,
  type DslV2ContentAddressedImport,
  type DslV2ExternalImportCatalog,
  type DslV2ExternalImportCatalogs,
  type DslV2PrimitiveImport,
  type DslV2ResolvedImportLock,
} from "./types.js";

const PRIMITIVE_REF =
  /^primitive:\/\/[A-Za-z][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_IMPORTS = 128;
const MAX_REF_LENGTH = 256;
const ALLOWED_CATALOGS = new Set([
  "primitives",
  ...DSL_V2_EXTERNAL_IMPORT_CATALOGS,
]);

export interface ParsedV2PrimitiveImports {
  readonly explicit: boolean;
  readonly bindings: ReadonlyMap<
    PrimitiveDefinitionV2["ref"],
    `sha256:${string}`
  >;
}

export type ParsedV2ExternalImports = Readonly<
  Record<DslV2ExternalImportCatalog, readonly DslV2ContentAddressedImport[]>
>;

/** Parse exact, content-addressed primitive imports without selecting latest versions. */
export function parseV2PrimitiveImports(
  raw: unknown,
  registry: PrimitiveRegistryV2,
  diagnostics: DslDiagnostic[],
): ParsedV2PrimitiveImports {
  if (raw === undefined) return { explicit: false, bindings: new Map() };
  if (!isRecord(raw)) {
    diagnostics.push(invalid("imports must be an object", "root.imports"));
    return { explicit: true, bindings: new Map() };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_CATALOGS.has(key)) {
      diagnostics.push(
        unsupported(
          `unsupported v2 import catalog "${key}"`,
          `root.imports.${key}`,
        ),
      );
    }
  }
  if (raw.primitives === undefined) {
    return { explicit: false, bindings: new Map() };
  }
  if (!Array.isArray(raw.primitives)) {
    diagnostics.push(
      invalid("imports.primitives must be an array", "root.imports.primitives"),
    );
    return { explicit: true, bindings: new Map() };
  }
  if (raw.primitives.length > MAX_IMPORTS) {
    diagnostics.push(
      invalid(
        `imports.primitives exceeds the ${MAX_IMPORTS}-entry limit`,
        "root.imports.primitives",
      ),
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
            `${path}.${key}`,
          ),
        );
      }
    }
    if (typeof entry.ref !== "string" || !PRIMITIVE_REF.test(entry.ref)) {
      diagnostics.push(
        invalid(
          "primitive import ref must be an exact primitive://kind@version ref",
          `${path}.ref`,
        ),
      );
      return;
    }
    const ref = entry.ref as PrimitiveDefinitionV2["ref"];
    if (bindings.has(ref)) {
      diagnostics.push(
        invalid(`duplicate primitive import ${ref}`, `${path}.ref`),
      );
      return;
    }
    const definition = registry.get(ref);
    if (definition === undefined) {
      diagnostics.push(
        invalid(`primitive import ${ref} is not registered`, `${path}.ref`),
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
          `${path}.semanticHash`,
        ),
      );
      return;
    }
    if (entry.semanticHash !== definition.compatibility.semanticHash) {
      diagnostics.push(
        invalid(
          `primitive import ${ref} semantic hash does not match the registry`,
          `${path}.semanticHash`,
        ),
      );
      return;
    }
    bindings.set(ref, entry.semanticHash as `sha256:${string}`);
  });
  return { explicit: true, bindings };
}

/** Parse broader exact imports against caller-owned, content-addressed catalogs. */
export function parseV2ExternalImports(
  raw: unknown,
  registries: DslV2ExternalImportCatalogs | undefined,
  diagnostics: DslDiagnostic[],
): ParsedV2ExternalImports {
  const result: Record<
    DslV2ExternalImportCatalog,
    readonly DslV2ContentAddressedImport[]
  > = {
    profiles: [],
    schemas: [],
    fragments: [],
    connectors: [],
    roles: [],
    flows: [],
  };
  if (raw === undefined || !isRecord(raw)) return Object.freeze(result);

  for (const catalog of DSL_V2_EXTERNAL_IMPORT_CATALOGS) {
    const authored = raw[catalog];
    if (authored === undefined) continue;
    const path = `root.imports.${catalog}`;
    if (!Array.isArray(authored)) {
      diagnostics.push(invalid(`imports.${catalog} must be an array`, path));
      continue;
    }
    if (authored.length > MAX_IMPORTS) {
      diagnostics.push(
        invalid(
          `imports.${catalog} exceeds the ${MAX_IMPORTS}-entry limit`,
          path,
        ),
      );
    }
    const registry = catalogRegistry(
      catalog,
      registries?.[catalog],
      diagnostics,
    );
    const seen = new Set<string>();
    const accepted: DslV2ContentAddressedImport[] = [];
    authored.slice(0, MAX_IMPORTS).forEach((entry, index) => {
      const entryPath = `${path}[${index}]`;
      const parsed = parseContentAddressedImport(entry, entryPath, diagnostics);
      if (parsed === undefined) return;
      if (seen.has(parsed.ref)) {
        diagnostics.push(
          invalid(
            `duplicate ${catalog} import ${parsed.ref}`,
            `${entryPath}.ref`,
          ),
        );
        return;
      }
      seen.add(parsed.ref);
      const expected = registry.get(parsed.ref);
      if (expected === undefined) {
        diagnostics.push(
          invalid(
            `${catalog} import ${parsed.ref} is not registered`,
            `${entryPath}.ref`,
          ),
        );
        return;
      }
      if (expected !== parsed.semanticHash) {
        diagnostics.push(
          invalid(
            `${catalog} import ${parsed.ref} semantic hash does not match the registry`,
            `${entryPath}.semanticHash`,
          ),
        );
        return;
      }
      accepted.push(parsed);
    });
    result[catalog] = Object.freeze(
      accepted.sort((left, right) => left.ref.localeCompare(right.ref)),
    );
  }
  return Object.freeze(result);
}

export function createV2ResolvedImportLock(
  primitives: readonly DslV2PrimitiveImport[],
  external: ParsedV2ExternalImports,
): DslV2ResolvedImportLock {
  const core = {
    schema: "dzupagent.dslV2ResolvedImportLock/v1" as const,
    catalogs: Object.freeze({
      primitives: sortImports(primitives),
      ...Object.fromEntries(
        DSL_V2_EXTERNAL_IMPORT_CATALOGS.map((catalog) => [
          catalog,
          sortImports(external[catalog]),
        ]),
      ),
    }) as DslV2ResolvedImportLock["catalogs"],
  };
  return Object.freeze({
    ...core,
    // authoring-v1 is the exact port of the private stableStringify/sha256
    // pair this file used to carry (corpus-proven, ARCH27-T-13), so
    // persisted lock digests are byte-identical.
    lockSha256: canonicalDigestPrefixed(core, "authoring-v1"),
  });
}

/** Require an explicit import catalog to equal the exact primitive-use closure. */
export function validateV2PrimitiveImportClosure(
  imports: ParsedV2PrimitiveImports,
  used: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>,
  diagnostics: DslDiagnostic[],
): void {
  if (!imports.explicit) return;
  for (const ref of used.keys()) {
    if (!imports.bindings.has(ref)) {
      diagnostics.push(
        invalid(
          `used primitive ${ref} is missing from imports.primitives`,
          "root.imports.primitives",
        ),
      );
    }
  }
  for (const ref of imports.bindings.keys()) {
    if (!used.has(ref)) {
      diagnostics.push(
        invalid(`primitive import ${ref} is unused`, "root.imports.primitives"),
      );
    }
  }
}

export function effectiveV2PrimitiveImports(
  imports: ParsedV2PrimitiveImports,
  used: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>,
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

function catalogRegistry(
  catalog: DslV2ExternalImportCatalog,
  entries: readonly DslV2ContentAddressedImport[] | undefined,
  diagnostics: DslDiagnostic[],
): ReadonlyMap<string, `sha256:${string}`> {
  const registry = new Map<string, `sha256:${string}`>();
  if (entries === undefined) return registry;
  entries.forEach((entry, index) => {
    const parsed = parseContentAddressedImport(
      entry,
      `options.importCatalogs.${catalog}[${index}]`,
      diagnostics,
    );
    if (parsed === undefined) return;
    if (registry.has(parsed.ref)) {
      diagnostics.push(
        invalid(
          `duplicate registered ${catalog} import ${parsed.ref}`,
          `options.importCatalogs.${catalog}[${index}].ref`,
        ),
      );
      return;
    }
    registry.set(parsed.ref, parsed.semanticHash);
  });
  return registry;
}

function parseContentAddressedImport(
  entry: unknown,
  path: string,
  diagnostics: DslDiagnostic[],
): DslV2ContentAddressedImport | undefined {
  if (!isRecord(entry)) {
    diagnostics.push(
      invalid("content-addressed import must be an object", path),
    );
    return undefined;
  }
  for (const key of Object.keys(entry)) {
    if (key !== "ref" && key !== "semanticHash") {
      diagnostics.push(
        unsupported(`unsupported import field "${key}"`, `${path}.${key}`),
      );
    }
  }
  if (
    typeof entry.ref !== "string" ||
    entry.ref.length === 0 ||
    entry.ref.length > MAX_REF_LENGTH ||
    entry.ref.trim() !== entry.ref
  ) {
    diagnostics.push(
      invalid(
        "import ref must be one exact bounded non-empty string",
        `${path}.ref`,
      ),
    );
    return undefined;
  }
  if (
    typeof entry.semanticHash !== "string" ||
    !SHA256.test(entry.semanticHash)
  ) {
    diagnostics.push(
      invalid(
        "import semanticHash must be an exact lowercase SHA-256 digest",
        `${path}.semanticHash`,
      ),
    );
    return undefined;
  }
  return Object.freeze({
    ref: entry.ref,
    semanticHash: entry.semanticHash as `sha256:${string}`,
  });
}

function sortImports(
  entries: readonly DslV2ContentAddressedImport[],
): readonly DslV2ContentAddressedImport[] {
  return Object.freeze(
    entries
      .map((entry) => Object.freeze({ ...entry }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { DslDiagnostic } from "../types.js";
import type { DslV2ConfigReference, DslV2ConfigReferenceKind } from "./types.js";

/**
 * Closed set of config reference kinds a `dzupflow/v2` document may declare.
 * A document declares reference *names* only; the host binds their values at
 * run time, so no value slot exists anywhere in the `config:` block.
 */
export const DSL_V2_CONFIG_REFERENCE_KINDS: readonly DslV2ConfigReferenceKind[] =
  Object.freeze(["model", "provider", "environment"]);

const REFERENCE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;
const ENTRY_KEYS = new Set(["kind", "description"]);
const MAX_DESCRIPTION_LENGTH = 200;
const REDACTED_SEGMENT = "<redacted>";

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["provider key prefix", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["provider key prefix", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["provider key prefix", /\bgh[opsu]_[A-Za-z0-9]{16,}/],
  ["provider key prefix", /\bgithub_pat_[A-Za-z0-9_]{8,}/],
  ["provider key prefix", /\bglpat-[A-Za-z0-9_-]{8,}/],
  ["provider key prefix", /\bxox[abprs]-[A-Za-z0-9-]{8,}/],
  ["provider key prefix", /\b(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["provider key prefix", /\bAIza[A-Za-z0-9_-]{35}/],
  ["PEM block", /-----BEGIN[ A-Z]*-----/],
  ["authorization credential", /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{6,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ["URL with credentials", /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/],
];
const OPAQUE_RUN_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * Report whether `text` looks like a literal secret or credential. Returns
 * the pattern class (never the matched text) so callers can build a
 * diagnostic that does not echo the secret, or `undefined` when clean.
 */
export function findConfigLiteralSecret(text: string): string | undefined {
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  for (const run of text.match(OPAQUE_RUN_PATTERN) ?? []) {
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return "opaque token";
  }
  return undefined;
}

/**
 * Parse the optional top-level `config:` block of a `dzupflow/v2` document.
 * Returns `undefined` when the block is absent, so metadata for documents
 * without it is unchanged. Refusals are pushed onto `diagnostics`; their
 * messages and paths never contain secret-shaped text.
 */
export function parseV2ConfigReferences(
  raw: unknown,
  diagnostics: DslDiagnostic[]
): readonly DslV2ConfigReference[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message: "dzupflow/v2 config must be an object of reference declarations",
      path: "root.config",
    });
    return [];
  }
  const references: DslV2ConfigReference[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const nameLeak = findConfigLiteralSecret(name);
    const path = `root.config.${nameLeak === undefined ? name : REDACTED_SEGMENT}`;
    if (nameLeak !== undefined) {
      diagnostics.push(literalSecret(nameLeak, path));
    } else if (!REFERENCE_NAME_PATTERN.test(name)) {
      diagnostics.push(
        invalid(
          "config reference name must match ^[a-z][A-Za-z0-9_]{0,63}$",
          path
        )
      );
    }
    const reference = parseEntry(entry, path, diagnostics);
    if (reference !== undefined && nameLeak === undefined) {
      references.push({ name, ...reference });
    }
  }
  return references.sort((left, right) => left.name.localeCompare(right.name));
}

function parseEntry(
  entry: unknown,
  path: string,
  diagnostics: DslDiagnostic[]
): Omit<DslV2ConfigReference, "name"> | undefined {
  if (!isRecord(entry)) {
    const leak =
      typeof entry === "string" ? findConfigLiteralSecret(entry) : undefined;
    diagnostics.push(
      leak === undefined
        ? {
            phase: "normalize",
            code: "CONFIG_LITERAL_VALUE",
            message:
              "config entries declare a reference ({ kind, description? }); the document declares names and the host binds values",
            path,
          }
        : literalSecret(leak, path)
    );
    return undefined;
  }
  let valid = true;
  for (const [key, value] of Object.entries(entry)) {
    const keyLeak = findConfigLiteralSecret(key);
    const keyPath = `${path}.${keyLeak === undefined ? key : REDACTED_SEGMENT}`;
    if (keyLeak !== undefined) {
      diagnostics.push(literalSecret(keyLeak, keyPath));
      valid = false;
      continue;
    }
    if (ENTRY_KEYS.has(key)) continue;
    valid = false;
    diagnostics.push(
      invalid(
        `config reference field "${key}" is not allowed; the document declares names and the host binds values`,
        keyPath
      )
    );
    if (typeof value === "string") {
      const leak = findConfigLiteralSecret(value);
      if (leak !== undefined) diagnostics.push(literalSecret(leak, keyPath));
    }
  }
  const kind = entry.kind;
  if (
    typeof kind !== "string" ||
    !(DSL_V2_CONFIG_REFERENCE_KINDS as readonly string[]).includes(kind)
  ) {
    valid = false;
    diagnostics.push(
      invalid(
        `config reference kind must be one of ${DSL_V2_CONFIG_REFERENCE_KINDS.join(", ")}`,
        `${path}.kind`
      )
    );
  }
  const description = entry.description;
  if (description !== undefined) {
    const descriptionPath = `${path}.description`;
    if (typeof description !== "string") {
      valid = false;
      diagnostics.push(
        invalid("config reference description must be a string", descriptionPath)
      );
    } else {
      const leak = findConfigLiteralSecret(description);
      if (leak !== undefined) {
        valid = false;
        diagnostics.push(literalSecret(leak, descriptionPath));
      } else if (description.length > MAX_DESCRIPTION_LENGTH) {
        valid = false;
        diagnostics.push(
          invalid(
            `config reference description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
            descriptionPath
          )
        );
      }
    }
  }
  if (!valid) return undefined;
  return {
    kind: kind as DslV2ConfigReferenceKind,
    ...(description === undefined ? {} : { description: description as string }),
  };
}

function literalSecret(label: string, path: string): DslDiagnostic {
  return {
    phase: "normalize",
    code: "CONFIG_LITERAL_SECRET",
    message: `config contains a value that looks like a secret (${label}); dzupflow/v2 documents declare reference names and the host binds values`,
    path,
  };
}

function invalid(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "CONFIG_REFERENCE_INVALID", message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

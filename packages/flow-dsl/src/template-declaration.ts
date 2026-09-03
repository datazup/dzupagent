/**
 * Prompt-template variable declarations (ADR-0001 C1, framework half).
 *
 * `template.ts` already validates a template's *sections* against frontmatter.
 * Nothing validated its *variables*: a template could reference `{{ ROLE_LABLE }}`
 * and render an empty string forever, and a digest pin would happily prove that
 * the typo had not changed. This module closes that gap on the framework side
 * using the same contract the lab adopted in `scripts` (`b69754a8`), so both
 * stacks check rendered payloads against one shared definition.
 *
 * Shape follows the lab's sidecar decision rather than frontmatter: 0 of the 35
 * lab templates carry frontmatter, so a sidecar is purely additive.
 *
 * Divergence from the lab, deliberate: the lab throws on the first defect
 * (it is a build gate), while this returns a result carrying every diagnostic,
 * matching the result-based convention used across flow-dsl.
 */

import { canonicalDigestPrefixed } from "@dzupagent/canonical-json";

export const PROMPT_TEMPLATE_DECLARATION_SCHEMA =
  "flow-prompt-lab/prompt-template-declaration/v1";

/** Permissive scan, so malformed tokens surface as errors instead of vanishing. */
const PLACEHOLDER_SCAN = /\{\{\s*([^}]+?)\s*\}\}/gu;

/**
 * A well-formed placeholder: a dotted path of identifier segments. Covers both
 * dialects in use — `inputs.currentTask` / `state.loop.iteration` and bare
 * `SCREAMING_CASE` tokens. Kept identical to the lab's grammar; the two
 * previously disagreed, which let a pinned fingerprint describe different text
 * than a step actually rendered.
 */
const PLACEHOLDER_EXPRESSION =
  // Same shape as definition-v2: each repetition is gated by a literal `.` that
  // the identifier class cannot match, so no two repetitions compete for the
  // same input. Measured flat: 10k-char adversarial dotted input 0.60ms.
  // eslint-disable-next-line security/detect-unsafe-regex -- False positive.
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

/** Paths that must never be interpolated into a prompt body. */
const SENSITIVE_PATH_SEGMENT = /(^|\.)(secret|token|password|apiKey)s?(\.|$)/iu;

export interface TemplateVariableDeclaration {
  readonly required: boolean;
  readonly description?: string;
}

export interface TemplateDeclaration {
  readonly schema: string;
  readonly id: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

export interface TemplateDeclarationDiagnostic {
  readonly code:
    | "TEMPLATE_DECLARATION_INVALID"
    | "TEMPLATE_UNDECLARED_VARIABLE"
    | "TEMPLATE_STALE_VARIABLE"
    | "TEMPLATE_SENSITIVE_VARIABLE";
  readonly message: string;
  readonly path: string;
}

export interface TemplateDeclarationOk {
  readonly ok: true;
  readonly status: "consistent";
  readonly id: string;
  readonly referencedPaths: readonly string[];
  readonly requiredVariables: readonly string[];
  readonly fingerprint: `sha256:${string}`;
}

export interface TemplateDeclarationFailure {
  readonly ok: false;
  readonly id: string;
  readonly undeclared: readonly string[];
  readonly unused: readonly string[];
  readonly diagnostics: readonly TemplateDeclarationDiagnostic[];
}

export type TemplateDeclarationResult =
  | TemplateDeclarationOk
  | TemplateDeclarationFailure;

/** Extract the deduped, sorted set of placeholder paths a template references. */
export function templatePlaceholderPaths(template: string): readonly string[] {
  const found = new Set<string>();
  for (const match of String(template ?? "").matchAll(PLACEHOLDER_SCAN)) {
    const expression = (match[1] ?? "").trim();
    if (!PLACEHOLDER_EXPRESSION.test(expression)) {
      throw new Error(
        `Malformed placeholder expression in template: {{ ${expression} }}`,
      );
    }
    found.add(expression);
  }
  return [...found].sort();
}

/**
 * Join what a template *declares* against what it actually *references*.
 *
 * A digest pin proves a template has not changed; it says nothing about whether
 * the template was ever correct. This is the check that makes the pin
 * meaningful: an undeclared placeholder (typically a typo) and a
 * declared-but-unreferenced variable (a stale contract) are both failures.
 */
export function reconcileTemplateDeclaration(input: {
  readonly id: string;
  readonly template: string;
  readonly declaration: TemplateDeclaration;
}): TemplateDeclarationResult {
  const { id, template, declaration } = input;
  const diagnostics: TemplateDeclarationDiagnostic[] = [];

  if (declaration.schema !== PROMPT_TEMPLATE_DECLARATION_SCHEMA) {
    diagnostics.push({
      code: "TEMPLATE_DECLARATION_INVALID",
      message: `declaration schema must be ${PROMPT_TEMPLATE_DECLARATION_SCHEMA}`,
      path: `${id}.schema`,
    });
    return failure(id, [], [], diagnostics);
  }

  const declared = new Map<string, TemplateVariableDeclaration>();
  for (const [name, raw] of Object.entries(declaration.variables ?? {})) {
    const path = `${id}.variables.${name}`;
    if (!PLACEHOLDER_EXPRESSION.test(name)) {
      diagnostics.push({
        code: "TEMPLATE_DECLARATION_INVALID",
        message: `declared variable name "${name}" is not a well-formed placeholder path`,
        path,
      });
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      diagnostics.push({
        code: "TEMPLATE_DECLARATION_INVALID",
        message: `declared variable "${name}" must be an object`,
        path,
      });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.required !== "boolean") {
      diagnostics.push({
        code: "TEMPLATE_DECLARATION_INVALID",
        message: `declared variable "${name}" must carry a boolean "required"`,
        path: `${path}.required`,
      });
      continue;
    }
    if (
      entry.description !== undefined &&
      typeof entry.description !== "string"
    ) {
      diagnostics.push({
        code: "TEMPLATE_DECLARATION_INVALID",
        message: `declared variable "${name}" description must be a string`,
        path: `${path}.description`,
      });
      continue;
    }
    declared.set(name, {
      required: entry.required,
      description:
        typeof entry.description === "string" ? entry.description : "",
    });
  }

  let referenced: readonly string[];
  try {
    referenced = templatePlaceholderPaths(template);
  } catch (error) {
    diagnostics.push({
      code: "TEMPLATE_DECLARATION_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: `${id}.template`,
    });
    return failure(id, [], [], diagnostics);
  }

  for (const expression of referenced) {
    if (SENSITIVE_PATH_SEGMENT.test(expression)) {
      diagnostics.push({
        code: "TEMPLATE_SENSITIVE_VARIABLE",
        message: `template references a sensitive path: ${expression}`,
        path: `${id}.template`,
      });
    }
  }

  const declaredNames = [...declared.keys()].sort();
  const undeclared = referenced.filter((name) => !declared.has(name));
  const unused = declaredNames.filter((name) => !referenced.includes(name));

  for (const name of undeclared) {
    diagnostics.push({
      code: "TEMPLATE_UNDECLARED_VARIABLE",
      message: `template ${id} references undeclared variable "${name}"`,
      path: `${id}.template`,
    });
  }
  for (const name of unused) {
    diagnostics.push({
      code: "TEMPLATE_STALE_VARIABLE",
      message: `template ${id} declares unused (stale) variable "${name}"`,
      path: `${id}.variables.${name}`,
    });
  }

  if (diagnostics.length > 0) {
    return failure(id, undeclared, unused, diagnostics);
  }

  // Fingerprint the declared contract, not the prose: the same variable set
  // with the same requiredness yields the same fingerprint regardless of key
  // order or wording changes elsewhere in the template body.
  const payload = {
    schema: PROMPT_TEMPLATE_DECLARATION_SCHEMA,
    id,
    variables: Object.fromEntries(
      declaredNames.map((name) => {
        const entry = declared.get(name) as TemplateVariableDeclaration;
        return [
          name,
          { required: entry.required, description: entry.description ?? "" },
        ];
      }),
    ),
    requiredVariables: declaredNames.filter(
      (name) => declared.get(name)?.required === true,
    ),
  };

  return Object.freeze({
    ok: true as const,
    status: "consistent" as const,
    id,
    referencedPaths: referenced,
    requiredVariables: payload.requiredVariables,
    // authoring-v1 is the exact port of the private stableStringify/sha256
    // pair this file used to carry, so template fingerprints are
    // byte-identical (corpus-proven old-vs-preset, ARCH27-T-13).
    fingerprint: canonicalDigestPrefixed(payload, "authoring-v1"),
  });
}

function failure(
  id: string,
  undeclared: readonly string[],
  unused: readonly string[],
  diagnostics: readonly TemplateDeclarationDiagnostic[],
): TemplateDeclarationFailure {
  return Object.freeze({
    ok: false as const,
    id,
    undeclared: Object.freeze([...undeclared]),
    unused: Object.freeze([...unused]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

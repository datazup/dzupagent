import { createHash } from "node:crypto";

import type {
  VersionMigrationFixture,
  VersionMigrationFixtureResult,
  VersionMigrationHandlers,
  VersionMigrationPreview,
  VersionMigrationQualificationReport,
  VersionMigrationRef,
  VersionMigrationRegistry,
} from "./types.js";

/** Execute an isolated deterministic transform and return evidence without applying it. */
export function previewVersionMigration(
  migrationRef: VersionMigrationRef,
  input: unknown,
  registry: VersionMigrationRegistry,
  handlers: VersionMigrationHandlers,
): VersionMigrationPreview {
  const definition = registry.get(migrationRef);
  if (definition === undefined) {
    throw new Error(`migration registry does not contain ${migrationRef}`);
  }
  const before = cloneJson(input, `migration ${migrationRef} input`);
  const beforeDigest = digest(before);
  if (definition.classification === "incompatible") {
    return deepFreeze({
      schema: "dzupagent.versionMigrationPreview/v1",
      migrationRef,
      migrationHash: definition.migrationHash,
      classification: definition.classification,
      status: "blocked-incompatible",
      fromRef: definition.fromRef,
      toRef: definition.toRef,
      fromSemanticHash: definition.fromSemanticHash,
      toSemanticHash: definition.toSemanticHash,
      beforeDigest,
      changed: false,
      rollback: {
        kind: definition.rollback.kind,
        detail:
          definition.rollback.kind === "manual"
            ? definition.rollback.instructions
            : definition.rollback.kind === "unavailable"
              ? definition.rollback.reason
              : "No transform is available for an incompatible migration.",
      },
    }) as VersionMigrationPreview;
  }

  const transform = requireHandler(
    definition.transformRef!,
    handlers.transforms,
    "transform",
  );
  const output = runDeterministic(
    transform,
    before,
    `${migrationRef} transform`,
  );
  const afterDigest = digest(output);
  const projection =
    definition.semanticProjectionRef === undefined
      ? undefined
      : requireHandler(
          definition.semanticProjectionRef,
          handlers.projections ?? {},
          "semantic projection",
        );
  const beforeSemantic =
    projection === undefined
      ? undefined
      : runDeterministic(
          projection,
          before,
          `${migrationRef} source semantic projection`,
        );
  const afterSemantic =
    projection === undefined
      ? undefined
      : runDeterministic(
          projection,
          output,
          `${migrationRef} target semantic projection`,
        );
  const beforeSemanticDigest =
    beforeSemantic === undefined ? undefined : digest(beforeSemantic);
  const afterSemanticDigest =
    afterSemantic === undefined ? undefined : digest(afterSemantic);

  const rollback =
    definition.rollback.kind === "exact"
      ? exactRollback(
          definition.rollback.transformRef,
          output,
          beforeDigest,
          handlers,
          migrationRef,
        )
      : {
          kind: definition.rollback.kind,
          detail:
            definition.rollback.kind === "manual"
              ? definition.rollback.instructions
              : definition.rollback.reason,
        };

  return deepFreeze({
    schema: "dzupagent.versionMigrationPreview/v1",
    migrationRef,
    migrationHash: definition.migrationHash,
    classification: definition.classification,
    status: "previewed",
    fromRef: definition.fromRef,
    toRef: definition.toRef,
    fromSemanticHash: definition.fromSemanticHash,
    toSemanticHash: definition.toSemanticHash,
    beforeDigest,
    afterDigest,
    changed: beforeDigest !== afterDigest,
    ...(beforeSemanticDigest === undefined
      ? {}
      : {
          semanticEquivalent: beforeSemanticDigest === afterSemanticDigest,
          beforeSemanticDigest,
          afterSemanticDigest,
        }),
    rollback,
    output,
  }) as VersionMigrationPreview;
}

/** Qualify one migration against a hash-pinned fixture set. */
export function qualifyVersionMigration(
  migrationRef: VersionMigrationRef,
  fixtures: readonly VersionMigrationFixture[],
  registry: VersionMigrationRegistry,
  handlers: VersionMigrationHandlers,
): VersionMigrationQualificationReport {
  if (fixtures.length === 0) {
    throw new Error(`migration ${migrationRef} requires at least one fixture`);
  }
  const ids = new Set<string>();
  const results: VersionMigrationFixtureResult[] = fixtures.map((fixture) => {
    if (fixture.id.trim().length === 0 || ids.has(fixture.id)) {
      throw new Error(`migration ${migrationRef} has an empty or duplicate fixture id`);
    }
    ids.add(fixture.id);
    const preview = previewVersionMigration(
      migrationRef,
      fixture.input,
      registry,
      handlers,
    );
    const diagnostics: string[] = [];
    if (preview.status === "blocked-incompatible") {
      diagnostics.push("MIGRATION_INCOMPATIBLE");
    }
    const expectedOutputDigest =
      fixture.expectedOutput === undefined
        ? undefined
        : digest(
            cloneJson(
              fixture.expectedOutput,
              `migration ${migrationRef} expected output`,
            ),
          );
    if (
      expectedOutputDigest !== undefined &&
      preview.afterDigest !== expectedOutputDigest
    ) {
      diagnostics.push("MIGRATION_EXPECTED_OUTPUT_MISMATCH");
    }
    if (
      preview.classification === "equivalent" &&
      preview.semanticEquivalent !== true
    ) {
      diagnostics.push("MIGRATION_SEMANTIC_EQUIVALENCE_FAILED");
    }
    if (
      preview.rollback.kind === "exact" &&
      preview.rollback.restoresInput !== true
    ) {
      diagnostics.push("MIGRATION_EXACT_ROLLBACK_FAILED");
    }
    return deepFreeze({
      id: fixture.id,
      passed: diagnostics.length === 0,
      ...(expectedOutputDigest === undefined ? {} : { expectedOutputDigest }),
      preview,
      diagnostics: Object.freeze(diagnostics),
    }) as VersionMigrationFixtureResult;
  });
  const definition = registry.get(migrationRef);
  if (definition === undefined) {
    throw new Error(`migration registry does not contain ${migrationRef}`);
  }
  return deepFreeze({
    schema: "dzupagent.versionMigrationQualification/v1",
    migrationRef,
    migrationHash: definition.migrationHash,
    fixtureSetHash: digest(
      fixtures
        .map((fixture) => ({
          id: fixture.id,
          inputDigest: digest(
            cloneJson(fixture.input, `fixture ${fixture.id}`),
          ),
          expectedOutputDigest:
            fixture.expectedOutput === undefined
              ? null
              : digest(
                  cloneJson(
                    fixture.expectedOutput,
                    `fixture ${fixture.id} expected output`,
                  ),
                ),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    ready: results.every((result) => result.passed),
    results: Object.freeze(results),
  }) as VersionMigrationQualificationReport;
}

function exactRollback(
  handlerRef: string,
  output: unknown,
  beforeDigest: `sha256:${string}`,
  handlers: VersionMigrationHandlers,
  migrationRef: VersionMigrationRef,
): {
  kind: "exact";
  digest: `sha256:${string}`;
  restoresInput: boolean;
} {
  const reverse = requireHandler(
    handlerRef,
    handlers.transforms,
    "rollback transform",
  );
  const restored = runDeterministic(
    reverse,
    output,
    `${migrationRef} rollback transform`,
  );
  const rollbackDigest = digest(restored);
  return {
    kind: "exact",
    digest: rollbackDigest,
    restoresInput: rollbackDigest === beforeDigest,
  };
}

function runDeterministic(
  handler: (value: unknown) => unknown,
  input: unknown,
  label: string,
): unknown {
  const firstInput = cloneJson(input, `${label} input`);
  const secondInput = cloneJson(input, `${label} replay input`);
  const first = cloneJson(handler(firstInput), `${label} output`);
  const second = cloneJson(handler(secondInput), `${label} replay output`);
  if (digest(first) !== digest(second)) {
    throw new Error(`${label} is nondeterministic`);
  }
  return first;
}

function requireHandler(
  ref: string,
  handlers: Readonly<
    Record<string, ((value: unknown) => unknown) | undefined>
  >,
  kind: string,
): (value: unknown) => unknown {
  const handler = handlers[ref];
  if (handler === undefined) {
    throw new Error(`${kind} handler "${ref}" is not registered`);
  }
  return handler;
}

function cloneJson(value: unknown, label: string): unknown {
  try {
    assertFiniteJson(value, new WeakSet<object>());
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON");
    return deepFreeze(JSON.parse(encoded) as unknown);
  } catch {
    throw new Error(`${label} must be finite JSON data`);
  }
}

function assertFiniteJson(value: unknown, seen: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error("non-JSON value");
  if (seen.has(value)) throw new Error("cyclic value");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertFiniteJson(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-plain object");
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      assertFiniteJson(nested, seen);
    }
  }
  seen.delete(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreeze(item)));
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        deepFreeze(nested),
      ]),
    ),
  );
}

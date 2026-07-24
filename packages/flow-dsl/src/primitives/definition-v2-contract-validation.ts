import type { PrimitiveDefinitionV2 } from "./types.js";

const CLASSIFICATIONS = new Set(["public", "internal", "sensitive", "secret"]);
const EFFECT_CLASSES = new Set([
  "read",
  "compute",
  "llm",
  "file_write",
  "code_change",
  "network_write",
  "db_write",
  "human_decision",
  "queue_publish",
]);

/** Runtime enum and scalar validation for externally supplied V2 manifests. */
export function validatePrimitiveDefinitionV2ContractValues(
  definition: PrimitiveDefinitionV2,
  identity: string,
): void {
  if (definition.schema !== "dzupagent.primitiveDefinition/v2") {
    throw new Error(`primitive ${identity} has an invalid schema identity`);
  }
  validateNonEmpty(
    [
      definition.name,
      definition.version,
      definition.owner,
      definition.requiresKernel,
    ],
    `primitive ${identity} identity fields`,
  );
  validateEnum(
    definition.stability,
    ["experimental", "beta", "stable", "deprecated"],
    `primitive ${identity} stability`,
  );
  validateEnum(
    definition.category,
    ["leaf", "composite", "validator", "transformer", "governance"],
    `primitive ${identity} category`,
  );
  if (
    definition.acceptedInputClassifications.some(
      (classification) => !CLASSIFICATIONS.has(classification),
    )
  ) {
    throw new Error(`primitive ${identity} has an invalid input classification`);
  }
  if (
    Object.values(definition.inputPathClassifications ?? {}).some(
      (classification) => !CLASSIFICATIONS.has(classification),
    )
  ) {
    throw new Error(
      `primitive ${identity} has an invalid input-path classification`,
    );
  }
  if (
    definition.effect.classes.some(
      (effectClass) => !EFFECT_CLASSES.has(effectClass),
    )
  ) {
    throw new Error(`primitive ${identity} has an invalid effect class`);
  }
  validateEnum(
    definition.effect.idempotency,
    ["pure", "idempotent", "at-least-once", "exactly-once-required"],
    `primitive ${identity} idempotency`,
  );
  validateEnum(
    definition.effect.replay,
    ["safe", "deduplicated", "not-replayable"],
    `primitive ${identity} replay policy`,
  );
  validateEnum(
    definition.execution.kind,
    ["expand", "runtime-leaf", "host-action"],
    `primitive ${identity} execution kind`,
  );
  definition.execution.delivery.forEach((value) =>
    validateEnum(
      value,
      ["inline", "queued", "detached"],
      `primitive ${identity} delivery mode`,
    ),
  );
  definition.execution.durability.forEach((value) =>
    validateEnum(
      value,
      ["volatile", "checkpointed", "durable"],
      `primitive ${identity} durability mode`,
    ),
  );
  validateEnum(
    definition.execution.cancellation,
    ["none", "cooperative", "required"],
    `primitive ${identity} cancellation`,
  );
  validateEnum(
    definition.evidence.rawContent,
    ["forbidden", "ephemeral", "allowed-by-policy"],
    `primitive ${identity} raw evidence policy`,
  );
  for (const [port, output] of Object.entries(definition.outputPorts)) {
    if (!CLASSIFICATIONS.has(output.classification)) {
      throw new Error(
        `primitive ${identity} output port "${port}" has an invalid classification`,
      );
    }
    validateEnum(
      output.cardinality,
      ["one", "optional", "many"],
      `primitive ${identity} output port "${port}" cardinality`,
    );
    validateEnum(
      output.persistence,
      ["state", "artifact", "ephemeral"],
      `primitive ${identity} output port "${port}" persistence`,
    );
  }
  if (
    definition.redactionRequiredAbove !== undefined &&
    !CLASSIFICATIONS.has(definition.redactionRequiredAbove)
  ) {
    throw new Error(`primitive ${identity} has an invalid redaction threshold`);
  }
}

function validateNonEmpty(values: readonly string[], label: string): void {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must be non-empty strings`);
  }
}

function validateEnum(
  value: string,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
}

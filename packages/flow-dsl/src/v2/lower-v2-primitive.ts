import type { PrimitiveDefinitionV2 } from "../primitives/types.js";
import type { PrimitivePolicyNarrowing } from "./policy-narrowing.js";
import { evaluatePrimitivePolicyNarrowing } from "./policy-narrowing.js";
import type { PrimitiveRetryPolicy } from "./retry-policy.js";
import { evaluatePrimitiveRetryPolicy } from "./retry-policy.js";
import type {
  PrimitiveTerminalCatchContract,
} from "./terminal-catch.js";
import {
  evaluatePrimitiveTerminalCatch,
} from "./terminal-catch.js";
import type {
  PrimitiveMultiPortSaveContract,
} from "./multi-port-save.js";
import {
  evaluatePrimitiveMultiPortSave,
} from "./multi-port-save.js";
import type { V2LoweringContext } from "./lower-v2-context.js";

const STATE_TARGET_PATTERN = /^state\.([A-Za-z][A-Za-z0-9_]*)$/;
const LEGACY_OUTPUT_FIELDS: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    "adapter.run": "output",
    http: "outputVar",
    "shell.run": "output",
    "evidence.write": "output",
    "validate.schema": "output",
  });

export function lowerV2Save(
  raw: unknown,
  definition: PrimitiveDefinitionV2,
  body: Record<string, unknown>,
  authoredPath: string,
  context: V2LoweringContext,
  options: {
    readonly guarded: boolean;
    readonly terminalCatchContinues: boolean;
  },
): {
  readonly legacyBindings: Readonly<Record<string, string>>;
  readonly multiPortSave?: PrimitiveMultiPortSaveContract;
} {
  if (raw === undefined) return { legacyBindings: {} };
  if (!isRecord(raw)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message: "v2 save must map one output port to state.<key>",
      path: `${authoredPath}.save`,
    });
    return { legacyBindings: {} };
  }
  const entries = Object.entries(raw);
  if (entries.length !== 1) {
    const result = evaluatePrimitiveMultiPortSave(definition, raw, options);
    if (!result.ok) {
      for (const error of result.errors) {
        context.diagnostics.push({
          phase: "normalize",
          code: error.code,
          message: error.message,
          path:
            error.field === undefined
              ? `${authoredPath}.save`
              : `${authoredPath}.save.${error.field}`,
        });
      }
      return { legacyBindings: {} };
    }
    const outputField = LEGACY_OUTPUT_FIELDS[primitiveKind(definition)];
    if (outputField === undefined) {
      context.diagnostics.push({
        phase: "normalize",
        code: "V2_UNSUPPORTED_SAVE",
        message:
          `P3a has no canonical v1 save adapter for ${definition.ref}`,
        path: `${authoredPath}.save`,
      });
      return { legacyBindings: {} };
    }
    const compatibilityBinding =
      result.contract.bindings.find((binding) => binding.port === "result") ??
      result.contract.bindings[0]!;
    body[outputField] = compatibilityBinding.destination.key;
    context.multiPortSaves.push({
      authoredPath,
      primitiveRef: definition.ref,
      primitiveSemanticHash: definition.compatibility.semanticHash,
      save: result.contract,
    });
    return {
      legacyBindings: {
        [outputField]: compatibilityBinding.port,
      },
      multiPortSave: result.contract,
    };
  }
  const [port, target] = entries[0]!;
  if (!(port in definition.outputPorts)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNKNOWN_OUTPUT_PORT",
      message: `primitive ${definition.ref} does not declare output port "${port}"`,
      path: `${authoredPath}.save.${port}`,
    });
    return { legacyBindings: {} };
  }
  if (typeof target !== "string") {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_INVALID_SAVE_TARGET",
      message: "P3a save target must be state.<key>",
      path: `${authoredPath}.save.${port}`,
    });
    return { legacyBindings: {} };
  }
  const targetMatch = STATE_TARGET_PATTERN.exec(target);
  if (targetMatch === null) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_INVALID_SAVE_TARGET",
      message: `P3a save target must be state.<key>; received "${target}"`,
      path: `${authoredPath}.save.${port}`,
    });
    return { legacyBindings: {} };
  }
  const outputField = LEGACY_OUTPUT_FIELDS[primitiveKind(definition)];
  if (outputField === undefined) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNSUPPORTED_SAVE",
      message: `P3a has no canonical v1 save adapter for ${definition.ref}`,
      path: `${authoredPath}.save`,
    });
    return { legacyBindings: {} };
  }
  body[outputField] = targetMatch[1]!;
  return { legacyBindings: { [outputField]: port } };
}

export function registerV2Primitive(
  definition: PrimitiveDefinitionV2,
  authoredPath: string,
  context: V2LoweringContext,
): void {
  context.bindings.set(
    definition.ref,
    definition.compatibility.semanticHash,
  );
  if (definition.namespace.length === 0) return;
  const prior = context.namespaceVersions.get(definition.namespace);
  if (prior !== undefined && prior !== definition.version) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_NAMESPACE_VERSION_CONFLICT",
      message: `P3a cannot lower ${definition.namespace}@${prior} and ${definition.namespace}@${definition.version} through one v1 namespace import`,
      path: `${authoredPath}.use`,
    });
    return;
  }
  context.namespaceVersions.set(definition.namespace, definition.version);
}

export function lowerV2RetryPolicy(
  raw: unknown,
  definition: PrimitiveDefinitionV2,
  authoredPath: string,
  context: V2LoweringContext,
): PrimitiveRetryPolicy | undefined {
  if (raw === undefined) return undefined;
  const result = evaluatePrimitiveRetryPolicy(definition, raw);
  if (!result.ok) {
    for (const error of result.errors) {
      context.diagnostics.push({
        phase: "normalize",
        code: error.code,
        message: error.message,
        path:
          error.field === undefined
            ? `${authoredPath}.retry`
            : `${authoredPath}.retry.${error.field}`,
      });
    }
    return undefined;
  }
  context.retryPolicies.push({
    authoredPath,
    primitiveRef: definition.ref,
    primitiveSemanticHash: definition.compatibility.semanticHash,
    retry: result.policy,
  });
  return result.policy;
}

export function lowerV2TerminalCatch(
  raw: unknown,
  definition: PrimitiveDefinitionV2,
  authoredPath: string,
  context: V2LoweringContext,
): PrimitiveTerminalCatchContract | undefined {
  if (raw === undefined) return undefined;
  const result = evaluatePrimitiveTerminalCatch(definition, raw);
  if (!result.ok) {
    for (const error of result.errors) {
      context.diagnostics.push({
        phase: "normalize",
        code: error.code,
        message: error.message,
        path:
          error.field === undefined
            ? `${authoredPath}.catch`
            : `${authoredPath}.catch${error.field.startsWith("[") ? "" : "."}${error.field}`,
      });
    }
    return undefined;
  }
  context.terminalCatches.push({
    authoredPath,
    primitiveRef: definition.ref,
    primitiveSemanticHash: definition.compatibility.semanticHash,
    catch: result.contract,
  });
  return result.contract;
}

export function lowerV2PolicyNarrowing(
  raw: unknown,
  definition: PrimitiveDefinitionV2,
  authoredPath: string,
  context: V2LoweringContext,
): PrimitivePolicyNarrowing | undefined {
  if (raw === undefined) return undefined;
  const result = evaluatePrimitivePolicyNarrowing(
    definition,
    raw,
    context.inheritedPolicy,
  );
  if (!result.ok) {
    for (const error of result.errors) {
      context.diagnostics.push({
        phase: "normalize",
        code: error.code,
        message: error.message,
        path:
          error.field === undefined
            ? `${authoredPath}.policy`
            : `${authoredPath}.policy.${error.field}`,
      });
    }
    return undefined;
  }
  context.policyNarrowings.push({
    authoredPath,
    primitiveRef: definition.ref,
    primitiveSemanticHash: definition.compatibility.semanticHash,
    narrowing: result.narrowing,
  });
  return result.narrowing;
}

function primitiveKind(definition: PrimitiveDefinitionV2): string {
  return definition.namespace.length === 0
    ? definition.name
    : `${definition.namespace}.${definition.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

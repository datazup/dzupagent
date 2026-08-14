import type { FlowNode } from "@dzupagent/flow-ast";
import { evaluateFlowTypedCondition } from "@dzupagent/flow-ast/typed-condition-evaluator";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  primitiveKind,
  type DslV2FrontendMetadata,
} from "@dzupagent/flow-dsl";

import { prepareFlowInputFromDsl } from "../authoring-input.js";
import { createFlowCompiler } from "../index.js";
import {
  validateCompilerPrimitiveRegistry,
  validateFlowPrimitiveSelections,
} from "../primitive-registry-admission.js";
import type {
  V2InactiveLocalTargetQualificationError,
  V2InactiveLocalTargetQualificationRequest,
  V2InactiveLocalTargetQualificationResult,
} from "./contracts.js";
import {
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  V2_INACTIVE_LOCAL_TARGET_GATE_CODES,
  V2_INACTIVE_LOCAL_TARGET_ID,
} from "./contracts.js";
import {
  collectPrimitiveContractEvidence,
  collectTypedConditions,
  deepFreeze,
  digest,
  stableStringify,
  validatePrimitiveContractIdentities,
} from "./evidence.js";

/**
 * Qualify the complete provider-free V2 capability set on an inactive target.
 *
 * The qualifier evaluates typed conditions and binds every remaining V2
 * contract to its exact primitive ref/hash. It emits deterministic evidence
 * only: no compiler artifact, primitive attempt, provider call, state write,
 * continuation, deployment, promotion, or activation is possible here.
 */
export function qualifyV2InactiveLocalTarget(
  request: V2InactiveLocalTargetQualificationRequest
): Promise<V2InactiveLocalTargetQualificationResult> {
  return qualify(request);
}

async function qualify(
  request: V2InactiveLocalTargetQualificationRequest
): Promise<V2InactiveLocalTargetQualificationResult> {
  const capabilityError = validateExactCapabilities(request.hostCapabilities);
  if (capabilityError !== undefined) return fail(capabilityError);
  if (
    request.compilerOptions.referencePolicy !== "strict" ||
    request.compilerOptions.target !== undefined ||
    request.compilerOptions.targetCapabilities !== undefined
  ) {
    return fail({
      code: "V2_LOCAL_TARGET_STRICT_COMPILER_REQUIRED",
      message:
        "inactive local target qualification requires strict reference validation with no external target-resolution hint or artifact-emission capability advertisement",
      path: "compilerOptions",
    });
  }

  if (request.compilerOptions.primitiveRegistry !== undefined) {
    const registryValidation = validateCompilerPrimitiveRegistry(
      request.compilerOptions.primitiveRegistry,
      request.compilerOptions.primitiveBindings
    );
    if (!registryValidation.valid) {
      return fail({
        code: "V2_LOCAL_TARGET_REGISTRY_INVALID",
        message:
          "inactive local target qualification requires an additive compiler registry and exact binding hashes",
        path: "primitiveRegistry",
        causes: registryValidation.issues,
      });
    }
  }

  const prepared = prepareFlowInputFromDsl(request.source, {
    ...(request.compilerOptions.primitiveRegistry === undefined
      ? {}
      : {
          primitiveRegistry: request.compilerOptions.primitiveRegistry,
        }),
    ...(request.compilerOptions.primitiveExpansionHandlers === undefined
      ? {}
      : {
          primitiveExpansionHandlers:
            request.compilerOptions.primitiveExpansionHandlers,
        }),
  });
  if (!prepared.ok) {
    return fail({
      code: "V2_LOCAL_TARGET_SOURCE_INVALID",
      message: "inactive local target qualification requires valid DSL source",
      path: "root",
      causes: Object.freeze(
        prepared.errors.map(
          (error) => `${error.code}:${error.nodePath}:${error.message}`
        )
      ),
    });
  }
  if (prepared.frontend?.authoredDsl !== "dzupflow/v2") {
    return fail({
      code: "V2_LOCAL_TARGET_V2_SOURCE_REQUIRED",
      message:
        "inactive local target qualification accepts only explicit dzupflow/v2 source",
      path: "root.dsl",
    });
  }

  const root = prepared.flowInput as FlowNode;
  const externalBindingErrors = validateExternalFrontendBindings(
    prepared.frontend,
    request
  );
  if (externalBindingErrors.length > 0) {
    return fail({
      code: "V2_LOCAL_TARGET_PRIMITIVE_BINDING_REQUIRED",
      message:
        "inactive local target qualification requires every external primitive to have an exact compiler ref/hash binding",
      path: "compilerOptions.primitiveBindings",
      causes: externalBindingErrors,
    });
  }
  const selectionIssues = validateFlowPrimitiveSelections(
    root,
    request.compilerOptions.primitiveRegistry,
    request.compilerOptions.primitiveBindings
  );
  if (selectionIssues.length > 0) {
    return fail({
      code: "V2_LOCAL_TARGET_PRIMITIVE_BINDING_REQUIRED",
      message:
        "inactive local target qualification requires every external primitive to have an exact compiler ref/hash binding",
      path: selectionIssues[0]?.nodePath ?? "root",
      causes: Object.freeze(selectionIssues.map((issue) => issue.message)),
    });
  }

  const typedConditions = collectTypedConditions(root);
  const frontend = prepared.frontend;
  const coverage = Object.freeze({
    typedConditions: typedConditions.length,
    policyNarrowings: frontend.policyNarrowings.length,
    retryPolicies: frontend.retryPolicies.length,
    terminalCatches: frontend.terminalCatches.length,
    multiPortSaves: frontend.multiPortSaves.length,
  });
  const missingCoverage = Object.entries(coverage)
    .filter(([, count]) => count === 0)
    .map(([name]) => name);
  if (missingCoverage.length > 0) {
    return fail({
      code: "V2_LOCAL_TARGET_COVERAGE_INCOMPLETE",
      message: `inactive local target qualification must exercise all five V2 capabilities; missing ${missingCoverage.join(
        ", "
      )}`,
      path: "root",
    });
  }

  const identityErrors = validatePrimitiveContractIdentities(frontend);
  if (identityErrors.length > 0) {
    return { ok: false, errors: deepFreeze(identityErrors) };
  }

  const compilerGate = await validateCompilerGate(request);
  if (compilerGate !== undefined) return fail(compilerGate);

  const conditionEvaluationMode = request.conditionEvaluationMode ?? "eager";
  const conditionEvaluations = [];
  for (const item of typedConditions) {
    if (conditionEvaluationMode === "deferred-runtime") {
      conditionEvaluations.push({
        path: item.path,
        status: "deferred-runtime" as const,
      });
      continue;
    }
    const evaluation = evaluateFlowTypedCondition(item.condition, {
      hostCapabilities: request.hostCapabilities,
      bindings: request.conditionBindings,
    });
    if (!evaluation.ok) {
      return fail({
        code: "V2_LOCAL_TARGET_TYPED_CONDITION_FAILED",
        message: evaluation.message,
        path: `${item.path}.${evaluation.path}`,
        causes: Object.freeze([evaluation.code]),
      });
    }
    conditionEvaluations.push({
      path: item.path,
      status: "evaluated" as const,
      value: evaluation.value,
      resolvedReferences: Object.freeze([...evaluation.resolvedReferences]),
    });
  }

  const primitiveContracts = collectPrimitiveContractEvidence(frontend);
  const sourceSha256 = digest(request.source);
  const receiptCore = {
    schema: "dzupagent.v2InactiveLocalTargetQualification/v1" as const,
    target: V2_INACTIVE_LOCAL_TARGET_ID,
    status: "qualified-inactive" as const,
    sourceSha256,
    capabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    compilerGate: Object.freeze({
      referencePolicy: "strict" as const,
      artifactEmission: "blocked" as const,
      observedDiagnostics: V2_INACTIVE_LOCAL_TARGET_GATE_CODES,
    }),
    coverage,
    conditionEvaluationMode,
    conditionEvaluations: Object.freeze(conditionEvaluations),
    primitiveContracts,
    lifecycle: Object.freeze({
      activation: "inactive" as const,
      cancellation: "not-applicable-before-activation" as const,
      restart: "requalify-exact-source-and-capabilities" as const,
      evidence: "deterministic-qualification-receipt-only" as const,
    }),
    authority: Object.freeze({
      artifactEmission: false as const,
      primitiveExecution: false as const,
      providerDispatch: false as const,
      stateMutation: false as const,
      continuation: false as const,
      deployment: false as const,
      promotion: false as const,
      activation: false as const,
    }),
  };
  return {
    ok: true,
    receipt: deepFreeze({
      ...receiptCore,
      qualificationSha256: digest(stableStringify(receiptCore)),
    }),
  };
}

async function validateCompilerGate(
  request: V2InactiveLocalTargetQualificationRequest
): Promise<V2InactiveLocalTargetQualificationError | undefined> {
  let compiled;
  try {
    compiled = await createFlowCompiler(request.compilerOptions).compileDsl(
      request.source
    );
  } catch (error) {
    return {
      code: "V2_LOCAL_TARGET_COMPILER_GATE_REQUIRED",
      message:
        "inactive local target qualification could not construct the normal compiler pipeline",
      path: "compilerOptions",
      causes: Object.freeze([
        error instanceof Error ? error.message : String(error),
      ]),
    };
  }
  if (!("errors" in compiled)) {
    return {
      code: "V2_LOCAL_TARGET_COMPILER_GATE_REQUIRED",
      message:
        "inactive local target qualification requires generic artifact emission to remain blocked",
      path: "root",
    };
  }

  const expected = new Set<string>(V2_INACTIVE_LOCAL_TARGET_GATE_CODES);
  const observed = new Set(compiled.errors.map((error) => error.code));
  const unexpected = compiled.errors.filter(
    (error) => !expected.has(error.code)
  );
  const missing = [...expected].filter((code) => !observed.has(code));
  if (unexpected.length > 0 || missing.length > 0) {
    return {
      code: "V2_LOCAL_TARGET_COMPILER_GATE_REQUIRED",
      message:
        "inactive local target qualification requires a semantically valid flow blocked only by all five reviewed V2 target gates",
      path: "root",
      causes: Object.freeze([
        ...unexpected.map(
          (error) => `${error.code}:${error.nodePath}:${error.message}`
        ),
        ...missing.map((code) => `missing:${code}`),
      ]),
    };
  }
  return undefined;
}

function validateExternalFrontendBindings(
  frontend: DslV2FrontendMetadata,
  request: V2InactiveLocalTargetQualificationRequest
): readonly string[] {
  const errors: string[] = [];
  for (const selected of frontend.primitiveBindings) {
    if (BUILT_IN_PRIMITIVE_REGISTRY_V2.get(selected.ref) !== undefined) {
      continue;
    }
    const definition = request.compilerOptions.primitiveRegistry?.get(
      selected.ref
    );
    if (definition === undefined) {
      errors.push(`selected external primitive ${selected.ref} is unavailable`);
      continue;
    }
    const kind = primitiveKind(definition);
    const binding = request.compilerOptions.primitiveBindings?.[kind];
    if (
      binding?.ref !== selected.ref ||
      binding.semanticHash !== selected.semanticHash
    ) {
      errors.push(
        `selected external primitive ${selected.ref} requires an exact compiler binding`
      );
    }
  }
  return Object.freeze(errors);
}

function validateExactCapabilities(
  capabilities: readonly string[]
): V2InactiveLocalTargetQualificationError | undefined {
  const actual = [...capabilities].sort();
  const expected = [...V2_INACTIVE_LOCAL_TARGET_CAPABILITIES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((capability, index) => capability !== expected[index])
  ) {
    return {
      code: "V2_LOCAL_TARGET_EXACT_CAPABILITIES_REQUIRED",
      message:
        "inactive local target qualification requires exactly the five reviewed V2 capabilities with no omissions, duplicates, or additions",
      path: "hostCapabilities",
      causes: Object.freeze([
        `expected:${expected.join(",")}`,
        `actual:${actual.join(",")}`,
      ]),
    };
  }
  return undefined;
}

function fail(
  error: V2InactiveLocalTargetQualificationError
): V2InactiveLocalTargetQualificationResult {
  return { ok: false, errors: deepFreeze([error]) };
}

import type { FlowCompiledClassificationEnvelope } from "./classification-envelope-types.js";
import { validateFlowCompiledClassificationEnvelope } from "./classification-envelope-validation.js";

export interface FlowClassificationHostAdmissionRequest {
  readonly envelope: unknown;
  readonly expectedSemanticHash: string;
  readonly expectedClassificationHash?: `sha256:${string}`;
  readonly expectedCompileId?: string;
  readonly availableCapabilities: readonly string[];
}

export interface FlowClassificationHostAdmission {
  readonly admitted: boolean;
  readonly issues: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly envelope?: FlowCompiledClassificationEnvelope;
}

/**
 * Fail-closed admission for strict or unattended hosts.
 *
 * The host must supply the semantic identity it intends to execute and its
 * currently available capabilities. Missing or incomplete envelopes are never
 * treated as compatibility-mode success.
 */
export function admitFlowCompiledClassificationEnvelope(
  request: FlowClassificationHostAdmissionRequest,
): FlowClassificationHostAdmission {
  const validation = validateFlowCompiledClassificationEnvelope(
    request.envelope,
  );
  if (!validation.valid) {
    return frozenAdmission(false, validation.issues, [], []);
  }
  const envelope = request.envelope as FlowCompiledClassificationEnvelope;
  const issues: string[] = [];
  if (envelope.semanticHash !== request.expectedSemanticHash) {
    issues.push("semanticHash does not match the admitted artifact");
  }
  if (
    request.expectedClassificationHash !== undefined &&
    envelope.classificationHash !== request.expectedClassificationHash
  ) {
    issues.push("classificationHash does not match the admitted artifact");
  }
  if (
    request.expectedCompileId !== undefined &&
    envelope.compileId !== request.expectedCompileId
  ) {
    issues.push("compileId does not match the admitted compile");
  }
  if (!envelope.classificationComplete) {
    issues.push(
      `classification coverage is incomplete: ${envelope.unclassifiedReferences.join(", ")}`,
    );
  }
  const requiredCapabilities = collectRequiredCapabilities(envelope);
  const available = new Set(request.availableCapabilities);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !available.has(capability),
  );
  for (const capability of missingCapabilities) {
    issues.push(`required host capability is unavailable: ${capability}`);
  }
  return frozenAdmission(
    issues.length === 0,
    issues,
    requiredCapabilities,
    missingCapabilities,
    envelope,
  );
}

function collectRequiredCapabilities(
  envelope: FlowCompiledClassificationEnvelope,
): string[] {
  const required = new Set<string>();
  for (const primitive of envelope.primitives) {
    for (const capability of primitive.requiredCapabilities) {
      required.add(capability);
    }
    if (primitive.credential?.resolverCapabilityRef !== undefined) {
      required.add(primitive.credential.resolverCapabilityRef);
    }
  }
  return [...required].sort((left, right) => left.localeCompare(right));
}

function frozenAdmission(
  admitted: boolean,
  issues: readonly string[],
  requiredCapabilities: readonly string[],
  missingCapabilities: readonly string[],
  envelope?: FlowCompiledClassificationEnvelope,
): FlowClassificationHostAdmission {
  return Object.freeze({
    admitted,
    issues: Object.freeze([...issues]),
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    missingCapabilities: Object.freeze([...missingCapabilities]),
    ...(envelope === undefined ? {} : { envelope }),
  });
}

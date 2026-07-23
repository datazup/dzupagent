import type {
  FlowCredentialHandle,
  FlowCredentialHandleResolver,
  FlowCredentialLease,
  FlowCredentialResolution,
  FlowCredentialUse,
} from "@dzupagent/flow-ast";
import {
  FLOW_CREDENTIAL_LEASE_SCHEMA,
  isFlowCredentialHandle,
} from "@dzupagent/flow-ast";

import type { FlowCompiledClassificationEnvelope } from "./classification-envelope-types.js";
import { validateFlowCompiledClassificationEnvelope } from "./classification-envelope-validation.js";

export interface FlowEnvelopeCredentialLeaseRequest {
  readonly envelope: FlowCompiledClassificationEnvelope;
  readonly nodePath: string;
  readonly inputPath: string;
  readonly handle: FlowCredentialHandle;
  readonly resolver: FlowCredentialHandleResolver;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly now?: Date;
}

export interface FlowEnvelopeToolCredentialLeaseRequest {
  readonly envelope: FlowCompiledClassificationEnvelope;
  readonly nodePath: string;
  readonly inputPath: string;
  readonly handle: FlowCredentialHandle;
  readonly resolver: FlowCredentialHandleResolver;
  /** Current host-registry identity for the exact tool policy. */
  readonly expectedPolicyHash: `sha256:${string}`;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly now?: Date;
}

/**
 * Resolve only an envelope-authorized opaque handle use and verify the
 * returned lease is bound to that exact handle and capability.
 */
export async function resolveFlowCredentialLeaseForEnvelope(
  request: FlowEnvelopeCredentialLeaseRequest,
): Promise<FlowCredentialResolution> {
  const envelopeValidation = validateFlowCompiledClassificationEnvelope(
    request.envelope,
  );
  if (!envelopeValidation.valid) {
    return denied("CLASSIFICATION_ENVELOPE_INVALID");
  }
  if (!request.envelope.classificationComplete) {
    return denied("CLASSIFICATION_ENVELOPE_INCOMPLETE");
  }
  const primitive = request.envelope.primitives.find(
    (entry) => entry.nodePath === request.nodePath,
  );
  if (primitive === undefined) {
    return denied("PRIMITIVE_NOT_ADMITTED");
  }
  if (primitive.credential === undefined) {
    return denied("CREDENTIAL_USE_FORBIDDEN");
  }
  if (
    !primitive.credential.inputPaths.some((pattern) =>
      matchesInputPath(pattern, request.inputPath),
    )
  ) {
    return denied("CREDENTIAL_PATH_NOT_ADMITTED");
  }
  const capability = primitive.credential.resolverCapabilityRef;
  if (capability === undefined) {
    return denied("CREDENTIAL_RESOLVER_CAPABILITY_MISSING");
  }
  if (!primitive.requiredCapabilities.includes(capability)) {
    return denied("CREDENTIAL_RESOLVER_CAPABILITY_NOT_REQUIRED");
  }
  if (!isFlowCredentialHandle(request.handle)) {
    return denied("CREDENTIAL_HANDLE_INVALID");
  }
  if (
    primitive.credential.allowedProviders !== undefined &&
    (request.handle.provider === undefined ||
      !primitive.credential.allowedProviders.includes(request.handle.provider))
  ) {
    return denied("CREDENTIAL_PROVIDER_NOT_ADMITTED");
  }
  if (
    primitive.credential.requiredScopes !== undefined &&
    primitive.credential.requiredScopes.some(
      (scope) => !request.handle.scopes.includes(scope),
    )
  ) {
    return denied("CREDENTIAL_SCOPE_NOT_ADMITTED");
  }
  const use: FlowCredentialUse = Object.freeze({
    primitiveRef: primitive.primitiveRef,
    inputPath: request.inputPath,
    capabilityRef: capability,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.attemptId === undefined
      ? {}
      : { attemptId: request.attemptId }),
  });
  return resolveAuthorizedCredential(
    request.handle,
    capability,
    use,
    request.resolver,
    request.now ?? new Date(),
  );
}

/**
 * Resolve a tool credential only when the compiled integration obligation,
 * exact path, provider, scopes, and resolver capability all match.
 */
export async function resolveFlowToolCredentialLeaseForEnvelope(
  request: FlowEnvelopeToolCredentialLeaseRequest,
): Promise<FlowCredentialResolution> {
  const validation = validateFlowCompiledClassificationEnvelope(
    request.envelope,
  );
  if (!validation.valid) return denied("CLASSIFICATION_ENVELOPE_INVALID");
  if (!request.envelope.classificationComplete) {
    return denied("CLASSIFICATION_ENVELOPE_INCOMPLETE");
  }
  const integration = request.envelope.integrations.find(
    (entry) => entry.nodePath === request.nodePath,
  );
  if (integration === undefined) return denied("TOOL_NOT_ADMITTED");
  const credential = integration.credential;
  if (credential === undefined) return denied("CREDENTIAL_USE_FORBIDDEN");
  if (integration.policyHash !== request.expectedPolicyHash) {
    return denied("TOOL_SECURITY_POLICY_HASH_MISMATCH");
  }
  if (
    !credential.inputPaths.some((pattern) =>
      matchesInputPath(pattern, request.inputPath),
    )
  ) {
    return denied("CREDENTIAL_PATH_NOT_ADMITTED");
  }
  if (!isFlowCredentialHandle(request.handle)) {
    return denied("CREDENTIAL_HANDLE_INVALID");
  }
  if (
    request.handle.provider === undefined ||
    !credential.allowedProviders.includes(request.handle.provider)
  ) {
    return denied("CREDENTIAL_PROVIDER_NOT_ADMITTED");
  }
  if (
    credential.requiredScopes.some(
      (scope) => !request.handle.scopes.includes(scope),
    )
  ) {
    return denied("CREDENTIAL_SCOPE_NOT_ADMITTED");
  }
  const capability = credential.resolverCapabilityRef;
  const use: FlowCredentialUse = Object.freeze({
    toolRef: integration.toolRef,
    inputPath: request.inputPath,
    capabilityRef: capability,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.attemptId === undefined
      ? {}
      : { attemptId: request.attemptId }),
  });
  return resolveAuthorizedCredential(
    request.handle,
    capability,
    use,
    request.resolver,
    request.now ?? new Date(),
  );
}

async function resolveAuthorizedCredential(
  handle: FlowCredentialHandle,
  capability: string,
  use: FlowCredentialUse,
  resolver: FlowCredentialHandleResolver,
  now: Date,
): Promise<FlowCredentialResolution> {
  if (!isFlowCredentialHandle(handle)) {
    return denied("CREDENTIAL_HANDLE_INVALID");
  }
  if (handle.capabilityRef !== capability) {
    return denied("CREDENTIAL_HANDLE_CAPABILITY_MISMATCH");
  }
  if (expired(handle.expiresAt, now)) {
    return Object.freeze({ status: "expired", code: "CREDENTIAL_HANDLE_EXPIRED" });
  }
  let resolution: unknown;
  try {
    resolution = await resolver.resolve(handle, use);
  } catch {
    return Object.freeze({
      status: "unavailable",
      code: "CREDENTIAL_RESOLVER_FAILED",
    });
  }
  if (!isRecord(resolution) || typeof resolution.status !== "string") {
    return Object.freeze({
      status: "unavailable",
      code: "CREDENTIAL_RESOLUTION_INVALID",
    });
  }
  if (resolution.status !== "resolved") {
    if (
      (resolution.status !== "denied" &&
        resolution.status !== "unavailable" &&
        resolution.status !== "expired") ||
      typeof resolution.code !== "string" ||
      resolution.code.trim().length === 0
    ) {
      return Object.freeze({
        status: "unavailable",
        code: "CREDENTIAL_RESOLUTION_INVALID",
      });
    }
    return Object.freeze({
      status: resolution.status,
      code: resolution.code,
      ...(typeof resolution.message !== "string"
        ? {}
        : { message: resolution.message }),
    });
  }
  if (!("lease" in resolution)) {
    return Object.freeze({
      status: "unavailable",
      code: "CREDENTIAL_RESOLUTION_INVALID",
    });
  }
  const issue = validateLease(
    resolution.lease,
    handle.handleId,
    capability,
    now,
  );
  if (issue !== undefined) {
    if (isRecord(resolution.lease)) {
      await releaseInvalidLease(
        resolver,
        resolution.lease as unknown as FlowCredentialLease,
      );
    }
    return denied(issue);
  }
  return Object.freeze({
    status: "resolved",
    lease: freezeLease(resolution.lease as FlowCredentialLease),
  });
}

function matchesInputPath(pattern: string, actual: string): boolean {
  const expected = pattern.split(".");
  const observed = actual.split(".");
  if (expected.length !== observed.length) return false;
  return expected.every(
    (segment, index) => segment === "*" || segment === observed[index],
  );
}

function validateLease(
  lease: unknown,
  handleId: string,
  capabilityRef: string,
  now: Date,
): string | undefined {
  if (!isRecord(lease)) {
    return "CREDENTIAL_LEASE_INVALID";
  }
  if (lease.schema !== FLOW_CREDENTIAL_LEASE_SCHEMA) {
    return "CREDENTIAL_LEASE_SCHEMA_INVALID";
  }
  if (typeof lease.leaseId !== "string" || lease.leaseId.trim().length === 0) {
    return "CREDENTIAL_LEASE_ID_INVALID";
  }
  if (lease.handleId !== handleId) {
    return "CREDENTIAL_LEASE_HANDLE_MISMATCH";
  }
  if (lease.capabilityRef !== capabilityRef) {
    return "CREDENTIAL_LEASE_CAPABILITY_MISMATCH";
  }
  if (typeof lease.expiresAt === "string" && expired(lease.expiresAt, now)) {
    return "CREDENTIAL_LEASE_EXPIRED";
  }
  if (
    lease.expiresAt !== undefined &&
    (typeof lease.expiresAt !== "string" || !validDate(lease.expiresAt))
  ) {
    return "CREDENTIAL_LEASE_EXPIRATION_INVALID";
  }
  return undefined;
}

async function releaseInvalidLease(
  resolver: FlowCredentialHandleResolver,
  lease: FlowCredentialLease,
): Promise<void> {
  try {
    await resolver.release?.(lease);
  } catch {
    // Admission remains denied even when best-effort cleanup fails.
  }
}

function freezeLease(lease: FlowCredentialLease): FlowCredentialLease {
  return Object.freeze({
    schema: FLOW_CREDENTIAL_LEASE_SCHEMA,
    leaseId: lease.leaseId,
    handleId: lease.handleId,
    capabilityRef: lease.capabilityRef,
    ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }),
  });
}

function denied(code: string): FlowCredentialResolution {
  return Object.freeze({ status: "denied", code });
}

function expired(value: string | undefined, now: Date): boolean {
  return value !== undefined && validDate(value) && Date.parse(value) <= now.getTime();
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

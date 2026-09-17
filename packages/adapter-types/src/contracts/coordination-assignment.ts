/**
 * Coordination assignment consumer contracts (B3-CP-03).
 *
 * Types only. DzupAgent decodes the sealed coordination execution assignment
 * (`datazup.coordination.execution-assignment/v2`) structurally, without a
 * dependency on the producer package, and composes it with a separate
 * DzupAgent execution binding into one immutable attempt-execution plan.
 *
 * The sealed assignment carries no provider fact. Provider, backend, model,
 * profile, auth, capabilities, tariff, session and reasoning effort come only
 * from {@link CoordinationExecutionBinding}; no authority grant can supply
 * them. Every fact in the plan keeps its own issuer, generation, validity and
 * scope.
 */
import type {
  ProviderSessionAttemptBinding,
  ProviderSessionCapability,
} from "@dzupagent/runtime-contracts/provider-session";

export type CoordinationSha256Digest = `sha256:${string}`;

// ---------------------------------------------------------------------------
// Decoded assignment view (mirrors the producer wire shape field for field)
// ---------------------------------------------------------------------------

export type CoordinationAuthorityFactClass =
  | "execution"
  | "placement"
  | "resource"
  | "effect"
  | "budget"
  | "integration";

export type CoordinationExecutionAssignmentRole =
  | "implementer"
  | "reviewer"
  | "observer"
  | "integration-requester";

export type CoordinationSessionEnrollmentState =
  | "enrolled"
  | "renewal_due"
  | "terminal"
  | "recovery_required";

export type CoordinationSessionInteractionMode =
  | "read_only"
  | "fast_mutation"
  | "planned_mutation"
  | "review"
  | "integration_request";

export type CoordinationSensitivityClass =
  | "public"
  | "internal"
  | "sensitive"
  | "restricted";

export type CoordinationContextPackRole =
  | "task"
  | "acceptance_spec"
  | "contract"
  | "local_guidance"
  | "architecture_intent"
  | "architecture_anchor_set"
  | "structural_snapshot"
  | "impact_slice"
  | "governing_decisions"
  | "implementation_ledger_slice"
  | "predecessor_checkpoint"
  | "validation_profile"
  | "curated_memory"
  | "provider_transcript";

export interface CoordinationProviderReferenceView {
  readonly schema: "datazup.orchestration.provider-reference/v1";
  readonly kind: string;
  readonly referenceId: string;
}

export interface CoordinationArtifactReferenceView {
  readonly schema: "datazup.orchestration.artifact-reference/v1";
  readonly artifactId: string;
  readonly digest: CoordinationSha256Digest;
  readonly mediaType: string;
  readonly sensitivity: CoordinationSensitivityClass;
  readonly retained: boolean;
}

export interface CoordinationSessionEnrollmentView {
  readonly schema: "datazup.coordination.session-enrollment/v1";
  readonly sessionId: string;
  readonly intentRef: string;
  readonly attemptId: string;
  readonly providerRef: CoordinationProviderReferenceView | null;
  readonly interactionMode: CoordinationSessionInteractionMode;
  readonly workspaceObservationRef: string;
  readonly programmeSpecDigest: CoordinationSha256Digest | null;
  readonly workIntentDigest: CoordinationSha256Digest;
  readonly observationCapabilityRef: string;
  readonly contextPackDigest: CoordinationSha256Digest | null;
  readonly renewalPolicyRef: string;
  readonly decisionDeadlinePolicyRef: string;
  readonly recoveryEndpointRef: string;
  readonly allowedEffects: readonly string[];
  readonly forbiddenEffects: readonly string[];
  readonly state: CoordinationSessionEnrollmentState;
  readonly generation: number;
  readonly enrolledAt: string;
  readonly expiresAt: string;
  readonly enrollmentDigest: CoordinationSha256Digest;
}

export interface CoordinationResourceClaimView {
  readonly schemaVersion: "resource-claim/v1";
  readonly claimId: string;
  readonly taskId: string;
  readonly resourceId: string;
  readonly mode: string;
  readonly scope: string;
  readonly baseFingerprint?: CoordinationSha256Digest;
  readonly semanticGroups?: readonly string[];
  readonly confidence: string;
  readonly enforcement: "required" | "advisory";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CoordinationWorkIntentView {
  readonly schemaVersion: "work-intent/v1";
  readonly programId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly dependencies: readonly string[];
  readonly claims: readonly CoordinationResourceClaimView[];
  readonly validationContractRef?: string;
  readonly authorityRequirements: readonly string[];
  readonly alternativeGroupId?: string;
}

export interface CoordinationSourceBindingView {
  readonly schema: "datazup.coordination.source-binding/v1";
  readonly repositoryId: string;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly status: "clean" | "dirty-overlay";
  readonly statusDigest: CoordinationSha256Digest;
  readonly overlayArtifact: CoordinationArtifactReferenceView | null;
  readonly overlayScopeDigest: CoordinationSha256Digest | null;
  readonly freshnessGeneration: number;
  readonly observedAt: string;
  readonly bindingDigest: CoordinationSha256Digest;
}

export interface CoordinationWorkspaceInstanceView {
  readonly schema: "datazup.coordination.workspace-instance/v2";
  readonly workspaceId: string;
  readonly logicalWorkspaceRef: string;
  readonly physicalDomainRef: string;
  readonly isolationStrategy: "isolated" | "shared-read-only" | "host-managed";
  readonly source: CoordinationSourceBindingView;
  readonly observationRef: string;
  readonly authorityBindingRef: string;
  readonly generation: number;
  readonly observedAt: string;
  readonly workspaceDigest: CoordinationSha256Digest;
}

export interface CoordinationAuthorityGrantView {
  readonly factClass: CoordinationAuthorityFactClass;
  readonly grantRef: string;
  readonly generation: number;
  readonly fenceRef: string;
  readonly notAfter: string;
  readonly requiredEffects: readonly string[];
  readonly coveredAuthorityRequirements: readonly string[];
}

export interface CoordinationAuthorityBundleView {
  readonly schema: "datazup.coordination.authority-bundle/v2";
  readonly bundleId: string;
  readonly grants: readonly CoordinationAuthorityGrantView[];
  readonly generation: number;
  readonly observedAt: string;
  readonly bundleDigest: CoordinationSha256Digest;
}

export interface CoordinationContextPackProfileView {
  readonly schema: "datazup.coordination.context-pack-profile/v2";
  readonly profileRef: CoordinationSha256Digest;
  readonly requiredRoles: readonly CoordinationContextPackRole[];
  readonly optionalRoles: readonly CoordinationContextPackRole[];
  readonly limits: {
    readonly maxInputTokens: number;
    readonly reservedOutputTokens: number;
    readonly reservedToolTokens: number;
  };
}

export interface CoordinationContextItemView {
  readonly role: CoordinationContextPackRole;
  readonly required: boolean;
  readonly artifact: CoordinationArtifactReferenceView;
  readonly contentDigest: CoordinationSha256Digest;
  readonly sourceBindingDigest: CoordinationSha256Digest;
  readonly freshness: "current" | "admitted-stale" | "unknown";
  readonly privacyLabel: CoordinationSensitivityClass;
}

export interface CoordinationContextOmissionView {
  readonly role: CoordinationContextPackRole;
  readonly required: false;
  readonly reasonCode: string;
  readonly evidenceRef: string;
}

export interface CoordinationContextPackManifestView {
  readonly schema: "datazup.coordination.context-pack-manifest/v2";
  readonly manifestId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly sourceBindingDigest: CoordinationSha256Digest;
  readonly profile: CoordinationContextPackProfileView;
  readonly items: readonly CoordinationContextItemView[];
  readonly omissions: readonly CoordinationContextOmissionView[];
  readonly privacyLabels: readonly CoordinationSensitivityClass[];
  readonly createdAt: string;
  readonly manifestDigest: CoordinationSha256Digest;
}

/** Deep-frozen, structurally decoded `datazup.coordination.execution-assignment/v2`. */
export interface CoordinationExecutionAssignmentView {
  readonly schema: "datazup.coordination.execution-assignment/v2";
  readonly assignmentId: string;
  readonly programmeSpecDigest: CoordinationSha256Digest;
  readonly sessionEnrollment: CoordinationSessionEnrollmentView;
  readonly attemptId: string;
  readonly generation: number;
  readonly role: CoordinationExecutionAssignmentRole;
  readonly workIntent: CoordinationWorkIntentView;
  readonly source: CoordinationSourceBindingView;
  readonly workspace: CoordinationWorkspaceInstanceView;
  readonly authorityBundle: CoordinationAuthorityBundleView;
  readonly providerRef: CoordinationProviderReferenceView | null;
  readonly contextPack: CoordinationContextPackManifestView;
  readonly processStrategyLockRef: CoordinationSha256Digest;
  readonly validationProfileRef: CoordinationSha256Digest;
  readonly allowedEffects: readonly string[];
  readonly forbiddenEffects: readonly string[];
  readonly issuedAt: string;
  readonly notAfter: string;
  readonly issuerRef: string;
  readonly assignmentDigest: CoordinationSha256Digest;
}

/** Embedded digests the decoder recomputed from the canonical unsigned bytes. */
export type CoordinationVerifiedDigest =
  | "assignmentDigest"
  | "sessionEnrollment.enrollmentDigest"
  | "sessionEnrollment.workIntentDigest"
  | "sessionEnrollment.contextPackDigest"
  | "source.bindingDigest"
  | "workspace.source.bindingDigest"
  | "workspace.workspaceDigest"
  | "authorityBundle.bundleDigest"
  | "contextPack.manifestDigest";

export interface CoordinationAssignmentDiagnostic {
  readonly code: string;
  /** JSON path into the assignment or binding; never a value. */
  readonly path: string;
  readonly message: string;
}

export interface DecodedCoordinationExecutionAssignment {
  readonly assignment: CoordinationExecutionAssignmentView;
  /** `sha256:` digest of the canonical JSON of the whole document. */
  readonly canonicalSeal: CoordinationSha256Digest;
  /** True only when the caller supplied an expected seal and it matched. */
  readonly sealVerified: boolean;
  readonly verifiedDigests: readonly CoordinationVerifiedDigest[];
}

export type CoordinationAssignmentDecodeResult =
  | { readonly ok: true; readonly value: DecodedCoordinationExecutionAssignment }
  | { readonly ok: false; readonly diagnostics: readonly CoordinationAssignmentDiagnostic[] };

// ---------------------------------------------------------------------------
// DzupAgent execution binding (the only source of provider facts)
// ---------------------------------------------------------------------------

export type CoordinationExecutionProviderId = "codex" | "claude";
export type CoordinationExecutionBackend = "cli" | "sdk";
export type CoordinationExecutionAuthMode = "subscription_cli" | "api_key";
export type CoordinationReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Auth is carried as a mode plus an opaque source reference, never a value. */
export interface CoordinationAuthReference {
  readonly mode: CoordinationExecutionAuthMode;
  /** Opaque reference resolved by the host; must equal the session binding's `authSourceRef`. */
  readonly sourceRef: string;
}

export interface CoordinationCapabilitySet {
  /** Attested provider-session binding: descriptor, capabilities and per-effect authority. */
  readonly providerSession: ProviderSessionAttemptBinding;
  /** Provider-session capabilities the attempt requires to be native. */
  readonly requiredCapabilities: readonly ProviderSessionCapability[];
  /** Coordination effects the bound host could perform (for `forbiddenEffects` checks). */
  readonly effects: readonly string[];
}

export interface CoordinationExecutionBinding {
  readonly schema: "dzupagent.coordinationExecutionBinding/v1";
  readonly bindingId: string;
  readonly providerId: CoordinationExecutionProviderId;
  /** Agent host backend. Never inferred from the provider. */
  readonly backend: CoordinationExecutionBackend;
  readonly model: string;
  readonly profileRef: string;
  readonly auth: CoordinationAuthReference;
  readonly capabilitySet: CoordinationCapabilitySet;
  /** Pricing reference; stays in the plan and attestation, never sent to the provider. */
  readonly tariffRef: string;
  /** Opaque provider-session reference the attempt opens. */
  readonly sessionRef: string;
  /** Effective reasoning effort; refused, never downgraded, when unsupported. */
  readonly reasoning: CoordinationReasoningEffort;
}

// ---------------------------------------------------------------------------
// Composed attempt-execution plan
// ---------------------------------------------------------------------------

/** A fact's own provenance: who issued it, which generation, until when, over what. */
export interface CoordinationFactProvenance {
  readonly issuerRef: string;
  readonly generation: number | null;
  readonly validFrom: string;
  readonly notAfter: string | null;
  readonly scope: string;
}

export interface CoordinationPlanAssignmentFact {
  readonly provenance: CoordinationFactProvenance;
  readonly assignmentId: string;
  readonly assignmentDigest: CoordinationSha256Digest;
  readonly canonicalSeal: CoordinationSha256Digest;
  readonly attemptId: string;
  readonly role: CoordinationExecutionAssignmentRole;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly sourceBindingDigest: CoordinationSha256Digest;
  readonly workspaceId: string;
  readonly workspaceDigest: CoordinationSha256Digest;
  readonly allowedEffects: readonly string[];
  readonly forbiddenEffects: readonly string[];
}

export interface CoordinationPlanSessionFact {
  readonly provenance: CoordinationFactProvenance;
  readonly sessionId: string;
  readonly enrollmentDigest: CoordinationSha256Digest;
  readonly state: CoordinationSessionEnrollmentState;
}

export interface CoordinationPlanGrantFact {
  readonly provenance: CoordinationFactProvenance;
  readonly factClass: CoordinationAuthorityFactClass;
  readonly grantRef: string;
  readonly fenceRef: string;
  readonly coveredAuthorityRequirements: readonly string[];
}

export interface CoordinationPlanAuthorityFact {
  readonly bundleId: string;
  readonly bundleDigest: CoordinationSha256Digest;
  readonly grants: readonly CoordinationPlanGrantFact[];
}

export interface CoordinationPlanExecutionFact {
  readonly provenance: CoordinationFactProvenance;
  readonly providerId: CoordinationExecutionProviderId;
  readonly backend: CoordinationExecutionBackend;
  readonly model: string;
  readonly profileRef: string;
  readonly authMode: CoordinationExecutionAuthMode;
  readonly authSourceRef: string;
  readonly capabilityDescriptorId: string;
  readonly nativeCapabilities: readonly ProviderSessionCapability[];
  readonly hostEffects: readonly string[];
  readonly tariffRef: string;
  readonly sessionRef: string;
  readonly reasoning: CoordinationReasoningEffort;
  /** Fingerprint of the model catalog that attested the reasoning effort. */
  readonly reasoningCatalogFingerprint: string;
}

export interface CoordinationPlanContextItem {
  readonly role: CoordinationContextPackRole;
  readonly artifactId: string;
  readonly contentDigest: CoordinationSha256Digest;
  readonly mediaType: string;
  readonly privacyLabel: CoordinationSensitivityClass;
  /** UTF-8 content whose sha256 equals `contentDigest`. */
  readonly content: string;
}

export interface CoordinationPlanContextFact {
  readonly provenance: CoordinationFactProvenance;
  readonly manifestId: string;
  readonly manifestDigest: CoordinationSha256Digest;
  readonly items: readonly CoordinationPlanContextItem[];
  readonly omittedRoles: readonly {
    readonly role: CoordinationContextPackRole;
    readonly reasonCode: string;
  }[];
}

/** Deep-frozen, provider-neutral plan for one coordination attempt. */
export interface CoordinationAttemptExecutionPlan {
  readonly schema: "dzupagent.coordinationAttemptExecutionPlan/v1";
  readonly composedAt: string;
  readonly assignment: CoordinationPlanAssignmentFact;
  readonly session: CoordinationPlanSessionFact;
  readonly authority: CoordinationPlanAuthorityFact;
  readonly execution: CoordinationPlanExecutionFact;
  readonly context: CoordinationPlanContextFact;
  /** `sha256:` digest of the canonical plan without this field. */
  readonly planDigest: CoordinationSha256Digest;
}

export type CoordinationAttemptExecutionPlanResult =
  | { readonly ok: true; readonly plan: CoordinationAttemptExecutionPlan }
  | { readonly ok: false; readonly refusals: readonly CoordinationAssignmentDiagnostic[] };

import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import {
  deserializeRecursiveScopedCommitV1,
  materializeRecursiveScopedCommitV1,
  serializeRecursiveScopedCommitV1,
  type RecursiveIntentClaimV1,
  type RecursiveScopedCommitBindingV1,
  type RecursiveScopedCommitV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  assertRecursiveAcknowledgementsKnownV1,
  reconcileRecursiveCommitSaveV1,
} from "./durable-child.js";
import type {
  RecursiveControlAbortStateV1,
  RecursiveControlCandidateSetV1,
  RecursiveControlCancellationV1,
  RecursiveControlCandidateV1,
  RecursiveControlCatchRouteV1,
  RecursiveControlCoordinatorV1,
  RecursiveControlDecisionV1,
  RecursiveControlPolicyV1,
  RecursiveControlPreparedChildV1,
  RecursiveControlRestoreV1,
  RecursiveControlScopeBindingV1,
} from "./control-types.js";
import type { RecursiveScopedDurablePortV1 } from "./types.js";

const DECISION_SCHEMA = "dzupagent.recursiveControlDecision/v1" as const;
const CANDIDATE_SET_SCHEMA =
  "dzupagent.recursiveControlCandidateSet/v1" as const;
const CANCELLATION_SCHEMA =
  "dzupagent.recursiveControlCancellation/v1" as const;
const CONTROL_KINDS = new Set([
  "interaction",
  "suspension",
  "terminal",
  "error",
]);

type ControlDeps = {
  readonly durable: RecursiveScopedDurablePortV1;
  readonly control: RecursiveControlCoordinatorV1;
};

export class RecursiveControlAbort extends Error {
  override readonly name = "RecursiveControlAbort";

  constructor(readonly state: RecursiveControlAbortStateV1) {
    super(`${state.status}:${state.reason}`);
  }
}

function abort(state: RecursiveControlAbortStateV1): never {
  throw new RecursiveControlAbort(state);
}

function digest(value: unknown): RecursiveScopedSha256Digest {
  return `sha256:${canonicalInputDigest(value)}`;
}

function isDigest(value: unknown): value is RecursiveScopedSha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((entry, index) => entry === path[index])
  );
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

async function storageCall<T>(
  childScopeId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    return abort({ status: "blocked", childScopeId, reason: "storage-error" });
  }
}

export function recursiveControlScopeIdentityV1(
  binding: RecursiveControlScopeBindingV1,
): RecursiveScopedSha256Digest {
  return digest({
    schema: "dzupagent.recursiveControlScope/v1",
    rootDefinitionDigest: binding.rootDefinitionDigest,
    ownerPath: binding.ownerPath,
    parentCommitIdentity: binding.parentCommitIdentity,
  });
}

function catchRouteFor(
  policy: RecursiveControlPolicyV1,
  frame: RecursiveScopedFrameV1,
  nodeId: string,
): RecursiveControlCatchRouteV1 | null {
  const matches = (policy.catchRoutes ?? []).filter(
    (route) => route.errorNodeId === nodeId,
  );
  if (matches.length === 0) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "catch-owner-missing",
    });
  }
  if (matches.length !== 1) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "catch-owner-ambiguous",
    });
  }
  const route = matches[0]!;
  if (
    route.catchNodeId.length === 0 ||
    !stringArray(route.catchOwnerPath) ||
    !isPathPrefix(route.catchOwnerPath, frame.ownerPath)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "control-intent-corrupt",
    });
  }
  return route;
}

function validateIntent(
  policy: RecursiveControlPolicyV1,
  frame: RecursiveScopedFrameV1,
  intent: RecursiveControlCandidateV1["intent"],
): RecursiveControlCatchRouteV1 | null {
  if (
    !CONTROL_KINDS.has(intent.kind) ||
    intent.intentKey.length === 0 ||
    intent.nodeId.length === 0 ||
    !frame.nodeInventory.includes(intent.nodeId)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "control-intent-corrupt",
    });
  }
  return intent.kind === "error"
    ? catchRouteFor(policy, frame, intent.nodeId)
    : null;
}

function commitBindingFor(
  frame: RecursiveScopedFrameV1,
): RecursiveScopedCommitBindingV1 {
  return {
    rootDefinitionDigest: frame.definition.rootDefinitionDigest,
    ownerPath: frame.ownerPath,
    childScopeId: frame.childScopeId,
    childScopeIdentity: frame.childScopeIdentity,
    frameKind: frame.frameKind,
    ownership: frame.ownership,
    frameIdentity: frame.frameIdentity,
    parentCommitIdentity: frame.parentCommitIdentity,
  };
}

type MaterializedControlCandidate = {
  readonly candidate: RecursiveControlCandidateV1;
  readonly catchRoute: RecursiveControlCatchRouteV1 | null;
  readonly commit: RecursiveScopedCommitV1;
};

function materializeCandidateSet(
  binding: RecursiveControlScopeBindingV1,
  entries: readonly MaterializedControlCandidate[],
): RecursiveControlCandidateSetV1 {
  const candidates = entries
    .map(({ candidate, commit }) => ({
      childScopeId: candidate.frame.childScopeId,
      frameIdentity: candidate.frame.frameIdentity,
      commitIdentity: commit.commitIdentity,
      serializedCommit: serializeRecursiveScopedCommitV1(commit),
    }))
    .sort((left, right) =>
      left.childScopeId.localeCompare(right.childScopeId) ||
      left.commitIdentity.localeCompare(right.commitIdentity),
    );
  if (
    candidates.length === 0 ||
    new Set(candidates.map(({ childScopeId }) => childScopeId)).size !==
      candidates.length
  ) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-intent-corrupt",
    });
  }
  const core = {
    schema: CANDIDATE_SET_SCHEMA,
    controlScopeIdentity: recursiveControlScopeIdentityV1(binding),
    rootDefinitionDigest: binding.rootDefinitionDigest,
    ownerPath: [...binding.ownerPath],
    parentCommitIdentity: binding.parentCommitIdentity,
    candidates,
  };
  return { ...core, candidateSetIdentity: digest(core) };
}

function parseCandidateSet(
  serialized: string,
  binding: RecursiveControlScopeBindingV1,
  policy: RecursiveControlPolicyV1,
  children: readonly RecursiveControlPreparedChildV1[],
): {
  readonly candidateSet: RecursiveControlCandidateSetV1;
  readonly candidates: readonly RecursiveControlCandidateV1[];
} {
  const value = parseJson(serialized);
  if (
    !record(value) ||
    !exactKeys(value, [
      "schema",
      "controlScopeIdentity",
      "rootDefinitionDigest",
      "ownerPath",
      "parentCommitIdentity",
      "candidates",
      "candidateSetIdentity",
    ]) ||
    value.schema !== CANDIDATE_SET_SCHEMA ||
    !isDigest(value.controlScopeIdentity) ||
    !isDigest(value.rootDefinitionDigest) ||
    !stringArray(value.ownerPath) ||
    !isDigest(value.parentCommitIdentity) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length === 0 ||
    !isDigest(value.candidateSetIdentity)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-candidate-set-corrupt",
    });
  }
  const { candidateSetIdentity, ...core } = value;
  if (candidateSetIdentity !== digest(core)) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-candidate-set-corrupt",
    });
  }
  if (
    value.controlScopeIdentity !== recursiveControlScopeIdentityV1(binding) ||
    value.rootDefinitionDigest !== binding.rootDefinitionDigest ||
    !sameStrings(value.ownerPath, binding.ownerPath) ||
    value.parentCommitIdentity !== binding.parentCommitIdentity
  ) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-candidate-set-drift",
    });
  }

  const parsed: RecursiveControlCandidateV1[] = [];
  const keys: string[] = [];
  for (const entry of value.candidates) {
    if (
      !record(entry) ||
      !exactKeys(entry, [
        "childScopeId",
        "frameIdentity",
        "commitIdentity",
        "serializedCommit",
      ]) ||
      typeof entry.childScopeId !== "string" ||
      entry.childScopeId.length === 0 ||
      !isDigest(entry.frameIdentity) ||
      !isDigest(entry.commitIdentity) ||
      typeof entry.serializedCommit !== "string"
    ) {
      return abort({
        status: "corrupt",
        childScopeId: undefined,
        reason: "control-candidate-set-corrupt",
      });
    }
    const key = `${entry.childScopeId}\u0000${entry.commitIdentity}`;
    keys.push(key);
    const child = children.find(
      ({ frame }) => frame.childScopeId === entry.childScopeId,
    );
    if (child === undefined || child.frame.frameIdentity !== entry.frameIdentity) {
      return abort({
        status: "corrupt",
        childScopeId: entry.childScopeId,
        reason: "control-candidate-set-drift",
      });
    }
    let commit: RecursiveScopedCommitV1;
    try {
      commit = deserializeRecursiveScopedCommitV1(
        entry.serializedCommit,
        commitBindingFor(child.frame),
      );
    } catch (error) {
      const drift =
        error instanceof Error && error.message.includes("binding failed");
      return abort({
        status: "corrupt",
        childScopeId: entry.childScopeId,
        reason: drift
          ? "control-candidate-set-drift"
          : "control-candidate-set-corrupt",
      });
    }
    const claim = commit.intentClaims[0];
    if (
      commit.commitIdentity !== entry.commitIdentity ||
      commit.intentClaims.length !== 1 ||
      claim === undefined ||
      claim.ownerFrameIdentity !== child.frame.frameIdentity
    ) {
      return abort({
        status: "corrupt",
        childScopeId: entry.childScopeId,
        reason: "control-candidate-set-corrupt",
      });
    }
    validateIntent(policy, child.frame, claim);
    parsed.push({
      frame: child.frame,
      intent: {
        kind: claim.kind,
        intentKey: claim.intentKey,
        nodeId: claim.nodeId,
      },
      committed: commit,
    });
  }
  if (
    new Set(keys).size !== keys.length ||
    keys.some((entry, index) => index > 0 && keys[index - 1]! > entry)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-candidate-set-corrupt",
    });
  }
  return {
    candidateSet: value as unknown as RecursiveControlCandidateSetV1,
    candidates: parsed,
  };
}

function materializeDecision(
  binding: RecursiveControlScopeBindingV1,
  candidate: RecursiveControlCandidateV1,
  commit: RecursiveScopedCommitV1,
  catchRoute: RecursiveControlCatchRouteV1 | null,
): RecursiveControlDecisionV1 {
  const core = {
    schema: DECISION_SCHEMA,
    controlScopeIdentity: recursiveControlScopeIdentityV1(binding),
    rootDefinitionDigest: binding.rootDefinitionDigest,
    ownerPath: [...binding.ownerPath],
    parentCommitIdentity: binding.parentCommitIdentity,
    kind: candidate.intent.kind,
    intentKey: candidate.intent.intentKey,
    nodeId: candidate.intent.nodeId,
    ownerChildScopeId: candidate.frame.childScopeId,
    ownerFrameIdentity: candidate.frame.frameIdentity,
    ownerCommitIdentity: commit.commitIdentity,
    catchRoute:
      catchRoute === null
        ? null
        : {
            catchNodeId: catchRoute.catchNodeId,
            catchOwnerPath: [...catchRoute.catchOwnerPath],
          },
  };
  return { ...core, decisionIdentity: digest(core) };
}

function parseDecision(
  serialized: string,
  binding: RecursiveControlScopeBindingV1,
): RecursiveControlDecisionV1 {
  const value = parseJson(serialized);
  if (
    !record(value) ||
    !exactKeys(value, [
      "schema",
      "controlScopeIdentity",
      "rootDefinitionDigest",
      "ownerPath",
      "parentCommitIdentity",
      "kind",
      "intentKey",
      "nodeId",
      "ownerChildScopeId",
      "ownerFrameIdentity",
      "ownerCommitIdentity",
      "catchRoute",
      "decisionIdentity",
    ]) ||
    value.schema !== DECISION_SCHEMA ||
    !isDigest(value.controlScopeIdentity) ||
    !isDigest(value.rootDefinitionDigest) ||
    !stringArray(value.ownerPath) ||
    !isDigest(value.parentCommitIdentity) ||
    typeof value.kind !== "string" ||
    !CONTROL_KINDS.has(value.kind) ||
    typeof value.intentKey !== "string" ||
    value.intentKey.length === 0 ||
    typeof value.nodeId !== "string" ||
    value.nodeId.length === 0 ||
    typeof value.ownerChildScopeId !== "string" ||
    value.ownerChildScopeId.length === 0 ||
    !isDigest(value.ownerFrameIdentity) ||
    !isDigest(value.ownerCommitIdentity) ||
    !isDigest(value.decisionIdentity)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: undefined,
      reason: "control-decision-corrupt",
    });
  }
  if (value.catchRoute !== null) {
    if (
      !record(value.catchRoute) ||
      !exactKeys(value.catchRoute, ["catchNodeId", "catchOwnerPath"]) ||
      typeof value.catchRoute.catchNodeId !== "string" ||
      value.catchRoute.catchNodeId.length === 0 ||
      !stringArray(value.catchRoute.catchOwnerPath)
    ) {
      return abort({
        status: "corrupt",
        childScopeId: value.ownerChildScopeId,
        reason: "control-decision-corrupt",
      });
    }
  }
  const { decisionIdentity, ...core } = value;
  if (decisionIdentity !== digest(core)) {
    return abort({
      status: "corrupt",
      childScopeId: value.ownerChildScopeId,
      reason: "control-decision-corrupt",
    });
  }
  if (
    value.controlScopeIdentity !== recursiveControlScopeIdentityV1(binding) ||
    value.rootDefinitionDigest !== binding.rootDefinitionDigest ||
    !sameStrings(value.ownerPath, binding.ownerPath) ||
    value.parentCommitIdentity !== binding.parentCommitIdentity
  ) {
    return abort({
      status: "corrupt",
      childScopeId: value.ownerChildScopeId,
      reason: "control-decision-drift",
    });
  }
  return value as unknown as RecursiveControlDecisionV1;
}

function materializeCancellation(
  decision: RecursiveControlDecisionV1,
  frame: RecursiveScopedFrameV1,
): RecursiveControlCancellationV1 {
  const core = {
    schema: CANCELLATION_SCHEMA,
    controlScopeIdentity: decision.controlScopeIdentity,
    parentCommitIdentity: decision.parentCommitIdentity,
    decisionIdentity: decision.decisionIdentity,
    ownerCommitIdentity: decision.ownerCommitIdentity,
    childScopeId: frame.childScopeId,
    childFrameIdentity: frame.frameIdentity,
  };
  return { ...core, cancellationIdentity: digest(core) };
}

function parseCancellation(
  serialized: string,
  decision: RecursiveControlDecisionV1,
  frame: RecursiveScopedFrameV1,
): RecursiveControlCancellationV1 {
  const value = parseJson(serialized);
  if (
    !record(value) ||
    !exactKeys(value, [
      "schema",
      "controlScopeIdentity",
      "parentCommitIdentity",
      "decisionIdentity",
      "ownerCommitIdentity",
      "childScopeId",
      "childFrameIdentity",
      "cancellationIdentity",
    ]) ||
    value.schema !== CANCELLATION_SCHEMA ||
    !isDigest(value.controlScopeIdentity) ||
    !isDigest(value.parentCommitIdentity) ||
    !isDigest(value.decisionIdentity) ||
    !isDigest(value.ownerCommitIdentity) ||
    typeof value.childScopeId !== "string" ||
    !isDigest(value.childFrameIdentity) ||
    !isDigest(value.cancellationIdentity)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "control-cancellation-corrupt",
    });
  }
  const { cancellationIdentity, ...core } = value;
  if (cancellationIdentity !== digest(core)) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "control-cancellation-corrupt",
    });
  }
  if (
    value.controlScopeIdentity !== decision.controlScopeIdentity ||
    value.parentCommitIdentity !== decision.parentCommitIdentity ||
    value.decisionIdentity !== decision.decisionIdentity ||
    value.ownerCommitIdentity !== decision.ownerCommitIdentity ||
    value.childScopeId !== frame.childScopeId ||
    value.childFrameIdentity !== frame.frameIdentity
  ) {
    return abort({
      status: "corrupt",
      childScopeId: frame.childScopeId,
      reason: "control-cancellation-drift",
    });
  }
  return value as unknown as RecursiveControlCancellationV1;
}

async function saveDecision(
  coordinator: RecursiveControlCoordinatorV1,
  decision: RecursiveControlDecisionV1,
): Promise<RecursiveControlDecisionV1> {
  const write = await storageCall(decision.ownerChildScopeId, () =>
    coordinator.durable.compareAndSaveControlDecision({
      controlScopeIdentity: decision.controlScopeIdentity,
      expectedDecisionIdentity: undefined,
      decisionIdentity: decision.decisionIdentity,
      serializedDecision: serialize(decision),
    }),
  );
  if (
    write.status === "committed" &&
    write.storedIdentity === decision.decisionIdentity
  ) {
    return decision;
  }
  const observed = await storageCall(decision.ownerChildScopeId, () =>
    coordinator.durable.loadControlDecision(decision.controlScopeIdentity),
  );
  if (observed === undefined) {
    return abort({
      status: "blocked",
      childScopeId: decision.ownerChildScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "control-decision-acknowledgement-unknown"
          : "control-decision-save-conflict",
    });
  }
  const restored = parseDecision(observed, decision);
  if (restored.decisionIdentity !== decision.decisionIdentity) {
    return abort({
      status: "blocked",
      childScopeId: decision.ownerChildScopeId,
      reason: "control-decision-save-conflict",
    });
  }
  return restored;
}

async function saveCancellation(
  coordinator: RecursiveControlCoordinatorV1,
  decision: RecursiveControlDecisionV1,
  frame: RecursiveScopedFrameV1,
): Promise<RecursiveControlCancellationV1> {
  const cancellation = materializeCancellation(decision, frame);
  const write = await storageCall(frame.childScopeId, () =>
    coordinator.durable.compareAndSaveControlCancellation({
      childScopeId: frame.childScopeId,
      expectedCancellationIdentity: undefined,
      cancellationIdentity: cancellation.cancellationIdentity,
      serializedCancellation: serialize(cancellation),
    }),
  );
  if (
    write.status === "committed" &&
    write.storedIdentity === cancellation.cancellationIdentity
  ) {
    return cancellation;
  }
  const observed = await storageCall(frame.childScopeId, () =>
    coordinator.durable.loadControlCancellation(frame.childScopeId),
  );
  if (observed === undefined) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason:
        write.status === "acknowledgement-lost"
          ? "cancellation-acknowledgement-unknown"
          : "cancellation-save-conflict",
    });
  }
  const restored = parseCancellation(observed, decision, frame);
  if (restored.cancellationIdentity !== cancellation.cancellationIdentity) {
    return abort({
      status: "blocked",
      childScopeId: frame.childScopeId,
      reason: "cancellation-save-conflict",
    });
  }
  return restored;
}

function assertDecisionOwner(
  policy: RecursiveControlPolicyV1,
  decision: RecursiveControlDecisionV1,
  children: readonly RecursiveControlPreparedChildV1[],
): RecursiveControlPreparedChildV1 {
  const owner = children.find(
    ({ frame }) => frame.childScopeId === decision.ownerChildScopeId,
  );
  if (owner?.committed === undefined) {
    return abort({
      status: "corrupt",
      childScopeId: decision.ownerChildScopeId,
      reason: "control-owner-commit-missing",
    });
  }
  if (
    children.some(
      (child) =>
        child.frame.childScopeId !== decision.ownerChildScopeId &&
        (child.committed?.intentClaims.length ?? 0) > 0,
    )
  ) {
    return abort({
      status: "blocked",
      childScopeId: undefined,
      reason: "ambiguous-control-owner",
    });
  }
  const claims = owner.committed.intentClaims;
  const claim = claims.length === 1 ? claims[0] : undefined;
  if (
    owner.frame.frameIdentity !== decision.ownerFrameIdentity ||
    owner.committed.commitIdentity !== decision.ownerCommitIdentity ||
    claim === undefined ||
    claim.ownerFrameIdentity !== decision.ownerFrameIdentity ||
    claim.kind !== decision.kind ||
    claim.intentKey !== decision.intentKey ||
    claim.nodeId !== decision.nodeId
  ) {
    return abort({
      status: "corrupt",
      childScopeId: decision.ownerChildScopeId,
      reason: "control-owner-commit-drift",
    });
  }
  const route = validateIntent(policy, owner.frame, {
    kind: claim.kind,
    intentKey: claim.intentKey,
    nodeId: claim.nodeId,
  });
  const expectedCatch =
    route === null
      ? null
      : {
          catchNodeId: route.catchNodeId,
          catchOwnerPath: route.catchOwnerPath,
        };
  if (
    JSON.stringify(decision.catchRoute) !== JSON.stringify(expectedCatch)
  ) {
    return abort({
      status: "corrupt",
      childScopeId: decision.ownerChildScopeId,
      reason: "control-owner-commit-drift",
    });
  }
  return owner;
}

async function reconcileCancellations(
  coordinator: RecursiveControlCoordinatorV1,
  decision: RecursiveControlDecisionV1,
  children: readonly RecursiveControlPreparedChildV1[],
): Promise<void> {
  for (const child of children) {
    const observed = await storageCall(child.frame.childScopeId, () =>
      coordinator.durable.loadControlCancellation(child.frame.childScopeId),
    );
    if (child.frame.childScopeId === decision.ownerChildScopeId) {
      if (observed !== undefined) {
        abort({
          status: "corrupt",
          childScopeId: child.frame.childScopeId,
          reason: "control-cancellation-drift",
        });
      }
      continue;
    }
    if (child.committed !== undefined) {
      if (observed !== undefined) {
        abort({
          status: "corrupt",
          childScopeId: child.frame.childScopeId,
          reason: "control-cancellation-commit-conflict",
        });
      }
      continue;
    }
    if (decision.kind !== "terminal") {
      if (observed !== undefined) {
        abort({
          status: "corrupt",
          childScopeId: child.frame.childScopeId,
          reason: "control-cancellation-drift",
        });
      }
      continue;
    }
    if (observed === undefined) {
      await saveCancellation(coordinator, decision, child.frame);
    } else {
      parseCancellation(observed, decision, child.frame);
    }
  }
}

function candidateFromClaim(
  child: RecursiveControlPreparedChildV1,
  claim: RecursiveIntentClaimV1,
): RecursiveControlCandidateV1 {
  const committed = child.committed;
  if (committed === undefined) {
    return abort({
      status: "corrupt",
      childScopeId: child.frame.childScopeId,
      reason: "control-owner-commit-missing",
    });
  }
  return {
    frame: child.frame,
    intent: {
      kind: claim.kind,
      intentKey: claim.intentKey,
      nodeId: claim.nodeId,
    },
    committed,
  };
}

async function loadCancellationsWithoutDecision(
  coordinator: RecursiveControlCoordinatorV1,
  children: readonly RecursiveControlPreparedChildV1[],
): Promise<void> {
  for (const child of children) {
    const observed = await storageCall(child.frame.childScopeId, () =>
      coordinator.durable.loadControlCancellation(child.frame.childScopeId),
    );
    if (observed !== undefined) {
      abort({
        status: "corrupt",
        childScopeId: child.frame.childScopeId,
        reason: "orphan-control-cancellation",
      });
    }
  }
}

export async function restoreRecursiveControlDecisionV1(
  deps: ControlDeps,
  binding: RecursiveControlScopeBindingV1,
  policy: RecursiveControlPolicyV1,
  children: readonly RecursiveControlPreparedChildV1[],
): Promise<RecursiveControlRestoreV1> {
  const controlScopeIdentity = recursiveControlScopeIdentityV1(binding);
  const serialized = await storageCall(undefined, () =>
    deps.control.durable.loadControlDecision(controlScopeIdentity),
  );
  if (serialized !== undefined) {
    const decision = parseDecision(serialized, binding);
    assertDecisionOwner(policy, decision, children);
    await reconcileCancellations(deps.control, decision, children);
    return { status: "restored", decision };
  }

  const candidates = children.flatMap((child) => {
    const claims = child.committed?.intentClaims ?? [];
    if (claims.length === 0) return [];
    if (claims.length !== 1) {
      abort({
        status: "corrupt",
        childScopeId: child.frame.childScopeId,
        reason: "control-intent-corrupt",
      });
    }
    return [candidateFromClaim(child, claims[0]!)];
  });
  if (candidates.length === 0) {
    await loadCancellationsWithoutDecision(deps.control, children);
    return { status: "none" };
  }
  return {
    status: "restored",
    decision: await settleRecursiveControlDecisionV1(
      deps,
      binding,
      policy,
      children,
      candidates,
    ),
  };
}

export async function settleRecursiveControlDecisionV1(
  deps: ControlDeps,
  binding: RecursiveControlScopeBindingV1,
  policy: RecursiveControlPolicyV1,
  children: readonly RecursiveControlPreparedChildV1[],
  candidates: readonly RecursiveControlCandidateV1[],
): Promise<RecursiveControlDecisionV1> {
  const validated = candidates.map((candidate) => {
    const catchRoute = validateIntent(policy, candidate.frame, candidate.intent);
    if ((candidate.commit?.intentClaims?.length ?? 0) !== 0) {
      return abort({
        status: "corrupt",
        childScopeId: candidate.frame.childScopeId,
        reason: "control-intent-corrupt",
      });
    }
    const committed = candidate.committed;
    if (committed !== undefined) {
      const claim = committed.intentClaims[0];
      if (
        committed.intentClaims.length !== 1 ||
        committed.frameIdentity !== candidate.frame.frameIdentity ||
        claim?.ownerFrameIdentity !== candidate.frame.frameIdentity ||
        claim.kind !== candidate.intent.kind ||
        claim.intentKey !== candidate.intent.intentKey ||
        claim.nodeId !== candidate.intent.nodeId
      ) {
        return abort({
          status: "corrupt",
          childScopeId: candidate.frame.childScopeId,
          reason: "control-intent-corrupt",
        });
      }
    }
    return { candidate, catchRoute };
  });

  const persisted: Array<{
    readonly candidate: RecursiveControlCandidateV1;
    readonly catchRoute: RecursiveControlCatchRouteV1 | null;
    readonly commit: RecursiveScopedCommitV1;
  }> = [];
  for (const entry of validated) {
    let commit = entry.candidate.committed;
    if (commit === undefined) {
      try {
        commit = materializeRecursiveScopedCommitV1({
          ...entry.candidate.commit,
          frame: entry.candidate.frame,
          intentClaims: [entry.candidate.intent],
        });
      } catch {
        return abort({
          status: "corrupt",
          childScopeId: entry.candidate.frame.childScopeId,
          reason: "control-intent-corrupt",
        });
      }
      assertRecursiveAcknowledgementsKnownV1(commit);
      commit = await reconcileRecursiveCommitSaveV1(
        { durable: deps.durable },
        entry.candidate.frame,
        commit,
      );
    }
    persisted.push({ ...entry, commit });
  }

  if (persisted.length !== 1) {
    return abort({
      status: "blocked",
      childScopeId: undefined,
      reason: "ambiguous-control-owner",
    });
  }
  const { candidate, catchRoute, commit } = persisted[0]!;

  const decision = await saveDecision(
    deps.control,
    materializeDecision(binding, candidate, commit, catchRoute),
  );
  const settledChildren = children.map((child) =>
    child.frame.childScopeId === decision.ownerChildScopeId
      ? { ...child, frame: candidate.frame, committed: commit }
      : child,
  );
  assertDecisionOwner(policy, decision, settledChildren);
  await reconcileCancellations(deps.control, decision, settledChildren);
  return decision;
}

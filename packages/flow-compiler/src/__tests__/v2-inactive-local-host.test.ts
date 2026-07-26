import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  definePrimitiveV2,
  extendPrimitiveRegistryV2,
  type PrimitiveDefinitionV2,
} from "@dzupagent/flow-dsl";
import { describe, expect, it } from "vitest";

import {
  createFileV2InactiveLocalHostStore,
  createInMemoryV2InactiveLocalHostStore,
  runV2InactiveLocalHost,
  V2_INACTIVE_LOCAL_HOST_ID,
  V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
  type V2InactiveLocalHandlerBinding,
  type V2InactiveLocalHandlerInvocation,
  type V2InactiveLocalHostRequest,
  type V2InactiveLocalHostCheckpoint,
} from "../v2-inactive-local-target.js";
import {
  digest,
  stableStringify,
} from "../v2-inactive-local-target/evidence.js";

const resolver = {
  resolve: () => null,
  listAvailable: () => [],
};

function multiPortAdapter(): PrimitiveDefinitionV2 {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  return definePrimitiveV2({
    ...contract,
    ref: "primitive://adapter.run@2",
    version: "2",
    owner: "test.external",
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: {
          type: "object",
          properties: { digest: { type: "string", minLength: 1 } },
          required: ["digest"],
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: {
      ...compatibility,
      supersedes: [base.ref],
      deprecatedAliases: [],
    },
  });
}

function source(): string {
  return `
dsl: dzupflow/v2
id: inactive-local-host
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: draft
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
      backoff:
        strategy: fixed
        initialMs: 5
        maxMs: 5
        jitter: none
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: continue
    save:
      result: state.draft
      receipt: state.draftReceipt
  - id: review
    use: adapter.run@2
    when:
      ref: inputs.ready
    with:
      provider: codex
      instructions: Review.
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match:
        - ADAPTER_FAILED
      maxAttempts: 2
      backoff:
        strategy: fixed
        initialMs: 5
        maxMs: 5
        jitter: none
    catch:
      - match:
          - ADAPTER_CANCELLED
        action: complete
    save:
      result: state.review
      receipt: state.reviewReceipt
`;
}

function kernelSource(): string {
  return `
dsl: dzupflow/v2
id: inactive-local-kernel-host
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        route: "{{ inputs.ready }}"
  - id: choose
    use: core.branch@1
    when:
      eq:
        - ref: state.route
        - true
    with:
      then:
        - id: choose-then
          use: core.set@1
          with:
            assign:
              chosen: then
      else:
        - id: choose-else
          use: core.set@1
          with:
            assign:
              chosen: else
  - id: draft
    use: adapter.run@2
    with:
      provider: codex
      instructions: "Draft {{ state.chosen }}"
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match: [ADAPTER_FAILED]
      maxAttempts: 2
    catch:
      - match: [ADAPTER_CANCELLED]
        action: continue
    save:
      result: state.draft
      receipt: state.draftReceipt
  - id: review
    use: adapter.run@2
    with:
      provider: codex
      instructions: "Review {{ steps.draft.result | json }}"
    policy:
      timeoutMs: 30000
      budgetCents: 100
    retry:
      match: [ADAPTER_FAILED]
      maxAttempts: 2
    catch:
      - match: [ADAPTER_CANCELLED]
        action: continue
    save:
      result: state.review
      receipt: state.reviewReceipt
  - id: done
    use: core.complete@1
    with:
      result: "{{ state.chosen }}"
`;
}

function fixture(
  invoke: V2InactiveLocalHandlerBinding["invoke"],
  options: {
    readonly store?: V2InactiveLocalHostRequest["checkpointStore"];
    readonly runId?: string;
    readonly ownerId?: string;
  } = {}
): V2InactiveLocalHostRequest {
  const primitive = multiPortAdapter();
  const registry = extendPrimitiveRegistryV2(BUILT_IN_PRIMITIVE_REGISTRY_V2, [
    primitive,
  ]);
  return {
    runId: options.runId ?? "host-run-1",
    ownerId: options.ownerId ?? "worker-1",
    source: source(),
    compilerOptions: {
      toolResolver: resolver,
      referencePolicy: "strict",
      primitiveRegistry: registry,
      primitiveBindings: {
        "adapter.run": {
          ref: primitive.ref,
          semanticHash: primitive.compatibility.semanticHash,
        },
      },
    },
    hostCapabilities: V2_INACTIVE_LOCAL_TARGET_CAPABILITIES,
    conditionBindings: { inputs: { ready: true } },
    initialState: { retained: "before" },
    handlers: [
      {
        ref: primitive.ref,
        semanticHash: primitive.compatibility.semanticHash,
        handlerId: "test.adapter-run-local.v1",
        handlerSha256: `sha256:${"a".repeat(64)}`,
        mode: "provider-free-local",
        declaredEffects: "none",
        replay: "safe",
        invoke,
      },
    ],
    checkpointStore: options.store ?? createInMemoryV2InactiveLocalHostStore(),
  };
}

function success(invocation: V2InactiveLocalHandlerInvocation) {
  return {
    status: "success" as const,
    outputs: {
      result: { text: `${invocation.stepId}-done` },
      receipt: { digest: `${invocation.stepId}-digest` },
    },
    durationMs: 10,
    costCents: 1,
  };
}

describe("inactive provider-free multi-step V2 host", () => {
  it("executes set, dynamic branch, resolved inputs, step outputs, and complete across restart", async () => {
    const store = createInMemoryV2InactiveLocalHostStore();
    const observed: V2InactiveLocalHandlerInvocation[] = [];
    const base = fixture(
      (invocation) => {
        observed.push(invocation);
        return success(invocation);
      },
      { store, runId: "kernel-run", ownerId: "worker-a" }
    );
    const request = {
      ...base,
      source: kernelSource(),
      compilerOptions: {
        ...base.compilerOptions,
        referencePortBindings: {
          draft: { result: "object" as const },
        },
        referenceTypeBindings: { state: { route: "boolean" as const } },
      },
      conditionBindings: { inputs: { ready: true } },
    };

    const suspended = await runV2InactiveLocalHost({
      ...request,
      maxStepsThisRun: 3,
    });
    if (!suspended.ok)
      throw new Error(JSON.stringify(suspended.errors, null, 2));
    expect(suspended).toMatchObject({
      ok: true,
      receipt: {
        status: "suspended",
        state: { route: true, chosen: "then" },
        branchDecisions: { choose: true },
        steps: [
          { id: "seed", kind: "set", status: "set-applied" },
          { id: "choose", kind: "branch", status: "branch-then" },
          { id: "choose-then", status: "set-applied" },
        ],
      },
    });

    const result = await runV2InactiveLocalHost({
      ...request,
      ownerId: "worker-b",
      maxStepsThisRun: undefined,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result.receipt).toMatchObject({
      status: "completed",
      result: "then",
      branchDecisions: { choose: true },
      stepOutputs: {
        draft: { result: { text: "draft-done" } },
        review: { result: { text: "review-done" } },
      },
      steps: [
        {
          id: "seed",
          status: "set-applied",
          resolvedInputSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        { id: "choose", status: "branch-then", branchDecision: true },
        { id: "choose-then", status: "set-applied" },
        { id: "choose-else", status: "skipped-branch" },
        {
          id: "draft",
          status: "completed",
          resolvedInputSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        {
          id: "review",
          status: "completed",
          resolvedInputSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        {
          id: "done",
          status: "complete",
          resolvedInputSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      ],
    });
    expect(observed.map((item) => item.stepId)).toEqual(["draft", "review"]);
    expect(observed[0]?.input.instructions).toBe("Draft then");
    expect(observed[1]?.input.instructions).toBe(
      'Review {"text":"draft-done"}'
    );
  });

  it("persists the false branch decision and never invokes skipped branch work", async () => {
    const observed: V2InactiveLocalHandlerInvocation[] = [];
    const base = fixture((invocation) => {
      observed.push(invocation);
      return success(invocation);
    });
    const result = await runV2InactiveLocalHost({
      ...base,
      runId: "kernel-else-run",
      source: kernelSource(),
      compilerOptions: {
        ...base.compilerOptions,
        referencePortBindings: { draft: { result: "object" } },
        referenceTypeBindings: { state: { route: "boolean" } },
      },
      conditionBindings: { inputs: { ready: false } },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        result: "else",
        branchDecisions: { choose: false },
        steps: [
          { id: "seed", status: "set-applied" },
          { id: "choose", status: "branch-else" },
          { id: "choose-then", status: "skipped-branch" },
          { id: "choose-else", status: "set-applied" },
          { id: "draft", status: "completed" },
          { id: "review", status: "completed" },
          { id: "done", status: "complete" },
        ],
      },
    });
    expect(observed[0]?.input.instructions).toBe("Draft else");
  });

  it("fails closed before mutation when a runtime input reference is missing", async () => {
    const observed: V2InactiveLocalHandlerInvocation[] = [];
    const base = fixture((invocation) => {
      observed.push(invocation);
      return success(invocation);
    });
    const result = await runV2InactiveLocalHost({
      ...base,
      runId: "kernel-missing-input",
      source: kernelSource(),
      compilerOptions: {
        ...base.compilerOptions,
        referencePortBindings: { draft: { result: "object" } },
        referenceTypeBindings: { state: { route: "boolean" } },
      },
      conditionBindings: { inputs: {} },
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "V2_LOCAL_HOST_REFERENCE_RESOLUTION_FAILED",
          path: "root.steps[0].with.assign.route",
        },
      ],
    });
    expect(observed).toEqual([]);
  });

  it("rejects a digest-valid checkpoint whose branch projection was rewritten", async () => {
    let checkpoint: V2InactiveLocalHostCheckpoint | null = null;
    let lease: string | null = null;
    const store: V2InactiveLocalHostRequest["checkpointStore"] = {
      claim: async ({ ownerId }) => {
        if (lease !== null) return { ok: false, reason: "already-claimed" };
        lease = `lease-${ownerId}`;
        return { ok: true, leaseToken: lease, checkpoint };
      },
      commit: async (input) => {
        if (lease !== input.leaseToken) return false;
        checkpoint = structuredClone(input.checkpoint);
        return true;
      },
      release: async (input) => {
        if (lease !== input.leaseToken) return false;
        lease = null;
        return true;
      },
    };
    const base = fixture(success, {
      store,
      runId: "kernel-projection-drift",
      ownerId: "worker-a",
    });
    const request = {
      ...base,
      source: kernelSource(),
      compilerOptions: {
        ...base.compilerOptions,
        referencePortBindings: { draft: { result: "object" as const } },
        referenceTypeBindings: { state: { route: "boolean" as const } },
      },
      conditionBindings: { inputs: { ready: true } },
    };
    expect(
      await runV2InactiveLocalHost({ ...request, maxStepsThisRun: 2 })
    ).toMatchObject({ ok: true, receipt: { status: "suspended" } });
    if (checkpoint === null) throw new Error("expected checkpoint");
    const currentCheckpoint = checkpoint as V2InactiveLocalHostCheckpoint;
    const { checkpointSha256: _digest, ...core } = currentCheckpoint;
    const rewritten = { ...core, branchDecisions: { choose: false } };
    checkpoint = {
      ...rewritten,
      checkpointSha256: digest(stableStringify(rewritten)),
    };

    const resumed = await runV2InactiveLocalHost({
      ...request,
      ownerId: "worker-b",
      maxStepsThisRun: undefined,
    });
    expect(resumed).toMatchObject({
      ok: false,
      errors: [{ code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT" }],
    });
  });

  it("runs exact local handlers in order and atomically checkpoints every step", async () => {
    const observed: V2InactiveLocalHandlerInvocation[] = [];
    const request = fixture((invocation) => {
      observed.push(invocation);
      return success(invocation);
    });
    const result = await runV2InactiveLocalHost(request);
    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        target: V2_INACTIVE_LOCAL_HOST_ID,
        status: "completed",
        state: {
          retained: "before",
          draft: { text: "draft-done" },
          draftReceipt: { digest: "draft-digest" },
          review: { text: "review-done" },
          reviewReceipt: { digest: "review-digest" },
        },
        steps: [
          {
            index: 0,
            id: "draft",
            status: "completed",
            handler: {
              id: "test.adapter-run-local.v1",
              sha256: `sha256:${"a".repeat(64)}`,
              declaredEffects: "none",
              replay: "safe",
            },
          },
          { index: 1, id: "review", status: "completed" },
        ],
        authority: {
          localHandlerInvocation: true,
          checkpointStoreMutation: true,
          handlerDeclaredEffects: "none",
          providerDispatch: false,
          workflowExternalStateMutation: false,
          externalContinuation: false,
          deployment: false,
          promotion: false,
          activation: false,
        },
      },
    });
    expect(observed).toHaveLength(2);
    expect(observed[0]?.state).toEqual({ retained: "before" });
    expect(observed[1]?.state).toMatchObject({
      retained: "before",
      draft: { text: "draft-done" },
    });
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(Object.isFrozen(observed[0]?.state)).toBe(true);
  });

  it("resumes after a per-step checkpoint without replaying completed handlers", async () => {
    const store = createInMemoryV2InactiveLocalHostStore();
    const invocations: string[] = [];
    const firstRequest = fixture(
      (invocation) => {
        invocations.push(invocation.stepId);
        return success(invocation);
      },
      { store, runId: "resume-run", ownerId: "worker-a" }
    );
    const suspended = await runV2InactiveLocalHost({
      ...firstRequest,
      maxStepsThisRun: 1,
    });
    expect(suspended).toMatchObject({
      ok: true,
      receipt: { status: "suspended", steps: [{ id: "draft" }] },
    });

    const resumed = await runV2InactiveLocalHost({
      ...firstRequest,
      ownerId: "worker-b",
      maxStepsThisRun: undefined,
    });
    expect(resumed).toMatchObject({
      ok: true,
      receipt: {
        status: "completed",
        steps: [{ id: "draft" }, { id: "review" }],
      },
    });
    expect(invocations).toEqual(["draft", "review"]);

    const idempotent = await runV2InactiveLocalHost({
      ...firstRequest,
      ownerId: "worker-c",
      maxStepsThisRun: undefined,
    });
    expect(idempotent).toEqual(resumed);
    expect(invocations).toEqual(["draft", "review"]);
  });

  it("rejects a concurrent claim before a second handler invocation", async () => {
    const store = createInMemoryV2InactiveLocalHostStore();
    let release!: () => void;
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = fixture(
      async (invocation) => {
        entered();
        await gate;
        return success(invocation);
      },
      { store, runId: "concurrent-run", ownerId: "worker-a" }
    );
    const first = runV2InactiveLocalHost(request);
    await handlerEntered;
    const second = await runV2InactiveLocalHost({
      ...request,
      ownerId: "worker-b",
    });
    expect(second).toMatchObject({
      ok: false,
      errors: [{ code: "V2_LOCAL_HOST_CONCURRENT_RUN" }],
    });
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("applies retry locally and never exposes raw provider content", async () => {
    const attempts = new Map<string, number>();
    const result = await runV2InactiveLocalHost(
      fixture((invocation) => {
        const count = (attempts.get(invocation.stepId) ?? 0) + 1;
        attempts.set(invocation.stepId, count);
        if (invocation.stepId === "draft" && count === 1) {
          return {
            status: "error",
            code: "ADAPTER_FAILED",
            durationMs: 4,
            costCents: 1,
          };
        }
        return success(invocation);
      })
    );
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        steps: [
          {
            attempts: [
              {
                status: "retryable-error",
                scheduledBackoffMs: 5,
                rawProviderContent: "excluded",
              },
              { status: "success", rawProviderContent: "excluded" },
            ],
          },
          { attempts: [{ status: "success" }] },
        ],
      },
    });
  });

  it("cancels only at a step boundary and preserves the last committed state", async () => {
    const invocations: string[] = [];
    const result = await runV2InactiveLocalHost({
      ...fixture((invocation) => {
        invocations.push(invocation.stepId);
        return success(invocation);
      }),
      cancelBeforeStep: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        status: "cancelled",
        steps: [{ id: "draft" }],
        state: {
          retained: "before",
          draft: { text: "draft-done" },
        },
      },
    });
    expect(invocations).toEqual(["draft"]);
  });

  it("observes cooperative cancellation only after the current step checkpoint", async () => {
    const cancellation = { aborted: false };
    const invocations: string[] = [];
    const result = await runV2InactiveLocalHost({
      ...fixture((invocation) => {
        invocations.push(invocation.stepId);
        cancellation.aborted = true;
        return success(invocation);
      }),
      cancellation,
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        status: "cancelled",
        steps: [{ id: "draft" }],
        state: { draft: { text: "draft-done" } },
      },
    });
    expect(invocations).toEqual(["draft"]);
  });

  it("rejects handler identity and output drift without a partial state commit", async () => {
    const invalidOutput = fixture(() => ({
      status: "success",
      outputs: {
        result: { text: "draft" },
        receipt: { digest: "" },
      },
      durationMs: 1,
      costCents: 0,
    }));
    const output = await runV2InactiveLocalHost(invalidOutput);
    expect(output).toMatchObject({
      ok: false,
      errors: [{ code: "V2_LOCAL_HOST_OUTPUT_INVALID" }],
    });

    const exact = fixture(success);
    const identity = await runV2InactiveLocalHost({
      ...exact,
      handlers: [
        {
          ...exact.handlers[0]!,
          semanticHash: `sha256:${"0".repeat(64)}`,
        },
      ],
    });
    expect(identity).toMatchObject({
      ok: false,
      errors: [{ code: "V2_LOCAL_HOST_HANDLER_BINDING_INVALID" }],
    });
  });

  it("binds handler code identity into checkpoint restart admission", async () => {
    const store = createInMemoryV2InactiveLocalHostStore();
    const request = fixture(success, {
      store,
      runId: "handler-drift-run",
      ownerId: "worker-a",
    });
    expect(
      await runV2InactiveLocalHost({ ...request, maxStepsThisRun: 1 })
    ).toMatchObject({ ok: true, receipt: { status: "suspended" } });

    const drifted = await runV2InactiveLocalHost({
      ...request,
      ownerId: "worker-b",
      maxStepsThisRun: undefined,
      handlers: [
        {
          ...request.handlers[0]!,
          handlerSha256: `sha256:${"b".repeat(64)}`,
        },
      ],
    });
    expect(drifted).toMatchObject({
      ok: false,
      errors: [{ code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT" }],
    });
  });

  it("reuses a terminal host checkpoint through a fresh durable-store instance", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "dzup-v2-host-terminal-")
    );
    try {
      const first = await runV2InactiveLocalHost(
        fixture(success, {
          store: createFileV2InactiveLocalHostStore({ rootDirectory }),
          runId: "durable-terminal-run",
          ownerId: "worker-a",
        })
      );
      expect(first).toMatchObject({
        ok: true,
        receipt: { status: "completed" },
      });

      let replayed = false;
      const reused = await runV2InactiveLocalHost(
        fixture(
          () => {
            replayed = true;
            throw new Error("terminal checkpoint must not replay a handler");
          },
          {
            store: createFileV2InactiveLocalHostStore({ rootDirectory }),
            runId: "durable-terminal-run",
            ownerId: "worker-b",
          }
        )
      );
      expect(reused).toEqual(first);
      expect(replayed).toBe(false);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when the caller-supplied checkpoint store cannot release", async () => {
    const backing = createInMemoryV2InactiveLocalHostStore();
    const result = await runV2InactiveLocalHost({
      ...fixture(success),
      runId: "release-failure-run",
      checkpointStore: {
        claim: (input) => backing.claim(input),
        commit: (input) => backing.commit(input),
        release: async () => false,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
          path: "checkpointStore",
        },
      ],
    });
  });
});

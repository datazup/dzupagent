/**
 * Direct unit tests for the two workflow-compiler helper modules.
 *
 * Narrowed residual of ORCH-DSL-TEST-H-09. That finding claimed the whole
 * workflow-execution core was untested; it is not — `compiled-workflow-deep`
 * drives it through the barrel (the finding's grep was defeated by a NUL byte,
 * fixed separately). What genuinely survives is that these two modules, though
 * executed on every workflow run, have no test naming their exported functions
 * directly. Their branches — a missing transform handler, a throwing handler, a
 * throwing error-handler predicate, recovery-step state merging — are reachable
 * transitively but never asserted at the seam where they are decided.
 */
import { describe, it, expect, vi } from "vitest";
import type { PipelineNode } from "@dzupagent/core/pipeline";
import { createNodeExecutorFactory } from "../workflow-compiler-executor.js";
import {
  applyErrorHandlers,
  asAbortSignal,
} from "../workflow-compiler-error-handlers.js";
import type { WorkflowContext, WorkflowEvent } from "../workflow-types.js";
import type { WorkflowErrorHandler } from "../workflow-builder-types.js";
import type { NodeExecutionContext } from "../../pipeline/pipeline-runtime-types.js";

function transformNode(transformName: string): PipelineNode {
  return { type: "transform", transformName } as unknown as PipelineNode;
}

function execContext(
  state: Record<string, unknown> = {}
): NodeExecutionContext {
  return { state } as unknown as NodeExecutionContext;
}

describe("createNodeExecutorFactory", () => {
  it("returns a zero-duration no-op for non-transform nodes", async () => {
    const executor = createNodeExecutorFactory("wf", new Map())(
      vi.fn(),
      vi.fn()
    );

    const result = await executor(
      "n1",
      { type: "suspend" } as unknown as PipelineNode,
      execContext()
    );

    expect(result).toEqual({ nodeId: "n1", output: null, durationMs: 0 });
  });

  it("surfaces a descriptive error when no handler is registered", async () => {
    const executor = createNodeExecutorFactory("wf", new Map())(
      vi.fn(),
      vi.fn()
    );

    const result = await executor(
      "n1",
      transformNode("missing"),
      execContext()
    );

    expect(result.output).toBeNull();
    expect(result.error).toBe(
      'No workflow transform handler found for "missing"'
    );
  });

  it("invokes the registered handler and returns its output", async () => {
    const handler = vi.fn(async () => ({ produced: true }));
    const handlers = new Map([["step", handler]]);
    const emit = vi.fn();
    const executor = createNodeExecutorFactory("wf-id", handlers)(
      emit,
      vi.fn()
    );

    const state = { seed: 1 };
    const result = await executor(
      "n1",
      transformNode("step"),
      execContext(state)
    );

    expect(result.output).toEqual({ produced: true });
    expect(result.error).toBeUndefined();
    // The handler receives the live state, a context carrying the workflow id,
    // and the emit function — the contract the compiler depends on.
    expect(handler).toHaveBeenCalledTimes(1);
    const [passedState, passedCtx, passedEmit] = handler.mock.calls[0] as [
      Record<string, unknown>,
      WorkflowContext,
      unknown
    ];
    expect(passedState).toBe(state);
    expect(passedCtx.workflowId).toBe("wf-id");
    expect(passedEmit).toBe(emit);
  });

  it("converts a thrown handler error into an error result, not a rejection", async () => {
    const handlers = new Map([
      [
        "boom",
        vi.fn(() => {
          throw new Error("handler exploded");
        }),
      ],
    ]);
    const executor = createNodeExecutorFactory("wf", handlers)(
      vi.fn(),
      vi.fn()
    );

    const result = await executor("n1", transformNode("boom"), execContext());

    expect(result.error).toBe("handler exploded");
    expect(result.output).toBeNull();
  });

  it("observes state before execution and again after a successful handler", async () => {
    const onStateObserved = vi.fn();
    const handlers = new Map([["step", vi.fn(async () => null)]]);
    const executor = createNodeExecutorFactory("wf", handlers)(
      vi.fn(),
      onStateObserved
    );

    await executor("n1", transformNode("step"), execContext({ a: 1 }));

    // Twice: once on entry, once after the handler may have mutated state.
    expect(onStateObserved).toHaveBeenCalledTimes(2);
  });

  it("observes state only once when the handler throws", async () => {
    const onStateObserved = vi.fn();
    const handlers = new Map([
      [
        "boom",
        vi.fn(() => {
          throw new Error("nope");
        }),
      ],
    ]);
    const executor = createNodeExecutorFactory("wf", handlers)(
      vi.fn(),
      onStateObserved
    );

    await executor("n1", transformNode("boom"), execContext());

    expect(onStateObserved).toHaveBeenCalledTimes(1);
  });
});

describe("asAbortSignal", () => {
  it("passes undefined through", () => {
    expect(asAbortSignal(undefined)).toBeUndefined();
  });

  it("returns the same signal instance it was given", () => {
    const controller = new AbortController();
    expect(
      asAbortSignal(controller.signal as NodeExecutionContext["signal"])
    ).toBe(controller.signal);
  });
});

describe("applyErrorHandlers", () => {
  const ctx = { workflowId: "wf", state: {} } as WorkflowContext;

  function handler(
    predicate: (err: Error) => boolean,
    recoverySteps: WorkflowErrorHandler["recoverySteps"]
  ): WorkflowErrorHandler {
    return { predicate, recoverySteps } as WorkflowErrorHandler;
  }

  it("returns false when no handlers are registered", async () => {
    const handled = await applyErrorHandlers(
      new Error("x"),
      {},
      ctx,
      vi.fn(),
      []
    );
    expect(handled).toBe(false);
  });

  it("returns false when no predicate matches", async () => {
    const handled = await applyErrorHandlers(new Error("x"), {}, ctx, vi.fn(), [
      handler(() => false, []),
    ]);
    expect(handled).toBe(false);
  });

  it("treats a throwing predicate as non-matching rather than propagating", async () => {
    const recovery = vi.fn(async () => ({}));
    const handled = await applyErrorHandlers(new Error("x"), {}, ctx, vi.fn(), [
      handler(() => {
        throw new Error("predicate blew up");
      }, []),
      handler(() => true, [{ id: "r1", execute: recovery } as never]),
    ]);

    // The throwing predicate is skipped and the next handler still wins.
    expect(handled).toBe(true);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("populates a serializable error view on state", async () => {
    const state: Record<string, unknown> = {};
    const err = new Error("boom");
    await applyErrorHandlers(err, state, ctx, vi.fn(), [
      handler(() => true, []),
    ]);

    expect(state["error"]).toEqual({
      name: "Error",
      message: "boom",
      stack: err.stack,
    });
  });

  it("wraps a non-Error throwable before matching", async () => {
    const state: Record<string, unknown> = {};
    const seen: Error[] = [];
    await applyErrorHandlers("plain string", state, ctx, vi.fn(), [
      handler((e) => {
        seen.push(e);
        return true;
      }, []),
    ]);

    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0]?.message).toBe("plain string");
  });

  it("merges object outputs from recovery steps back into state", async () => {
    const state: Record<string, unknown> = { keep: 1 };
    const handled = await applyErrorHandlers(
      new Error("x"),
      state,
      ctx,
      vi.fn(),
      [
        handler(
          () => true,
          [
            { id: "r1", execute: async () => ({ recovered: true }) } as never,
            { id: "r2", execute: async () => ({ second: 2 }) } as never,
          ]
        ),
      ]
    );

    expect(handled).toBe(true);
    expect(state).toMatchObject({ keep: 1, recovered: true, second: 2 });
  });

  it("ignores non-object recovery outputs", async () => {
    const state: Record<string, unknown> = {};
    await applyErrorHandlers(new Error("x"), state, ctx, vi.fn(), [
      handler(
        () => true,
        [{ id: "r1", execute: async () => "not an object" } as never]
      ),
    ]);

    expect(state["0"]).toBeUndefined();
  });

  it("emits started/completed around each recovery step", async () => {
    const events: WorkflowEvent[] = [];
    await applyErrorHandlers(new Error("x"), {}, ctx, (e) => events.push(e), [
      handler(() => true, [{ id: "r1", execute: async () => ({}) } as never]),
    ]);

    expect(events.map((e) => e.type)).toEqual([
      "step:started",
      "step:completed",
    ]);
  });

  it("emits step:failed and rethrows when a recovery step throws", async () => {
    const events: WorkflowEvent[] = [];
    await expect(
      applyErrorHandlers(new Error("x"), {}, ctx, (e) => events.push(e), [
        handler(
          () => true,
          [
            {
              id: "r1",
              execute: async () => {
                throw new Error("recovery failed");
              },
            } as never,
          ]
        ),
      ])
    ).rejects.toThrow("recovery failed");

    expect(events.map((e) => e.type)).toEqual(["step:started", "step:failed"]);
  });

  it("uses the first matching handler only", async () => {
    const first = vi.fn(async () => ({}));
    const second = vi.fn(async () => ({}));
    await applyErrorHandlers(new Error("x"), {}, ctx, vi.fn(), [
      handler(() => true, [{ id: "a", execute: first } as never]),
      handler(() => true, [{ id: "b", execute: second } as never]),
    ]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

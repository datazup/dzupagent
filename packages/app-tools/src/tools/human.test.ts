import type {
  ApprovalPayload,
  ClarificationPayload,
} from "@dzupagent/hitl-kit";
import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "./builtin.js";
import {
  buildHumanTools,
  type ApproveCallback,
  type ClarifyCallback,
} from "./human.js";
import type { AnyExecutableDomainTool, ExecutableDomainTool } from "./shared.js";

function getExecutor<TInput, TOutput>(
  tools: readonly AnyExecutableDomainTool[],
  name: string,
): ExecutableDomainTool<TInput, TOutput> {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not built`);
  }
  // Existential unpack, keyed by the tool's definition name — same boundary
  // documented on AnyExecutableDomainTool.
  return tool as ExecutableDomainTool<TInput, TOutput>;
}

/** Yield to the macrotask queue so every pending microtask has run. */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * These tests are the pin for the `=> void` narrowing of the HITL callback
 * types. They are a TYPE-level lock as much as a runtime one: every callback
 * below is written with an EXPRESSION body whose result is a value (Array#push
 * returns `number`). Under the previous `=> void | Promise<void>` declarations
 * this file does not compile — each supplier fails with TS2322 ("Type 'number'
 * is not assignable to type 'void | Promise<void>'"). `packages/app-tools`
 * typechecks `src/**` including `*.test.ts`, so `yarn typecheck` enforces it.
 */
describe("HITL callbacks accept expression-bodied suppliers", () => {
  it("ClarifyCallback accepts an expression-bodied arrow returning a value", async () => {
    const seen: ClarificationPayload[] = [];
    // Expression body: returns `number`. Rejected by `=> void | Promise<void>`.
    const onClarify: ClarifyCallback = (payload) => seen.push(payload);
    const onApprove: ApproveCallback = () => undefined;

    const tools = buildHumanTools(onClarify, onApprove);
    const exec = getExecutor<{ question: string }, { sent: true }>(
      tools,
      "human.clarify",
    );

    const result = await exec.execute({ question: "Which DB?" });

    expect(result).toEqual({ sent: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Which DB?");
  });

  it("ApproveCallback accepts an expression-bodied arrow returning a value", async () => {
    const seen: ApprovalPayload[] = [];
    const onClarify: ClarifyCallback = () => undefined;
    // Expression body: returns `number`. Rejected by `=> void | Promise<void>`.
    const onApprove: ApproveCallback = (payload) => seen.push(payload);

    const tools = buildHumanTools(onClarify, onApprove);
    const exec = getExecutor<{ question: string }, { sent: true }>(
      tools,
      "human.approve",
    );

    const result = await exec.execute({ question: "Deploy to prod?" });

    expect(result).toEqual({ sent: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Deploy to prod?");
  });

  it("BuiltinToolOptions accepts expression-bodied onClarify/onApprove", async () => {
    const clarifications: ClarificationPayload[] = [];
    const approvals: ApprovalPayload[] = [];

    // The public surface: this is how a consumer of @dzupagent/app-tools wires
    // HITL delivery. Both arrows have expression bodies returning `number`.
    const { executors } = createBuiltinToolRegistry({
      onClarify: (payload) => clarifications.push(payload),
      onApprove: (payload) => approvals.push(payload),
    });

    const clarify = getExecutor<{ question: string }, { sent: true }>(
      [...executors.values()],
      "human.clarify",
    );
    const approve = getExecutor<{ question: string }, { sent: true }>(
      [...executors.values()],
      "human.approve",
    );

    await clarify.execute({ question: "Which region?" });
    await approve.execute({ question: "Drop the table?" });

    expect(clarifications.map((c) => c.question)).toEqual(["Which region?"]);
    expect(approvals.map((a) => a.question)).toEqual(["Drop the table?"]);
  });

  it("still accepts async callbacks after the narrowing to => void", async () => {
    const seen: ClarificationPayload[] = [];
    const { executors } = createBuiltinToolRegistry({
      onClarify: async (payload) => {
        await Promise.resolve();
        seen.push(payload);
      },
    });
    const clarify = getExecutor<{ question: string }, { sent: true }>(
      [...executors.values()],
      "human.clarify",
    );

    await clarify.execute({ question: "Async ok?" });

    expect(seen).toHaveLength(1);
  });
});

/**
 * The await inside `invokeCallback` is load-bearing: `human.clarify` and
 * `human.approve` are gates, so `{ sent: true }` must not resolve before the
 * injected delivery callback has settled. Narrowing the callback types to
 * `=> void` forced the direct `await onClarify(payload)` to be replaced by a
 * widen-to-`unknown` + thenable check, so these tests exist to prove the await
 * survived that rewrite. Deleting the `await result` in `invokeCallback` fails
 * every test in this block.
 */
describe("HITL callbacks are awaited before the tool reports sent", () => {
  it("human.clarify does not resolve until an async onClarify settles", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { executors } = createBuiltinToolRegistry({
      onClarify: async (payload) => {
        order.push(`dispatch:${payload.question}`);
        await gate;
        order.push("delivered");
      },
    });
    const clarify = getExecutor<{ question: string }, { sent: true }>(
      [...executors.values()],
      "human.clarify",
    );

    let settled = false;
    const pending = clarify.execute({ question: "Which DB?" }).then((r) => {
      settled = true;
      order.push("sent");
      return r;
    });

    await drainMicrotasks();

    // The callback has been dispatched but has NOT settled. If the await were
    // dropped, execute() would already have resolved here.
    expect(order).toEqual(["dispatch:Which DB?"]);
    expect(settled).toBe(false);

    release();
    const result = await pending;

    expect(result).toEqual({ sent: true });
    expect(order).toEqual(["dispatch:Which DB?", "delivered", "sent"]);
  });

  it("human.approve does not resolve until an async onApprove settles", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { executors } = createBuiltinToolRegistry({
      onApprove: async (payload) => {
        order.push(`dispatch:${payload.question}`);
        await gate;
        order.push("delivered");
      },
    });
    const approve = getExecutor<{ question: string }, { sent: true }>(
      [...executors.values()],
      "human.approve",
    );

    let settled = false;
    const pending = approve.execute({ question: "Deploy to prod?" }).then((r) => {
      settled = true;
      order.push("sent");
      return r;
    });

    await drainMicrotasks();

    expect(order).toEqual(["dispatch:Deploy to prod?"]);
    expect(settled).toBe(false);

    release();
    const result = await pending;

    expect(result).toEqual({ sent: true });
    expect(order).toEqual(["dispatch:Deploy to prod?", "delivered", "sent"]);
  });

  it("awaits any thenable, not just a native Promise", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A bare thenable — `instanceof Promise` is false for this value, so this
    // pins the structural `isPromiseLike` check rather than a Promise identity
    // check.
    const thenable = {
      then(onFulfilled: () => void): void {
        void gate.then(() => {
          order.push("delivered");
          onFulfilled();
        });
      },
    };

    // Declared with its real return type, then assigned to the `=> void`
    // callback type. That assignment is the void-return leniency this sweep
    // restored: it is exactly what `=> void | Promise<void>` used to reject.
    const deliver = (payload: ApprovalPayload): { then: unknown } => {
      order.push(`dispatch:${payload.question}`);
      return thenable;
    };
    const onApprove: ApproveCallback = deliver;

    const tools = buildHumanTools(() => undefined, onApprove);
    const approve = getExecutor<{ question: string }, { sent: true }>(
      tools,
      "human.approve",
    );

    let settled = false;
    const pending = approve.execute({ question: "Ship it?" }).then((r) => {
      settled = true;
      order.push("sent");
      return r;
    });

    await drainMicrotasks();

    expect(order).toEqual(["dispatch:Ship it?"]);
    expect(settled).toBe(false);

    release();
    await pending;

    expect(order).toEqual(["dispatch:Ship it?", "delivered", "sent"]);
  });
});

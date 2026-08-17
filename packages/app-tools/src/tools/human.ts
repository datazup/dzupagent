import type {
  ApprovalPayload,
  ClarificationPayload,
} from "@dzupagent/hitl-kit";
import type { DomainToolDefinition } from "../types.js";
import type {
  AnyExecutableDomainTool,
  ExecutableDomainTool,
} from "./shared.js";

/**
 * human.* — human-in-the-loop interaction tools.
 *
 * `human.clarify` and `human.approve` produce HITL payloads conforming to
 * `@dzupagent/hitl-kit` and hand them off to injected callbacks. The callbacks
 * are responsible for actually delivering the payload (SSE, WebSocket, email,
 * etc.) — this layer is pure plumbing.
 */

/**
 * Callback returns are declared as plain `void`, deliberately — not
 * `void | Promise<void>`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` parameter, so
 * `createBuiltinToolRegistry({ onClarify: (p) => seen.push(p) })` type-checks
 * even though `push` returns `number`. That leniency does not survive a union:
 * under `=> void | Promise<void>` the same expression is rejected with TS2322
 * ("Type 'number' is not assignable to type 'void | Promise<void>'"), which is
 * why every supplier in this package had to spell its callback with a block
 * body. `=> void | Promise<void>` reads as the more permissive declaration and
 * is in fact strictly the less permissive one.
 *
 * `void` still accepts `async` callbacks — a `Promise<void>` return is
 * assignable to a `void` return position — and {@link invokeCallback} inspects
 * the value a callback actually returned, so an async delivery is still awaited.
 */
export type ClarifyCallback = (payload: ClarificationPayload) => void;
export type ApproveCallback = (payload: ApprovalPayload) => void;

/**
 * How a callback is invoked internally.
 *
 * The public types above say `void` for the leniency described there; this one
 * says `unknown` because {@link invokeCallback} has to inspect what the callback
 * actually returned, and an expression of type `void` can neither be tested for
 * truthiness (TS1345) nor meaningfully awaited.
 */
type InvokableCallback<TPayload> = (payload: TPayload) => unknown;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

/**
 * Invoke a HITL delivery callback and await it when it returned a promise.
 *
 * The await is LOAD-BEARING. `human.clarify` / `human.approve` must not resolve
 * `{ sent: true }` until the injected callback has settled: reporting `sent`
 * early would let the agent proceed before the clarification or approval
 * request had actually been dispatched to the human operator. Narrowing the
 * public callback types to `=> void` must not drop that guarantee, so the
 * returned value is widened to `unknown` here and awaited when thenable rather
 * than being awaited blindly through a `void`-typed expression.
 */
async function invokeCallback<TPayload>(
  callback: InvokableCallback<TPayload>,
  payload: TPayload,
): Promise<void> {
  const result: unknown = callback(payload);
  if (isPromiseLike(result)) {
    await result;
  }
}

// ---------------------------------------------------------------------------
// human.clarify
// ---------------------------------------------------------------------------

interface ClarifyInput {
  question: string;
  context?: string;
  choices?: string[];
}

interface ClarifyOutput {
  sent: true;
}

function buildHumanClarify(
  onClarify: ClarifyCallback,
): ExecutableDomainTool<ClarifyInput, ClarifyOutput> {
  const definition: DomainToolDefinition = {
    name: "human.clarify",
    description: "Request clarification from a human operator.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1 },
        context: { type: "string" },
        choices: { type: "array", items: { type: "string" } },
      },
    },
    outputSchema: {
      type: "object",
      required: ["sent"],
      properties: {
        sent: { type: "boolean", const: true },
      },
    },
    permissionLevel: "read",
    sideEffects: [
      {
        type: "sends_notification",
        description: "Sends a clarification request to a human operator.",
      },
    ],
    namespace: "human",
  };

  return {
    definition,
    async execute(input: ClarifyInput): Promise<ClarifyOutput> {
      const hasChoices =
        input.choices !== undefined && input.choices.length > 0;
      const payload: ClarificationPayload = {
        type: "clarification",
        runId: "",
        nodeIndex: 0,
        question: input.question,
        expected: hasChoices ? "choice" : "text",
        ...(hasChoices ? { choices: input.choices as string[] } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      };
      await invokeCallback(onClarify, payload);
      return { sent: true };
    },
  };
}

// ---------------------------------------------------------------------------
// human.approve
// ---------------------------------------------------------------------------

interface ApproveInput {
  question: string;
  options?: string[];
  sideEffects?: string[];
  context?: string;
}

interface ApproveOutput {
  sent: true;
}

function buildHumanApprove(
  onApprove: ApproveCallback,
): ExecutableDomainTool<ApproveInput, ApproveOutput> {
  const definition: DomainToolDefinition = {
    name: "human.approve",
    description:
      "Request approval from a human operator for a side-effectful action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1 },
        options: { type: "array", items: { type: "string" } },
        sideEffects: { type: "array", items: { type: "string" } },
        context: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["sent"],
      properties: {
        sent: { type: "boolean", const: true },
      },
    },
    permissionLevel: "read",
    sideEffects: [
      {
        type: "sends_notification",
        description: "Sends an approval request to a human operator.",
      },
    ],
    requiresApproval: true,
    namespace: "human",
  };

  return {
    definition,
    async execute(input: ApproveInput): Promise<ApproveOutput> {
      const payload: ApprovalPayload = {
        type: "approval",
        runId: "",
        nodeIndex: 0,
        question: input.question,
        options: input.options ?? ["approve", "reject"],
        sideEffects: input.sideEffects ?? [],
        ...(input.context !== undefined ? { context: input.context } : {}),
      };
      await invokeCallback(onApprove, payload);
      return { sent: true };
    },
  };
}

export function buildHumanTools(
  onClarify: ClarifyCallback,
  onApprove: ApproveCallback,
): AnyExecutableDomainTool[] {
  return [buildHumanClarify(onClarify), buildHumanApprove(onApprove)];
}

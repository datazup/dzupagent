// MPCO P5 — pre-normalization macro expansion.
// Replaces `collab.review_loop` wrappers with canonical node wrappers
// (adapter.run / validate / if) BEFORE normalization/validation.
// Pure: no I/O, returns a new object, never mutates input.
//
// IMPORTANT — canonical shapes target the dzupflow/v1 NORMALIZE layer
// (`normalizeDslDocument` / `normalizeNodeWrapper`), which is the layer the
// parse pipeline actually runs. That layer differs from the flow-ast `parse/*`
// authoring layer:
//   - the conditional wrapper key is `if` (not `branch`); it normalizes to a
//     `branch` node, but the recognized DSL key is `if`.
//   - `approval.on_approve` is the recognized field (camelCase `onApprove` is
//     also accepted) and must be a non-empty step array.
//   - `adapter.run` requires `instructions` + a non-empty `output` + a
//     provider/tags selector.
//   - `validate` requires a non-empty `commands` array (or a `ref`); we omit
//     the validate node entirely when the macro supplies no gate commands.
// `meta.collabExpansion` is provenance only — expanded nodes still pass the
// NORMAL validator unchanged; it is never a validation escape hatch.

export class CollabMacroError extends Error {
  constructor(message: string) {
    super(`collab.review_loop: ${message}`);
    this.name = "CollabMacroError";
  }
}

interface ReviewLoopInput {
  id: string;
  task: { kind: string; risk?: string };
  proposer: { executionProviderId: string };
  critic: { executionProviderId: string };
  gates?: { commands?: Array<{ command: string }> };
  reconcile?: { mode?: string; maxRevise?: number };
}

function assertReviewLoop(raw: unknown): asserts raw is ReviewLoopInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CollabMacroError("input must be an object");
  }
  const r = raw as Partial<ReviewLoopInput>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new CollabMacroError("id is required");
  }
  if (
    !r.task ||
    typeof r.task !== "object" ||
    typeof r.task.kind !== "string"
  ) {
    throw new CollabMacroError("task.kind is required");
  }
  if (!r.proposer || typeof r.proposer.executionProviderId !== "string") {
    throw new CollabMacroError("proposer.executionProviderId is required");
  }
  if (!r.critic || typeof r.critic.executionProviderId !== "string") {
    throw new CollabMacroError("critic.executionProviderId is required");
  }
}

/**
 * Expand a single `collab.review_loop` macro into canonical dzupflow/v1 step
 * wrappers. Sequential propose -> critique -> (optional gate validate) ->
 * if(reconcile). No loop/return_to: a real bounded-revise subgraph is added in
 * a later packet; here the disagreement path escalates to a human approval.
 */
function expandOne(input: ReviewLoopInput): Array<Record<string, unknown>> {
  const meta = { collabExpansion: input.id };
  const commands = input.gates?.commands ?? [];

  const steps: Array<Record<string, unknown>> = [
    {
      "adapter.run": {
        id: `${input.id}__propose`,
        provider: input.proposer.executionProviderId,
        instructions: `Propose for: ${input.id}`,
        output: `${input.id}_proposal`,
        meta,
      },
    },
    {
      "adapter.run": {
        id: `${input.id}__critique`,
        provider: input.critic.executionProviderId,
        instructions: `Adversarially review the proposer artifact for: ${input.id}`,
        output: `${input.id}_critique`,
        meta,
      },
    },
  ];

  // Only emit a validate node when the macro provides gate commands; an empty
  // commands array would fail validation (validate requires ref or non-empty
  // commands).
  if (commands.length > 0) {
    steps.push({
      validate: {
        id: `${input.id}__gates`,
        commands,
        meta,
      },
    });
  }

  steps.push({
    if: {
      id: `${input.id}__reconcile`,
      condition: "{{ state.agree }}",
      then: [
        { complete: { id: `${input.id}__accept`, result: "accepted", meta } },
      ],
      else: [
        {
          approval: {
            id: `${input.id}__escalate`,
            question: "Reconcile disagreement?",
            on_approve: [
              {
                complete: {
                  id: `${input.id}__reconciled`,
                  result: "reconciled",
                  meta,
                },
              },
            ],
            meta,
          },
        },
      ],
      meta,
    },
  });

  return steps;
}

const MACRO_KEY = "collab.review_loop";

function expandStepArray(
  stepsRaw: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const wrapper of stepsRaw) {
    const key = Object.keys(wrapper)[0];
    if (key === MACRO_KEY) {
      const inner = wrapper[MACRO_KEY];
      assertReviewLoop(inner);
      out.push(...expandOne(inner));
    } else {
      out.push(wrapper);
    }
  }
  return out;
}

/**
 * Pre-normalization pass: replace every `collab.review_loop` wrapper with
 * canonical node wrappers. Operates on whichever step array key is present
 * (`steps`, the dzupflow/v1 authoring key the parse pipeline uses, or `nodes`,
 * the graph-style key) and leaves all other keys untouched. Pure — returns a
 * new object and never mutates the input.
 */
export function expandCollabMacros(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;

  const arrayKey = Array.isArray(doc.steps)
    ? "steps"
    : Array.isArray(doc.nodes)
    ? "nodes"
    : null;
  if (arrayKey === null) return raw;

  const stepsRaw = doc[arrayKey] as Array<Record<string, unknown>>;
  const hasMacro = stepsRaw.some(
    (wrapper) => wrapper && typeof wrapper === "object" && MACRO_KEY in wrapper
  );
  if (!hasMacro) return raw;

  return { ...doc, [arrayKey]: expandStepArray(stepsRaw) };
}

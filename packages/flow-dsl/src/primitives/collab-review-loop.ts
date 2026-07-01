import type { PrimitiveExpansionContext } from "./types.js";

export class CollabMacroError extends Error {
  constructor(message: string) {
    super(`collab.review_loop: ${message}`);
    this.name = "CollabMacroError";
  }
}

interface ReviewLoopProvider {
  executionProviderId: string;
  requestedModel?: string;
}

interface ReviewLoopCommand {
  command: string;
  id?: string;
}

interface ReviewLoopInput {
  id: string;
  task: { kind: string; risk?: string };
  proposer: ReviewLoopProvider;
  critic: ReviewLoopProvider;
  gates?: { commands?: ReviewLoopCommand[] };
  reconcile?: { mode?: string; maxRevise?: number };
}

function assertReviewLoop(raw: unknown): asserts raw is ReviewLoopInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CollabMacroError("input must be an object");
  }
  const input = raw as Partial<ReviewLoopInput>;
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new CollabMacroError("id is required");
  }
  if (
    !input.task ||
    typeof input.task !== "object" ||
    typeof input.task.kind !== "string"
  ) {
    throw new CollabMacroError("task.kind is required");
  }
  if (
    !input.proposer ||
    typeof input.proposer.executionProviderId !== "string"
  ) {
    throw new CollabMacroError("proposer.executionProviderId is required");
  }
  if (!input.critic || typeof input.critic.executionProviderId !== "string") {
    throw new CollabMacroError("critic.executionProviderId is required");
  }
}

function adapterBody(
  id: string,
  provider: ReviewLoopProvider,
  instructions: string,
  output: string,
  meta: Record<string, unknown>
): Record<string, unknown> {
  return {
    "adapter.run": {
      id,
      provider: provider.executionProviderId,
      ...(provider.requestedModel ? { model: provider.requestedModel } : {}),
      instructions,
      output,
      meta,
    },
  };
}

export function expandCollabReviewLoop(
  raw: unknown,
  context: PrimitiveExpansionContext = {
    kind: "collab.review_loop",
    version: "1",
  }
): Array<Record<string, unknown>> {
  assertReviewLoop(raw);
  const primitive = `${context.kind}@${context.version}`;
  const meta = { collabExpansion: raw.id, primitive };
  const commands = raw.gates?.commands ?? [];
  const steps: Array<Record<string, unknown>> = [
    adapterBody(
      `${raw.id}__propose`,
      raw.proposer,
      `Propose for: ${raw.id}`,
      `${raw.id}_proposal`,
      meta
    ),
    adapterBody(
      `${raw.id}__critique`,
      raw.critic,
      `Adversarially review the proposer artifact for: ${raw.id}`,
      `${raw.id}_critique`,
      meta
    ),
  ];

  if (commands.length > 0) {
    steps.push({
      validate: {
        id: `${raw.id}__gates`,
        commands,
        meta,
      },
    });
  }

  steps.push({
    if: {
      id: `${raw.id}__reconcile`,
      condition: "{{ state.agree }}",
      then: [
        {
          complete: {
            id: `${raw.id}__accept`,
            result: "accepted",
            meta,
          },
        },
      ],
      else: [
        {
          approval: {
            id: `${raw.id}__escalate`,
            question: `Reconcile disagreement for ${raw.id}?`,
            on_approve: [
              {
                complete: {
                  id: `${raw.id}__reconciled`,
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

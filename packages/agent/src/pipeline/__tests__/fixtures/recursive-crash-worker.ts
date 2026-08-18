import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type {
  RecursiveAcknowledgementEvidenceInputV1,
  RecursiveScopedFrameV1,
  RecursiveScopedJsonValue,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  deriveRecursiveForEachItemIdentityV1,
  dispatchRecursiveBranchesV1,
  dispatchRecursiveForEachItemsV1,
  type RecursiveBranchChildExecutionV1,
  type RecursiveBranchPlanInputV1,
  type RecursiveForEachItemCommitPayloadV1,
  type RecursiveForEachItemPlanInputV1,
} from "../../recursive-scope/index.js";
import {
  appendRecursiveCrashEvent,
  FileRecursiveCrashPort,
  RecursiveCrashController,
} from "./recursive-crash-test-port.js";

type Scenario =
  | "branch"
  | "branch-single"
  | "branch-left-last"
  | "branch-right-last"
  | "item"
  | "control-single"
  | "control-terminal"
  | "control-ambiguous";

const [rootDirectory, scenarioArgument, modeArgument, crashPoint = "none"] =
  process.argv.slice(2);
if (
  rootDirectory === undefined ||
  ![
    "branch",
    "branch-single",
    "branch-left-last",
    "branch-right-last",
    "item",
    "control-single",
    "control-terminal",
    "control-ambiguous",
  ].includes(scenarioArgument ?? "") ||
  (modeArgument !== "initial" && modeArgument !== "restart")
) {
  throw new Error("Invalid recursive crash-worker arguments.");
}
const scenario = scenarioArgument as Scenario;
const mode = modeArgument;
const stateDirectory = rootDirectory as string;
const crash = new RecursiveCrashController(stateDirectory, crashPoint);
const durable = new FileRecursiveCrashPort(stateDirectory, crash);

const sha = (character: string) =>
  `sha256:${character.repeat(64)}` as RecursiveScopedSha256Digest;
const digest = (value: unknown) =>
  `sha256:${canonicalInputDigest(value)}` as RecursiveScopedSha256Digest;
const observedAt = "2026-08-18T15:00:00.000Z";

function branchPlan(): RecursiveBranchPlanInputV1 {
  const plan: RecursiveBranchPlanInputV1 = {
    frameKind: "fork-branch",
    rootDefinitionId: "crash-root",
    rootDefinitionDigest: sha("a"),
    ownerPath: ["root", "try-owner", "parallel"],
    ownerNodeId: "parallel",
    parentCommitIdentity: sha("c"),
    branches: [
      {
        branchOrdinal: 1,
        branchIdentity: "right",
        childScopeId: "parallel/right",
        scopedDefinitionId: "parallel/right",
        scopedDefinitionDigest: sha("e"),
        nodeInventory: ["right-entry", "right-exit"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "right-entry" },
      },
      {
        branchOrdinal: 0,
        branchIdentity: "left",
        childScopeId: "parallel/left",
        scopedDefinitionId: "parallel/left",
        scopedDefinitionDigest: sha("d"),
        nodeInventory: ["left-entry", "left-exit"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "left-entry" },
      },
    ],
  };
  return scenario === "branch-single"
    ? { ...plan, branches: plan.branches.filter(({ branchIdentity }) => branchIdentity === "left") }
    : plan;
}

function itemPlan(): RecursiveForEachItemPlanInputV1 {
  const values: readonly RecursiveScopedJsonValue[] = ["zero", "one"];
  const collectionSourceDigest = digest(values);
  const forEachNodeId = "recursive-items";
  return {
    rootDefinitionId: "crash-root",
    rootDefinitionDigest: sha("a"),
    ownerPath: ["root", forEachNodeId],
    forEachNodeId,
    parentCommitIdentity: sha("c"),
    collectionSourceDigest,
    maxConcurrency: 1,
    items: values.map((itemValue, itemOrdinal) => {
      const itemValueDigest = digest(itemValue);
      return {
        itemOrdinal,
        itemIdentity: deriveRecursiveForEachItemIdentityV1({
          collectionSourceDigest,
          forEachNodeId,
          itemOrdinal,
          itemValueDigest,
        }),
        itemValue,
        childScopeId: `recursive-items/${itemOrdinal}`,
        scopedDefinitionId: `recursive-items/body/${itemOrdinal}`,
        scopedDefinitionDigest: sha(itemOrdinal === 0 ? "d" : "e"),
        nodeInventory: [`item-${itemOrdinal}-entry`, `item-${itemOrdinal}-exit`],
        continuation: {
          kind: "for-each-join" as const,
          nodeId: "items-join",
        },
        checkpoint: { cursor: `item-${itemOrdinal}-entry` },
        economics: {
          chargeKey: `charge-${itemOrdinal}`,
          reservationIdentity: sha(itemOrdinal === 0 ? "6" : "7"),
          hardCeilingMicros: 1_000 + itemOrdinal,
          currency: "USD",
        },
      };
    }),
  };
}

function ordinal(frame: RecursiveScopedFrameV1): number {
  return frame.ownership.kind === "for-each-item"
    ? frame.ownership.itemOrdinal
    : frame.ownership.branchOrdinal;
}

function acknowledgement(
  boundary: "effect" | "charge",
  itemOrdinal: number,
): RecursiveAcknowledgementEvidenceInputV1 {
  const committedIdentity = sha(
    boundary === "effect"
      ? itemOrdinal === 0
        ? "1"
        : "2"
      : itemOrdinal === 0
        ? "3"
        : "4",
  );
  return {
    status: "committed",
    observation: {
      kind: "durable-commit",
      committedIdentity,
      evidenceDigest: sha(boundary === "effect" ? "8" : "9"),
    },
    observedAt,
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function settleLocalJournal(
  boundary: "effect" | "charge",
  childScopeId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await crash.hit(`${boundary}-before-write`);
  const path = join(
    stateDirectory,
    "operation-journal",
    `${boundary}-${Buffer.from(childScopeId).toString("base64url")}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  const serialized = JSON.stringify(payload);
  let performed = false;
  try {
    await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
    performed = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    if ((await readOptional(path)) !== serialized) {
      throw new Error(`Local ${boundary} journal identity conflict.`);
    }
  }
  await appendRecursiveCrashEvent(stateDirectory, {
    event: performed ? `${boundary}-performed` : `${boundary}-reconciled`,
    childScopeId,
  });
  await crash.hit(`${boundary}-after-write`);
}

async function maybeDelayBranch(childScopeId: string): Promise<void> {
  const delay =
    (scenario === "branch-left-last" && childScopeId.endsWith("/left")) ||
    (scenario === "branch-right-last" && childScopeId.endsWith("/right"));
  if (delay) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function runBranch(): Promise<unknown> {
  const withControl = scenario.startsWith("control-");
  return dispatchRecursiveBranchesV1(
    {
      durable,
      ...(withControl ? { control: { durable } } : {}),
      createChildExecutor: ({ frame }) => {
        void appendRecursiveCrashEvent(stateDirectory, {
          event: "executor-constructed",
          childScopeId: frame.childScopeId,
        });
        return {
          execute: async ({ persistCheckpoint }) => {
            await appendRecursiveCrashEvent(stateDirectory, {
              event: "executor-executed",
              childScopeId: frame.childScopeId,
            });
            if (!withControl) {
              if (frame.checkpoint.stage !== "checkpointed") {
                await persistCheckpoint({ stage: "checkpointed" });
              } else {
                await appendRecursiveCrashEvent(stateDirectory, {
                  event: "checkpoint-restored",
                  childScopeId: frame.childScopeId,
                });
              }
              await maybeDelayBranch(frame.childScopeId);
              return {
                status: "completed",
                commit: {
                  state: { [`state-${ordinal(frame)}`]: ordinal(frame) },
                  results: { [`result-${ordinal(frame)}`]: frame.childScopeId },
                  idempotencyKeys: {
                    [`node-${ordinal(frame)}`]: `key-${ordinal(frame)}`,
                  },
                },
              };
            }
            const left = frame.childScopeId.endsWith("/left");
            if (scenario === "control-single") {
              return left
                ? structuredControl(frame, "interaction")
                : normalControlChild(frame);
            }
            if (scenario === "control-terminal") {
              return left
                ? structuredControl(frame, "terminal")
                : { status: "suspended-for-later", control: "suspension" };
            }
            return structuredControl(
              frame,
              left ? "interaction" : "suspension",
            );
          },
        };
      },
    },
    {
      mode,
      plan: branchPlan(),
      ...(withControl ? { controlPolicy: { catchRoutes: [] } } : {}),
    },
  );
}

function normalControlChild(
  frame: RecursiveScopedFrameV1,
): RecursiveBranchChildExecutionV1 {
  return {
    status: "completed",
    commit: { results: { [frame.childScopeId]: "completed" } },
  };
}

function structuredControl(
  frame: RecursiveScopedFrameV1,
  kind: "interaction" | "suspension" | "terminal",
): RecursiveBranchChildExecutionV1 {
  return {
    status: "suspended-for-later",
    control: kind,
    checkpoint: { stage: `${kind}-checkpoint` },
    intent: {
      kind,
      intentKey: `${kind}:${frame.childScopeId}`,
      nodeId: frame.nodeInventory[0]!,
    },
  };
}

async function runItems(): Promise<unknown> {
  const plan = itemPlan();
  return dispatchRecursiveForEachItemsV1(
    {
      durable,
      createItemExecutor: ({ frame, itemValue, checkpoint }) => {
        void appendRecursiveCrashEvent(stateDirectory, {
          event: "executor-constructed",
          childScopeId: frame.childScopeId,
        });
        return {
          execute: async ({ persistCheckpoint }) => {
            await appendRecursiveCrashEvent(stateDirectory, {
              event: "executor-executed",
              childScopeId: frame.childScopeId,
            });
            if (checkpoint.stage !== "checkpointed") {
              await persistCheckpoint({ ...checkpoint, stage: "checkpointed" });
            } else {
              await appendRecursiveCrashEvent(stateDirectory, {
                event: "checkpoint-restored",
                childScopeId: frame.childScopeId,
              });
            }
            const itemOrdinal = ordinal(frame);
            const effectPayload = {
              idempotencyKey: `effect-${itemOrdinal}`,
              intentDigest: sha(itemOrdinal === 0 ? "a" : "b"),
            };
            const chargePayload = {
              reservationIdentity: sha(itemOrdinal === 0 ? "6" : "7"),
              measurementDigest: sha(itemOrdinal === 0 ? "c" : "d"),
              settledCostMicros: 500 + itemOrdinal,
              currency: "USD",
            };
            await settleLocalJournal(
              "effect",
              frame.childScopeId,
              effectPayload,
            );
            await settleLocalJournal(
              "charge",
              frame.childScopeId,
              chargePayload,
            );
            const commit: RecursiveForEachItemCommitPayloadV1 = {
              results: { [`result-${itemOrdinal}`]: itemValue },
              idempotencyKeys: {
                [`node-${itemOrdinal}`]: `key-${itemOrdinal}`,
              },
              effects: {
                [`effect-${itemOrdinal}`]: {
                  ...effectPayload,
                  acknowledgement: acknowledgement("effect", itemOrdinal),
                },
              },
              charges: {
                [`charge-${itemOrdinal}`]: {
                  ...chargePayload,
                  acknowledgement: acknowledgement("charge", itemOrdinal),
                },
              },
            };
            return {
              status: "completed",
              orderedResult: { itemOrdinal, itemValue },
              commit,
            };
          },
        };
      },
    },
    { mode, plan },
  );
}

function summarize(outcome: unknown): Readonly<Record<string, unknown>> {
  if (typeof outcome !== "object" || outcome === null || !("status" in outcome)) {
    throw new Error("Recursive crash worker returned an invalid outcome.");
  }
  const typed = outcome as {
    readonly status: string;
    readonly reason?: string;
    readonly childScopeId?: string;
    readonly control?: string;
    readonly decision?: { readonly decisionIdentity: string };
    readonly merge?: { readonly mergeIdentity: string };
    readonly orderedResults?: readonly unknown[];
    readonly progress?: unknown;
  };
  return {
    status: typed.status,
    ...(typed.reason === undefined ? {} : { reason: typed.reason }),
    ...(typed.childScopeId === undefined
      ? {}
      : { childScopeId: typed.childScopeId }),
    ...(typed.control === undefined ? {} : { control: typed.control }),
    ...(typed.decision === undefined
      ? {}
      : { decisionIdentity: typed.decision.decisionIdentity }),
    ...(typed.merge === undefined
      ? {}
      : { mergeIdentity: typed.merge.mergeIdentity }),
    ...(typed.orderedResults === undefined
      ? {}
      : { orderedResults: typed.orderedResults }),
    ...(typed.progress === undefined ? {} : { progress: typed.progress }),
  };
}

const outcome = scenario === "item" ? await runItems() : await runBranch();
const summary = summarize(outcome);
await writeFile(
  join(stateDirectory, "last-summary.json"),
  JSON.stringify(summary),
  "utf8",
);
await appendRecursiveCrashEvent(stateDirectory, {
  event: `outcome-${String(summary.status)}`,
});
if (summary.status === "completed") {
  await crash.hit("parent-merge-after-materialize");
}
process.stdout.write(`RESULT:${JSON.stringify(summary)}\n`);

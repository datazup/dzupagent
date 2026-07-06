import {
  createRuntimeToolHandlers,
  formatRuntimeToolReadinessReport,
  getRuntimeToolReadiness,
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  RUNTIME_TOOL_NAMES,
  type PipelineState,
  type RuntimeToolHandlers,
} from "@dzupagent/agent/pipeline";
import type { PipelineDefinition } from "@dzupagent/core/pipeline";
import { createFlowCompiler } from "@dzupagent/flow-compiler";
import {
  BUILT_IN_FRAGMENT_REGISTRY,
  parseDslToDocument,
} from "@dzupagent/flow-dsl";

export interface HostValidationCommandOutput {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationItem {
  id: string;
  command: string;
  result: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationStatus {
  id: string;
  command: string;
  accepted: boolean;
  status: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export function shapeCommandOutputsForBatchValidation(
  outputs: readonly HostValidationCommandOutput[],
): SdlcBatchValidationItem[] {
  return outputs.map((output) => {
    const item: SdlcBatchValidationItem = {
      id: output.id,
      command: output.command,
      result: output.exitCode === 0 ? "pass" : "fail",
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
    if (output.durationMs !== undefined) {
      item.durationMs = output.durationMs;
    }
    return item;
  });
}

export interface SdlcValidationRuntimeToolHandlerOptions {
  /**
   * State key used by the `sdlc.batch_validation` loop body for each shaped
   * validation item.
   */
  itemStateKey?: string;
}

export interface SdlcMvpEvidenceReportOptions {
  packetItems?: readonly { ref: string }[];
  commandOutputs?: readonly HostValidationCommandOutput[];
  env?: Record<string, string | undefined>;
}

export interface SdlcMvpEvidenceReport {
  parseOk: boolean;
  compileOk: boolean;
  runtimeReady: boolean;
  readinessReport: string;
  checkpointBackend: "memory";
  backendChecks: {
    redisConfigured: boolean;
    postgresConfigured: boolean;
  };
  execution: {
    state: PipelineState;
    runId: string;
    exportedState: {
      truth?: unknown;
      closeoutStatus?: unknown;
    };
  };
}

export function createSdlcValidationRuntimeToolHandlers(
  options: SdlcValidationRuntimeToolHandlerOptions = {},
): RuntimeToolHandlers {
  const itemStateKey = options.itemStateKey ?? "validationItem";
  const handlers = createRuntimeToolHandlers({
    validateSchema: async ({ context, source }) => {
      const item = context.state[itemStateKey];
      if (item === undefined) {
        return { output: source };
      }
      return {
        output: sdlcBatchValidationStatusFromItem(
          item as SdlcBatchValidationItem,
        ),
      };
    },
  });
  return {
    [RUNTIME_TOOL_NAMES.validateSchema]:
      handlers[RUNTIME_TOOL_NAMES.validateSchema]!,
  };
}

const SDLC_MVP_CLOSEOUT_DSL = `
dsl: dzupflow/v1
id: sdlc-mvp-closeout
version: 1
uses:
  sdlc: dzup.sdlc@1
steps:
  - sdlc.current_truth:
      id: truth
      scope: dzupagent
      output: truth
  - sdlc.packet_fanout:
      id: fanout
      packetsKey: packetItems
      output: packetStatuses
  - sdlc.batch_validation:
      id: batch
      itemsKey: validationItems
      output: validationStatuses
  - sdlc.closeout:
      id: closeout
      status: complete
      output: closeoutStatus
`;

export async function runSdlcMvpEvidenceReport(
  options: SdlcMvpEvidenceReportOptions = {},
): Promise<SdlcMvpEvidenceReport> {
  const parsed = parseDslToDocument(SDLC_MVP_CLOSEOUT_DSL, {
    fragmentRegistry: BUILT_IN_FRAGMENT_REGISTRY,
    requirePinnedFragmentUses: true,
  });
  if (!parsed.ok) {
    throw new Error("expected SDLC MVP closeout DSL to parse");
  }

  const compiler = createFlowCompiler({
    toolResolver: {
      resolve(ref) {
        if (ref !== "sdlc.current_truth" && ref !== "validate.schema") {
          return null;
        }
        return {
          ref,
          kind: "skill",
          inputSchema: { type: "object" },
          handle: { skillId: ref },
        };
      },
      listAvailable: () => ["sdlc.current_truth", "validate.schema"],
    },
  });
  const compiled = await compiler.compileDocument(parsed.document);
  if ("errors" in compiled) {
    throw new Error("expected SDLC MVP closeout DSL to compile");
  }

  const definition = {
    ...(compiled.artifact as PipelineDefinition),
    checkpointStrategy: "after_each_node",
  } satisfies PipelineDefinition;
  const runtimeToolHandlers = {
    ...createRuntimeToolHandlers({
      workerDispatch: async ({ context }) => {
        const packet = context.state.packetItem as { ref: string };
        return {
          output: {
            packetRef: packet.ref,
            accepted: true,
            status: "ready",
          },
        };
      },
    }),
    ...createSdlcValidationRuntimeToolHandlers(),
  };
  const readiness = getRuntimeToolReadiness(definition, runtimeToolHandlers);
  const checkpointStore = new InMemoryPipelineCheckpointStore();
  const result = await new PipelineRuntime({
    definition,
    checkpointStore,
    runtimeToolHandlers,
    nodeExecutor: async (nodeId, node) => {
      if (node.type === "tool" && node.toolName === "sdlc.current_truth") {
        return {
          nodeId,
          output: { scope: "dzupagent", dirty: false },
          durationMs: 1,
        };
      }
      return {
        nodeId,
        output: null,
        durationMs: 1,
        error: `unexpected fallback execution for ${node.type}`,
      };
    },
  }).execute({
    packetItems: options.packetItems ?? [
      { ref: "packet/alpha" },
      { ref: "packet/beta" },
    ],
    validationItems: shapeCommandOutputsForBatchValidation(
      options.commandOutputs ?? [
        {
          id: "types",
          command: "yarn workspace @dzupagent/flow-dsl typecheck",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
        {
          id: "tests",
          command: "yarn workspace @dzupagent/testing test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
      ],
    ),
  });
  const finalCheckpoint = await checkpointStore.load(result.runId);
  const env = options.env ?? process.env;

  return {
    parseOk: true,
    compileOk: true,
    runtimeReady: readiness.ready,
    readinessReport: formatRuntimeToolReadinessReport(readiness),
    checkpointBackend: "memory",
    backendChecks: {
      redisConfigured: Boolean(env["DZUPAGENT_REDIS_URL"]),
      postgresConfigured: Boolean(env["DZUPAGENT_POSTGRES_URL"]),
    },
    execution: {
      state: result.state,
      runId: result.runId,
      exportedState: {
        truth: finalCheckpoint?.state["truth"],
        closeoutStatus: finalCheckpoint?.state["closeoutStatus"],
      },
    },
  };
}

function sdlcBatchValidationStatusFromItem(
  item: SdlcBatchValidationItem,
): SdlcBatchValidationStatus {
  const status: SdlcBatchValidationStatus = {
    id: item.id,
    command: item.command,
    accepted: item.result === "pass",
    status: item.result,
    exitCode: item.exitCode,
    stdout: item.stdout,
    stderr: item.stderr,
  };
  if (item.durationMs !== undefined) {
    status.durationMs = item.durationMs;
  }
  return status;
}

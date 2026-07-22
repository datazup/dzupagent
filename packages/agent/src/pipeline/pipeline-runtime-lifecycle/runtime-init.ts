/**
 * Construction-time wiring for the pipeline runtime.
 *
 * Extracted from `pipeline-runtime.ts` (DZUPAGENT-ARCH-M-06). Holds the two
 * pure setup steps the constructor performs before it can run anything:
 *
 *  - `normalizeRuntimeConfig` — wrap the caller's `nodeExecutor` with the
 *    runtime-tool executor, resolve/auto-wire the checkpoint store, and install
 *    the event-capture tap. Returns the effective config plus the shared event
 *    log the tap appends to.
 *  - `buildNodeIndex` — materialise the id→node map and the outgoing/error edge
 *    adjacency maps from the definition.
 *
 * Behaviour is identical to the original inline code; no runtime state is held
 * here.
 *
 * @module pipeline/pipeline-runtime-lifecycle/runtime-init
 */

import type { PipelineNode, PipelineEdge } from "@dzupagent/core/pipeline";
import { InMemoryPipelineCheckpointStore } from "../in-memory-checkpoint-store.js";
import { PostgresPipelineCheckpointStore } from "../postgres-checkpoint-store.js";
import { RedisPipelineCheckpointStore } from "../redis-checkpoint-store.js";
import type {
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from "../pipeline-runtime-types.js";
import { createRuntimeToolNodeExecutor } from "../runtime-tool-handlers.js";
import {
  resolveCheckpointStore,
  shouldCaptureRuntimeEvents,
} from "./checkpoint-store-resolution.js";

/** Adjacency indexes derived from a pipeline definition. */
export interface NodeIndex {
  readonly nodeMap: Map<string, PipelineNode>;
  readonly outgoingEdges: Map<string, PipelineEdge[]>;
  readonly errorEdges: Map<string, PipelineEdge[]>;
}

/**
 * Produce the effective runtime config: wrap the node executor with the
 * runtime-tool executor, resolve and (when absent) auto-wire the checkpoint
 * store, and tap `onEvent` so captured events land in a shared `eventLog`.
 * Returns both the normalized config and that log so the runtime can expose it.
 */
export function normalizeRuntimeConfig(config: PipelineRuntimeConfig): {
  config: PipelineRuntimeConfig;
  eventLog: PipelineRuntimeEvent[];
} {
  const eventLog: PipelineRuntimeEvent[] = [];
  const downstreamOnEvent = config.onEvent;
  const captureEvents = shouldCaptureRuntimeEvents(config.definition);
  const resolvedCheckpointStore = resolveCheckpointStore(config);
  let next: PipelineRuntimeConfig = {
    ...config,
    nodeExecutor: createRuntimeToolNodeExecutor(
      config.nodeExecutor,
      config.runtimeToolHandlers
    ),
    ...(resolvedCheckpointStore !== undefined
      ? { checkpointStore: resolvedCheckpointStore }
      : {}),
    onEvent: (event) => {
      if (captureEvents) eventLog.push(structuredClone(event));
      downstreamOnEvent?.(event);
    },
  };

  // Auto-wire checkpoint store when not explicitly provided.
  if (!next.checkpointStore) {
    if (next.redisClient) {
      next = {
        ...next,
        checkpointStore: new RedisPipelineCheckpointStore({
          client: next.redisClient,
        }),
      };
    } else if (next.pgClient) {
      next = {
        ...next,
        checkpointStore: new PostgresPipelineCheckpointStore({
          client: next.pgClient,
        }),
      };
    } else {
      next = {
        ...next,
        checkpointStore: new InMemoryPipelineCheckpointStore(),
      };
    }
  }

  return { config: next, eventLog };
}

/**
 * Build the id→node map plus outgoing/error edge adjacency maps for a
 * definition. Every node gets an (initially empty) entry in all three maps so
 * lookups never miss for a declared node.
 */
export function buildNodeIndex(
  definition: PipelineRuntimeConfig["definition"]
): NodeIndex {
  const nodeMap = new Map<string, PipelineNode>();
  const outgoingEdges = new Map<string, PipelineEdge[]>();
  const errorEdges = new Map<string, PipelineEdge[]>();

  for (const node of definition.nodes) {
    nodeMap.set(node.id, node);
    outgoingEdges.set(node.id, []);
    errorEdges.set(node.id, []);
  }

  for (const edge of definition.edges) {
    if (edge.type === "error") {
      errorEdges.get(edge.sourceNodeId)?.push(edge);
    } else {
      outgoingEdges.get(edge.sourceNodeId)?.push(edge);
    }
  }

  return { nodeMap, outgoingEdges, errorEdges };
}

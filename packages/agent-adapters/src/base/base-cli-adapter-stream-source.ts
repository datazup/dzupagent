import type { AgentEvent, AgentInput } from "../types.js";
import { withCorrelationId } from "../types.js";
import type { RawAgentEvent } from "@dzupagent/adapter-types";
import type { SpawnJsonlOptions } from "../utils/process-helpers.js";
import { spawnAndStreamJsonl } from "../utils/process-helpers.js";
import type { AdapterProviderId } from "../types.js";
import type { GovernanceEmitter } from "./governance-emitter.js";
import type { InteractionResolver } from "../interaction/interaction-resolver.js";
import type { InteractionPolicy } from "../types.js";
import { createStdinResponder } from "./stdin-responder.js";
import type {
  AdapterStreamSource,
  StreamContext,
  ThreadStartResult,
} from "./stream-runner.js";
import type { NormalizedAdapterError } from "./adapter-error-normalizer.js";
import type { RunEventStore } from "../runs/run-event-store.js";
import type { PreparedCliRun } from "./prepared-cli-run.js";

/**
 * Minimal view of {@link BaseCliAdapter} that the stream-source factory needs.
 * Keeps this leaf module decoupled from the full class surface.
 */
export interface StreamSourceAdapter {
  readonly providerId: AdapterProviderId;
  readonly governance: GovernanceEmitter;
  getBinaryName(): string;
  prepareCliRun(input: AgentInput): Promise<PreparedCliRun>;
  mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string
  ): AgentEvent | AgentEvent[] | undefined;
  detectProviderThreadStart(
    record: Record<string, unknown>
  ): ThreadStartResult | null;
  normalizeError(err: unknown): NormalizedAdapterError;
}

export interface RunFlags {
  hasCompleted: boolean;
  hasFailed: boolean;
  rawOrdinal: number;
}

export interface BuildStreamSourceOptions {
  readonly adapter: StreamSourceAdapter;
  readonly input: AgentInput;
  readonly sessionId: string;
  readonly policy: InteractionPolicy;
  readonly resolver: InteractionResolver | null;
  readonly pendingEvents: AgentEvent[];
  readonly captured: { error: NormalizedAdapterError | null };
  readonly flags: RunFlags;
  readonly emitRaw: boolean;
  readonly store: RunEventStore | null;
  readonly timeoutMs?: number | undefined;
  /** Queue that receives raw events for the caller to flush before each batch. */
  readonly rawQueue: RawAgentEvent[];
}

/**
 * Construct the {@link AdapterStreamSource} that drives one CLI run, including
 * spawn/JSONL streaming, provider-event mapping, and raw-event interception.
 * Extracted from {@link BaseCliAdapter.executeWithRaw} to keep the class a thin
 * composition root. Mutates the shared `flags`, `captured`, `pendingEvents`,
 * and `rawQueue` structures owned by the caller.
 */
export function buildCliStreamSource(
  opts: BuildStreamSourceOptions
): AdapterStreamSource<Record<string, unknown>> {
  const {
    adapter,
    input,
    sessionId,
    policy,
    resolver,
    pendingEvents,
    captured,
    flags,
    emitRaw,
    store,
    timeoutMs,
    rawQueue,
  } = opts;

  const source: AdapterStreamSource<Record<string, unknown>> = {
    providerId: adapter.providerId,
    async *open(_input: AgentInput, signal: AbortSignal) {
      const prepared = await adapter.prepareCliRun(_input);
      const spawnOpts: SpawnJsonlOptions = {
        cwd: prepared.cwd,
        env: prepared.env,
        signal,
        timeoutMs,
        malformedLinePolicy: prepared.malformedLinePolicy,
        stdoutMode: prepared.stdoutMode,
        limits: prepared.limits,
      };
      if (resolver) {
        spawnOpts.stdinResponder = createStdinResponder({
          providerId: adapter.providerId,
          resolver,
          policy,
          input: _input,
          sessionId,
          pendingEvents,
          governance: adapter.governance,
        });
      }
      try {
        yield* spawnAndStreamJsonl(
          adapter.getBinaryName(),
          prepared.args,
          spawnOpts
        );
      } catch (err: unknown) {
        // Capture for ForgeError rethrow + custom adapter:failed emission;
        // also rethrow so the runner's catch path triggers its lifecycle
        // bookkeeping (abort handling, finally cleanup).
        captured.error = adapter.normalizeError(err);
        throw err;
      } finally {
        await prepared.cleanup?.();
      }
    },
    mapRawEvent(
      record: Record<string, unknown>,
      _context: StreamContext
    ): AgentEvent | AgentEvent[] | null {
      const events: AgentEvent[] = [];
      for (const evt of pendingEvents.splice(0)) events.push(evt);

      // Emit governance:hook_executed for recognized hook records.
      adapter.governance.emitHookExecutedIfRecognized(record, {
        runId: input.correlationId ?? sessionId,
        sessionId,
      });

      const mapped = adapter.mapProviderEvent(record, sessionId);
      if (mapped) {
        const mappedEvents = Array.isArray(mapped) ? mapped : [mapped];
        for (const mappedEvent of mappedEvents) {
          const event = withCorrelationId(mappedEvent, input.correlationId);
          if (event.type === "adapter:completed") flags.hasCompleted = true;
          if (event.type === "adapter:failed") flags.hasFailed = true;
          events.push(event);
        }
      }
      return events.length === 0 ? null : events;
    },
    detectThreadStart(
      record: Record<string, unknown>
    ): ThreadStartResult | null {
      return adapter.detectProviderThreadStart(record);
    },
  };

  // Intercept mapRawEvent to also capture the raw record, then emit the
  // ProviderRawStreamEvent before the normalized events downstream.
  const originalMapRawEvent = source.mapRawEvent!.bind(source);
  source.mapRawEvent = (
    record: Record<string, unknown>,
    context: StreamContext
  ) => {
    if (emitRaw) {
      flags.rawOrdinal += 1;
      const providerEventId = `${adapter.providerId}-raw-${flags.rawOrdinal}`;
      const rawEvent: RawAgentEvent = {
        providerId: adapter.providerId,
        runId: input.correlationId ?? sessionId,
        sessionId,
        providerEventId,
        timestamp: Date.now(),
        source: "stdout",
        payload: record,
        ...(input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
      };
      rawQueue.push(rawEvent);
      // Fire-and-forget persistence — errors are swallowed by RunEventStore
      if (store) {
        void store.appendRaw(rawEvent);
      }
    }
    return originalMapRawEvent(record, context);
  };

  return source;
}

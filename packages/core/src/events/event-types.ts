/**
 * Event type barrel — re-exports the discriminated union of all events
 * emitted through {@link DzupEventBus} from focused sibling modules.
 *
 * The full union is composed here (not in a single file) so each domain
 * grouping can grow independently while keeping caller imports stable:
 *
 *   import type { DzupEvent } from './events/event-types.js'
 *
 * Domain modules:
 *   - event-types-shared.ts        — shared payloads (BudgetUsage, …)
 *   - event-types-agent.ts         — agent + tool + agent telemetry
 *   - event-types-llm-memory.ts    — LLM invocation, memory, budget
 *   - event-types-orchestration.ts — pipeline, approval, MCP, supervisor, …
 *   - event-types-platform.ts      — identity, registry, security, ledger, …
 *   - event-types-domain.ts        — persona, scheduler, skill, workflow, …
 *   - event-types-adapter.ts       — adapter run lifecycle, session, UCL, …
 */
import type { RunStatus } from "../persistence/store-interfaces.js";
import type { AdapterDomainEvent } from "./event-types-adapter.js";
import type { AgentDomainEvent } from "./event-types-agent.js";
import type { DomainLifecycleEvent } from "./event-types-domain.js";
import type { LlmMemoryDomainEvent } from "./event-types-llm-memory.js";
import type { OrchestrationDomainEvent } from "./event-types-orchestration.js";
import type { PlatformDomainEvent } from "./event-types-platform.js";

export type {
  AdapterProgressDzupEvent,
  AdapterRuntimeDzupEvent,
  BudgetUsage,
  LlmInvocationRecord,
  MapReduceDzupEvent,
  FanoutRuntimeDzupEvent,
  SubagentRuntimeDzupEvent,
  SubagentGovernanceDzupEvent,
  ToolCallAuditRecord,
  ToolCallAuditSink,
  ToolStatSummary,
} from "./event-types-shared.js";

export type { AdapterDomainEvent } from "./event-types-adapter.js";
export type { AgentDomainEvent } from "./event-types-agent.js";
export type { DomainLifecycleEvent } from "./event-types-domain.js";
export type { LlmMemoryDomainEvent } from "./event-types-llm-memory.js";
export type { OrchestrationDomainEvent } from "./event-types-orchestration.js";
export type { PlatformDomainEvent } from "./event-types-platform.js";

/**
 * Discriminated union of all events emitted through DzupEventBus.
 *
 * Each event has a `type` discriminator and type-specific payload fields.
 * Use `DzupEvent['type']` to enumerate all event types.
 */
export type DzupEvent =
  | AgentDomainEvent
  | LlmMemoryDomainEvent
  | OrchestrationDomainEvent
  | PlatformDomainEvent
  | DomainLifecycleEvent
  | AdapterDomainEvent;

/** Extract a specific event by its type discriminator */
export type DzupEventOf<T extends DzupEvent["type"]> = Extract<
  DzupEvent,
  { type: T }
>;

/**
 * Adapter run lifecycle event union — one event per terminal/intermediate
 * `RunStatus`. Exposed so adapter-layer code that mints these events from a
 * dynamic `run.status` discriminator can bind the resulting object to a
 * concrete type before calling {@link typedEmit}.
 */
export type RunLifecycleEvent = DzupEventOf<`adapter:run_${RunStatus}`>;

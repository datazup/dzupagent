# 04 — Orchestration & Coordination Patterns

> **Created:** 2026-03-24
> **Status:** Proposed
> **Package:** `@dzipagent/agent` (orchestration subsystem)
> **Depends on:** 01-Identity (agent URIs), 02-Communication (ProtocolAdapter), 03-Discovery (AgentRegistry)
> **Gaps addressed:** G-12 (parallel orchestration), supervisor wiring, contract-net, dynamic topology, blackboard, workflow persistence, quorum consensus, cascading timeouts, dead-letter queue

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Pattern Taxonomy](#2-pattern-taxonomy)
3. [F1: Fix Supervisor Tool Wiring (P0)](#3-f1-fix-supervisor-tool-wiring)
4. [F2: Contract-Net Protocol (P1)](#4-f2-contract-net-protocol)
5. [F3: Dynamic Topology Switching (P1)](#5-f3-dynamic-topology-switching)
6. [F4: Blackboard Architecture (P1)](#6-f4-blackboard-architecture)
7. [F5: Workflow Persistence (P1)](#7-f5-workflow-persistence)
8. [F6: Quorum Consensus (P2)](#8-f6-quorum-consensus)
9. [F7: Cascading Timeouts (P1)](#9-f7-cascading-timeouts)
10. [F8: Dead-Letter Queue (P2)](#10-f8-dead-letter-queue)
11. [F9: Multi-Round Debate (P2)](#11-f9-multi-round-debate)
12. [F10: Agent Tournament (P3)](#12-f10-agent-tournament)
13. [State Machines](#13-state-machines)
14. [Data Flow Diagrams](#14-data-flow-diagrams)
15. [File Structure](#15-file-structure)
16. [Testing Strategy](#16-testing-strategy)
17. [Implementation Roadmap](#17-implementation-roadmap)

---

## 1. Architecture Overview

### Current State

The `@dzipagent/agent` package provides these orchestration primitives:

| Component | Location | Status |
|-----------|----------|--------|
| `AgentOrchestrator.sequential()` | `orchestration/orchestrator.ts` | Working |
| `AgentOrchestrator.parallel()` | `orchestration/orchestrator.ts` | Working |
| `AgentOrchestrator.supervisor()` | `orchestration/orchestrator.ts` | **Broken** -- tools not wired |
| `AgentOrchestrator.debate()` | `orchestration/orchestrator.ts` | Working (single-round only) |
| `mapReduce()` / `mapReduceMulti()` | `orchestration/map-reduce.ts` | Working |
| `WorkflowBuilder` | `workflow/workflow-builder.ts` | Working (in-memory only) |
| `CompiledWorkflow` | `workflow/workflow-builder.ts` | Working (no persistence) |
| `ApprovalGate` | `approval/approval-gate.ts` | Working |
| `IterationBudget` | `guardrails/iteration-budget.ts` | Working (with `fork()`) |
| `StuckDetector` | `guardrails/stuck-detector.ts` | Working |
| `DynamicToolRegistry` | `agent/tool-registry.ts` | Working |

### Target Architecture

```
+------------------------------------------------------------------+
|                    @dzipagent/agent                              |
|                                                                  |
|  +-------------------+  +-------------------+  +---------------+ |
|  | DzipAgent        |  | WorkflowBuilder   |  | Guardrails    | |
|  |  .generate()      |  |  .then()          |  |  Budget       | |
|  |  .stream()        |  |  .parallel()      |  |  StuckDetect  | |
|  |  .asTool()        |  |  .branch()        |  |  Timeout      | |
|  +--------+----------+  |  .suspend()       |  +-------+-------+ |
|           |              |  .build()         |          |         |
|           v              +--------+----------+          |         |
|  +-------------------+           |                      |         |
|  | Orchestrator      |<----------+                      |         |
|  |  .sequential()    |                                  |         |
|  |  .parallel()      |     +------------------------+   |         |
|  |  .supervisor()  <-+---->| Contract-Net Manager   |   |         |
|  |  .debate()        |     |  CFP -> Bid -> Award   |   |         |
|  |  .mapReduce()     |     +------------------------+   |         |
|  |  .contractNet()   |                                  |         |
|  |  .blackboard()    |     +------------------------+   |         |
|  |  .tournament()    |     | Topology Analyzer      |   |         |
|  |  .quorum()        |     |  hierarchical/mesh/    |   |         |
|  +--------+----------+     |  pipeline/star/ring    |   |         |
|           |                +------------------------+   |         |
|           v                                             |         |
|  +-------------------+     +------------------------+   |         |
|  | Blackboard        |     | Cascading Timeouts     |<--+         |
|  |  SharedState      |     |  Deadline propagation  |             |
|  |  KnowledgeSources |     |  AbortController chain |             |
|  |  ControlComponent |     +------------------------+             |
|  +-------------------+                                            |
|                            +------------------------+             |
|  +-------------------+     | Dead-Letter Queue      |             |
|  | Workflow Persist   |     |  Failed interaction    |             |
|  |  Checkpoint/Resume |     |  Retry + backoff       |             |
|  |  State versioning  |     |  Manual replay         |             |
|  +-------------------+     +------------------------+             |
+------------------------------------------------------------------+
        |                              |
        v                              v
+------------------+         +--------------------+
| @dzipagent/core |         | @dzipagent/server |
|  DzipEventBus   |         |  PostgresRunStore   |
|  MemoryService   |         |  Drizzle schemas    |
|  ModelRegistry   |         |  REST API           |
+------------------+         +--------------------+
```

### Integration with WorkflowBuilder

Every orchestration pattern can be used in two modes:

1. **Standalone** -- call `AgentOrchestrator.contractNet(...)` directly
2. **As a WorkflowStep** -- wrap the pattern as a `WorkflowStep` and plug it into `WorkflowBuilder`

```typescript
// Standalone
const result = await AgentOrchestrator.contractNet(manager, specialists, task)

// As a WorkflowStep inside a workflow
const cnetStep: WorkflowStep = {
  id: 'delegate-via-cnet',
  execute: async (state, ctx) => {
    const result = await AgentOrchestrator.contractNet(
      manager, specialists, state.task as string,
      { signal: ctx.signal }
    )
    return { delegationResult: result }
  },
}

const workflow = createWorkflow({ id: 'my-pipeline' })
  .then(planStep)
  .then(cnetStep)   // <-- contract-net as a workflow step
  .then(reviewStep)
  .build()
```

### Integration with ProtocolAdapter

For cross-process orchestration (agents in different containers or services), patterns delegate message transport to `ProtocolAdapter` from doc 02-COMMUNICATION-PROTOCOLS:

```typescript
// Local agent -- direct invocation
const localAgent: DzipAgent = new DzipAgent({ ... })

// Remote agent -- ProtocolAdapter wraps HTTP/WebSocket/A2A transport
const remoteAgent: DzipAgent = protocolAdapter.wrapAsLocal(remoteAgentUri)

// Both work identically with orchestration patterns
await AgentOrchestrator.parallel([localAgent, remoteAgent], task)
```

This is transparent because `DzipAgent.asTool()` and `DzipAgent.generate()` are the universal interfaces. Remote agents implement these via protocol adapters.

---

## 2. Pattern Taxonomy

```
Orchestration Patterns
+-- Coordination Patterns (how agents interact)
|   +-- Sequential (pipeline)           -- EXISTING
|   +-- Parallel (fan-out/merge)        -- EXISTING
|   +-- Supervisor (manager/worker)     -- EXISTING (broken)
|   +-- Contract-Net (negotiated delegation) -- NEW (F2)
|   +-- Blackboard (shared workspace)   -- NEW (F4)
|
+-- Decision Patterns (how agents agree)
|   +-- Debate (propose/judge)          -- EXISTING (single-round)
|   +-- Quorum Consensus (N-of-M vote)  -- NEW (F6)
|   +-- Tournament (competitive)        -- NEW (F10)
|   +-- Multi-Round Debate              -- NEW (F9)
|
+-- Topology Patterns (how agents are connected)
|   +-- Hierarchical (tree)             -- via supervisor
|   +-- Star (hub-spoke)                -- via parallel
|   +-- Pipeline (chain)                -- via sequential
|   +-- Mesh (all-to-all)               -- NEW (F3)
|   +-- Ring (circular pass)            -- NEW (F3)
|
+-- Infrastructure Patterns (cross-cutting)
    +-- Cascading Timeouts              -- NEW (F7)
    +-- Dead-Letter Queue               -- NEW (F8)
    +-- Workflow Persistence             -- NEW (F5)
    +-- Dynamic Topology Switching       -- NEW (F3)
```

### Key Insight from Research

Architecture-task alignment determines success, not agent count. The Contract Net Protocol (Smith 1980) is foundational: agents bid on tasks based on capability and availability, and the manager awards based on bid quality. Blackboard architectures achieve competitive performance with fewer tokens because agents only act when they have relevant knowledge to contribute.

---

## 3. F1: Fix Supervisor Tool Wiring

**Priority:** P0 | **Effort:** 2h | **Risk:** Low

### Problem

`AgentOrchestrator.supervisor()` in `orchestration/orchestrator.ts` (line 56-85) has a `TODO: wire specialist tools into manager agent`. The current implementation:

1. Calls `specialists.map(s => s.asTool())` but discards the result (`void await`)
2. Builds a text description of specialists instead
3. The manager generates without access to specialist tools
4. The manager cannot actually delegate work -- it only sees descriptions

### Root Cause

`DzipAgent` is constructed with a fixed `tools` array (`DzipAgentConfig.tools`). There is no way to add tools post-construction. The supervisor pattern needs to inject specialist tools into the manager at call time.

### Solution

Create a new `DzipAgent` instance for the manager that includes specialist tools. Since `DzipAgent` is effectively immutable after construction, we construct a fresh manager with the combined tool set.

### Exact Changes

**File: `packages/forgeagent-agent/src/orchestration/orchestrator.ts`**

Replace the `supervisor` method (lines 50-85):

```typescript
/**
 * Supervisor pattern -- manager agent delegates to specialist agents via tools.
 *
 * Each specialist is wrapped via asTool() and injected into a fresh manager
 * instance. The manager's LLM decides which specialist(s) to invoke and
 * with what input via function calling.
 *
 * @param manager - The coordinating agent (its instructions guide delegation)
 * @param specialists - Agents to expose as callable tools
 * @param task - The task to accomplish
 * @param options - Optional signal and health-check config
 */
static async supervisor(
  manager: DzipAgent,
  specialists: DzipAgent[],
  task: string,
  options?: {
    signal?: AbortSignal
    /** If true, ping specialists before wiring (default: false) */
    healthCheck?: boolean
    /** Max iterations for the manager's tool loop (default: manager's config) */
    maxIterations?: number
  },
): Promise<string> {
  // 1. Optionally health-check specialists
  const healthy = options?.healthCheck
    ? await AgentOrchestrator.filterHealthy(specialists)
    : specialists

  if (healthy.length === 0) {
    throw new OrchestrationError(
      'supervisor',
      'No healthy specialists available',
      { totalSpecialists: specialists.length },
    )
  }

  // 2. Wrap each specialist as a LangChain tool
  const specialistTools = await Promise.all(
    healthy.map(s => s.asTool()),
  )

  // 3. Build a new manager with specialist tools added to its existing tools
  const managerWithTools = AgentOrchestrator.cloneWithTools(
    manager,
    specialistTools,
  )

  // 4. Run the manager -- it will call specialist tools via function calling
  const messages: BaseMessage[] = [
    new HumanMessage(task),
  ]

  const result = await managerWithTools.generate(messages, {
    maxIterations: options?.maxIterations,
    signal: options?.signal,
  })

  return result.content
}

/**
 * Create a new DzipAgent with additional tools appended.
 * Used by supervisor and other patterns that need to inject tools at runtime.
 */
private static cloneWithTools(
  agent: DzipAgent,
  additionalTools: StructuredToolInterface[],
): DzipAgent {
  // Access the config to construct a new agent with merged tools
  return new DzipAgent({
    ...(agent as unknown as { config: DzipAgentConfig }).config,
    tools: [
      ...((agent as unknown as { config: DzipAgentConfig }).config.tools ?? []),
      ...additionalTools,
    ],
  })
}

/**
 * Filter specialists to only those that respond within a timeout.
 * A specialist is "healthy" if it can process a trivial no-op prompt.
 */
private static async filterHealthy(
  specialists: DzipAgent[],
  timeoutMs = 10_000,
): Promise<DzipAgent[]> {
  const results = await Promise.allSettled(
    specialists.map(async (s) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        // Minimal health check -- specialist must respond to a ping
        await s.generate(
          [new HumanMessage('Respond with OK.')],
          { signal: controller.signal, maxIterations: 1 },
        )
        return s
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return results
    .filter((r): r is PromiseFulfilledResult<DzipAgent> => r.status === 'fulfilled')
    .map(r => r.value)
}
```

**Additional requirement:** Expose `DzipAgentConfig` through a getter on `DzipAgent`:

**File: `packages/forgeagent-agent/src/agent/dzip-agent.ts`**

Add a public getter for the config (needed by `cloneWithTools`):

```typescript
/** Read-only access to this agent's configuration (for cloning). */
get agentConfig(): Readonly<DzipAgentConfig> {
  return this.config
}
```

Then update `cloneWithTools` to use `agent.agentConfig` instead of the unsafe cast.

**File: `packages/forgeagent-agent/src/orchestration/orchestrator.ts`**

Add the error class at the top:

```typescript
export class OrchestrationError extends Error {
  constructor(
    readonly pattern: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(`Orchestration[${pattern}]: ${message}`)
    this.name = 'OrchestrationError'
  }
}
```

### Validation Criteria

- [ ] Manager agent receives specialist tools via `bindTools()`
- [ ] Manager's LLM can invoke specialist agents via tool calling
- [ ] Specialist results flow back through ToolMessage
- [ ] Health check filters out unresponsive specialists
- [ ] Existing sequential/parallel/debate patterns still work unchanged

---

## 4. F2: Contract-Net Protocol

**Priority:** P1 | **Effort:** 12h | **Risk:** Medium

### Background

The Contract Net Protocol (CNP), proposed by Reid Smith in 1980, is a task-sharing protocol for distributed problem solving. It maps naturally to multi-agent LLM systems:

1. **Manager** broadcasts a Call for Proposals (CFP) describing the task
2. **Contractors** evaluate the CFP and submit bids (capability + cost + time estimate)
3. **Manager** evaluates bids and awards the contract to the best bidder
4. **Winner** executes the task and reports results
5. **Manager** evaluates the result

### Why Not Just Use Supervisor?

The supervisor pattern has the manager's LLM decide which specialist to call based on tool descriptions. This works for small teams (3-5 specialists) but breaks down when:

- There are 10+ specialists and the tool descriptions overwhelm the context
- Specialists have dynamic availability (some are busy or down)
- Cost varies by specialist and the manager needs structured cost comparison
- The task needs to be decomposed and multiple specialists must bid on sub-tasks

Contract-net solves these by externalizing the bidding/evaluation logic from the LLM.

### Interface Specification

```typescript
// orchestration/contract-net/contract-net-types.ts

/**
 * A Call for Proposals broadcast to potential contractors.
 * The manager describes what needs to be done; agents decide if they can help.
 */
export interface CallForProposals {
  /** Unique CFP identifier */
  readonly cfpId: string
  /** The task to be accomplished */
  readonly task: string
  /** Additional context for evaluating the task */
  readonly context?: string
  /** Required capabilities (matched against agent descriptions/tags) */
  readonly requiredCapabilities?: string[]
  /** Maximum acceptable cost in cents */
  readonly maxCostCents?: number
  /** Deadline for bid submission (absolute timestamp) */
  readonly bidDeadline: number
  /** Deadline for task completion (absolute timestamp) */
  readonly executionDeadline?: number
  /** Metadata passed through to bidders */
  readonly metadata?: Record<string, unknown>
}

/**
 * A bid submitted by a contractor in response to a CFP.
 */
export interface ContractBid {
  /** The CFP this bid responds to */
  readonly cfpId: string
  /** The bidding agent's ID */
  readonly agentId: string
  /** Estimated cost in cents */
  readonly estimatedCostCents: number
  /** Estimated duration in milliseconds */
  readonly estimatedDurationMs: number
  /** Self-assessed quality score (0-1) */
  readonly qualityEstimate: number
  /** Confidence in the estimate (0-1) */
  readonly confidence: number
  /** Free-form explanation of approach */
  readonly approach: string
  /** Whether the agent can start immediately */
  readonly availableNow: boolean
  /** Timestamp of bid submission */
  readonly submittedAt: number
}

/**
 * Result of bid evaluation -- which agent won and why.
 */
export interface ContractAward {
  readonly cfpId: string
  readonly winnerId: string
  readonly reason: string
  /** All bids received, for audit */
  readonly allBids: ReadonlyArray<ContractBid>
  /** Rejected bidder IDs */
  readonly rejectedIds: string[]
}

/**
 * Result of contract execution.
 */
export interface ContractResult {
  readonly cfpId: string
  readonly agentId: string
  readonly content: string
  readonly success: boolean
  readonly actualCostCents: number
  readonly actualDurationMs: number
  readonly error?: string
}

/**
 * Strategy for evaluating bids. Implementations rank bids and select a winner.
 */
export interface BidEvaluationStrategy {
  readonly name: string
  /** Evaluate bids and return them sorted best-first. */
  evaluate(bids: ContractBid[], cfp: CallForProposals): ContractBid[]
}

/**
 * State of a single contract-net negotiation.
 */
export type ContractNetPhase =
  | 'broadcasting'    // CFP sent, waiting for bids
  | 'evaluating'      // Bids received, evaluating
  | 'awarded'         // Contract awarded to winner
  | 'executing'       // Winner is executing the task
  | 'completed'       // Execution finished successfully
  | 'failed'          // Execution failed
  | 'no-bids'         // No bids received within deadline
  | 'cancelled'       // Cancelled by manager

export interface ContractNetState {
  readonly cfp: CallForProposals
  readonly phase: ContractNetPhase
  readonly bids: ContractBid[]
  readonly award?: ContractAward
  readonly result?: ContractResult
  readonly startedAt: number
  readonly completedAt?: number
}
```

### Bid Evaluation Strategies

```typescript
// orchestration/contract-net/bid-strategies.ts

/** Select the bid with the lowest estimated cost. */
export const lowestCostStrategy: BidEvaluationStrategy = {
  name: 'lowest-cost',
  evaluate(bids) {
    return [...bids].sort((a, b) => a.estimatedCostCents - b.estimatedCostCents)
  },
}

/** Select the bid with the shortest estimated duration. */
export const fastestStrategy: BidEvaluationStrategy = {
  name: 'fastest',
  evaluate(bids) {
    return [...bids].sort((a, b) => a.estimatedDurationMs - b.estimatedDurationMs)
  },
}

/** Select the bid with the highest quality estimate. */
export const highestQualityStrategy: BidEvaluationStrategy = {
  name: 'highest-quality',
  evaluate(bids) {
    return [...bids].sort((a, b) => b.qualityEstimate - a.qualityEstimate)
  },
}

/**
 * Weighted multi-factor evaluation.
 * Each bid is scored as: w_cost * (1 - norm_cost) + w_time * (1 - norm_time)
 *   + w_quality * quality + w_confidence * confidence + w_availability * available
 *
 * Weights are normalized to sum to 1.
 */
export interface WeightedStrategyConfig {
  costWeight: number
  timeWeight: number
  qualityWeight: number
  confidenceWeight: number
  availabilityWeight: number
}

export function createWeightedStrategy(
  config: WeightedStrategyConfig,
): BidEvaluationStrategy {
  const total = config.costWeight + config.timeWeight + config.qualityWeight
    + config.confidenceWeight + config.availabilityWeight

  const w = {
    cost: config.costWeight / total,
    time: config.timeWeight / total,
    quality: config.qualityWeight / total,
    confidence: config.confidenceWeight / total,
    availability: config.availabilityWeight / total,
  }

  return {
    name: 'weighted',
    evaluate(bids) {
      if (bids.length === 0) return []

      // Normalize cost and time to [0, 1] range
      const maxCost = Math.max(...bids.map(b => b.estimatedCostCents), 1)
      const maxTime = Math.max(...bids.map(b => b.estimatedDurationMs), 1)

      const scored = bids.map(bid => {
        const score =
          w.cost * (1 - bid.estimatedCostCents / maxCost) +
          w.time * (1 - bid.estimatedDurationMs / maxTime) +
          w.quality * bid.qualityEstimate +
          w.confidence * bid.confidence +
          w.availability * (bid.availableNow ? 1 : 0)

        return { bid, score }
      })

      return scored.sort((a, b) => b.score - a.score).map(s => s.bid)
    },
  }
}
```

### ContractNetManager Class

```typescript
// orchestration/contract-net/contract-net-manager.ts

import { randomUUID } from 'node:crypto'
import type { DzipEventBus } from '@dzipagent/core'
import type { DzipAgent } from '../../agent/dzip-agent.js'
import { HumanMessage } from '@langchain/core/messages'
import type {
  CallForProposals,
  ContractBid,
  ContractAward,
  ContractResult,
  ContractNetState,
  ContractNetPhase,
  BidEvaluationStrategy,
} from './contract-net-types.js'
import { createWeightedStrategy } from './bid-strategies.js'

export interface ContractNetConfig {
  /** Strategy for evaluating bids (default: weighted with equal weights) */
  strategy?: BidEvaluationStrategy
  /** Timeout for bid collection in ms (default: 30_000) */
  bidTimeoutMs?: number
  /** Timeout for task execution in ms (default: 300_000) */
  executionTimeoutMs?: number
  /** Minimum number of bids required (default: 1) */
  minBids?: number
  /** If true, re-broadcast CFP if no bids received (default: false) */
  retryOnNoBids?: boolean
  /** Maximum CFP re-broadcasts (default: 2) */
  maxRetries?: number
  /** AbortSignal for cancellation */
  signal?: AbortSignal
}

/**
 * ContractNetManager orchestrates the full Contract Net Protocol lifecycle.
 *
 * Usage:
 * ```ts
 * const cnet = new ContractNetManager(eventBus)
 * const result = await cnet.execute(
 *   'Write comprehensive unit tests for the auth module',
 *   [testAgent1, testAgent2, testAgent3],
 *   { strategy: highestQualityStrategy }
 * )
 * ```
 */
export class ContractNetManager {
  constructor(private readonly eventBus?: DzipEventBus) {}

  /**
   * Execute the full contract-net protocol.
   *
   * 1. Broadcast CFP to all contractors
   * 2. Collect bids (agents evaluate the task and submit estimates)
   * 3. Evaluate bids using the configured strategy
   * 4. Award contract to the best bidder
   * 5. Execute the task with the winner
   * 6. Return the result
   */
  async execute(
    task: string,
    contractors: DzipAgent[],
    config?: ContractNetConfig,
  ): Promise<ContractResult> {
    const cfg: Required<
      Pick<ContractNetConfig, 'bidTimeoutMs' | 'executionTimeoutMs' | 'minBids' | 'maxRetries'>
    > & ContractNetConfig = {
      bidTimeoutMs: 30_000,
      executionTimeoutMs: 300_000,
      minBids: 1,
      maxRetries: 2,
      retryOnNoBids: false,
      ...config,
    }

    const strategy = cfg.strategy ?? createWeightedStrategy({
      costWeight: 1,
      timeWeight: 1,
      qualityWeight: 2,
      confidenceWeight: 1,
      availabilityWeight: 0.5,
    })

    const cfp = this.buildCFP(task, cfg)
    let retries = 0
    let state: ContractNetState = {
      cfp,
      phase: 'broadcasting',
      bids: [],
      startedAt: Date.now(),
    }

    this.emitPhaseChange(state)

    while (retries <= cfg.maxRetries) {
      if (cfg.signal?.aborted) {
        return this.buildCancelledResult(cfp)
      }

      // Phase 1: Collect bids
      state = { ...state, phase: 'broadcasting' }
      this.emitPhaseChange(state)

      const bids = await this.collectBids(cfp, contractors, cfg)
      state = { ...state, bids }

      if (bids.length < cfg.minBids) {
        if (cfg.retryOnNoBids && retries < cfg.maxRetries) {
          retries++
          this.eventBus?.emit({
            type: 'contract-net:retry',
            cfpId: cfp.cfpId,
            attempt: retries,
            reason: `Only ${bids.length} bids received, need ${cfg.minBids}`,
          })
          continue
        }

        state = { ...state, phase: 'no-bids', completedAt: Date.now() }
        this.emitPhaseChange(state)

        return {
          cfpId: cfp.cfpId,
          agentId: '',
          content: '',
          success: false,
          actualCostCents: 0,
          actualDurationMs: Date.now() - state.startedAt,
          error: `Insufficient bids: ${bids.length} received, ${cfg.minBids} required`,
        }
      }

      // Phase 2: Evaluate bids
      state = { ...state, phase: 'evaluating' }
      this.emitPhaseChange(state)

      const ranked = strategy.evaluate(bids, cfp)
      const winner = ranked[0]!
      const rejected = ranked.slice(1).map(b => b.agentId)

      const award: ContractAward = {
        cfpId: cfp.cfpId,
        winnerId: winner.agentId,
        reason: `Selected by ${strategy.name} strategy`,
        allBids: bids,
        rejectedIds: rejected,
      }

      state = { ...state, phase: 'awarded', award }
      this.emitPhaseChange(state)

      this.eventBus?.emit({
        type: 'contract-net:awarded',
        cfpId: cfp.cfpId,
        winnerId: winner.agentId,
        bidCount: bids.length,
      })

      // Phase 3: Execute with winner
      state = { ...state, phase: 'executing' }
      this.emitPhaseChange(state)

      const winnerAgent = contractors.find(c => c.id === winner.agentId)
      if (!winnerAgent) {
        state = { ...state, phase: 'failed', completedAt: Date.now() }
        this.emitPhaseChange(state)
        return {
          cfpId: cfp.cfpId,
          agentId: winner.agentId,
          content: '',
          success: false,
          actualCostCents: 0,
          actualDurationMs: Date.now() - state.startedAt,
          error: `Winner agent "${winner.agentId}" no longer available`,
        }
      }

      const result = await this.executeContract(
        winnerAgent, cfp, cfg.executionTimeoutMs, cfg.signal,
      )

      const finalPhase: ContractNetPhase = result.success ? 'completed' : 'failed'
      state = { ...state, phase: finalPhase, result, completedAt: Date.now() }
      this.emitPhaseChange(state)

      return result
    }

    // Should not reach here, but satisfy TypeScript
    return this.buildCancelledResult(cfp)
  }

  // ---- Internal methods ----

  private buildCFP(
    task: string,
    config: { bidTimeoutMs: number; executionTimeoutMs?: number },
  ): CallForProposals {
    return {
      cfpId: randomUUID(),
      task,
      bidDeadline: Date.now() + config.bidTimeoutMs,
      executionDeadline: config.executionTimeoutMs
        ? Date.now() + config.bidTimeoutMs + config.executionTimeoutMs
        : undefined,
    }
  }

  /**
   * Collect bids from all contractors in parallel.
   * Each contractor evaluates the CFP and returns a structured bid.
   * Bids that arrive after the deadline or fail are silently dropped.
   */
  private async collectBids(
    cfp: CallForProposals,
    contractors: DzipAgent[],
    config: { bidTimeoutMs: number; signal?: AbortSignal },
  ): Promise<ContractBid[]> {
    const bidPrompt = [
      `You are being asked to bid on a task. Evaluate whether you can handle it.`,
      ``,
      `## Task`,
      cfp.task,
      ``,
      `## Instructions`,
      `Respond with a JSON object containing your bid:`,
      `{`,
      `  "canHandle": true/false,`,
      `  "estimatedCostCents": <number>,`,
      `  "estimatedDurationMs": <number>,`,
      `  "qualityEstimate": <0-1>,`,
      `  "confidence": <0-1>,`,
      `  "approach": "<brief description of your approach>"`,
      `}`,
      ``,
      `If you cannot handle this task, set canHandle to false.`,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.bidTimeoutMs)

    // Compose signals: external signal + bid timeout
    const signal = config.signal
      ? AbortSignal.any([config.signal, controller.signal])
      : controller.signal

    try {
      const results = await Promise.allSettled(
        contractors.map(async (agent) => {
          const result = await agent.generate(
            [new HumanMessage(bidPrompt)],
            { signal, maxIterations: 1 },
          )
          return this.parseBid(cfp.cfpId, agent.id, result.content)
        }),
      )

      return results
        .filter((r): r is PromiseFulfilledResult<ContractBid | null> =>
          r.status === 'fulfilled')
        .map(r => r.value)
        .filter((bid): bid is ContractBid => bid !== null && bid.estimatedCostCents >= 0)
    } finally {
      clearTimeout(timer)
    }
  }

  private parseBid(
    cfpId: string,
    agentId: string,
    content: string,
  ): ContractBid | null {
    try {
      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0]) as {
        canHandle?: boolean
        estimatedCostCents?: number
        estimatedDurationMs?: number
        qualityEstimate?: number
        confidence?: number
        approach?: string
      }

      if (parsed.canHandle === false) return null

      return {
        cfpId,
        agentId,
        estimatedCostCents: parsed.estimatedCostCents ?? 0,
        estimatedDurationMs: parsed.estimatedDurationMs ?? 60_000,
        qualityEstimate: Math.min(1, Math.max(0, parsed.qualityEstimate ?? 0.5)),
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
        approach: parsed.approach ?? '',
        availableNow: true,
        submittedAt: Date.now(),
      }
    } catch {
      return null
    }
  }

  private async executeContract(
    agent: DzipAgent,
    cfp: CallForProposals,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<ContractResult> {
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal

    try {
      const result = await agent.generate(
        [new HumanMessage(cfp.task)],
        { signal },
      )

      return {
        cfpId: cfp.cfpId,
        agentId: agent.id,
        content: result.content,
        success: true,
        actualCostCents: 0, // TODO: extract from budget tracking
        actualDurationMs: Date.now() - start,
      }
    } catch (err: unknown) {
      return {
        cfpId: cfp.cfpId,
        agentId: agent.id,
        content: '',
        success: false,
        actualCostCents: 0,
        actualDurationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private buildCancelledResult(cfp: CallForProposals): ContractResult {
    return {
      cfpId: cfp.cfpId,
      agentId: '',
      content: '',
      success: false,
      actualCostCents: 0,
      actualDurationMs: 0,
      error: 'Contract-net cancelled',
    }
  }

  private emitPhaseChange(state: ContractNetState): void {
    this.eventBus?.emit({
      type: 'contract-net:phase-change',
      cfpId: state.cfp.cfpId,
      phase: state.phase,
      bidCount: state.bids.length,
    })
  }
}
```

### Integration with AgentOrchestrator

Add to `orchestrator.ts`:

```typescript
/**
 * Contract-net delegation -- agents bid on the task, best bidder executes.
 *
 * Use when: many potential workers, cost/quality tradeoffs matter,
 * or agents have variable availability.
 */
static async contractNet(
  contractors: DzipAgent[],
  task: string,
  config?: ContractNetConfig,
  eventBus?: DzipEventBus,
): Promise<ContractResult> {
  const manager = new ContractNetManager(eventBus)
  return manager.execute(task, contractors, config)
}
```

---

## 5. F3: Dynamic Topology Switching

**Priority:** P1 | **Effort:** 16h | **Risk:** High

### Concept

Instead of choosing an orchestration pattern at design time, the system analyzes the task and selects the best topology at runtime. It can also switch topologies mid-execution if conditions change (for example, switching from parallel to sequential when error rate rises).

### Interface Specification

```typescript
// orchestration/topology/topology-types.ts

/**
 * Supported topology types.
 *
 * - hierarchical: Tree structure, supervisor delegates to workers
 * - pipeline: Linear chain, each agent transforms and passes to next
 * - star: Hub agent broadcasts to all spokes, collects results
 * - mesh: All agents can communicate with all others
 * - ring: Circular pass -- each agent refines the previous agent's output
 */
export type TopologyType = 'hierarchical' | 'pipeline' | 'star' | 'mesh' | 'ring'

/**
 * Characteristics of a task that influence topology selection.
 */
export interface TaskCharacteristics {
  /** Estimated complexity (0-1, where 1 = very complex) */
  complexity: number
  /** Whether sub-tasks are independent (true) or interdependent (false) */
  parallelizable: boolean
  /** Number of agents available */
  agentCount: number
  /** Maximum acceptable latency in ms */
  maxLatencyMs?: number
  /** Error tolerance: 'strict' (fail-fast) or 'lenient' (best-effort) */
  errorTolerance: 'strict' | 'lenient'
  /** Whether the task requires iterative refinement */
  needsRefinement: boolean
  /** Whether a single coordinator should manage the work */
  needsCoordination: boolean
}

/**
 * Result of topology analysis.
 */
export interface TopologyRecommendation {
  /** Recommended topology */
  topology: TopologyType
  /** Confidence in the recommendation (0-1) */
  confidence: number
  /** Explanation of why this topology was selected */
  reason: string
  /** Alternative topologies ranked by suitability */
  alternatives: Array<{ topology: TopologyType; score: number }>
}

/**
 * Metrics collected during topology execution.
 */
export interface TopologyMetrics {
  topology: TopologyType
  agentCount: number
  totalLatencyMs: number
  totalTokens: number
  totalCostCents: number
  messageCount: number
  errorCount: number
  /** Effective throughput: tasks completed per second */
  throughput: number
}

/**
 * Configuration for dynamic topology switching.
 */
export interface TopologySwitchConfig {
  /** Enable automatic topology switching during execution */
  autoSwitch: boolean
  /** Minimum messages before considering a switch (default: 5) */
  minMessagesBeforeSwitch: number
  /** Error rate threshold that triggers re-evaluation (default: 0.3) */
  errorRateThreshold: number
  /** Latency threshold (ms) that triggers re-evaluation */
  latencyThresholdMs?: number
}
```

### TopologyAnalyzer

```typescript
// orchestration/topology/topology-analyzer.ts

/**
 * Analyzes task characteristics and recommends the best orchestration topology.
 *
 * Scoring rules (heuristic, not LLM-based):
 *
 * - hierarchical: best for complex + needs coordination + >3 agents
 * - pipeline: best for sequential dependencies + needs refinement
 * - star: best for parallelizable + lenient errors + fast required
 * - mesh: best for interdependent + needs refinement + small groups
 * - ring: best for iterative refinement + 3-6 agents
 */
export class TopologyAnalyzer {
  /**
   * Analyze task characteristics and recommend a topology.
   */
  analyze(task: TaskCharacteristics): TopologyRecommendation {
    const scores = new Map<TopologyType, number>()

    // Score each topology
    scores.set('hierarchical', this.scoreHierarchical(task))
    scores.set('pipeline', this.scorePipeline(task))
    scores.set('star', this.scoreStar(task))
    scores.set('mesh', this.scoreMesh(task))
    scores.set('ring', this.scoreRing(task))

    // Sort by score descending
    const sorted = [...scores.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([topology, score]) => ({ topology, score }))

    const best = sorted[0]!
    const maxScore = Math.max(...scores.values())

    return {
      topology: best.topology,
      confidence: maxScore > 0 ? best.score / maxScore : 0.5,
      reason: this.explainChoice(best.topology, task),
      alternatives: sorted.slice(1),
    }
  }

  /**
   * Recommend switching topology based on runtime metrics.
   * Returns null if current topology is still optimal.
   */
  suggestSwitch(
    current: TopologyType,
    metrics: TopologyMetrics,
    config: TopologySwitchConfig,
  ): TopologyRecommendation | null {
    if (metrics.messageCount < config.minMessagesBeforeSwitch) return null

    const errorRate = metrics.errorCount / Math.max(metrics.messageCount, 1)

    // High error rate --> switch to hierarchical (more oversight)
    if (errorRate > config.errorRateThreshold && current !== 'hierarchical') {
      return {
        topology: 'hierarchical',
        confidence: 0.7,
        reason: `Error rate ${(errorRate * 100).toFixed(0)}% exceeds threshold. `
          + `Switching to hierarchical for better oversight.`,
        alternatives: [],
      }
    }

    // High latency + parallelizable --> switch to star
    if (
      config.latencyThresholdMs &&
      metrics.totalLatencyMs > config.latencyThresholdMs &&
      current === 'pipeline'
    ) {
      return {
        topology: 'star',
        confidence: 0.6,
        reason: `Latency ${metrics.totalLatencyMs}ms exceeds threshold. `
          + `Switching from pipeline to star for parallelism.`,
        alternatives: [],
      }
    }

    return null
  }

  private scoreHierarchical(t: TaskCharacteristics): number {
    let score = 0
    if (t.complexity > 0.6) score += 3
    if (t.needsCoordination) score += 3
    if (t.agentCount > 3) score += 2
    if (t.errorTolerance === 'strict') score += 1
    return score
  }

  private scorePipeline(t: TaskCharacteristics): number {
    let score = 0
    if (!t.parallelizable) score += 3
    if (t.needsRefinement) score += 2
    if (t.agentCount <= 5) score += 1
    if (t.complexity > 0.3) score += 1
    return score
  }

  private scoreStar(t: TaskCharacteristics): number {
    let score = 0
    if (t.parallelizable) score += 3
    if (t.errorTolerance === 'lenient') score += 2
    if (t.maxLatencyMs && t.maxLatencyMs < 60_000) score += 2
    if (t.agentCount > 2) score += 1
    return score
  }

  private scoreMesh(t: TaskCharacteristics): number {
    let score = 0
    if (!t.parallelizable && t.needsRefinement) score += 3
    if (t.agentCount >= 2 && t.agentCount <= 4) score += 2
    if (t.complexity > 0.7) score += 1
    // Mesh does not scale well
    if (t.agentCount > 6) score -= 3
    return Math.max(0, score)
  }

  private scoreRing(t: TaskCharacteristics): number {
    let score = 0
    if (t.needsRefinement) score += 3
    if (t.agentCount >= 3 && t.agentCount <= 6) score += 2
    if (t.complexity > 0.4) score += 1
    if (t.errorTolerance === 'lenient') score += 1
    return score
  }

  private explainChoice(topology: TopologyType, t: TaskCharacteristics): string {
    const explanations: Record<TopologyType, string> = {
      hierarchical: `Complex task (${t.complexity.toFixed(1)}) with ${t.agentCount} agents `
        + `benefits from coordinated delegation.`,
      pipeline: `Sequential dependencies detected. Pipeline ensures each stage `
        + `builds on the previous.`,
      star: `Parallelizable task with ${t.agentCount} agents. Star topology `
        + `minimizes latency via concurrent execution.`,
      mesh: `Interdependent sub-tasks with small team (${t.agentCount}). `
        + `Mesh allows direct agent-to-agent refinement.`,
      ring: `Iterative refinement needed. Ring topology passes output through `
        + `${t.agentCount} agents cyclically.`,
    }
    return explanations[topology]
  }
}
```

### TopologyExecutor

```typescript
// orchestration/topology/topology-executor.ts

import type { DzipAgent } from '../../agent/dzip-agent.js'
import type { TopologyType, TopologyMetrics, TopologySwitchConfig } from './topology-types.js'
import { TopologyAnalyzer } from './topology-analyzer.js'
import { AgentOrchestrator } from '../orchestrator.js'

export interface TopologyExecutionConfig {
  /** Override topology (skip analysis) */
  topology?: TopologyType
  /** Enable dynamic switching */
  switchConfig?: TopologySwitchConfig
  /** AbortSignal */
  signal?: AbortSignal
  /** Number of refinement rounds for ring topology (default: 2) */
  ringRounds?: number
}

/**
 * Executes a task using the recommended (or specified) topology.
 */
export class TopologyExecutor {
  private readonly analyzer = new TopologyAnalyzer()

  /**
   * Execute a task with automatic topology selection.
   */
  async execute(
    agents: DzipAgent[],
    task: string,
    config?: TopologyExecutionConfig,
  ): Promise<{ result: string; metrics: TopologyMetrics; topology: TopologyType }> {
    const topology = config?.topology ?? this.analyzer.analyze({
      complexity: 0.5, // TODO: estimate from task length/keywords
      parallelizable: agents.length > 2,
      agentCount: agents.length,
      errorTolerance: 'lenient',
      needsRefinement: false,
      needsCoordination: agents.length > 3,
    }).topology

    const start = Date.now()
    const result = await this.executeWithTopology(agents, task, topology, config)

    const metrics: TopologyMetrics = {
      topology,
      agentCount: agents.length,
      totalLatencyMs: Date.now() - start,
      totalTokens: 0,
      totalCostCents: 0,
      messageCount: 0,
      errorCount: 0,
      throughput: 0,
    }

    return { result, metrics, topology }
  }

  private async executeWithTopology(
    agents: DzipAgent[],
    task: string,
    topology: TopologyType,
    config?: TopologyExecutionConfig,
  ): Promise<string> {
    switch (topology) {
      case 'hierarchical':
        // First agent is supervisor, rest are specialists
        return AgentOrchestrator.supervisor(agents[0]!, agents.slice(1), task, {
          signal: config?.signal,
        })

      case 'pipeline':
        return AgentOrchestrator.sequential(agents, task)

      case 'star':
        return AgentOrchestrator.parallel(agents, task)

      case 'mesh':
        return this.executeMesh(agents, task, config)

      case 'ring':
        return this.executeRing(agents, task, config?.ringRounds ?? 2)
    }
  }

  /**
   * Mesh topology: each agent sees all other agents' outputs
   * and produces a refined response. Two rounds by default.
   */
  private async executeMesh(
    agents: DzipAgent[],
    task: string,
    config?: TopologyExecutionConfig,
  ): Promise<string> {
    // Round 1: all agents produce initial responses
    const initial = await AgentOrchestrator.parallel(agents, task)

    // Round 2: each agent refines given all responses
    const refinedPrompt = [
      `Original task: ${task}`,
      ``,
      `All agents produced these responses:`,
      initial,
      ``,
      `Synthesize the best answer from all perspectives.`,
    ].join('\n')

    // Use first agent to synthesize
    const { HumanMessage } = await import('@langchain/core/messages')
    const result = await agents[0]!.generate([new HumanMessage(refinedPrompt)], {
      signal: config?.signal,
    })
    return result.content
  }

  /**
   * Ring topology: agent[0] -> agent[1] -> ... -> agent[n-1] -> agent[0]
   * Each agent refines the previous output. Runs for `rounds` cycles.
   */
  private async executeRing(
    agents: DzipAgent[],
    task: string,
    rounds: number,
  ): Promise<string> {
    const { HumanMessage } = await import('@langchain/core/messages')
    let current = task

    for (let round = 0; round < rounds; round++) {
      for (const agent of agents) {
        const prompt = round === 0 && agent === agents[0]
          ? task
          : `Original task: ${task}\n\nPrevious agent's output:\n${current}\n\nRefine and improve this output.`

        const result = await agent.generate([new HumanMessage(prompt)])
        current = result.content
      }
    }

    return current
  }
}
```

---

## 6. F4: Blackboard Architecture

**Priority:** P1 | **Effort:** 8h | **Risk:** Medium

### Concept

The blackboard pattern uses a shared data structure (the "blackboard") that agents read from and write to. A control component decides which agent should act next based on what is on the blackboard. This is particularly effective for:

- Tasks where agents contribute different types of knowledge
- Problems that require incremental refinement
- Situations where the order of agent execution depends on intermediate results

### Interface Specification

```typescript
// orchestration/blackboard/blackboard-types.ts

/**
 * An entry on the blackboard. Each entry has a typed key, a value,
 * and metadata about who wrote it and when.
 */
export interface BlackboardEntry<T = unknown> {
  readonly key: string
  readonly value: T
  readonly writtenBy: string
  readonly writtenAt: number
  readonly version: number
  readonly tags: ReadonlyArray<string>
}

/**
 * Event emitted when the blackboard changes.
 */
export type BlackboardEvent =
  | { type: 'entry:written'; key: string; writtenBy: string; version: number }
  | { type: 'entry:deleted'; key: string; deletedBy: string }
  | { type: 'blackboard:cleared'; clearedBy: string }

/**
 * The shared blackboard data structure.
 * All agent interactions go through this interface.
 */
export interface Blackboard {
  /** Read an entry by key. Returns undefined if not found. */
  get<T = unknown>(key: string): BlackboardEntry<T> | undefined

  /** Write a value to the blackboard. Increments version. */
  put<T = unknown>(key: string, value: T, writtenBy: string, tags?: string[]): void

  /** Delete an entry. */
  delete(key: string, deletedBy: string): boolean

  /** Check if a key exists. */
  has(key: string): boolean

  /** Get all entries, optionally filtered by tag. */
  getAll(tag?: string): ReadonlyArray<BlackboardEntry>

  /** Get all keys. */
  keys(): string[]

  /** Subscribe to blackboard changes. Returns unsubscribe function. */
  onChange(listener: (event: BlackboardEvent) => void): () => void

  /** Snapshot the entire blackboard as a plain object. */
  snapshot(): Record<string, unknown>

  /** Clear all entries. */
  clear(clearedBy: string): void
}

/**
 * A knowledge source wraps an agent and defines:
 * - What blackboard keys it reads (preconditions)
 * - What blackboard keys it writes (effects)
 * - A condition function that determines if it should activate
 */
export interface KnowledgeSource {
  readonly id: string
  readonly agent: DzipAgent
  /** Keys this source reads from the blackboard */
  readonly reads: string[]
  /** Keys this source writes to the blackboard */
  readonly writes: string[]
  /** Priority (higher = more preferred when multiple sources can fire) */
  readonly priority: number
  /**
   * Activation condition: returns true if this source should fire
   * given the current blackboard state.
   */
  canActivate(board: Blackboard): boolean
  /**
   * Execute: read from blackboard, process via agent, write results back.
   */
  execute(board: Blackboard, signal?: AbortSignal): Promise<void>
}

/**
 * The control component decides which knowledge source acts next.
 */
export interface ControlComponent {
  /**
   * Select the next knowledge source to activate.
   * Returns null if no source should fire (convergence).
   */
  selectNext(
    sources: KnowledgeSource[],
    board: Blackboard,
    history: ReadonlyArray<{ sourceId: string; timestamp: number }>,
  ): KnowledgeSource | null
}

/**
 * Configuration for a blackboard session.
 */
export interface BlackboardConfig {
  /** Maximum number of knowledge source activations (default: 20) */
  maxActivations: number
  /** Timeout for the entire session in ms (default: 300_000) */
  timeoutMs: number
  /** Custom control component (default: priority-based) */
  controlComponent?: ControlComponent
  /** AbortSignal */
  signal?: AbortSignal
  /** Convergence detector: stop when no new writes in N activations */
  convergenceThreshold?: number
}

/**
 * Result of a blackboard session.
 */
export interface BlackboardResult {
  /** Final blackboard state */
  board: Record<string, unknown>
  /** Number of knowledge source activations */
  activations: number
  /** History of activations in order */
  history: Array<{ sourceId: string; timestamp: number; keysWritten: string[] }>
  /** Whether the session converged (no more sources can activate) */
  converged: boolean
  /** Total duration in ms */
  durationMs: number
}
```

### InMemoryBlackboard

```typescript
// orchestration/blackboard/in-memory-blackboard.ts

import type {
  Blackboard,
  BlackboardEntry,
  BlackboardEvent,
} from './blackboard-types.js'

/**
 * In-memory blackboard implementation.
 *
 * Thread-safe for single-process use (JavaScript is single-threaded).
 * For multi-process scenarios, use a Redis-backed or Postgres-backed
 * implementation behind the same Blackboard interface.
 */
export class InMemoryBlackboard implements Blackboard {
  private entries = new Map<string, BlackboardEntry>()
  private listeners: Array<(event: BlackboardEvent) => void> = []

  get<T = unknown>(key: string): BlackboardEntry<T> | undefined {
    return this.entries.get(key) as BlackboardEntry<T> | undefined
  }

  put<T = unknown>(
    key: string,
    value: T,
    writtenBy: string,
    tags?: string[],
  ): void {
    const existing = this.entries.get(key)
    const version = existing ? existing.version + 1 : 1

    this.entries.set(key, {
      key,
      value,
      writtenBy,
      writtenAt: Date.now(),
      version,
      tags: tags ?? [],
    })

    this.emit({ type: 'entry:written', key, writtenBy, version })
  }

  delete(key: string, deletedBy: string): boolean {
    const existed = this.entries.delete(key)
    if (existed) {
      this.emit({ type: 'entry:deleted', key, deletedBy })
    }
    return existed
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  getAll(tag?: string): ReadonlyArray<BlackboardEntry> {
    const all = [...this.entries.values()]
    if (!tag) return all
    return all.filter(e => e.tags.includes(tag))
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  onChange(listener: (event: BlackboardEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx !== -1) this.listeners.splice(idx, 1)
    }
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of this.entries) {
      result[key] = entry.value
    }
    return result
  }

  clear(clearedBy: string): void {
    this.entries.clear()
    this.emit({ type: 'blackboard:cleared', clearedBy })
  }

  private emit(event: BlackboardEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
```

### PriorityControlComponent

```typescript
// orchestration/blackboard/priority-control.ts

import type {
  ControlComponent,
  KnowledgeSource,
  Blackboard,
} from './blackboard-types.js'

/**
 * Default control component: selects the highest-priority source
 * that can activate. Breaks ties by fewest recent activations
 * (round-robin fairness).
 */
export class PriorityControlComponent implements ControlComponent {
  selectNext(
    sources: KnowledgeSource[],
    board: Blackboard,
    history: ReadonlyArray<{ sourceId: string; timestamp: number }>,
  ): KnowledgeSource | null {
    // Filter to sources that can activate
    const activatable = sources.filter(s => s.canActivate(board))

    if (activatable.length === 0) return null

    // Sort by priority (descending), then by activation count (ascending)
    const activationCounts = new Map<string, number>()
    for (const entry of history) {
      activationCounts.set(entry.sourceId, (activationCounts.get(entry.sourceId) ?? 0) + 1)
    }

    activatable.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      const countA = activationCounts.get(a.id) ?? 0
      const countB = activationCounts.get(b.id) ?? 0
      return countA - countB
    })

    return activatable[0] ?? null
  }
}
```

### BlackboardRunner

```typescript
// orchestration/blackboard/blackboard-runner.ts

import type { DzipEventBus } from '@dzipagent/core'
import type {
  KnowledgeSource,
  BlackboardConfig,
  BlackboardResult,
  Blackboard,
} from './blackboard-types.js'
import { InMemoryBlackboard } from './in-memory-blackboard.js'
import { PriorityControlComponent } from './priority-control.js'

/**
 * Runs a blackboard session: repeatedly activates knowledge sources
 * until convergence, max activations, or timeout.
 *
 * @example
 * ```ts
 * const runner = new BlackboardRunner(eventBus)
 * const result = await runner.run(
 *   [plannerSource, coderSource, reviewerSource],
 *   { task: 'Build a REST API endpoint' },
 *   { maxActivations: 15, timeoutMs: 120_000 }
 * )
 * console.log(result.board) // final accumulated knowledge
 * ```
 */
export class BlackboardRunner {
  constructor(private readonly eventBus?: DzipEventBus) {}

  async run(
    sources: KnowledgeSource[],
    initialState: Record<string, unknown>,
    config?: Partial<BlackboardConfig>,
  ): Promise<BlackboardResult> {
    const maxActivations = config?.maxActivations ?? 20
    const timeoutMs = config?.timeoutMs ?? 300_000
    const convergenceThreshold = config?.convergenceThreshold ?? 3
    const control = config?.controlComponent ?? new PriorityControlComponent()

    const board: Blackboard = new InMemoryBlackboard()
    const history: Array<{ sourceId: string; timestamp: number; keysWritten: string[] }> = []

    // Seed the blackboard with initial state
    for (const [key, value] of Object.entries(initialState)) {
      board.put(key, value, 'system')
    }

    const start = Date.now()
    const deadline = start + timeoutMs
    let activationsWithoutWrite = 0

    for (let i = 0; i < maxActivations; i++) {
      // Check timeout
      if (Date.now() > deadline) break

      // Check cancellation
      if (config?.signal?.aborted) break

      // Select next source
      const next = control.selectNext(sources, board, history)
      if (!next) break // convergence -- no source can activate

      // Track which keys exist before execution
      const keysBefore = new Set(board.keys())

      this.eventBus?.emit({
        type: 'blackboard:activation',
        sourceId: next.id,
        activationIndex: i,
      })

      // Execute the knowledge source
      try {
        await next.execute(board, config?.signal)
      } catch (err: unknown) {
        this.eventBus?.emit({
          type: 'blackboard:error',
          sourceId: next.id,
          error: err instanceof Error ? err.message : String(err),
        })
        // Non-fatal: continue with other sources
      }

      // Determine which keys were written
      const keysAfter = new Set(board.keys())
      const keysWritten: string[] = []
      for (const key of keysAfter) {
        if (!keysBefore.has(key)) {
          keysWritten.push(key)
        } else {
          // Check if version changed
          const entry = board.get(key)
          if (entry) {
            const historyForKey = history.filter(
              h => h.keysWritten.includes(key),
            )
            if (
              historyForKey.length === 0 ||
              entry.writtenBy === next.id
            ) {
              keysWritten.push(key)
            }
          }
        }
      }

      history.push({
        sourceId: next.id,
        timestamp: Date.now(),
        keysWritten,
      })

      // Convergence detection
      if (keysWritten.length === 0) {
        activationsWithoutWrite++
        if (activationsWithoutWrite >= convergenceThreshold) break
      } else {
        activationsWithoutWrite = 0
      }
    }

    return {
      board: board.snapshot(),
      activations: history.length,
      history,
      converged: activationsWithoutWrite >= convergenceThreshold,
      durationMs: Date.now() - start,
    }
  }
}
```

### Integration with AgentOrchestrator

```typescript
/**
 * Blackboard pattern -- agents contribute knowledge to a shared workspace.
 *
 * Use when: agents have complementary expertise, order of execution
 * depends on intermediate results, or you need incremental refinement.
 */
static async blackboard(
  sources: KnowledgeSource[],
  initialState: Record<string, unknown>,
  config?: Partial<BlackboardConfig>,
  eventBus?: DzipEventBus,
): Promise<BlackboardResult> {
  const runner = new BlackboardRunner(eventBus)
  return runner.run(sources, initialState, config)
}
```

### Helper: Creating KnowledgeSources from DzipAgents

```typescript
// orchestration/blackboard/knowledge-source-factory.ts

import type { DzipAgent } from '../../agent/dzip-agent.js'
import { HumanMessage } from '@langchain/core/messages'
import type { KnowledgeSource, Blackboard } from './blackboard-types.js'

/**
 * Create a KnowledgeSource from a DzipAgent.
 *
 * The agent reads specified keys from the blackboard, formats them as
 * context, generates a response, and writes the result to specified keys.
 */
export function createKnowledgeSource(config: {
  id: string
  agent: DzipAgent
  reads: string[]
  writes: string[]
  priority?: number
  /** Custom activation condition (default: all reads are present on board) */
  canActivate?: (board: Blackboard) => boolean
  /** Custom prompt builder (default: formats reads as context) */
  buildPrompt?: (board: Blackboard) => string
  /** Custom result parser (default: writes agent output to first write key) */
  parseResult?: (content: string, board: Blackboard) => void
}): KnowledgeSource {
  return {
    id: config.id,
    agent: config.agent,
    reads: config.reads,
    writes: config.writes,
    priority: config.priority ?? 1,

    canActivate(board: Blackboard): boolean {
      if (config.canActivate) return config.canActivate(board)
      // Default: activate when all required reads are present
      return config.reads.every(key => board.has(key))
    },

    async execute(board: Blackboard, signal?: AbortSignal): Promise<void> {
      // Build prompt from blackboard state
      const prompt = config.buildPrompt
        ? config.buildPrompt(board)
        : buildDefaultPrompt(config.reads, board)

      const result = await config.agent.generate(
        [new HumanMessage(prompt)],
        { signal },
      )

      // Write results to blackboard
      if (config.parseResult) {
        config.parseResult(result.content, board)
      } else {
        // Default: write to first write key
        const key = config.writes[0]
        if (key) {
          board.put(key, result.content, config.id)
        }
      }
    },
  }
}

function buildDefaultPrompt(reads: string[], board: Blackboard): string {
  const context = reads
    .map(key => {
      const entry = board.get(key)
      return entry
        ? `## ${key}\n${typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value, null, 2)}`
        : null
    })
    .filter(Boolean)
    .join('\n\n')

  return `Based on the following context, provide your analysis:\n\n${context}`
}
```

---

## 7. F5: Workflow Persistence

**Priority:** P1 | **Effort:** 8h | **Risk:** Medium

### Problem

`CompiledWorkflow.run()` stores all state in memory. If the process crashes or is redeployed, the workflow is lost. The `suspend()` node emits an event but does not actually persist state.

### Interface Specification

```typescript
// workflow/workflow-persistence-types.ts

/**
 * Serializable representation of workflow execution state.
 * Stored to a persistent backend for resume-after-crash.
 */
export interface WorkflowCheckpoint {
  /** Unique workflow run ID */
  readonly runId: string
  /** Workflow definition ID */
  readonly workflowId: string
  /** Index of the next node to execute */
  readonly nodeIndex: number
  /** Accumulated state from previous steps */
  readonly state: Record<string, unknown>
  /** Phase: running, suspended, completed, failed */
  readonly status: WorkflowPersistenceStatus
  /** Reason for suspension (if status === 'suspended') */
  readonly suspendReason?: string
  /** ISO timestamp of this checkpoint */
  readonly checkpointedAt: string
  /** Schema version for migration support */
  readonly schemaVersion: number
  /** Optional error message (if status === 'failed') */
  readonly error?: string
}

export type WorkflowPersistenceStatus =
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'

/**
 * Store interface for workflow persistence.
 * Implementations: InMemory (testing), Postgres (production via @dzipagent/server).
 */
export interface WorkflowStore {
  /** Save a checkpoint. Overwrites any existing checkpoint for the same runId. */
  save(checkpoint: WorkflowCheckpoint): Promise<void>

  /** Load the most recent checkpoint for a run. Returns null if not found. */
  load(runId: string): Promise<WorkflowCheckpoint | null>

  /** List all checkpoints for a workflow ID, ordered by checkpointedAt desc. */
  list(workflowId: string, options?: {
    status?: WorkflowPersistenceStatus
    limit?: number
  }): Promise<WorkflowCheckpoint[]>

  /** Delete a checkpoint. */
  delete(runId: string): Promise<void>
}

/**
 * Configuration for workflow persistence.
 */
export interface WorkflowPersistenceConfig {
  /** Store backend */
  store: WorkflowStore
  /** Checkpoint after every N steps (default: 1 = checkpoint after every step) */
  checkpointFrequency: number
  /** Schema version (for migration support) */
  schemaVersion: number
}
```

### InMemoryWorkflowStore

```typescript
// workflow/in-memory-workflow-store.ts

import type {
  WorkflowStore,
  WorkflowCheckpoint,
  WorkflowPersistenceStatus,
} from './workflow-persistence-types.js'

export class InMemoryWorkflowStore implements WorkflowStore {
  private checkpoints = new Map<string, WorkflowCheckpoint>()

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.runId, checkpoint)
  }

  async load(runId: string): Promise<WorkflowCheckpoint | null> {
    return this.checkpoints.get(runId) ?? null
  }

  async list(
    workflowId: string,
    options?: { status?: WorkflowPersistenceStatus; limit?: number },
  ): Promise<WorkflowCheckpoint[]> {
    let results = [...this.checkpoints.values()]
      .filter(c => c.workflowId === workflowId)

    if (options?.status) {
      results = results.filter(c => c.status === options.status)
    }

    results.sort((a, b) =>
      new Date(b.checkpointedAt).getTime() - new Date(a.checkpointedAt).getTime())

    if (options?.limit) {
      results = results.slice(0, options.limit)
    }

    return results
  }

  async delete(runId: string): Promise<void> {
    this.checkpoints.delete(runId)
  }
}
```

### Changes to CompiledWorkflow

The `CompiledWorkflow` class needs to be enhanced to:

1. Accept a `WorkflowPersistenceConfig` in `run()` options
2. Checkpoint after each step (or every N steps)
3. Support `resume()` from a checkpoint
4. Actually pause on `suspend` nodes (save state and return)

```typescript
// Changes to workflow/workflow-builder.ts -- CompiledWorkflow.run()

interface RunOptions {
  signal?: AbortSignal
  onEvent?: (event: WorkflowEvent) => void
  /** Persistence configuration for checkpoint/resume */
  persistence?: WorkflowPersistenceConfig
  /** Run ID (auto-generated if not provided) */
  runId?: string
}

async run(
  initialState: Record<string, unknown>,
  options?: RunOptions,
): Promise<Record<string, unknown>> {
  const runId = options?.runId ?? randomUUID()
  const persistence = options?.persistence
  // ... existing code, modified to checkpoint after steps ...
}

/**
 * Resume a suspended or crashed workflow from a checkpoint.
 */
async resume(
  store: WorkflowStore,
  runId: string,
  resumeData?: Record<string, unknown>,
  options?: Omit<RunOptions, 'runId'>,
): Promise<Record<string, unknown>> {
  const checkpoint = await store.load(runId)
  if (!checkpoint) {
    throw new Error(`No checkpoint found for runId "${runId}"`)
  }
  if (checkpoint.status === 'completed') {
    return checkpoint.state
  }

  // Merge resume data (e.g., human approval input) into state
  const state = resumeData
    ? { ...checkpoint.state, ...resumeData }
    : checkpoint.state

  // Re-run from the checkpoint's nodeIndex
  // ... execute remaining nodes starting from checkpoint.nodeIndex ...
}
```

### State Versioning

```typescript
// workflow/workflow-migration.ts

/**
 * Migration function signature: transforms state from one schema version to the next.
 */
export type WorkflowMigration = (
  state: Record<string, unknown>,
) => Record<string, unknown>

/**
 * Registry of schema migrations, keyed by target version.
 */
export class WorkflowMigrationRegistry {
  private migrations = new Map<number, WorkflowMigration>()

  /** Register a migration from version N-1 to version N. */
  register(targetVersion: number, migration: WorkflowMigration): void {
    this.migrations.set(targetVersion, migration)
  }

  /** Migrate state from sourceVersion to targetVersion, applying all intermediate migrations. */
  migrate(
    state: Record<string, unknown>,
    sourceVersion: number,
    targetVersion: number,
  ): Record<string, unknown> {
    let current = { ...state }
    for (let v = sourceVersion + 1; v <= targetVersion; v++) {
      const migration = this.migrations.get(v)
      if (!migration) {
        throw new Error(
          `No migration registered for version ${v}. `
          + `Cannot migrate from ${sourceVersion} to ${targetVersion}.`,
        )
      }
      current = migration(current)
    }
    return current
  }
}
```

---

## 8. F6: Quorum Consensus

**Priority:** P2 | **Effort:** 8h | **Risk:** Low

### Interface Specification

```typescript
// orchestration/consensus/quorum-types.ts

/**
 * A single agent's vote on a decision.
 */
export interface Vote {
  readonly agentId: string
  /** The agent's answer or decision */
  readonly answer: string
  /** Confidence in this vote (0-1) */
  readonly confidence: number
  /** Brief reasoning */
  readonly reasoning: string
  /** Weight for weighted voting (default: 1) */
  readonly weight?: number
  /** Timestamp of vote submission */
  readonly votedAt: number
}

/**
 * Voting strategy determines how votes are aggregated.
 */
export type VotingStrategy =
  | 'majority'         // >50% of votes agree
  | 'unanimous'        // 100% of votes agree
  | 'supermajority'    // >=2/3 of votes agree
  | 'weighted-majority' // weighted votes >50%
  | 'plurality'        // most common answer wins (no majority needed)

/**
 * Result of a quorum vote.
 */
export interface QuorumResult {
  /** The winning answer (or null if no quorum reached) */
  readonly answer: string | null
  /** Whether quorum was reached */
  readonly quorumReached: boolean
  /** Number of votes for the winning answer */
  readonly winningVotes: number
  /** Total votes cast */
  readonly totalVotes: number
  /** Required votes for quorum */
  readonly quorumThreshold: number
  /** All individual votes */
  readonly votes: ReadonlyArray<Vote>
  /** Breakdown by answer */
  readonly tally: ReadonlyArray<{
    answer: string
    count: number
    totalWeight: number
    averageConfidence: number
  }>
  /** Conflicts: answers with significantly different positions */
  readonly conflicts: ReadonlyArray<{
    answer1: string
    answer2: string
    divergence: number
  }>
}

/**
 * Configuration for quorum consensus.
 */
export interface QuorumConfig {
  /** Voting strategy (default: 'majority') */
  strategy: VotingStrategy
  /** Custom quorum threshold as fraction (0-1). Overrides strategy default. */
  threshold?: number
  /** Timeout for vote collection in ms (default: 60_000) */
  timeoutMs?: number
  /**
   * Fallback behavior when quorum is not reached.
   * - 'fail': throw an error
   * - 'partial': accept the plurality answer
   * - 'delegate': pass to a tiebreaker agent
   */
  fallback: 'fail' | 'partial' | 'delegate'
  /** Tiebreaker agent (required when fallback is 'delegate') */
  tiebreaker?: DzipAgent
  /** AbortSignal */
  signal?: AbortSignal
}
```

### QuorumManager

```typescript
// orchestration/consensus/quorum-manager.ts

import { HumanMessage } from '@langchain/core/messages'
import type { DzipAgent } from '../../agent/dzip-agent.js'
import type { Vote, QuorumResult, QuorumConfig } from './quorum-types.js'

export class QuorumManager {
  /**
   * Collect votes from agents and determine consensus.
   *
   * Each agent receives the question and produces a structured vote.
   * Votes are then aggregated according to the configured strategy.
   */
  async vote(
    agents: DzipAgent[],
    question: string,
    config: QuorumConfig,
  ): Promise<QuorumResult> {
    const timeout = config.timeoutMs ?? 60_000

    // Collect votes in parallel with timeout
    const votes = await this.collectVotes(agents, question, timeout, config.signal)

    // Aggregate
    const tally = this.buildTally(votes)
    const threshold = this.resolveThreshold(config, agents.length)

    // Find winner
    const sorted = [...tally].sort((a, b) => b.count - a.count)
    const topAnswer = sorted[0]

    const quorumReached = topAnswer
      ? this.checkQuorum(topAnswer, votes, threshold, config.strategy)
      : false

    // Detect conflicts
    const conflicts = this.detectConflicts(tally)

    if (!quorumReached && config.fallback === 'delegate' && config.tiebreaker) {
      // Delegate to tiebreaker
      const tiebreakerResult = await this.delegateToTiebreaker(
        config.tiebreaker, question, votes, config.signal,
      )
      return {
        answer: tiebreakerResult,
        quorumReached: false,
        winningVotes: 0,
        totalVotes: votes.length,
        quorumThreshold: threshold,
        votes,
        tally,
        conflicts,
      }
    }

    if (!quorumReached && config.fallback === 'fail') {
      return {
        answer: null,
        quorumReached: false,
        winningVotes: topAnswer?.count ?? 0,
        totalVotes: votes.length,
        quorumThreshold: threshold,
        votes,
        tally,
        conflicts,
      }
    }

    return {
      answer: topAnswer?.answer ?? null,
      quorumReached,
      winningVotes: topAnswer?.count ?? 0,
      totalVotes: votes.length,
      quorumThreshold: threshold,
      votes,
      tally,
      conflicts,
    }
  }

  private async collectVotes(
    agents: DzipAgent[],
    question: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Vote[]> {
    const votePrompt = [
      `You are participating in a group vote. Answer the following question.`,
      ``,
      `## Question`,
      question,
      ``,
      `## Instructions`,
      `Respond with a JSON object:`,
      `{`,
      `  "answer": "<your concise answer>",`,
      `  "confidence": <0-1>,`,
      `  "reasoning": "<brief explanation>"`,
      `}`,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const composedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal

    try {
      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const result = await agent.generate(
            [new HumanMessage(votePrompt)],
            { signal: composedSignal, maxIterations: 1 },
          )
          return this.parseVote(agent.id, result.content)
        }),
      )

      return results
        .filter((r): r is PromiseFulfilledResult<Vote | null> =>
          r.status === 'fulfilled')
        .map(r => r.value)
        .filter((v): v is Vote => v !== null)
    } finally {
      clearTimeout(timer)
    }
  }

  private parseVote(agentId: string, content: string): Vote | null {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0]) as {
        answer?: string
        confidence?: number
        reasoning?: string
      }

      if (!parsed.answer) return null

      return {
        agentId,
        answer: parsed.answer.trim(),
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
        reasoning: parsed.reasoning ?? '',
        votedAt: Date.now(),
      }
    } catch {
      return null
    }
  }

  private buildTally(votes: Vote[]): QuorumResult['tally'] {
    const groups = new Map<string, Vote[]>()
    for (const vote of votes) {
      const normalized = vote.answer.toLowerCase().trim()
      const existing = groups.get(normalized) ?? []
      existing.push(vote)
      groups.set(normalized, existing)
    }

    return [...groups.entries()].map(([answer, group]) => ({
      answer,
      count: group.length,
      totalWeight: group.reduce((sum, v) => sum + (v.weight ?? 1), 0),
      averageConfidence: group.reduce((sum, v) => sum + v.confidence, 0) / group.length,
    }))
  }

  private resolveThreshold(config: QuorumConfig, agentCount: number): number {
    if (config.threshold !== undefined) return Math.ceil(config.threshold * agentCount)

    switch (config.strategy) {
      case 'majority': return Math.ceil(agentCount / 2) + 1
      case 'supermajority': return Math.ceil(agentCount * 2 / 3)
      case 'unanimous': return agentCount
      case 'plurality': return 1
      case 'weighted-majority': return Math.ceil(agentCount / 2) + 1
    }
  }

  private checkQuorum(
    topAnswer: { count: number; totalWeight: number },
    votes: Vote[],
    threshold: number,
    strategy: QuorumConfig['strategy'],
  ): boolean {
    if (strategy === 'weighted-majority') {
      const totalWeight = votes.reduce((sum, v) => sum + (v.weight ?? 1), 0)
      return topAnswer.totalWeight > totalWeight / 2
    }
    return topAnswer.count >= threshold
  }

  private detectConflicts(
    tally: QuorumResult['tally'],
  ): QuorumResult['conflicts'] {
    const conflicts: QuorumResult['conflicts'][number][] = []

    for (let i = 0; i < tally.length; i++) {
      for (let j = i + 1; j < tally.length; j++) {
        const a = tally[i]!
        const b = tally[j]!
        // Two answers with similar vote counts = conflict
        const total = a.count + b.count
        const divergence = Math.min(a.count, b.count) / Math.max(total, 1)
        if (divergence > 0.3) {
          conflicts.push({
            answer1: a.answer,
            answer2: b.answer,
            divergence,
          })
        }
      }
    }

    return conflicts
  }

  private async delegateToTiebreaker(
    tiebreaker: DzipAgent,
    question: string,
    votes: Vote[],
    signal?: AbortSignal,
  ): Promise<string> {
    const voteSummary = votes
      .map(v => `- Agent ${v.agentId}: "${v.answer}" (confidence: ${v.confidence}, reasoning: ${v.reasoning})`)
      .join('\n')

    const prompt = [
      `The following agents voted on a question but did not reach consensus.`,
      `As the tiebreaker, make the final decision.`,
      ``,
      `## Question`,
      question,
      ``,
      `## Votes`,
      voteSummary,
      ``,
      `Provide your final answer.`,
    ].join('\n')

    const result = await tiebreaker.generate(
      [new HumanMessage(prompt)],
      { signal },
    )
    return result.content
  }
}
```

---

## 9. F7: Cascading Timeouts

**Priority:** P1 | **Effort:** 4h | **Risk:** Low

### Concept

When a parent orchestration has a deadline, child agent invocations must receive proportional time budgets. If a parent has 60s remaining and needs to run 3 sequential agents, each gets roughly 20s. The system propagates `AbortSignal`s through the agent hierarchy with grace periods.

### Interface Specification

```typescript
// orchestration/timeout/cascading-timeout.ts

/**
 * Manages deadline propagation across agent hierarchies.
 *
 * Creates child AbortControllers that fire before the parent,
 * ensuring the parent has time to collect partial results and
 * handle the timeout gracefully.
 */
export interface CascadingTimeoutConfig {
  /** Total deadline in ms from now */
  deadlineMs: number
  /** Grace period before hard abort (ms). Default: 5_000. */
  gracePeriodMs?: number
  /** Parent signal to compose with */
  parentSignal?: AbortSignal
}

export interface TimeoutBudget {
  /** Remaining time in ms */
  readonly remainingMs: number
  /** Whether the deadline has passed */
  readonly expired: boolean
  /** AbortSignal that fires at the deadline */
  readonly signal: AbortSignal
  /**
   * Create a child budget that expires before this one.
   * The child gets `fractionOfRemaining` of the remaining time,
   * minus the parent's grace period.
   */
  createChild(fractionOfRemaining?: number): TimeoutBudget
  /**
   * Split remaining time equally among N children.
   * Each child gets (remaining - gracePeriod) / count ms.
   */
  splitEqual(count: number): TimeoutBudget[]
  /** Cancel this budget (and all children) immediately. */
  cancel(): void
}

/**
 * Create a cascading timeout budget.
 *
 * @example
 * ```ts
 * const budget = createTimeoutBudget({ deadlineMs: 60_000 })
 *
 * // Split for 3 sequential steps
 * const [step1, step2, step3] = budget.splitEqual(3)
 *
 * await agent1.generate(msgs, { signal: step1.signal })
 * await agent2.generate(msgs, { signal: step2.signal })
 * await agent3.generate(msgs, { signal: step3.signal })
 * ```
 */
export function createTimeoutBudget(config: CascadingTimeoutConfig): TimeoutBudget {
  const gracePeriodMs = config.gracePeriodMs ?? 5_000
  const startTime = Date.now()
  const deadline = startTime + config.deadlineMs
  const controller = new AbortController()

  // Set up the top-level timer
  const timer = setTimeout(() => controller.abort(), config.deadlineMs)

  // Compose with parent signal if provided
  if (config.parentSignal) {
    config.parentSignal.addEventListener('abort', () => {
      controller.abort()
      clearTimeout(timer)
    }, { once: true })
  }

  function buildBudget(
    ctrl: AbortController,
    budgetDeadline: number,
    budgetGrace: number,
    cleanupTimer?: ReturnType<typeof setTimeout>,
  ): TimeoutBudget {
    return {
      get remainingMs() {
        return Math.max(0, budgetDeadline - Date.now())
      },
      get expired() {
        return Date.now() >= budgetDeadline
      },
      signal: ctrl.signal,

      createChild(fractionOfRemaining = 0.8): TimeoutBudget {
        const remaining = Math.max(0, budgetDeadline - Date.now())
        const childMs = Math.max(0, (remaining - budgetGrace) * fractionOfRemaining)
        const childCtrl = new AbortController()
        const childTimer = setTimeout(() => childCtrl.abort(), childMs)

        // If parent aborts, abort child too
        ctrl.signal.addEventListener('abort', () => {
          childCtrl.abort()
          clearTimeout(childTimer)
        }, { once: true })

        return buildBudget(childCtrl, Date.now() + childMs, budgetGrace, childTimer)
      },

      splitEqual(count: number): TimeoutBudget[] {
        const remaining = Math.max(0, budgetDeadline - Date.now())
        const perChild = Math.max(0, (remaining - budgetGrace) / count)
        const budgets: TimeoutBudget[] = []

        for (let i = 0; i < count; i++) {
          const childCtrl = new AbortController()
          // Each child's deadline is staggered for sequential use,
          // but the signal fires after perChild ms from when *it* starts.
          // For parallel use, all fire at perChild from now.
          const childTimer = setTimeout(() => childCtrl.abort(), perChild)

          ctrl.signal.addEventListener('abort', () => {
            childCtrl.abort()
            clearTimeout(childTimer)
          }, { once: true })

          budgets.push(
            buildBudget(childCtrl, Date.now() + perChild, budgetGrace, childTimer),
          )
        }

        return budgets
      },

      cancel(): void {
        ctrl.abort()
        if (cleanupTimer) clearTimeout(cleanupTimer)
      },
    }
  }

  return buildBudget(controller, deadline, gracePeriodMs, timer)
}
```

### Integration with Orchestration Patterns

All orchestration patterns accept an optional `signal?: AbortSignal`. Cascading timeouts compose naturally:

```typescript
// Example: sequential with cascading timeouts
const budget = createTimeoutBudget({ deadlineMs: 120_000 })
const [planBudget, codeBudget, reviewBudget] = budget.splitEqual(3)

await AgentOrchestrator.sequential(
  [planAgent],
  task,
  // Not directly -- each agent call passes signal individually
)

// Inside the enhanced sequential():
static async sequential(
  agents: DzipAgent[],
  initialInput: string,
  options?: { timeoutBudget?: TimeoutBudget },
): Promise<string> {
  const budgets = options?.timeoutBudget
    ? options.timeoutBudget.splitEqual(agents.length)
    : agents.map(() => undefined)

  let current = initialInput
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!
    const budget = budgets[i]
    const result = await agent.generate(
      [new HumanMessage(current)],
      { signal: budget?.signal },
    )
    current = result.content
  }
  return current
}
```

---

## 10. F8: Dead-Letter Queue

**Priority:** P2 | **Effort:** 4h | **Risk:** Low

### Interface Specification

```typescript
// orchestration/dlq/dead-letter-types.ts

/**
 * A failed interaction stored in the dead-letter queue.
 */
export interface DeadLetterEntry {
  /** Unique entry ID */
  readonly entryId: string
  /** The orchestration pattern that produced this failure */
  readonly pattern: string
  /** The failed agent's ID */
  readonly agentId: string
  /** The input that caused the failure */
  readonly input: string
  /** Error message */
  readonly error: string
  /** Stack trace (if available) */
  readonly stack?: string
  /** Number of retry attempts so far */
  readonly retryCount: number
  /** Maximum retries allowed */
  readonly maxRetries: number
  /** Timestamp of initial failure */
  readonly failedAt: string
  /** Timestamp of last retry attempt */
  readonly lastRetryAt?: string
  /** Metadata (workflow ID, step ID, etc.) */
  readonly metadata: Record<string, unknown>
}

/**
 * Retry policy for DLQ entries.
 */
export interface RetryPolicy {
  /** Maximum number of retries (default: 3) */
  maxRetries: number
  /** Base delay between retries in ms (default: 1_000) */
  baseDelayMs: number
  /** Backoff multiplier (default: 2 for exponential backoff) */
  backoffMultiplier: number
  /** Maximum delay cap in ms (default: 60_000) */
  maxDelayMs: number
}

/**
 * DLQ metrics for monitoring.
 */
export interface DLQMetrics {
  /** Total entries currently in the queue */
  depth: number
  /** Oldest entry age in ms */
  oldestAgeMs: number
  /** Total retries performed */
  totalRetries: number
  /** Number of entries that exhausted all retries */
  exhaustedCount: number
  /** Entries by pattern */
  byPattern: Record<string, number>
}

/**
 * Dead-letter queue interface.
 */
export interface DeadLetterQueue {
  /** Add a failed interaction to the queue. */
  enqueue(entry: Omit<DeadLetterEntry, 'entryId' | 'retryCount' | 'failedAt'>): Promise<string>

  /** Get an entry by ID. */
  get(entryId: string): Promise<DeadLetterEntry | null>

  /** List entries, optionally filtered. */
  list(options?: {
    pattern?: string
    agentId?: string
    limit?: number
    offset?: number
  }): Promise<DeadLetterEntry[]>

  /**
   * Retry an entry: re-execute the failed interaction.
   * Returns true if retry succeeded (entry removed from queue).
   */
  retry(entryId: string, agent: DzipAgent): Promise<boolean>

  /**
   * Replay an entry with modified input.
   * Useful for manual investigation and correction.
   */
  replay(
    entryId: string,
    agent: DzipAgent,
    modifiedInput?: string,
  ): Promise<{ success: boolean; result?: string; error?: string }>

  /** Remove an entry (manual acknowledgment). */
  acknowledge(entryId: string): Promise<void>

  /** Get queue metrics. */
  metrics(): Promise<DLQMetrics>

  /** Purge entries older than the given age in ms. */
  purge(maxAgeMs: number): Promise<number>
}
```

### InMemoryDeadLetterQueue

```typescript
// orchestration/dlq/in-memory-dlq.ts

import { randomUUID } from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'
import type { DzipAgent } from '../../agent/dzip-agent.js'
import type {
  DeadLetterQueue,
  DeadLetterEntry,
  DLQMetrics,
  RetryPolicy,
} from './dead-letter-types.js'

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private entries = new Map<string, DeadLetterEntry>()
  private readonly retryPolicy: Required<RetryPolicy>

  constructor(retryPolicy?: Partial<RetryPolicy>) {
    this.retryPolicy = {
      maxRetries: retryPolicy?.maxRetries ?? 3,
      baseDelayMs: retryPolicy?.baseDelayMs ?? 1_000,
      backoffMultiplier: retryPolicy?.backoffMultiplier ?? 2,
      maxDelayMs: retryPolicy?.maxDelayMs ?? 60_000,
    }
  }

  async enqueue(
    entry: Omit<DeadLetterEntry, 'entryId' | 'retryCount' | 'failedAt'>,
  ): Promise<string> {
    const entryId = randomUUID()
    this.entries.set(entryId, {
      ...entry,
      entryId,
      retryCount: 0,
      failedAt: new Date().toISOString(),
    })
    return entryId
  }

  async get(entryId: string): Promise<DeadLetterEntry | null> {
    return this.entries.get(entryId) ?? null
  }

  async list(options?: {
    pattern?: string
    agentId?: string
    limit?: number
    offset?: number
  }): Promise<DeadLetterEntry[]> {
    let results = [...this.entries.values()]

    if (options?.pattern) {
      results = results.filter(e => e.pattern === options.pattern)
    }
    if (options?.agentId) {
      results = results.filter(e => e.agentId === options.agentId)
    }

    results.sort((a, b) =>
      new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime())

    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    return results.slice(offset, offset + limit)
  }

  async retry(entryId: string, agent: DzipAgent): Promise<boolean> {
    const entry = this.entries.get(entryId)
    if (!entry) return false

    if (entry.retryCount >= entry.maxRetries) return false

    // Calculate backoff delay
    const delay = Math.min(
      this.retryPolicy.baseDelayMs * Math.pow(
        this.retryPolicy.backoffMultiplier,
        entry.retryCount,
      ),
      this.retryPolicy.maxDelayMs,
    )
    await new Promise(resolve => setTimeout(resolve, delay))

    try {
      await agent.generate([new HumanMessage(entry.input)])
      this.entries.delete(entryId) // Success -- remove from DLQ
      return true
    } catch {
      // Update retry count
      this.entries.set(entryId, {
        ...entry,
        retryCount: entry.retryCount + 1,
        lastRetryAt: new Date().toISOString(),
      })
      return false
    }
  }

  async replay(
    entryId: string,
    agent: DzipAgent,
    modifiedInput?: string,
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    const entry = this.entries.get(entryId)
    if (!entry) return { success: false, error: 'Entry not found' }

    const input = modifiedInput ?? entry.input

    try {
      const result = await agent.generate([new HumanMessage(input)])
      this.entries.delete(entryId)
      return { success: true, result: result.content }
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async acknowledge(entryId: string): Promise<void> {
    this.entries.delete(entryId)
  }

  async metrics(): Promise<DLQMetrics> {
    const entries = [...this.entries.values()]
    const now = Date.now()

    const byPattern: Record<string, number> = {}
    let oldestAge = 0
    let totalRetries = 0
    let exhaustedCount = 0

    for (const entry of entries) {
      byPattern[entry.pattern] = (byPattern[entry.pattern] ?? 0) + 1
      const age = now - new Date(entry.failedAt).getTime()
      if (age > oldestAge) oldestAge = age
      totalRetries += entry.retryCount
      if (entry.retryCount >= entry.maxRetries) exhaustedCount++
    }

    return {
      depth: entries.length,
      oldestAgeMs: oldestAge,
      totalRetries,
      exhaustedCount,
      byPattern,
    }
  }

  async purge(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs
    let purged = 0
    for (const [id, entry] of this.entries) {
      if (new Date(entry.failedAt).getTime() < cutoff) {
        this.entries.delete(id)
        purged++
      }
    }
    return purged
  }
}
```

### Integration with Orchestration Patterns

Orchestration patterns catch errors and route failures to the DLQ:

```typescript
// Enhanced parallel with DLQ
static async parallel(
  agents: DzipAgent[],
  input: string,
  options?: {
    merge?: MergeFn
    dlq?: DeadLetterQueue
    signal?: AbortSignal
  },
): Promise<string> {
  const results = await Promise.allSettled(
    agents.map(agent =>
      agent.generate([new HumanMessage(input)], { signal: options?.signal })),
  )

  const successes: string[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    if (result.status === 'fulfilled') {
      successes.push(result.value.content)
    } else if (options?.dlq) {
      await options.dlq.enqueue({
        pattern: 'parallel',
        agentId: agents[i]!.id,
        input,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        stack: result.reason instanceof Error ? result.reason.stack : undefined,
        maxRetries: 3,
        metadata: {},
      })
    }
  }

  return (options?.merge ?? defaultMerge)(successes)
}
```

---

## 11. F9: Multi-Round Debate

**Priority:** P2 | **Effort:** 6h | **Risk:** Low

### Enhancement to Existing Debate

The current `AgentOrchestrator.debate()` already supports `rounds`, but it lacks:

1. Convergence detection (stop early if agents agree)
2. Position tracking across rounds (who changed their mind)
3. Rubric-based judge evaluation

### Interface Specification

```typescript
// orchestration/debate/debate-types.ts

/**
 * Tracks an agent's position across debate rounds.
 */
export interface DebatePosition {
  readonly agentId: string
  readonly round: number
  readonly proposal: string
  /** Key points extracted from the proposal */
  readonly keyPoints: string[]
}

/**
 * Judge's evaluation with rubric scoring.
 */
export interface JudgeEvaluation {
  /** Winning proposal index (0-based) */
  readonly winnerIndex: number
  /** Scores per rubric dimension for each proposal */
  readonly scores: Array<{
    proposalIndex: number
    agentId: string
    dimensions: Record<string, number>
    overallScore: number
  }>
  /** Synthesized answer (best parts of all proposals) */
  readonly synthesized: string
  /** Judge's reasoning */
  readonly reasoning: string
}

/**
 * Convergence state of the debate.
 */
export interface ConvergenceState {
  /** Whether agents have converged (positions stopped changing) */
  readonly converged: boolean
  /** Similarity score between rounds (0-1, 1 = identical) */
  readonly similarity: number
  /** Number of agents that changed their position this round */
  readonly changedPositions: number
  /** Total agents */
  readonly totalAgents: number
}

/**
 * Configuration for multi-round debate.
 */
export interface DebateConfig {
  /** Maximum rounds (default: 3) */
  maxRounds: number
  /** Rubric dimensions for judge evaluation */
  rubric?: Record<string, string>
  /** Enable convergence detection (default: true) */
  detectConvergence?: boolean
  /** Convergence threshold: stop if similarity > this (default: 0.85) */
  convergenceThreshold?: number
  /** AbortSignal */
  signal?: AbortSignal
}

/**
 * Result of a multi-round debate.
 */
export interface DebateResult {
  /** Final synthesized answer from the judge */
  readonly answer: string
  /** Judge's full evaluation */
  readonly evaluation: JudgeEvaluation
  /** Position history for each agent across rounds */
  readonly positions: ReadonlyArray<DebatePosition>
  /** Number of rounds actually executed */
  readonly roundsExecuted: number
  /** Convergence state at the final round */
  readonly convergence: ConvergenceState
}
```

### Enhanced Debate Implementation

```typescript
// orchestration/debate/multi-round-debate.ts

import { HumanMessage } from '@langchain/core/messages'
import type { DzipAgent } from '../../agent/dzip-agent.js'
import type {
  DebateConfig,
  DebateResult,
  DebatePosition,
  JudgeEvaluation,
  ConvergenceState,
} from './debate-types.js'

export class MultiRoundDebate {
  async execute(
    proposers: DzipAgent[],
    judge: DzipAgent,
    task: string,
    config?: Partial<DebateConfig>,
  ): Promise<DebateResult> {
    const maxRounds = config?.maxRounds ?? 3
    const detectConvergence = config?.detectConvergence ?? true
    const convergenceThreshold = config?.convergenceThreshold ?? 0.85

    const allPositions: DebatePosition[] = []
    let lastProposals: string[] = []
    let convergence: ConvergenceState = {
      converged: false,
      similarity: 0,
      changedPositions: proposers.length,
      totalAgents: proposers.length,
    }

    for (let round = 0; round < maxRounds; round++) {
      if (config?.signal?.aborted) break

      // Build round prompt
      const roundPrompt = round === 0
        ? task
        : this.buildRefinementPrompt(task, lastProposals)

      // Collect proposals
      const proposals = await Promise.all(
        proposers.map(async (agent) => {
          const result = await agent.generate(
            [new HumanMessage(roundPrompt)],
            { signal: config?.signal },
          )
          return result.content
        }),
      )

      // Track positions
      for (let i = 0; i < proposers.length; i++) {
        allPositions.push({
          agentId: proposers[i]!.id,
          round,
          proposal: proposals[i]!,
          keyPoints: this.extractKeyPoints(proposals[i]!),
        })
      }

      // Check convergence
      if (detectConvergence && round > 0) {
        convergence = this.checkConvergence(
          lastProposals,
          proposals,
          proposers.length,
        )

        if (convergence.converged || convergence.similarity > convergenceThreshold) {
          lastProposals = proposals
          break
        }
      }

      lastProposals = proposals
    }

    // Judge evaluates
    const evaluation = await this.judgeEvaluate(
      judge,
      task,
      lastProposals,
      proposers,
      config?.rubric,
      config?.signal,
    )

    const roundsExecuted = Math.min(
      maxRounds,
      Math.max(...allPositions.map(p => p.round)) + 1,
    )

    return {
      answer: evaluation.synthesized,
      evaluation,
      positions: allPositions,
      roundsExecuted,
      convergence,
    }
  }

  private buildRefinementPrompt(task: string, previousProposals: string[]): string {
    const formatted = previousProposals
      .map((p, i) => `## Proposal ${i + 1}\n${p}`)
      .join('\n\n')

    return [
      `Original task: ${task}`,
      ``,
      `Previous round's proposals:`,
      formatted,
      ``,
      `Review all proposals. Improve upon the best aspects of each.`,
      `Produce an improved version that addresses weaknesses you see.`,
    ].join('\n')
  }

  private extractKeyPoints(proposal: string): string[] {
    // Simple heuristic: split by sentences, take first 5
    return proposal
      .split(/[.!?]\s+/)
      .filter(s => s.length > 20)
      .slice(0, 5)
      .map(s => s.trim())
  }

  private checkConvergence(
    previous: string[],
    current: string[],
    agentCount: number,
  ): ConvergenceState {
    let changedPositions = 0
    let totalSimilarity = 0

    for (let i = 0; i < Math.min(previous.length, current.length); i++) {
      const sim = this.cosineSimilarityApprox(previous[i]!, current[i]!)
      totalSimilarity += sim
      if (sim < 0.8) changedPositions++
    }

    const avgSimilarity = totalSimilarity / Math.max(agentCount, 1)

    return {
      converged: changedPositions === 0,
      similarity: avgSimilarity,
      changedPositions,
      totalAgents: agentCount,
    }
  }

  /**
   * Cheap approximate similarity using character trigram overlap.
   * Not a real cosine similarity, but sufficient for convergence detection.
   */
  private cosineSimilarityApprox(a: string, b: string): number {
    const trigramsA = this.trigrams(a.toLowerCase())
    const trigramsB = this.trigrams(b.toLowerCase())

    const setA = new Set(trigramsA)
    const setB = new Set(trigramsB)

    let intersection = 0
    for (const t of setA) {
      if (setB.has(t)) intersection++
    }

    const union = setA.size + setB.size - intersection
    return union === 0 ? 1 : intersection / union
  }

  private trigrams(s: string): string[] {
    const result: string[] = []
    for (let i = 0; i <= s.length - 3; i++) {
      result.push(s.slice(i, i + 3))
    }
    return result
  }

  private async judgeEvaluate(
    judge: DzipAgent,
    task: string,
    proposals: string[],
    proposers: DzipAgent[],
    rubric?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<JudgeEvaluation> {
    const rubricText = rubric
      ? Object.entries(rubric)
          .map(([dim, desc]) => `- **${dim}**: ${desc}`)
          .join('\n')
      : [
          '- **Correctness**: Is the solution technically correct?',
          '- **Completeness**: Does it address all aspects of the task?',
          '- **Clarity**: Is the explanation clear and well-structured?',
          '- **Practicality**: Can this be implemented as described?',
        ].join('\n')

    const proposalText = proposals
      .map((p, i) => `## Proposal ${i + 1} (by ${proposers[i]?.id ?? `agent-${i}`})\n${p}`)
      .join('\n\n')

    const judgePrompt = [
      `Evaluate these proposals for the following task:`,
      ``,
      `**Task:** ${task}`,
      ``,
      proposalText,
      ``,
      `## Evaluation Rubric`,
      rubricText,
      ``,
      `## Instructions`,
      `Respond with a JSON object:`,
      `{`,
      `  "winnerIndex": <0-based index>,`,
      `  "scores": [`,
      `    { "proposalIndex": 0, "dimensions": { "<dim>": <1-10>, ... }, "overallScore": <1-10> },`,
      `    ...`,
      `  ],`,
      `  "synthesized": "<your synthesized best answer combining the best parts>",`,
      `  "reasoning": "<your evaluation reasoning>"`,
      `}`,
    ].join('\n')

    const result = await judge.generate(
      [new HumanMessage(judgePrompt)],
      { signal, maxIterations: 1 },
    )

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in judge response')

      const parsed = JSON.parse(jsonMatch[0]) as {
        winnerIndex?: number
        scores?: Array<{
          proposalIndex: number
          dimensions: Record<string, number>
          overallScore: number
        }>
        synthesized?: string
        reasoning?: string
      }

      return {
        winnerIndex: parsed.winnerIndex ?? 0,
        scores: (parsed.scores ?? []).map((s, i) => ({
          ...s,
          agentId: proposers[s.proposalIndex ?? i]?.id ?? `agent-${i}`,
        })),
        synthesized: parsed.synthesized ?? result.content,
        reasoning: parsed.reasoning ?? '',
      }
    } catch {
      // Fallback: treat the entire response as the synthesized answer
      return {
        winnerIndex: 0,
        scores: [],
        synthesized: result.content,
        reasoning: 'Judge response could not be parsed as structured evaluation.',
      }
    }
  }
}
```

---

## 12. F10: Agent Tournament

**Priority:** P3 | **Effort:** 8h | **Risk:** Low

### Interface Specification

```typescript
// orchestration/tournament/tournament-types.ts

/**
 * A single tournament entry: agent + its result.
 */
export interface TournamentEntry {
  readonly agentId: string
  readonly result: string
  readonly durationMs: number
  readonly tokenUsage: { inputTokens: number; outputTokens: number }
  readonly costCents: number
}

/**
 * Scoring function applied to each entry.
 */
export type TournamentScorer = (
  entry: TournamentEntry,
  allEntries: ReadonlyArray<TournamentEntry>,
) => Promise<number> | number

/**
 * Tournament configuration.
 */
export interface TournamentConfig {
  /** Scoring functions (all run, results combined) */
  scorers: Array<{ name: string; scorer: TournamentScorer; weight: number }>
  /** Maximum total budget in cents for the tournament */
  maxBudgetCents?: number
  /** Maximum concurrent agent executions (default: 5) */
  concurrency?: number
  /** AbortSignal */
  signal?: AbortSignal
}

/**
 * Tournament result.
 */
export interface TournamentResult {
  /** Ranked entries, best first */
  readonly rankings: ReadonlyArray<{
    rank: number
    agentId: string
    result: string
    scores: Record<string, number>
    totalScore: number
  }>
  /** Winner's result */
  readonly winner: { agentId: string; result: string; totalScore: number }
  /** Total cost of the tournament */
  readonly totalCostCents: number
  /** Total duration */
  readonly durationMs: number
}
```

### TournamentRunner

```typescript
// orchestration/tournament/tournament-runner.ts

import { HumanMessage } from '@langchain/core/messages'
import type { DzipAgent } from '../../agent/dzip-agent.js'
import type {
  TournamentConfig,
  TournamentResult,
  TournamentEntry,
} from './tournament-types.js'

export class TournamentRunner {
  async execute(
    agents: DzipAgent[],
    task: string,
    config: TournamentConfig,
  ): Promise<TournamentResult> {
    const start = Date.now()
    const concurrency = config.concurrency ?? 5

    // Execute all agents with bounded concurrency
    const entries = await this.executeAll(agents, task, concurrency, config.signal)

    // Score each entry
    const scored = await Promise.all(
      entries.map(async (entry) => {
        const scores: Record<string, number> = {}
        let totalScore = 0

        for (const { name, scorer, weight } of config.scorers) {
          const score = await scorer(entry, entries)
          scores[name] = score
          totalScore += score * weight
        }

        return { ...entry, scores, totalScore }
      }),
    )

    // Rank by total score
    scored.sort((a, b) => b.totalScore - a.totalScore)

    const rankings = scored.map((entry, i) => ({
      rank: i + 1,
      agentId: entry.agentId,
      result: entry.result,
      scores: entry.scores,
      totalScore: entry.totalScore,
    }))

    const winner = rankings[0]!

    return {
      rankings,
      winner: {
        agentId: winner.agentId,
        result: winner.result,
        totalScore: winner.totalScore,
      },
      totalCostCents: entries.reduce((sum, e) => sum + e.costCents, 0),
      durationMs: Date.now() - start,
    }
  }

  private async executeAll(
    agents: DzipAgent[],
    task: string,
    concurrency: number,
    signal?: AbortSignal,
  ): Promise<TournamentEntry[]> {
    const entries: TournamentEntry[] = []
    const queue = [...agents]
    const running: Promise<void>[] = []

    const runOne = async (agent: DzipAgent): Promise<void> => {
      const start = Date.now()
      try {
        const result = await agent.generate(
          [new HumanMessage(task)],
          { signal },
        )
        entries.push({
          agentId: agent.id,
          result: result.content,
          durationMs: Date.now() - start,
          tokenUsage: {
            inputTokens: result.usage.totalInputTokens,
            outputTokens: result.usage.totalOutputTokens,
          },
          costCents: 0, // TODO: calculate from usage
        })
      } catch {
        // Failed agent gets no entry -- excluded from ranking
      }
    }

    // Bounded concurrency
    while (queue.length > 0 || running.length > 0) {
      while (running.length < concurrency && queue.length > 0) {
        const agent = queue.shift()!
        const promise = runOne(agent).then(() => {
          const idx = running.indexOf(promise)
          if (idx !== -1) running.splice(idx, 1)
        })
        running.push(promise)
      }
      if (running.length > 0) {
        await Promise.race(running)
      }
    }

    return entries
  }
}
```

### Built-in Scorers

```typescript
// orchestration/tournament/builtin-scorers.ts

import type { TournamentScorer } from './tournament-types.js'

/** Score by response length (longer = better, up to a point). */
export const lengthScorer: TournamentScorer = (entry) => {
  const len = entry.result.length
  // Bell curve: peak at ~2000 chars
  return Math.exp(-Math.pow((len - 2000) / 2000, 2))
}

/** Score inversely by cost (cheaper = better). */
export const costEfficiencyScorer: TournamentScorer = (entry, all) => {
  const maxCost = Math.max(...all.map(e => e.costCents), 1)
  return 1 - entry.costCents / maxCost
}

/** Score inversely by duration (faster = better). */
export const speedScorer: TournamentScorer = (entry, all) => {
  const maxDuration = Math.max(...all.map(e => e.durationMs), 1)
  return 1 - entry.durationMs / maxDuration
}

/**
 * Create a scorer that uses an LLM judge to evaluate quality.
 * The judge scores each response on a 1-10 scale.
 */
export function createLLMJudgeScorer(
  judge: DzipAgent,
  rubric: string,
): TournamentScorer {
  return async (entry) => {
    const { HumanMessage } = await import('@langchain/core/messages')
    const prompt = [
      `Score this response on a scale of 1-10 based on the rubric.`,
      ``,
      `## Rubric`,
      rubric,
      ``,
      `## Response`,
      entry.result,
      ``,
      `Respond with just a number (1-10).`,
    ].join('\n')

    const result = await judge.generate(
      [new HumanMessage(prompt)],
      { maxIterations: 1 },
    )

    const match = result.content.match(/\d+/)
    const score = match ? parseInt(match[0], 10) : 5
    return Math.min(10, Math.max(1, score)) / 10
  }
}
```

---

## 13. State Machines

### Contract-Net Protocol State Machine

```
                    +--------------+
                    | broadcasting |
                    +------+-------+
                           |
                    bids collected
                           |
                    +------v-------+
                    |  evaluating  |
                    +------+-------+
                           |
             +-------------+-------------+
             |                           |
        bids >= minBids             bids < minBids
             |                           |
      +------v-------+           +------v-------+
      |   awarded    |           |   no-bids    |
      +------+-------+           +------+-------+
             |                           |
             |                  retryOnNoBids?
             |                     /         \
             |                   yes          no
             |                    |            |
             |              [loop back    [terminal]
             |               to broadcasting]
             |
      +------v-------+
      |  executing   |
      +------+-------+
             |
      +------+------+
      |             |
   success       failure
      |             |
+-----v----+  +----v-----+
| completed |  |  failed  |
+----------+  +----------+

Cancellation can transition from any state to:
      +----------+
      | cancelled |
      +----------+
```

### Workflow Persistence State Machine

```
                 +----------+
                 |  created  |
                 +-----+----+
                       |
                  run() called
                       |
                 +-----v----+
            +--->|  running  |<---+
            |    +-----+----+    |
            |          |         |
            |    +-----+-----+  |
            |    |           |   |
            | suspend     step   |
            | node        done   |
            |    |           |   |
            | +--v-------+   |   |
            | | suspended |  |   |
            | +--+-------+   |   |
            |    |           |   |
            | resume()       |   |
            |    |           |   |
            +----+     +-----+   |
                       |         |
                  all steps    error
                  complete       |
                       |    +----v-----+
                 +-----v--+ |  failed  |
                 |completed| +----------+
                 +---------+
```

### Topology Switching State Machine

```
                  +----------+
                  | analyzing |
                  +-----+----+
                        |
                   select topology
                        |
         +--------------+--------------+
         |        |        |     |     |
    +----v-+ +---v--+ +--v-+ +-v--+ +v---+
    |hierch| |pipeln| |star| |mesh| |ring|
    +----+-+ +---+--+ +--+-+ +-+--+ ++---+
         |       |        |    |     |
         +-------+--------+---+-----+
                        |
                 monitor metrics
                        |
              error rate > threshold?
              latency > threshold?
                   /        \
                 yes          no
                  |            |
           +------v------+    |
           | re-analyzing |   |
           +------+------+   |
                  |           |
           switch topology    |
                  |           |
           [transition back   |
            to new topology]  |
                              |
                        [continue]
```

---

## 14. Data Flow Diagrams

### Contract-Net Negotiation Flow

```
Manager                    Agent A              Agent B              Agent C
  |                          |                    |                    |
  |--- CFP(task) ----------->|                    |                    |
  |--- CFP(task) ------------------------------------->|              |
  |--- CFP(task) -------------------------------------------------------->|
  |                          |                    |                    |
  |<-- Bid(cost,time,qual) --|                    |                    |
  |<-- Bid(cost,time,qual) ----------------------------|                    |
  |                          |                    |  (timeout, no bid) |
  |                          |                    |                    |
  |  [Evaluate bids]         |                    |                    |
  |                          |                    |                    |
  |--- Award() ------------->|                    |                    |
  |--- Reject() ------------------------------------>|                    |
  |                          |                    |                    |
  |  Agent A executes task   |                    |                    |
  |                          |                    |                    |
  |<-- Result(content) ------|                    |                    |
  |                          |                    |                    |
```

### Blackboard Read-Write-Trigger Cycle

```
Control Component         Blackboard          Knowledge Sources
       |                     |                 [A] [B] [C]
       |                     |                      |
       |-- selectNext() ---->|                      |
       |   canActivate()?    |<-- reads keys --[A]  |
       |                     |<-- reads keys --[B]  |
       |                     |<-- reads keys --[C]  |
       |<-- source B --------|                      |
       |                     |                      |
       |-- execute(B) ------>|                      |
       |                     |                 [B] executes
       |                     |<-- put(key,val) [B]  |
       |                     |                      |
       |  (event: entry:written)                    |
       |                     |                      |
       |-- selectNext() ---->|                      |
       |   canActivate()?    |<-- reads keys --[C]  |
       |   (C now has its    |                      |
       |    preconditions)   |                      |
       |<-- source C --------|                      |
       |                     |                      |
       |-- execute(C) ------>|                      |
       |                     |<-- put(key,val) [C]  |
       |                     |                      |
       |  ...repeat until convergence...            |
```

### Cascading Timeout Propagation

```
Parent Budget (120s)
  |
  |-- createChild(0.3) --> Child A (34s)
  |                          |
  |                          |-- agent.generate(signal_A)
  |                          |   [aborts at 34s]
  |
  |-- createChild(0.3) --> Child B (34s)
  |                          |
  |                          |-- agent.generate(signal_B)
  |                          |   [aborts at 34s]
  |
  |-- createChild(0.3) --> Child C (34s)
  |                          |
  |                          |-- agent.generate(signal_C)
  |                          |   [aborts at 34s]
  |
  |-- grace period (5s for parent cleanup)
  |
  [parent aborts at 120s, all children abort immediately]
```

### Dead-Letter Queue Retry Flow

```
Agent Execution          DLQ                    Operator
     |                    |                        |
     |-- error! --------->|                        |
     |                    |-- enqueue(entry) -->   |
     |                    |                        |
     |                    |  [auto-retry after     |
     |                    |   baseDelay * 2^N]     |
     |                    |                        |
     |<-- retry(agent) --|                        |
     |-- error! --------->|                        |
     |                    |-- increment retryCount |
     |                    |                        |
     |                    |  [backoff: 2s]         |
     |                    |                        |
     |<-- retry(agent) --|                        |
     |-- success! ------->|                        |
     |                    |-- delete entry ------> |
     |                    |                        |
     |  OR after maxRetries:                       |
     |                    |-- metrics.exhausted++  |
     |                    |                        |
     |                    |<--- list() ------------|
     |                    |--- entries[] ---------->|
     |                    |                        |
     |                    |<--- replay(modified) --|
     |<-- replay(agent) --|                        |
     |-- success -------->|                        |
     |                    |-- delete entry         |
```

---

## 15. File Structure

### New Files

```
packages/forgeagent-agent/src/
  orchestration/
    orchestrator.ts                          # MODIFY: fix supervisor, add contractNet/blackboard/quorum
    contract-net/
      contract-net-types.ts                  # NEW: CFP, Bid, Award, Result types
      contract-net-manager.ts                # NEW: Full CNP lifecycle
      bid-strategies.ts                      # NEW: lowest-cost, fastest, weighted
      index.ts                               # NEW: barrel export
    topology/
      topology-types.ts                      # NEW: TopologyType, TaskCharacteristics, metrics
      topology-analyzer.ts                   # NEW: Heuristic topology selection
      topology-executor.ts                   # NEW: Execute with auto-selected topology
      index.ts                               # NEW: barrel export
    blackboard/
      blackboard-types.ts                    # NEW: Blackboard, KnowledgeSource, ControlComponent
      in-memory-blackboard.ts                # NEW: InMemoryBlackboard
      priority-control.ts                    # NEW: PriorityControlComponent
      blackboard-runner.ts                   # NEW: Session runner
      knowledge-source-factory.ts            # NEW: Helper to create KnowledgeSources
      index.ts                               # NEW: barrel export
    consensus/
      quorum-types.ts                        # NEW: Vote, VotingStrategy, QuorumResult
      quorum-manager.ts                      # NEW: N-of-M voting
      index.ts                               # NEW: barrel export
    debate/
      debate-types.ts                        # NEW: DebatePosition, JudgeEvaluation, ConvergenceState
      multi-round-debate.ts                  # NEW: Enhanced multi-round debate
      index.ts                               # NEW: barrel export
    tournament/
      tournament-types.ts                    # NEW: TournamentEntry, TournamentScorer, TournamentResult
      tournament-runner.ts                   # NEW: Competitive execution
      builtin-scorers.ts                     # NEW: length, cost, speed, LLM judge scorers
      index.ts                               # NEW: barrel export
    timeout/
      cascading-timeout.ts                   # NEW: TimeoutBudget, createTimeoutBudget
      index.ts                               # NEW: barrel export
    dlq/
      dead-letter-types.ts                   # NEW: DeadLetterEntry, RetryPolicy, DLQMetrics
      in-memory-dlq.ts                       # NEW: InMemoryDeadLetterQueue
      index.ts                               # NEW: barrel export
  workflow/
    workflow-persistence-types.ts             # NEW: WorkflowCheckpoint, WorkflowStore
    in-memory-workflow-store.ts              # NEW: InMemoryWorkflowStore
    workflow-migration.ts                    # NEW: Schema versioning
  agent/
    dzip-agent.ts                           # MODIFY: add agentConfig getter
```

### Modified Files

```
packages/forgeagent-agent/src/
  orchestration/
    orchestrator.ts                          # Fix supervisor, add static methods
    index.ts                                 # Re-export new modules
  workflow/
    workflow-builder.ts                      # Add persistence + resume support
    index.ts                                 # Re-export persistence types
  index.ts                                   # Re-export all new modules
  agent/
    dzip-agent.ts                           # Add agentConfig getter
```

### Estimated LOC

| Component | New Files | ~LOC |
|-----------|-----------|------|
| F1: Supervisor fix | 0 (modify) | ~80 |
| F2: Contract-net | 4 | ~450 |
| F3: Dynamic topology | 4 | ~350 |
| F4: Blackboard | 6 | ~400 |
| F5: Workflow persistence | 3 | ~250 |
| F6: Quorum consensus | 3 | ~350 |
| F7: Cascading timeouts | 2 | ~120 |
| F8: Dead-letter queue | 3 | ~250 |
| F9: Multi-round debate | 3 | ~350 |
| F10: Agent tournament | 4 | ~300 |
| **Total** | **~32 files** | **~2,900 LOC** |

---

## 16. Testing Strategy

### Unit Tests

Each new module gets its own test file. Tests use the `MockChatModel` from `@dzipagent/test-utils` (or inline mocks until that package exists).

```
packages/forgeagent-agent/src/__tests__/
  contract-net.test.ts          # CFP lifecycle, bid parsing, strategy evaluation
  topology-analyzer.test.ts     # Scoring correctness for each topology
  blackboard.test.ts            # InMemoryBlackboard CRUD, event emission
  blackboard-runner.test.ts     # Session convergence, max activations, timeout
  quorum.test.ts                # Majority/unanimous/weighted voting
  cascading-timeout.test.ts     # Budget splitting, expiration, cancellation
  dead-letter-queue.test.ts     # Enqueue, retry with backoff, purge
  multi-round-debate.test.ts    # Convergence detection, rubric scoring
  tournament.test.ts            # Ranking, concurrent execution, cost tracking
  workflow-persistence.test.ts  # Checkpoint save/load, resume, migration
  supervisor-wiring.test.ts     # Specialist tools actually invoked by manager
```

### Multi-Agent Simulation Tests

Create a test harness that uses deterministic mock agents:

```typescript
// Test helper: mock agent that returns predictable responses
function createMockAgent(id: string, responses: Map<string, string>): DzipAgent {
  return new DzipAgent({
    id,
    instructions: 'mock',
    model: new MockChatModel({
      responses: (messages) => {
        const lastMsg = messages[messages.length - 1]
        const content = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
        // Match partial input to response
        for (const [key, value] of responses) {
          if (content.includes(key)) return value
        }
        return `Default response from ${id}`
      },
    }),
  })
}
```

### Failure Injection Tests

```typescript
describe('Contract-Net failure scenarios', () => {
  it('handles all bidders timing out', async () => {
    // Mock agents that never respond (or respond after deadline)
  })

  it('handles winner crashing during execution', async () => {
    // Mock agent that throws during generate()
  })

  it('retries on no bids when retryOnNoBids is true', async () => {
    // First round: no bids. Second round: one bid.
  })
})

describe('Blackboard failure scenarios', () => {
  it('continues when a knowledge source throws', async () => {
    // Source that throws -- others should still execute
  })

  it('respects maxActivations limit', async () => {
    // Sources that never converge -- should stop at limit
  })
})

describe('Cascading timeout scenarios', () => {
  it('child aborts when parent is cancelled', async () => {
    const budget = createTimeoutBudget({ deadlineMs: 10_000 })
    const child = budget.createChild()
    budget.cancel()
    expect(child.signal.aborted).toBe(true)
  })

  it('splitEqual creates correct number of budgets', () => {
    const budget = createTimeoutBudget({ deadlineMs: 30_000 })
    const children = budget.splitEqual(3)
    expect(children).toHaveLength(3)
  })
})
```

### Performance Benchmarks

```typescript
describe('Orchestration performance', () => {
  it('contract-net with 10 agents completes within 5s (mock)', async () => {
    const agents = Array.from({ length: 10 }, (_, i) =>
      createMockAgent(`agent-${i}`, new Map()))

    const start = Date.now()
    await AgentOrchestrator.contractNet(agents, 'test task')
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('blackboard with 5 sources converges within 20 activations', async () => {
    // ...
  })
})
```

---

## 17. Implementation Roadmap

### Phase 1: Foundation (Week 1, ~10h)

| Task | Priority | Effort | Depends On |
|------|----------|--------|------------|
| F1: Fix supervisor wiring | P0 | 2h | None |
| F7: Cascading timeouts | P1 | 4h | None |
| `OrchestrationError` class | P0 | 0.5h | None |
| `DzipAgent.agentConfig` getter | P0 | 0.5h | None |
| Tests for F1 + F7 | P0 | 3h | F1, F7 |

### Phase 2: Core Patterns (Weeks 2-3, ~28h)

| Task | Priority | Effort | Depends On |
|------|----------|--------|------------|
| F2: Contract-net types + strategies | P1 | 4h | Phase 1 |
| F2: ContractNetManager | P1 | 6h | F2 types |
| F2: Tests | P1 | 2h | F2 |
| F4: Blackboard types + InMemoryBlackboard | P1 | 3h | None |
| F4: PriorityControl + BlackboardRunner | P1 | 4h | F4 types |
| F4: KnowledgeSourceFactory | P1 | 1h | F4 |
| F4: Tests | P1 | 2h | F4 |
| F5: Workflow persistence types + InMemoryStore | P1 | 3h | None |
| F5: CompiledWorkflow resume support | P1 | 3h | F5 types |
| F5: Tests | P1 | 2h | F5 |

### Phase 3: Decision Patterns (Weeks 3-4, ~22h)

| Task | Priority | Effort | Depends On |
|------|----------|--------|------------|
| F6: Quorum types + QuorumManager | P2 | 6h | None |
| F6: Tests | P2 | 2h | F6 |
| F9: Multi-round debate types + runner | P2 | 5h | None |
| F9: Tests | P2 | 1h | F9 |
| F8: Dead-letter queue types + InMemoryDLQ | P2 | 3h | None |
| F8: Tests | P2 | 1h | F8 |

### Phase 4: Advanced (Weeks 4-5, ~24h)

| Task | Priority | Effort | Depends On |
|------|----------|--------|------------|
| F3: Topology types + analyzer | P1 | 6h | Phase 2 |
| F3: TopologyExecutor (mesh + ring) | P1 | 6h | F3 types |
| F3: Dynamic switching | P1 | 4h | F3 executor |
| F3: Tests | P1 | 2h | F3 |
| F10: Tournament types + runner + scorers | P3 | 6h | None |
| F10: Tests | P3 | 2h | F10 |

### Total Estimated Effort

| Phase | Effort | Features |
|-------|--------|----------|
| Phase 1: Foundation | 10h | F1 (supervisor fix), F7 (timeouts) |
| Phase 2: Core Patterns | 28h | F2 (contract-net), F4 (blackboard), F5 (persistence) |
| Phase 3: Decision Patterns | 18h | F6 (quorum), F9 (debate), F8 (DLQ) |
| Phase 4: Advanced | 26h | F3 (topology), F10 (tournament) |
| **Total** | **82h** | **10 features** |

---

## ADR-004: Orchestration Pattern Architecture

### Status: Proposed

### Context

DzipAgent needs advanced multi-agent coordination patterns beyond the current sequential/parallel/supervisor/debate primitives. Research shows that architecture-task alignment determines success, and different tasks benefit from different coordination strategies.

### Decision

1. All new orchestration patterns live in `@dzipagent/agent/src/orchestration/` as subdirectories
2. Each pattern exposes types in a `*-types.ts` file and implementation in separate files
3. `AgentOrchestrator` gains new static methods as the unified entry point
4. Patterns are composable: they can be used standalone or as `WorkflowStep` in `WorkflowBuilder`
5. All patterns accept `AbortSignal` for cancellation and integrate with `DzipEventBus` for observability
6. Blackboard, DLQ, and WorkflowStore use the same interface/implementation split: interface in `@dzipagent/agent`, `InMemory*` in agent, `Postgres*` in `@dzipagent/server`
7. `DzipAgent` gains a public `agentConfig` getter to support cloning with additional tools

### Constraints

- Must not create `agent -> core` dependency violations (all core imports are already established)
- Must not break existing `AgentOrchestrator.sequential/parallel/debate` signatures
- All new types use TypeScript strict mode, no `any`
- InMemory implementations must work without any external dependencies
- Pattern types are exported from `@dzipagent/agent/index.ts` for consumer use

### Consequences

#### Positive
- 10 new orchestration patterns covering coordination, decision, topology, and infrastructure
- Contract-net enables cost-aware delegation at scale
- Blackboard enables token-efficient incremental refinement
- Workflow persistence enables crash recovery and long-running workflows
- Cascading timeouts prevent runaway agent hierarchies

#### Negative
- ~2,900 LOC added to `@dzipagent/agent` (roughly tripling its size)
- ~32 new files increase maintenance surface
- Some patterns (tournament, topology switching) may see limited adoption

#### Risks
- Bid parsing in contract-net is LLM-dependent; structured output would be more reliable
- Dynamic topology switching mid-execution is complex and may introduce subtle bugs
- Blackboard convergence detection is heuristic-based and may not work for all task types

### Alternatives Considered

1. **External orchestration library**: Using LangGraph directly for all patterns. Rejected because LangGraph's API is lower-level and our patterns add DzipAgent-specific budget/event integration.
2. **Plugin-based patterns**: Each pattern as a separate DzipPlugin. Rejected because patterns need deep integration with DzipAgent internals (tool binding, budget forking).
3. **Single-file monolith**: All patterns in one large file. Rejected for maintainability.

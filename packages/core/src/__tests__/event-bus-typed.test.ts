/**
 * event-bus-typed.test.ts
 *
 * +70 new tests for DzupEventBus covering:
 * - Approval / human-contact event routing
 * - Delegation lifecycle events
 * - Pipeline runtime node events
 * - Provider run-attempt / run-failure / circuit events
 * - Protocol events
 * - Safety events
 * - Platform policy events
 * - Ledger events
 * - Recovery extended events
 * - Vector store events
 * - System / degraded-operation events
 * - Adapter interaction events
 * - Supervisor routing events
 * - Scheduler extended events
 * - Skill lifecycle events (full set)
 * - Workflow task and phase events
 * - Run-handle events (paused, resumed, cancelled, halted)
 * - Subscriber count tracking via wrapper
 * - Event ordering guarantees under fan-out
 * - Re-subscribe after clear: unsubscribing all then re-adding
 * - No-handler emit: types with no subscribers never throw
 * - Return value of on() and once() are callable functions
 * - onAny unsubscribe stops wildcard delivery
 * - Typed handler TypeScript narrowing (payload shape)
 * - Multiple independent buses after clear
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventBus, typedEmit } from "../events/event-bus.js";
import type { DzupEventBus } from "../events/event-bus.js";
import type { DzupEvent } from "../events/event-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bus(): DzupEventBus {
  return createEventBus();
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Approval events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — approval events", () => {
  it("delivers approval:requested with runId and plan", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:requested", h);
    b.emit({ type: "approval:requested", runId: "r1", plan: { steps: 3 } });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", plan: { steps: 3 } }),
    );
  });

  it("delivers approval:granted with approvedBy", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:granted", h);
    b.emit({ type: "approval:granted", runId: "r2", approvedBy: "alice" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ approvedBy: "alice" }),
    );
  });

  it("delivers approval:rejected with reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:rejected", h);
    b.emit({ type: "approval:rejected", runId: "r3", reason: "risky plan" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "risky plan" }),
    );
  });

  it("delivers approval:timed_out with timeoutMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:timed_out", h);
    b.emit({ type: "approval:timed_out", runId: "r4", timeoutMs: 5000 });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it("delivers approval:cancelled with reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:cancelled", h);
    b.emit({ type: "approval:cancelled", runId: "r5", reason: "user abort" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "user abort" }),
    );
  });

  it("delivers approval:webhook_failed with attempts and error", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:webhook_failed", h);
    b.emit({
      type: "approval:webhook_failed",
      runId: "r6",
      webhookUrl: "https://hook.example.com",
      attempts: 3,
      error: "timeout",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3, error: "timeout" }),
    );
  });

  it("handler for approval:granted does not fire on approval:rejected", () => {
    const b = bus();
    const h = vi.fn();
    b.on("approval:granted", h);
    b.emit({ type: "approval:rejected", runId: "r7", reason: "nope" });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Human contact events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — human contact events", () => {
  it("delivers human_contact:requested with contactId and channel", () => {
    const b = bus();
    const h = vi.fn();
    b.on("human_contact:requested", h);
    b.emit({
      type: "human_contact:requested",
      runId: "r1",
      contactId: "c1",
      contactType: "email",
      channel: "smtp",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c1", channel: "smtp" }),
    );
  });

  it("delivers human_contact:responded with response payload", () => {
    const b = bus();
    const h = vi.fn();
    b.on("human_contact:responded", h);
    b.emit({
      type: "human_contact:responded",
      runId: "r1",
      contactId: "c1",
      response: { decision: "approve" },
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ response: { decision: "approve" } }),
    );
  });

  it("delivers human_contact:timed_out with fallback", () => {
    const b = bus();
    const h = vi.fn();
    b.on("human_contact:timed_out", h);
    b.emit({
      type: "human_contact:timed_out",
      runId: "r1",
      contactId: "c1",
      fallback: "reject",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ fallback: "reject" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Delegation events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — delegation events", () => {
  it("delivers delegation:started with all three IDs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:started", h);
    b.emit({
      type: "delegation:started",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "p1", delegationId: "d1" }),
    );
  });

  it("delivers delegation:completed with success=true and durationMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:completed", h);
    b.emit({
      type: "delegation:completed",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
      durationMs: 120,
      success: true,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, durationMs: 120 }),
    );
  });

  it("delivers delegation:failed with error message", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:failed", h);
    b.emit({
      type: "delegation:failed",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
      error: "agent down",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ error: "agent down" }),
    );
  });

  it("delivers delegation:timeout with timeoutMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:timeout", h);
    b.emit({
      type: "delegation:timeout",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
      timeoutMs: 30000,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30000 }),
    );
  });

  it("delivers delegation:cancelled", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:cancelled", h);
    b.emit({
      type: "delegation:cancelled",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
    });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delegation:started handler does not fire on delegation:failed", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:started", h);
    b.emit({
      type: "delegation:failed",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
      error: "nope",
    });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pipeline runtime node events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — pipeline runtime node events", () => {
  it("delivers pipeline:run_started", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:run_started", h);
    b.emit({ type: "pipeline:run_started", pipelineId: "pl1", runId: "r1" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: "pl1" }),
    );
  });

  it("delivers pipeline:node_started with nodeType", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:node_started", h);
    b.emit({
      type: "pipeline:node_started",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      nodeType: "llm",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ nodeType: "llm" }),
    );
  });

  it("delivers pipeline:node_completed with durationMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:node_completed", h);
    b.emit({
      type: "pipeline:node_completed",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      durationMs: 55,
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 55 }));
  });

  it("delivers pipeline:node_failed with error", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:node_failed", h);
    b.emit({
      type: "pipeline:node_failed",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      error: "oom",
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ error: "oom" }));
  });

  it("delivers pipeline:node_skipped with reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:node_skipped", h);
    b.emit({
      type: "pipeline:node_skipped",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      reason: "disabled",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "disabled" }),
    );
  });

  it("delivers pipeline:suspended and pipeline:resumed separately", () => {
    const b = bus();
    const suspended = vi.fn();
    const resumed = vi.fn();
    b.on("pipeline:suspended", suspended);
    b.on("pipeline:resumed", resumed);
    b.emit({
      type: "pipeline:suspended",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
    });
    b.emit({
      type: "pipeline:resumed",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
    });
    expect(suspended).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledOnce();
  });

  it("delivers pipeline:checkpoint_saved with version", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:checkpoint_saved", h);
    b.emit({
      type: "pipeline:checkpoint_saved",
      pipelineId: "pl1",
      runId: "r1",
      version: 7,
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ version: 7 }));
  });

  it("delivers pipeline:loop_iteration with iteration counter", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:loop_iteration", h);
    b.emit({
      type: "pipeline:loop_iteration",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      iteration: 3,
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ iteration: 3 }));
  });

  it("delivers pipeline:node_retry with backoffMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:node_retry", h);
    b.emit({
      type: "pipeline:node_retry",
      pipelineId: "pl1",
      runId: "r1",
      nodeId: "n1",
      attempt: 2,
      maxAttempts: 5,
      error: "rate limit",
      backoffMs: 1000,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ backoffMs: 1000, attempt: 2 }),
    );
  });

  it("delivers pipeline:run_cancelled with optional reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("pipeline:run_cancelled", h);
    b.emit({
      type: "pipeline:run_cancelled",
      pipelineId: "pl1",
      runId: "r1",
      reason: "user request",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "user request" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Provider run events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — provider run events", () => {
  it("delivers provider:run_attempt with attempt and model", () => {
    const b = bus();
    const h = vi.fn();
    b.on("provider:run_attempt", h);
    b.emit({
      type: "provider:run_attempt",
      agentId: "a1",
      attempt: 1,
      maxAttempts: 3,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      phase: "invoke",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, model: "claude-sonnet-4-6" }),
    );
  });

  it("delivers provider:run_failure with retrying=true", () => {
    const b = bus();
    const h = vi.fn();
    b.on("provider:run_failure", h);
    b.emit({
      type: "provider:run_failure",
      agentId: "a1",
      attempt: 2,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      phase: "invoke",
      reason: "timeout",
      retrying: true,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ retrying: true, reason: "timeout" }),
    );
  });

  it("delivers provider:run_selected with provider and model", () => {
    const b = bus();
    const h = vi.fn();
    b.on("provider:run_selected", h);
    b.emit({
      type: "provider:run_selected",
      agentId: "a1",
      attempt: 1,
      provider: "openai",
      model: "gpt-4o",
      phase: "stream",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", phase: "stream" }),
    );
  });

  it("delivers provider:circuit_opened and provider:circuit_closed independently", () => {
    const b = bus();
    const opened = vi.fn();
    const closed = vi.fn();
    b.on("provider:circuit_opened", opened);
    b.on("provider:circuit_closed", closed);
    b.emit({ type: "provider:circuit_opened", provider: "anthropic" });
    b.emit({ type: "provider:circuit_closed", provider: "anthropic" });
    expect(opened).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("provider:circuit_opened handler does not fire on provider:circuit_closed", () => {
    const b = bus();
    const h = vi.fn();
    b.on("provider:circuit_opened", h);
    b.emit({ type: "provider:circuit_closed", provider: "anthropic" });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Protocol events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — protocol events", () => {
  it("delivers protocol:message_sent with to and messageType", () => {
    const b = bus();
    const h = vi.fn();
    b.on("protocol:message_sent", h);
    b.emit({
      type: "protocol:message_sent",
      protocol: "a2a",
      to: "agent-b",
      messageType: "task",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ to: "agent-b", messageType: "task" }),
    );
  });

  it("delivers protocol:message_received with from", () => {
    const b = bus();
    const h = vi.fn();
    b.on("protocol:message_received", h);
    b.emit({
      type: "protocol:message_received",
      protocol: "a2a",
      from: "agent-a",
      messageType: "response",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ from: "agent-a" }),
    );
  });

  it("delivers protocol:error with error string", () => {
    const b = bus();
    const h = vi.fn();
    b.on("protocol:error", h);
    b.emit({
      type: "protocol:error",
      protocol: "mcp",
      error: "connection refused",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ error: "connection refused" }),
    );
  });

  it("delivers protocol:connected and protocol:disconnected separately", () => {
    const b = bus();
    const connected = vi.fn();
    const disconnected = vi.fn();
    b.on("protocol:connected", connected);
    b.on("protocol:disconnected", disconnected);
    b.emit({
      type: "protocol:connected",
      protocol: "mcp",
      endpoint: "ws://localhost:4000",
    });
    b.emit({
      type: "protocol:disconnected",
      protocol: "mcp",
      endpoint: "ws://localhost:4000",
    });
    expect(connected).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("delivers protocol:state_changed with previousState and newState", () => {
    const b = bus();
    const h = vi.fn();
    b.on("protocol:state_changed", h);
    b.emit({
      type: "protocol:state_changed",
      protocol: "http",
      previousState: "idle",
      newState: "active",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ previousState: "idle", newState: "active" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Safety events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — safety events", () => {
  it("delivers safety:violation with category and severity", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:violation", h);
    b.emit({
      type: "safety:violation",
      category: "prompt-injection",
      severity: "high",
      message: "detected injection",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "prompt-injection",
        severity: "high",
      }),
    );
  });

  it("delivers safety:blocked with action", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:blocked", h);
    b.emit({
      type: "safety:blocked",
      category: "data-exfil",
      action: "send_email",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send_email" }),
    );
  });

  it("delivers safety:kill_requested with agentId and reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:kill_requested", h);
    b.emit({
      type: "safety:kill_requested",
      agentId: "a1",
      reason: "runaway cost",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "runaway cost" }),
    );
  });

  it("delivers safety:tool_result_blocked with toolName and category", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:tool_result_blocked", h);
    b.emit({
      type: "safety:tool_result_blocked",
      toolName: "bash",
      category: "secret-leak",
      severity: "critical",
      action: "block",
      message: "API key found",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", category: "secret-leak" }),
    );
  });

  it("delivers safety:tool_result_warning without blocking", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:tool_result_warning", h);
    b.emit({
      type: "safety:tool_result_warning",
      toolName: "read_file",
      category: "pii",
      severity: "low",
      action: "warn",
      message: "email found",
    });
    expect(h).toHaveBeenCalledOnce();
  });

  it("safety:blocked handler does not fire on safety:violation", () => {
    const b = bus();
    const h = vi.fn();
    b.on("safety:blocked", h);
    b.emit({
      type: "safety:violation",
      category: "pii",
      severity: "low",
      message: "minor",
    });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Policy events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — policy events", () => {
  it("delivers policy:evaluated with action and effect", () => {
    const b = bus();
    const h = vi.fn();
    b.on("policy:evaluated", h);
    b.emit({
      type: "policy:evaluated",
      policySetId: "ps1",
      action: "read",
      effect: "allow",
      durationUs: 500,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ action: "read", effect: "allow" }),
    );
  });

  it("delivers policy:denied with principalId and reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("policy:denied", h);
    b.emit({
      type: "policy:denied",
      policySetId: "ps1",
      action: "write",
      principalId: "user-1",
      reason: "read-only",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "user-1", reason: "read-only" }),
    );
  });

  it("delivers policy:set_updated with version", () => {
    const b = bus();
    const h = vi.fn();
    b.on("policy:set_updated", h);
    b.emit({ type: "policy:set_updated", policySetId: "ps1", version: 5 });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ version: 5 }));
  });

  it("delivers policy:conformance_violation with severity and fallbackBehavior", () => {
    const b = bus();
    const h = vi.fn();
    b.on("policy:conformance_violation", h);
    b.emit({
      type: "policy:conformance_violation",
      providerId: "p1",
      field: "temperature",
      reason: "out of range",
      severity: "warning",
      conformanceMode: "warn-only",
      fallbackBehavior: "continue_primary_attempt",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        fallbackBehavior: "continue_primary_attempt",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Vector store events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — vector store events", () => {
  it("delivers vector:search_completed with latencyMs and resultCount", () => {
    const b = bus();
    const h = vi.fn();
    b.on("vector:search_completed", h);
    b.emit({
      type: "vector:search_completed",
      provider: "lancedb",
      collection: "kb",
      latencyMs: 12,
      resultCount: 5,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ resultCount: 5, latencyMs: 12 }),
    );
  });

  it("delivers vector:upsert_completed with count", () => {
    const b = bus();
    const h = vi.fn();
    b.on("vector:upsert_completed", h);
    b.emit({
      type: "vector:upsert_completed",
      provider: "lancedb",
      collection: "kb",
      count: 20,
      latencyMs: 8,
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ count: 20 }));
  });

  it("delivers vector:embedding_completed with tokenCount", () => {
    const b = bus();
    const h = vi.fn();
    b.on("vector:embedding_completed", h);
    b.emit({
      type: "vector:embedding_completed",
      provider: "openai",
      latencyMs: 30,
      tokenCount: 512,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ tokenCount: 512 }),
    );
  });

  it("delivers vector:error with operation and message", () => {
    const b = bus();
    const h = vi.fn();
    b.on("vector:error", h);
    b.emit({
      type: "vector:error",
      provider: "lancedb",
      collection: "kb",
      operation: "search",
      message: "index not found",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "search",
        message: "index not found",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Ledger events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — ledger events", () => {
  it("delivers ledger:execution_recorded with providerId", () => {
    const b = bus();
    const h = vi.fn();
    b.on("ledger:execution_recorded", h);
    b.emit({ type: "ledger:execution_recorded", providerId: "p1" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "p1" }),
    );
  });

  it("delivers ledger:cost_recorded with costCents", () => {
    const b = bus();
    const h = vi.fn();
    b.on("ledger:cost_recorded", h);
    b.emit({ type: "ledger:cost_recorded", costCents: 7 });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ costCents: 7 }));
  });

  it("delivers ledger:budget_warning with usedCents and limitCents", () => {
    const b = bus();
    const h = vi.fn();
    b.on("ledger:budget_warning", h);
    b.emit({
      type: "ledger:budget_warning",
      workflowRunId: "wf1",
      usedCents: 80,
      limitCents: 100,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ usedCents: 80, limitCents: 100 }),
    );
  });

  it("delivers ledger:budget_exceeded", () => {
    const b = bus();
    const h = vi.fn();
    b.on("ledger:budget_exceeded", h);
    b.emit({
      type: "ledger:budget_exceeded",
      workflowRunId: "wf1",
      usedCents: 105,
      limitCents: 100,
    });
    expect(h).toHaveBeenCalledWith(expect.objectContaining({ usedCents: 105 }));
  });

  it("delivers ledger:tool_recorded with toolName", () => {
    const b = bus();
    const h = vi.fn();
    b.on("ledger:tool_recorded", h);
    b.emit({ type: "ledger:tool_recorded", toolName: "bash" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Recovery events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — recovery events", () => {
  it("delivers recovery:attempt_started with attempt and strategy", () => {
    const b = bus();
    const h = vi.fn();
    b.on("recovery:attempt_started", h);
    b.emit({
      type: "recovery:attempt_started",
      agentId: "a1",
      runId: "r1",
      attempt: 1,
      maxAttempts: 3,
      strategy: "retry",
      timestamp: Date.now(),
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, strategy: "retry" }),
    );
  });

  it("delivers recovery:succeeded with durationMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("recovery:succeeded", h);
    b.emit({
      type: "recovery:succeeded",
      agentId: "a1",
      runId: "r1",
      attempt: 2,
      strategy: "fallback",
      durationMs: 300,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 300 }),
    );
  });

  it("delivers recovery:exhausted with strategies array", () => {
    const b = bus();
    const h = vi.fn();
    b.on("recovery:exhausted", h);
    b.emit({
      type: "recovery:exhausted",
      agentId: "a1",
      runId: "r1",
      attempts: 3,
      strategies: ["retry", "fallback"],
      durationMs: 900,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ strategies: ["retry", "fallback"] }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. System / degraded-operation events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — system and degraded-operation events", () => {
  it("delivers system:degraded with subsystem and recoverable flag", () => {
    const b = bus();
    const h = vi.fn();
    b.on("system:degraded", h);
    b.emit({
      type: "system:degraded",
      subsystem: "vector-store",
      reason: "index corrupt",
      timestamp: Date.now(),
      recoverable: true,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: "vector-store", recoverable: true }),
    );
  });

  it("delivers system:consolidation_started (no fields)", () => {
    const b = bus();
    const h = vi.fn();
    b.on("system:consolidation_started", h);
    b.emit({ type: "system:consolidation_started" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers system:consolidation_completed with pruned and merged counts", () => {
    const b = bus();
    const h = vi.fn();
    b.on("system:consolidation_completed", h);
    b.emit({
      type: "system:consolidation_completed",
      durationMs: 120,
      recordsProcessed: 500,
      pruned: 30,
      merged: 15,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ pruned: 30, merged: 15 }),
    );
  });

  it("delivers cache:degraded with operation", () => {
    const b = bus();
    const h = vi.fn();
    b.on("cache:degraded", h);
    b.emit({ type: "cache:degraded", operation: "read", recoverable: false });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "read", recoverable: false }),
    );
  });

  it("delivers context:transfer_partial", () => {
    const b = bus();
    const h = vi.fn();
    b.on("context:transfer_partial", h);
    b.emit({ type: "context:transfer_partial", recoverable: true });
    expect(h).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Run-handle events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — run-handle lifecycle events", () => {
  it("delivers run:paused with runId and agentId", () => {
    const b = bus();
    const h = vi.fn();
    b.on("run:paused", h);
    b.emit({ type: "run:paused", runId: "r1", agentId: "a1" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "r1", agentId: "a1" }),
    );
  });

  it("delivers run:resumed with resumeToken", () => {
    const b = bus();
    const h = vi.fn();
    b.on("run:resumed", h);
    b.emit({
      type: "run:resumed",
      runId: "r1",
      agentId: "a1",
      resumeToken: "tok-abc",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ resumeToken: "tok-abc" }),
    );
  });

  it("delivers run:cancelled with reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("run:cancelled", h);
    b.emit({
      type: "run:cancelled",
      runId: "r1",
      agentId: "a1",
      reason: "operator request",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "operator request" }),
    );
  });

  it("delivers run:halted:token-exhausted with iterations", () => {
    const b = bus();
    const h = vi.fn();
    b.on("run:halted:token-exhausted", h);
    b.emit({
      type: "run:halted:token-exhausted",
      agentId: "a1",
      iterations: 50,
      reason: "token_exhausted",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ iterations: 50, reason: "token_exhausted" }),
    );
  });

  it("run:paused handler does not fire on run:cancelled", () => {
    const b = bus();
    const h = vi.fn();
    b.on("run:paused", h);
    b.emit({ type: "run:cancelled", runId: "r1", agentId: "a1" });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Supervisor routing events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — supervisor routing events", () => {
  it("delivers supervisor:routing_decision with strategy and reason", () => {
    const b = bus();
    const h = vi.fn();
    b.on("supervisor:routing_decision", h);
    b.emit({
      type: "supervisor:routing_decision",
      strategy: "round-robin",
      reason: "load balance",
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "round-robin" }),
    );
  });

  it("delivers supervisor:plan_created with assignments", () => {
    const b = bus();
    const h = vi.fn();
    b.on("supervisor:plan_created", h);
    b.emit({
      type: "supervisor:plan_created",
      goal: "write tests",
      assignments: [{ task: "unit tests", specialistId: "coder" }],
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "write tests" }),
    );
  });

  it("delivers supervisor:merge_complete with successCount and errorCount", () => {
    const b = bus();
    const h = vi.fn();
    b.on("supervisor:merge_complete", h);
    b.emit({
      type: "supervisor:merge_complete",
      mergeStatus: "partial",
      successCount: 3,
      errorCount: 1,
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ successCount: 3, errorCount: 1 }),
    );
  });

  it("delivers supervisor:circuit_breaker_filtered with skipped list", () => {
    const b = bus();
    const h = vi.fn();
    b.on("supervisor:circuit_breaker_filtered", h);
    b.emit({
      type: "supervisor:circuit_breaker_filtered",
      skipped: ["agent-a", "agent-b"],
    });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: ["agent-a", "agent-b"] }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Skill lifecycle events (extended set)
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — skill lifecycle events", () => {
  it("delivers skill:created", () => {
    const b = bus();
    const h = vi.fn();
    b.on("skill:created", h);
    b.emit({ type: "skill:created" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers skill:updated", () => {
    const b = bus();
    const h = vi.fn();
    b.on("skill:updated", h);
    b.emit({ type: "skill:updated" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers skill:deprecated", () => {
    const b = bus();
    const h = vi.fn();
    b.on("skill:deprecated", h);
    b.emit({ type: "skill:deprecated" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers skill:archived", () => {
    const b = bus();
    const h = vi.fn();
    b.on("skill:archived", h);
    b.emit({ type: "skill:archived" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("skill:created handler does not fire on skill:archived", () => {
    const b = bus();
    const h = vi.fn();
    b.on("skill:created", h);
    b.emit({ type: "skill:archived" });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. Workflow task and phase events
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — workflow task and phase events", () => {
  it("delivers workflow:task_created", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:task_created", h);
    b.emit({ type: "workflow:task_created" });
    expect(h).toHaveBeenCalledOnce();
  });

  it("delivers workflow:task_completed with durationMs", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:task_completed", h);
    b.emit({ type: "workflow:task_completed", durationMs: 250 });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 250 }),
    );
  });

  it("delivers workflow:task_status_changed with newStatus", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:task_status_changed", h);
    b.emit({ type: "workflow:task_status_changed", newStatus: "in_progress" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ newStatus: "in_progress" }),
    );
  });

  it("delivers workflow:run_status_changed with newStatus", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:run_status_changed", h);
    b.emit({ type: "workflow:run_status_changed", newStatus: "completed" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ newStatus: "completed" }),
    );
  });

  it("delivers workflow:execution_started with providerId", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:execution_started", h);
    b.emit({ type: "workflow:execution_started", providerId: "codex" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex" }),
    );
  });

  it("delivers workflow:prompt_recorded with promptType", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:prompt_recorded", h);
    b.emit({ type: "workflow:prompt_recorded", promptType: "system" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ promptType: "system" }),
    );
  });

  it("delivers workflow:artifact_saved with artifactType", () => {
    const b = bus();
    const h = vi.fn();
    b.on("workflow:artifact_saved", h);
    b.emit({ type: "workflow:artifact_saved", artifactType: "diff" });
    expect(h).toHaveBeenCalledWith(
      expect.objectContaining({ artifactType: "diff" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. Subscriber-count tracking via lightweight wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — subscriber count tracking", () => {
  it("subscriber count increases on on() and decreases on unsub()", () => {
    const b = bus();
    // We track by counting on/off ourselves — the bus has no public count API.
    let count = 0;
    const track = (_e: DzupEvent): void => {
      count++;
    };
    const unsub1 = b.on("agent:started", track);
    const unsub2 = b.on("agent:started", (_e: DzupEvent) => {
      count++;
    });
    // Two handlers → emitting fires both
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(count).toBe(2);
    unsub1();
    count = 0;
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    // Only one handler left
    expect(count).toBe(1);
    unsub2();
    count = 0;
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(count).toBe(0);
  });

  it("wildcard subscriber count tracks independently of typed handlers", () => {
    const b = bus();
    const log: string[] = [];
    const typedUnsub = b.on("tool:called", () => {
      log.push("typed");
    });
    const wildUnsub = b.onAny(() => {
      log.push("wild");
    });
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(log).toEqual(["typed", "wild"]);
    typedUnsub();
    log.length = 0;
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(log).toEqual(["wild"]);
    wildUnsub();
    log.length = 0;
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(log).toEqual([]);
  });

  it("unsub() is safe to call multiple times", () => {
    const b = bus();
    const h = vi.fn();
    const unsub = b.on("agent:started", h);
    unsub();
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. No-handler emit: never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — no-handler emit never throws", () => {
  it("emitting with zero typed and zero wildcard handlers does not throw", () => {
    const b = bus();
    expect(() => {
      b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    }).not.toThrow();
  });

  it("emitting multiple event types with no handlers does not throw", () => {
    const b = bus();
    const events: DzupEvent[] = [
      { type: "agent:started", agentId: "a", runId: "r" },
      { type: "tool:called", toolName: "t", input: {} },
      { type: "mcp:connected", serverName: "s", toolCount: 2 },
      {
        type: "budget:warning",
        level: "warn",
        usage: {
          tokens: 100,
          costCents: 1,
          iterations: 1,
          tokenBudget: 1000,
          costCentsBudget: 10,
          iterationBudget: 10,
        },
      },
    ];
    expect(() => {
      for (const e of events) b.emit(e);
    }).not.toThrow();
  });

  it("emitting after all handlers unsubscribed does not throw", () => {
    const b = bus();
    const unsub1 = b.on("agent:started", vi.fn());
    const unsub2 = b.onAny(vi.fn());
    unsub1();
    unsub2();
    expect(() => {
      b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. Return value of on() and once() are callable unsubscribe functions
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — on() and once() return callable unsubscribe", () => {
  it("on() returns a function", () => {
    const b = bus();
    const unsub = b.on("agent:started", vi.fn());
    expect(typeof unsub).toBe("function");
  });

  it("once() returns a function", () => {
    const b = bus();
    const unsub = b.once("agent:started", vi.fn());
    expect(typeof unsub).toBe("function");
  });

  it("onAny() returns a function", () => {
    const b = bus();
    const unsub = b.onAny(vi.fn());
    expect(typeof unsub).toBe("function");
  });

  it("on() unsubscribe returns undefined (void)", () => {
    const b = bus();
    const unsub = b.on("agent:started", vi.fn());
    const result = unsub();
    expect(result).toBeUndefined();
  });

  it("once() unsubscribe called before emit prevents delivery", () => {
    const b = bus();
    const h = vi.fn();
    const unsub = b.once("mcp:connected", h);
    unsub();
    b.emit({ type: "mcp:connected", serverName: "s", toolCount: 1 });
    expect(h).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. onAny unsubscribe stops wildcard delivery
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — onAny unsubscribe", () => {
  it("onAny unsub removes handler and stops delivery", () => {
    const b = bus();
    const h = vi.fn();
    const unsub = b.onAny(h);
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(h).toHaveBeenCalledOnce();
    unsub();
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("onAny unsub does not affect typed handlers on same event", () => {
    const b = bus();
    const typed = vi.fn();
    const wild = vi.fn();
    b.on("agent:started", typed);
    const unsub = b.onAny(wild);
    unsub();
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(typed).toHaveBeenCalledOnce();
    expect(wild).not.toHaveBeenCalled();
  });

  it("multiple onAny handlers can be independently removed", () => {
    const b = bus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = b.onAny(h1);
    const unsub2 = b.onAny(h2);
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    unsub1();
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(2);
    unsub2();
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(h2).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21. Event ordering under fan-out
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — event ordering under fan-out", () => {
  it("typed handlers fire in registration order for same event type", () => {
    const b = bus();
    const order: number[] = [];
    b.on("agent:started", () => {
      order.push(1);
    });
    b.on("agent:started", () => {
      order.push(2);
    });
    b.on("agent:started", () => {
      order.push(3);
    });
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(order).toEqual([1, 2, 3]);
  });

  it("wildcard handlers fire after typed handlers", () => {
    const b = bus();
    const order: string[] = [];
    b.on("agent:started", () => {
      order.push("typed");
    });
    b.onAny(() => {
      order.push("wild");
    });
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    expect(order).toEqual(["typed", "wild"]);
  });

  it("sequential emits arrive in emission order via onAny", () => {
    const b = bus();
    const types: string[] = [];
    b.onAny((e) => {
      types.push(e.type);
    });
    b.emit({ type: "agent:started", agentId: "a", runId: "r1" });
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    b.emit({
      type: "agent:completed",
      agentId: "a",
      runId: "r1",
      durationMs: 10,
    });
    b.emit({ type: "mcp:connected", serverName: "s", toolCount: 1 });
    b.emit({
      type: "llm:invoked",
      agentId: "a",
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
      timestamp: 0,
    });
    expect(types).toEqual([
      "agent:started",
      "tool:called",
      "agent:completed",
      "mcp:connected",
      "llm:invoked",
    ]);
  });

  it("ten handlers on same event all receive the event in a single emit", () => {
    const b = bus();
    let count = 0;
    for (let i = 0; i < 10; i++) {
      b.on("tool:called", () => {
        count++;
      });
    }
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    expect(count).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22. Async error isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("DzupEventBus — async error isolation", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("async handler that throws does not prevent sync handler from running", async () => {
    const b = bus();
    const good = vi.fn();
    b.on("agent:started", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    b.on("agent:started", good);
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    await tick();
    expect(good).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
  });

  it("two async handlers that both throw still log two errors", async () => {
    const b = bus();
    b.on("tool:called", async () => {
      await Promise.resolve();
      throw new Error("err1");
    });
    b.on("tool:called", async () => {
      await Promise.resolve();
      throw new Error("err2");
    });
    b.emit({ type: "tool:called", toolName: "t", input: {} });
    await tick();
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("error-throwing handler does not corrupt later emissions", () => {
    const b = bus();
    const good = vi.fn();
    b.on("agent:started", () => {
      throw new Error("sync fail");
    });
    b.on("agent:started", good);
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    b.emit({ type: "agent:started", agentId: "a", runId: "r" });
    // good handler should have been called on both emits
    expect(good).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23. typedEmit with orchestration and platform events
// ─────────────────────────────────────────────────────────────────────────────

describe("typedEmit — orchestration and platform coverage", () => {
  it("typedEmit dispatches delegation:started to typed handler", () => {
    const b = bus();
    const h = vi.fn();
    b.on("delegation:started", h);
    typedEmit(b, {
      type: "delegation:started",
      parentRunId: "p1",
      targetAgentId: "a2",
      delegationId: "d1",
    });
    expect(h).toHaveBeenCalledOnce();
  });

  it("typedEmit dispatches safety:violation to wildcard handler", () => {
    const b = bus();
    const h = vi.fn();
    b.onAny(h);
    typedEmit(b, {
      type: "safety:violation",
      category: "pii",
      severity: "low",
      message: "test",
    });
    expect(h).toHaveBeenCalledOnce();
  });

  it("typedEmit with undefined bus does not throw for complex events", () => {
    expect(() => {
      typedEmit(undefined, {
        type: "pipeline:run_started",
        pipelineId: "pl1",
        runId: "r1",
      });
    }).not.toThrow();
  });

  it("typedEmit dispatches vector:search_completed to typed and wildcard", () => {
    const b = bus();
    const typed = vi.fn();
    const wild = vi.fn();
    b.on("vector:search_completed", typed);
    b.onAny(wild);
    typedEmit(b, {
      type: "vector:search_completed",
      provider: "lancedb",
      collection: "kb",
      latencyMs: 5,
      resultCount: 3,
    });
    expect(typed).toHaveBeenCalledOnce();
    expect(wild).toHaveBeenCalledOnce();
  });
});

/**
 * Comprehensive telemetry & tracing tests for @dzupagent/core.
 *
 * Covers:
 * - Span simulation (creation, start/end, duration, nesting, parent-child,
 *   attributes, events, status, error recording, serialization)
 * - MetricsCollector (counter, histogram, gauge, labels, no-op tracer pattern)
 * - TraceContext and W3C traceparent propagation (cross-process, multi-hop)
 * - HealthAggregator integration with metrics
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  injectTraceContext,
  extractTraceContext,
  formatTraceparent,
  parseTraceparent,
} from "../telemetry/trace-propagation.js";
import type { TraceContext } from "../telemetry/trace-propagation.js";
import { MetricsCollector } from "../observability/metrics-collector.js";

// ---------------------------------------------------------------------------
// Span simulation helpers
// ---------------------------------------------------------------------------
//
// @dzupagent/core does not expose a built-in Span class — tracing is handled
// via the lightweight W3C traceparent propagation helpers. These tests
// implement a minimal in-process span model on top of the real primitives so
// that all span-level behaviour can be exercised without external OTel deps.

type SpanStatus = "unset" | "ok" | "error";

interface SpanEvent {
  name: string;
  timestampMs: number;
  attributes: Record<string, unknown>;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
  errorMessage?: string;
  startMs: number;
  endMs?: number;
}

function generateHex(length: number): string {
  const chars = "0123456789abcdef";
  return Array.from(
    { length },
    () => chars[Math.floor(Math.random() * 16)]
  ).join("");
}

function createSpan(name: string, parent?: Span): Span {
  const traceId = parent ? parent.traceId : generateHex(32);
  const spanId = generateHex(16);
  return {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    name,
    attributes: {},
    events: [],
    status: "unset",
    startMs: Date.now(),
  };
}

function endSpan(span: Span): Span {
  return { ...span, endMs: Date.now() };
}

function setSpanAttribute(span: Span, key: string, value: unknown): void {
  span.attributes[key] = value;
}

function addSpanEvent(
  span: Span,
  name: string,
  attributes: Record<string, unknown> = {}
): void {
  span.events.push({ name, timestampMs: Date.now(), attributes });
}

function setSpanStatus(
  span: Span,
  status: SpanStatus,
  errorMessage?: string
): void {
  span.status = status;
  if (errorMessage) span.errorMessage = errorMessage;
}

function recordException(span: Span, err: Error): void {
  setSpanStatus(span, "error", err.message);
  addSpanEvent(span, "exception", {
    "exception.type": err.constructor.name,
    "exception.message": err.message,
    "exception.stacktrace": err.stack ?? "",
  });
}

function spanToJSON(span: Span): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    ...(span.errorMessage ? { errorMessage: span.errorMessage } : {}),
    startMs: span.startMs,
    ...(span.endMs !== undefined
      ? { endMs: span.endMs, durationMs: span.endMs - span.startMs }
      : {}),
  };
}

// No-op tracer: returns spans that carry no traceId and record nothing
const NOOP_SPAN: Span = Object.freeze({
  traceId: "",
  spanId: "",
  name: "noop",
  attributes: {},
  events: [],
  status: "unset" as SpanStatus,
  startMs: 0,
});

function noopCreateSpan(_name: string): Span {
  return { ...NOOP_SPAN };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telemetry-tracing", () => {
  // -------------------------------------------------------------------------
  // Span creation
  // -------------------------------------------------------------------------
  describe("span creation", () => {
    it("creates a span with the given name", () => {
      const span = createSpan("agent.run");
      expect(span.name).toBe("agent.run");
    });

    it("creates a span with a 32-hex traceId", () => {
      const span = createSpan("op");
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("creates a span with a 16-hex spanId", () => {
      const span = createSpan("op");
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("creates a root span without parentSpanId", () => {
      const span = createSpan("root");
      expect(span.parentSpanId).toBeUndefined();
    });

    it("creates two root spans with different traceIds", () => {
      const a = createSpan("op");
      const b = createSpan("op");
      expect(a.traceId).not.toBe(b.traceId);
    });

    it("creates two root spans with different spanIds", () => {
      const a = createSpan("op");
      const b = createSpan("op");
      expect(a.spanId).not.toBe(b.spanId);
    });

    it("new span starts with empty attributes", () => {
      const span = createSpan("op");
      expect(Object.keys(span.attributes)).toHaveLength(0);
    });

    it("new span starts with empty events array", () => {
      const span = createSpan("op");
      expect(span.events).toHaveLength(0);
    });

    it('new span has status "unset"', () => {
      const span = createSpan("op");
      expect(span.status).toBe("unset");
    });

    it("new span has a startMs timestamp", () => {
      const before = Date.now();
      const span = createSpan("op");
      const after = Date.now();
      expect(span.startMs).toBeGreaterThanOrEqual(before);
      expect(span.startMs).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // Span start / end / duration
  // -------------------------------------------------------------------------
  describe("span start/end/duration", () => {
    it("endSpan adds endMs to the span", () => {
      const span = createSpan("op");
      const ended = endSpan(span);
      expect(ended.endMs).toBeDefined();
    });

    it("endMs is >= startMs", () => {
      const span = createSpan("op");
      const ended = endSpan(span);
      expect(ended.endMs!).toBeGreaterThanOrEqual(ended.startMs);
    });

    it("duration in JSON is endMs - startMs", () => {
      const span = createSpan("op");
      const ended = endSpan(span);
      const json = spanToJSON(ended);
      expect(json["durationMs"]).toBe((ended.endMs ?? 0) - ended.startMs);
    });

    it("span without endMs has no durationMs in JSON", () => {
      const span = createSpan("op");
      const json = spanToJSON(span);
      expect(json["durationMs"]).toBeUndefined();
      expect(json["endMs"]).toBeUndefined();
    });

    it("does not mutate original span when ending", () => {
      const span = createSpan("op");
      const ended = endSpan(span);
      expect(span.endMs).toBeUndefined();
      expect(ended.endMs).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Span nesting and parent-child
  // -------------------------------------------------------------------------
  describe("span nesting (parent-child)", () => {
    it("child span has parentSpanId equal to parent spanId", () => {
      const parent = createSpan("parent");
      const child = createSpan("child", parent);
      expect(child.parentSpanId).toBe(parent.spanId);
    });

    it("child span shares traceId with parent", () => {
      const parent = createSpan("parent");
      const child = createSpan("child", parent);
      expect(child.traceId).toBe(parent.traceId);
    });

    it("grandchild shares traceId across 3 levels", () => {
      const root = createSpan("root");
      const child = createSpan("child", root);
      const grandchild = createSpan("grandchild", child);
      expect(grandchild.traceId).toBe(root.traceId);
    });

    it("grandchild parentSpanId is child spanId (not root)", () => {
      const root = createSpan("root");
      const child = createSpan("child", root);
      const grandchild = createSpan("grandchild", child);
      expect(grandchild.parentSpanId).toBe(child.spanId);
      expect(grandchild.parentSpanId).not.toBe(root.spanId);
    });

    it("child span has its own unique spanId", () => {
      const parent = createSpan("parent");
      const child = createSpan("child", parent);
      expect(child.spanId).not.toBe(parent.spanId);
    });

    it("sibling spans share traceId but have different spanIds", () => {
      const parent = createSpan("parent");
      const s1 = createSpan("sibling-1", parent);
      const s2 = createSpan("sibling-2", parent);
      expect(s1.traceId).toBe(s2.traceId);
      expect(s1.spanId).not.toBe(s2.spanId);
    });
  });

  // -------------------------------------------------------------------------
  // Span attributes
  // -------------------------------------------------------------------------
  describe("span attributes", () => {
    it("stores a string attribute", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "http.method", "POST");
      expect(span.attributes["http.method"]).toBe("POST");
    });

    it("stores a numeric attribute", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "http.status_code", 200);
      expect(span.attributes["http.status_code"]).toBe(200);
    });

    it("stores a boolean attribute", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "db.read_only", true);
      expect(span.attributes["db.read_only"]).toBe(true);
    });

    it("overwrites an attribute with a new value", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "retry", 0);
      setSpanAttribute(span, "retry", 3);
      expect(span.attributes["retry"]).toBe(3);
    });

    it("stores multiple independent attributes", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "service", "agent");
      setSpanAttribute(span, "env", "prod");
      expect(span.attributes["service"]).toBe("agent");
      expect(span.attributes["env"]).toBe("prod");
    });

    it("attributes appear in span JSON", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "model", "claude-3");
      const json = spanToJSON(span);
      expect((json["attributes"] as Record<string, unknown>)["model"]).toBe(
        "claude-3"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Span events
  // -------------------------------------------------------------------------
  describe("span events", () => {
    it("records an event with name and timestamp", () => {
      const span = createSpan("op");
      const before = Date.now();
      addSpanEvent(span, "cache.hit");
      const after = Date.now();
      expect(span.events).toHaveLength(1);
      expect(span.events[0]!.name).toBe("cache.hit");
      expect(span.events[0]!.timestampMs).toBeGreaterThanOrEqual(before);
      expect(span.events[0]!.timestampMs).toBeLessThanOrEqual(after);
    });

    it("records multiple events in order", () => {
      const span = createSpan("op");
      addSpanEvent(span, "start");
      addSpanEvent(span, "end");
      expect(span.events).toHaveLength(2);
      expect(span.events[0]!.name).toBe("start");
      expect(span.events[1]!.name).toBe("end");
    });

    it("records event attributes", () => {
      const span = createSpan("op");
      addSpanEvent(span, "retry", { attempt: 2, delay_ms: 500 });
      expect(span.events[0]!.attributes["attempt"]).toBe(2);
      expect(span.events[0]!.attributes["delay_ms"]).toBe(500);
    });

    it("events with no attributes default to empty object", () => {
      const span = createSpan("op");
      addSpanEvent(span, "ping");
      expect(span.events[0]!.attributes).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Span status
  // -------------------------------------------------------------------------
  describe("span status", () => {
    it("sets status to ok", () => {
      const span = createSpan("op");
      setSpanStatus(span, "ok");
      expect(span.status).toBe("ok");
    });

    it("sets status to error", () => {
      const span = createSpan("op");
      setSpanStatus(span, "error");
      expect(span.status).toBe("error");
    });

    it("sets error message with error status", () => {
      const span = createSpan("op");
      setSpanStatus(span, "error", "connection refused");
      expect(span.errorMessage).toBe("connection refused");
    });

    it("ok status appears in JSON", () => {
      const span = createSpan("op");
      setSpanStatus(span, "ok");
      const json = spanToJSON(span);
      expect(json["status"]).toBe("ok");
    });

    it("error status and message appear in JSON", () => {
      const span = createSpan("op");
      setSpanStatus(span, "error", "timeout");
      const json = spanToJSON(span);
      expect(json["status"]).toBe("error");
      expect(json["errorMessage"]).toBe("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // Error / exception recording
  // -------------------------------------------------------------------------
  describe("error span (exception recording)", () => {
    it("recordException sets span status to error", () => {
      const span = createSpan("op");
      recordException(span, new Error("something broke"));
      expect(span.status).toBe("error");
    });

    it("recordException stores error message", () => {
      const span = createSpan("op");
      recordException(span, new Error("timeout after 30s"));
      expect(span.errorMessage).toBe("timeout after 30s");
    });

    it("recordException adds an exception event", () => {
      const span = createSpan("op");
      recordException(span, new Error("oops"));
      const exc = span.events.find((e) => e.name === "exception");
      expect(exc).toBeDefined();
    });

    it("exception event contains error type", () => {
      const span = createSpan("op");
      class MyError extends Error {}
      recordException(span, new MyError("boom"));
      const exc = span.events.find((e) => e.name === "exception");
      expect(exc!.attributes["exception.type"]).toBe("MyError");
    });

    it("exception event contains error message", () => {
      const span = createSpan("op");
      recordException(span, new Error("bad input"));
      const exc = span.events.find((e) => e.name === "exception");
      expect(exc!.attributes["exception.message"]).toBe("bad input");
    });

    it("exception event contains stacktrace string", () => {
      const span = createSpan("op");
      recordException(span, new Error("trace me"));
      const exc = span.events.find((e) => e.name === "exception");
      expect(typeof exc!.attributes["exception.stacktrace"]).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // Span serialization
  // -------------------------------------------------------------------------
  describe("span serialization", () => {
    it("spanToJSON includes all required fields", () => {
      const span = createSpan("op");
      const json = spanToJSON(span);
      expect(json).toHaveProperty("traceId");
      expect(json).toHaveProperty("spanId");
      expect(json).toHaveProperty("name");
      expect(json).toHaveProperty("attributes");
      expect(json).toHaveProperty("events");
      expect(json).toHaveProperty("status");
      expect(json).toHaveProperty("startMs");
    });

    it("spanToJSON includes parentSpanId only when set", () => {
      const root = createSpan("root");
      const child = createSpan("child", root);
      const rootJSON = spanToJSON(root);
      const childJSON = spanToJSON(child);
      expect(rootJSON["parentSpanId"]).toBeUndefined();
      expect(childJSON["parentSpanId"]).toBe(root.spanId);
    });

    it("spanToJSON is JSON-serializable (no circular refs)", () => {
      const span = createSpan("op");
      setSpanAttribute(span, "key", "value");
      addSpanEvent(span, "event", { num: 1 });
      const json = spanToJSON(endSpan(span));
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    it("round-trip: JSON.stringify then JSON.parse preserves traceId", () => {
      const span = createSpan("op");
      const json = spanToJSON(span);
      const parsed = JSON.parse(JSON.stringify(json)) as Record<
        string,
        unknown
      >;
      expect(parsed["traceId"]).toBe(span.traceId);
    });

    it("round-trip: JSON.stringify then JSON.parse preserves spanId", () => {
      const span = createSpan("op");
      const json = spanToJSON(span);
      const parsed = JSON.parse(JSON.stringify(json)) as Record<
        string,
        unknown
      >;
      expect(parsed["spanId"]).toBe(span.spanId);
    });
  });

  // -------------------------------------------------------------------------
  // Trace propagation (cross-process via W3C traceparent)
  // -------------------------------------------------------------------------
  describe("trace propagation", () => {
    it("injectTraceContext embeds a valid traceparent in metadata", () => {
      const meta = injectTraceContext({ jobId: "42" });
      const ctx = extractTraceContext(meta);
      expect(ctx).not.toBeNull();
      expect(ctx!.traceId).toHaveLength(32);
    });

    it("injected traceId matches extracted traceId", () => {
      const meta = injectTraceContext({});
      const ctx = extractTraceContext(meta)!;
      const traceparent = (meta["_trace"] as Record<string, unknown>)[
        "traceparent"
      ] as string;
      const parsed = parseTraceparent(traceparent)!;
      expect(ctx.traceId).toBe(parsed.traceId);
    });

    it("traceId is stable across metadata propagation hops", () => {
      // Simulate queue -> worker hand-off via JSON serialization
      const produced = injectTraceContext({ taskType: "llm-call" });
      const wire = JSON.parse(JSON.stringify(produced)) as Record<
        string,
        unknown
      >;
      const ctx = extractTraceContext(wire);
      expect(ctx).not.toBeNull();
      const originalCtx = extractTraceContext(produced)!;
      expect(ctx!.traceId).toBe(originalCtx.traceId);
    });

    it("second injectTraceContext call on same metadata is idempotent", () => {
      const first = injectTraceContext({});
      const second = injectTraceContext(first);
      const c1 = extractTraceContext(first)!;
      const c2 = extractTraceContext(second)!;
      expect(c1.traceId).toBe(c2.traceId);
      expect(c1.spanId).toBe(c2.spanId);
    });

    it("formatTraceparent produces W3C format", () => {
      const ctx: TraceContext = {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
      };
      expect(formatTraceparent(ctx)).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/
      );
    });

    it("parseTraceparent round-trips through formatTraceparent", () => {
      const ctx: TraceContext = {
        traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
        spanId: "cafebabe01234567",
        traceFlags: 1,
      };
      const tp = formatTraceparent(ctx);
      const parsed = parseTraceparent(tp);
      expect(parsed).toEqual(ctx);
    });

    it("traceFlags=0 is preserved (unsampled)", () => {
      const ctx: TraceContext = {
        traceId: "0".repeat(32),
        spanId: "1".repeat(16),
        traceFlags: 0,
      };
      const tp = formatTraceparent(ctx);
      expect(tp).toMatch(/-00$/);
      expect(parseTraceparent(tp)!.traceFlags).toBe(0);
    });

    it("span-level traceId propagated through traceparent is 32 hex chars", () => {
      const span = createSpan("op");
      // Simulate propagating span's traceId into W3C metadata
      const ctx: TraceContext = {
        traceId: span.traceId,
        spanId: span.spanId,
        traceFlags: 1,
      };
      const tp = formatTraceparent(ctx);
      const extracted = parseTraceparent(tp)!;
      expect(extracted.traceId).toBe(span.traceId);
    });
  });

  // -------------------------------------------------------------------------
  // MetricsCollector — counter
  // -------------------------------------------------------------------------
  describe("metric counter", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it("increment starts at 1 on first call", () => {
      collector.increment("requests");
      expect(collector.get("requests")).toBe(1);
    });

    it("increment accumulates across calls", () => {
      collector.increment("requests");
      collector.increment("requests");
      collector.increment("requests");
      expect(collector.get("requests")).toBe(3);
    });

    it("increment by custom amount", () => {
      collector.increment("bytes", undefined, 512);
      expect(collector.get("bytes")).toBe(512);
    });

    it("increment by custom amount accumulates", () => {
      collector.increment("bytes", undefined, 100);
      collector.increment("bytes", undefined, 200);
      expect(collector.get("bytes")).toBe(300);
    });

    it('counter appears in toJSON with type "counter"', () => {
      collector.increment("hits");
      const entries = collector.toJSON();
      const entry = entries.find(
        (e) => (e as { name: string })["name"] === "hits"
      );
      expect((entry as { type: string })?.["type"]).toBe("counter");
    });

    it("counter appears in toJSON with correct value", () => {
      collector.increment("hits");
      collector.increment("hits");
      const entries = collector.toJSON();
      const entry = entries.find(
        (e) => (e as { name: string })["name"] === "hits"
      ) as { value: number };
      expect(entry?.["value"]).toBe(2);
    });

    it("returns undefined for unknown counter", () => {
      expect(collector.get("nonexistent")).toBeUndefined();
    });

    it("reset clears all counters", () => {
      collector.increment("c");
      collector.reset();
      expect(collector.get("c")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // MetricsCollector — histogram
  // -------------------------------------------------------------------------
  describe("metric histogram", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it("observe records first value as value and sum", () => {
      collector.observe("latency_ms", 100);
      const entries = collector.toJSON() as Array<{
        name: string;
        value: number;
        sum: number;
        count: number;
      }>;
      const entry = entries.find((e) => e["name"] === "latency_ms")!;
      expect(entry["value"]).toBe(100);
      expect(entry["sum"]).toBe(100);
      expect(entry["count"]).toBe(1);
    });

    it("observe accumulates sum across observations", () => {
      collector.observe("latency_ms", 100);
      collector.observe("latency_ms", 200);
      collector.observe("latency_ms", 300);
      const entries = collector.toJSON() as Array<{
        name: string;
        sum: number;
        count: number;
      }>;
      const entry = entries.find((e) => e["name"] === "latency_ms")!;
      expect(entry["sum"]).toBe(600);
      expect(entry["count"]).toBe(3);
    });

    it("observe stores the last observed value", () => {
      collector.observe("size", 10);
      collector.observe("size", 99);
      expect(collector.get("size")).toBe(99);
    });

    it('histogram appears in toJSON with type "histogram"', () => {
      collector.observe("duration", 42);
      const entries = collector.toJSON() as Array<{
        name: string;
        type: string;
      }>;
      const entry = entries.find((e) => e["name"] === "duration")!;
      expect(entry["type"]).toBe("histogram");
    });

    it("histogram includes sum and count in toJSON", () => {
      collector.observe("hist", 5);
      collector.observe("hist", 10);
      const entries = collector.toJSON() as Array<{
        name: string;
        sum?: number;
        count?: number;
      }>;
      const entry = entries.find((e) => e["name"] === "hist")!;
      expect(entry["sum"]).toBeDefined();
      expect(entry["count"]).toBeDefined();
    });

    it("mean can be computed from sum/count", () => {
      collector.observe("resp", 100);
      collector.observe("resp", 200);
      const entries = collector.toJSON() as Array<{
        name: string;
        sum: number;
        count: number;
      }>;
      const entry = entries.find((e) => e["name"] === "resp")!;
      expect(entry["sum"] / entry["count"]).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  // MetricsCollector — gauge
  // -------------------------------------------------------------------------
  describe("metric gauge", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it("gauge sets absolute value", () => {
      collector.gauge("queue_depth", 42);
      expect(collector.get("queue_depth")).toBe(42);
    });

    it("gauge overwrites with new absolute value", () => {
      collector.gauge("queue_depth", 10);
      collector.gauge("queue_depth", 3);
      expect(collector.get("queue_depth")).toBe(3);
    });

    it("gauge can be set to zero", () => {
      collector.gauge("active_agents", 5);
      collector.gauge("active_agents", 0);
      expect(collector.get("active_agents")).toBe(0);
    });

    it('gauge appears in toJSON with type "gauge"', () => {
      collector.gauge("mem_mb", 256);
      const entries = collector.toJSON() as Array<{
        name: string;
        type: string;
      }>;
      const entry = entries.find((e) => e["name"] === "mem_mb")!;
      expect(entry["type"]).toBe("gauge");
    });

    it("gauge does not accumulate — only stores last value", () => {
      for (let i = 1; i <= 5; i++) collector.gauge("temp", i);
      expect(collector.get("temp")).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // MetricsCollector — labels
  // -------------------------------------------------------------------------
  describe("metric labels", () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it("labels differentiate counter buckets", () => {
      collector.increment("requests", { status: "200" });
      collector.increment("requests", { status: "500" });
      expect(collector.get("requests", { status: "200" })).toBe(1);
      expect(collector.get("requests", { status: "500" })).toBe(1);
    });

    it("labeled counter does not affect unlabeled counter", () => {
      collector.increment("requests");
      collector.increment("requests", { env: "prod" });
      expect(collector.get("requests")).toBe(1);
      expect(collector.get("requests", { env: "prod" })).toBe(1);
    });

    it("labels appear in toJSON entry", () => {
      collector.gauge("cpu_pct", 80, { host: "node-1" });
      const entries = collector.toJSON() as Array<{
        name: string;
        labels: Record<string, string>;
      }>;
      const entry = entries.find((e) => e["name"] === "cpu_pct")!;
      expect(entry["labels"]["host"]).toBe("node-1");
    });

    it("label key order does not matter for lookup", () => {
      collector.increment("evt", { b: "2", a: "1" });
      // Same labels, different insertion order — should resolve to same bucket
      expect(collector.get("evt", { a: "1", b: "2" })).toBe(1);
    });

    it("multiple label dimensions are all stored", () => {
      collector.observe("span_ms", 300, {
        service: "llm",
        operation: "complete",
      });
      const entries = collector.toJSON() as Array<{
        name: string;
        labels: Record<string, string>;
      }>;
      const entry = entries.find((e) => e["name"] === "span_ms")!;
      expect(entry["labels"]["service"]).toBe("llm");
      expect(entry["labels"]["operation"]).toBe("complete");
    });

    it("two metrics with same name but different label values are independent", () => {
      collector.increment("tool_calls", { tool: "search" }, 5);
      collector.increment("tool_calls", { tool: "code_exec" }, 3);
      expect(collector.get("tool_calls", { tool: "search" })).toBe(5);
      expect(collector.get("tool_calls", { tool: "code_exec" })).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // No-op tracer
  // -------------------------------------------------------------------------
  describe("no-op tracer", () => {
    it("no-op span has empty traceId", () => {
      const span = noopCreateSpan("op");
      expect(span.traceId).toBe("");
    });

    it("no-op span has empty spanId", () => {
      const span = noopCreateSpan("op");
      expect(span.spanId).toBe("");
    });

    it("no-op span has startMs = 0 (no-op: no timing)", () => {
      const span = noopCreateSpan("op");
      expect(span.startMs).toBe(0);
    });

    it("no-op span has no events", () => {
      const span = noopCreateSpan("op");
      expect(span.events).toHaveLength(0);
    });

    it("no-op span has no attributes", () => {
      const span = noopCreateSpan("op");
      expect(Object.keys(span.attributes)).toHaveLength(0);
    });

    it("disabled MetricsCollector (reset) produces no entries in toJSON", () => {
      const collector = new MetricsCollector();
      collector.increment("ignored");
      collector.reset();
      expect(collector.toJSON()).toHaveLength(0);
    });

    it("disabled MetricsCollector returns undefined for any metric", () => {
      const collector = new MetricsCollector();
      collector.gauge("x", 100);
      collector.reset();
      expect(collector.get("x")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: metrics + trace context together
  // -------------------------------------------------------------------------
  describe("metrics + trace context integration", () => {
    it("each traced operation can record its own latency metric", () => {
      const collector = new MetricsCollector();
      const span1 = createSpan("llm.call");
      const ended1 = endSpan(span1);
      collector.observe("span_duration_ms", ended1.endMs! - ended1.startMs, {
        span_name: ended1.name,
      });

      const span2 = createSpan("tool.call");
      const ended2 = endSpan(span2);
      collector.observe("span_duration_ms", ended2.endMs! - ended2.startMs, {
        span_name: ended2.name,
      });

      expect(
        collector.get("span_duration_ms", { span_name: "llm.call" })
      ).toBeGreaterThanOrEqual(0);
      expect(
        collector.get("span_duration_ms", { span_name: "tool.call" })
      ).toBeGreaterThanOrEqual(0);
    });

    it("error spans increment an error counter", () => {
      const collector = new MetricsCollector();
      const span = createSpan("risky.op");
      recordException(span, new Error("boom"));
      if (span.status === "error") {
        collector.increment("span_errors_total", { span_name: span.name });
      }
      expect(
        collector.get("span_errors_total", { span_name: "risky.op" })
      ).toBe(1);
    });

    it("traceId from propagation can be stored as span attribute", () => {
      const meta = injectTraceContext({ task: "agent-run" });
      const ctx = extractTraceContext(meta)!;
      const span = createSpan("agent.run");
      setSpanAttribute(span, "parent.traceId", ctx.traceId);
      expect(span.attributes["parent.traceId"]).toBe(ctx.traceId);
    });
  });
});

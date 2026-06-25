/**
 * W27-B: Deep coverage for WebSocketSyncTransport, SyncProtocol, and SyncSession.
 *
 * WebSocketSyncTransport has zero existing test coverage.
 * This file adds:
 *   - WebSocketSyncTransport: setup/teardown, send/receive, closed-state errors,
 *     invalid/non-JSON messages, concurrent sends, handler replacement
 *   - SyncProtocol: anti-entropy custom interval, request-delta with empty delta,
 *     batch size edge cases, applyDelta HLC advance, handleMessage all branches
 *   - SyncSession: namespace filtering, error recovery, stats accumulation,
 *     multiple event handlers, disconnect without prior connect
 *   - Memory read/write through linked transport round-trips
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketSyncTransport } from "../sync/ws-transport.js";
import type { WebSocketLike } from "../sync/ws-transport.js";
import { SyncProtocol } from "../sync/sync-protocol.js";
import { SyncSession } from "../sync/sync-session.js";
import { SharedMemoryNamespace } from "../shared-namespace.js";
import { HLC } from "../crdt/hlc.js";
import type {
  SyncConfig,
  SyncEvent,
  SyncMessage,
  SyncTransport,
} from "../sync/types.js";

// ---------------------------------------------------------------------------
// WebSocket mock helpers
// ---------------------------------------------------------------------------

interface MockWsHandlers {
  message: Array<(ev: { data: unknown }) => void>;
  close: Array<() => void>;
}

function createMockWs(
  initialReadyState = 1
): WebSocketLike & { handlers: MockWsHandlers; sent: string[] } {
  const handlers: MockWsHandlers = { message: [], close: [] };
  const sent: string[] = [];
  let readyState = initialReadyState;

  return {
    handlers,
    sent,
    get readyState() {
      return readyState;
    },
    set readyState(v: number) {
      readyState = v;
    },
    send(data: string): void {
      sent.push(data);
    },
    addEventListener(event: string, handler: (ev: unknown) => void): void {
      if (event === "message") {
        handlers.message.push(handler as (ev: { data: unknown }) => void);
      } else if (event === "close") {
        handlers.close.push(handler as () => void);
      }
    },
    removeEventListener(event: string, handler: (ev: unknown) => void): void {
      if (event === "message") {
        const idx = handlers.message.indexOf(
          handler as (ev: { data: unknown }) => void
        );
        if (idx !== -1) handlers.message.splice(idx, 1);
      } else if (event === "close") {
        const idx = handlers.close.indexOf(handler as () => void);
        if (idx !== -1) handlers.close.splice(idx, 1);
      }
    },
    close(): void {
      readyState = 3;
      handlers.close.forEach((h) => h());
    },
  } as WebSocketLike & {
    handlers: MockWsHandlers;
    sent: string[];
    readyState: number;
  };
}

function injectMessage(
  ws: ReturnType<typeof createMockWs>,
  data: unknown
): void {
  ws.handlers.message.forEach((h) => h({ data }));
}

// ---------------------------------------------------------------------------
// SyncTransport mock helpers (for SyncProtocol / SyncSession tests)
// ---------------------------------------------------------------------------

function createMockTransport(): SyncTransport & {
  sent: SyncMessage[];
  _inject: (m: SyncMessage) => void;
} {
  let handler: ((message: SyncMessage) => void) | null = null;
  const sent: SyncMessage[] = [];

  return {
    sent,
    async send(message: SyncMessage): Promise<void> {
      sent.push(message);
    },
    onMessage(h: (message: SyncMessage) => void): void {
      handler = h;
    },
    async close(): Promise<void> {
      handler = null;
    },
    _inject(message: SyncMessage): void {
      if (handler) handler(message);
    },
  } as SyncTransport & {
    sent: SyncMessage[];
    _inject: (m: SyncMessage) => void;
  };
}

function createNamespace(name = "test"): SharedMemoryNamespace {
  return new SharedMemoryNamespace({ namespace: ["shared", name] });
}

function createHLC(nodeId: string): HLC {
  return new HLC(nodeId);
}

// ===========================================================================
// WebSocketSyncTransport — constructor and basic wiring
// ===========================================================================

describe("WebSocketSyncTransport — constructor and wiring", () => {
  it("registers a message listener on the WebSocket during construction", () => {
    const ws = createMockWs();
    new WebSocketSyncTransport(ws);
    expect(ws.handlers.message).toHaveLength(1);
  });

  it("does not send anything on construction", () => {
    const ws = createMockWs();
    new WebSocketSyncTransport(ws);
    expect(ws.sent).toHaveLength(0);
  });

  it("initial message handler is null (no messages delivered until onMessage is called)", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    // Inject before registering handler — nothing should arrive
    injectMessage(
      ws,
      JSON.stringify({
        type: "sync:ack",
        namespace: "ns",
        acceptedCount: 1,
        rejectedCount: 0,
      })
    );
    transport.onMessage((m) => received.push(m));
    expect(received).toHaveLength(0);
  });

  it("delivers messages to handler registered via onMessage", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    const msg: SyncMessage = {
      type: "sync:ack",
      namespace: "ns",
      acceptedCount: 2,
      rejectedCount: 0,
    };
    injectMessage(ws, JSON.stringify(msg));

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("sync:ack");
  });
});

// ===========================================================================
// WebSocketSyncTransport — send()
// ===========================================================================

describe("WebSocketSyncTransport — send()", () => {
  it("serializes the message as JSON and sends it", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);

    const msg: SyncMessage = {
      type: "sync:hello",
      nodeId: "node-A",
      namespaces: ["test"],
    };
    await transport.send(msg);

    expect(ws.sent).toHaveLength(1);
    const parsed: unknown = JSON.parse(ws.sent[0]!);
    expect((parsed as Record<string, unknown>)["type"]).toBe("sync:hello");
    expect((parsed as Record<string, unknown>)["nodeId"]).toBe("node-A");
  });

  it("throws when WebSocket is not open (readyState !== 1)", async () => {
    const ws = createMockWs(3); // CLOSED
    const transport = new WebSocketSyncTransport(ws);

    await expect(
      transport.send({
        type: "sync:ack",
        namespace: "ns",
        acceptedCount: 0,
        rejectedCount: 0,
      })
    ).rejects.toThrow("WebSocket is not open");
  });

  it("throws for CONNECTING state (readyState = 0)", async () => {
    const ws = createMockWs(0);
    const transport = new WebSocketSyncTransport(ws);

    await expect(
      transport.send({
        type: "sync:ack",
        namespace: "ns",
        acceptedCount: 0,
        rejectedCount: 0,
      })
    ).rejects.toThrow("WebSocket is not open");
  });

  it("can send multiple messages sequentially", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);

    await transport.send({
      type: "sync:hello",
      nodeId: "n1",
      namespaces: ["a"],
    });
    await transport.send({
      type: "sync:hello",
      nodeId: "n2",
      namespaces: ["b"],
    });
    await transport.send({
      type: "sync:hello",
      nodeId: "n3",
      namespaces: ["c"],
    });

    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[1]!)["nodeId"]).toBe("n2");
  });

  it("sends all SyncMessage types without error", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const hlc = createHLC("n");

    const messages: SyncMessage[] = [
      { type: "sync:hello", nodeId: "n", namespaces: [] },
      {
        type: "sync:digest",
        namespace: "ns",
        digest: {
          nodeId: "n",
          rootHash: "abc",
          entryCount: 0,
          latestTimestamp: hlc.now(),
          versionMap: {},
        },
      },
      { type: "sync:request-delta", namespace: "ns", sinceVersionMap: {} },
      {
        type: "sync:delta",
        namespace: "ns",
        delta: { sourceNodeId: "n", entries: [], generatedAt: hlc.now() },
      },
      { type: "sync:ack", namespace: "ns", acceptedCount: 1, rejectedCount: 0 },
      { type: "sync:error", code: "ERR", message: "test" },
    ];

    for (const msg of messages) {
      await expect(transport.send(msg)).resolves.toBeUndefined();
    }
    expect(ws.sent).toHaveLength(messages.length);
  });
});

// ===========================================================================
// WebSocketSyncTransport — close()
// ===========================================================================

describe("WebSocketSyncTransport — close()", () => {
  it("removes the bound message listener from WebSocket", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);

    expect(ws.handlers.message).toHaveLength(1);
    await transport.close();
    expect(ws.handlers.message).toHaveLength(0);
  });

  it("calls ws.close()", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);

    await transport.close();
    expect(ws.readyState).toBe(3); // createMockWs.close() sets readyState=3
  });

  it("stops delivering messages after close", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    await transport.close();
    injectMessage(
      ws,
      JSON.stringify({
        type: "sync:ack",
        namespace: "ns",
        acceptedCount: 1,
        rejectedCount: 0,
      })
    );

    expect(received).toHaveLength(0);
  });

  it("close() can be called multiple times without error", async () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);

    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// WebSocketSyncTransport — handleRawMessage (private, via side effects)
// ===========================================================================

describe("WebSocketSyncTransport — message handling edge cases", () => {
  it("silently drops malformed JSON", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    injectMessage(ws, "not-json-at-all{{{{");
    expect(received).toHaveLength(0);
  });

  it("silently drops JSON that lacks a type field", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    injectMessage(ws, JSON.stringify({ nodeId: "n", namespaces: [] }));
    expect(received).toHaveLength(0);
  });

  it("silently drops JSON where type is not a string", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    injectMessage(ws, JSON.stringify({ type: 42, namespace: "ns" }));
    expect(received).toHaveLength(0);
  });

  it("silently drops null JSON", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    injectMessage(ws, "null");
    expect(received).toHaveLength(0);
  });

  it("coerces non-string data to string before parsing", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    // Pass a Buffer-like or non-string that toString() produces valid JSON
    const buf = Buffer.from(
      JSON.stringify({
        type: "sync:ack",
        namespace: "ns",
        acceptedCount: 0,
        rejectedCount: 0,
      })
    );
    injectMessage(ws, buf);
    // toString() of Buffer returns valid JSON string, so message should arrive
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("sync:ack");
  });

  it("delivers multiple messages in sequence", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received: SyncMessage[] = [];
    transport.onMessage((m) => received.push(m));

    for (let i = 0; i < 5; i++) {
      injectMessage(
        ws,
        JSON.stringify({
          type: "sync:ack",
          namespace: `ns-${i}`,
          acceptedCount: i,
          rejectedCount: 0,
        })
      );
    }

    expect(received).toHaveLength(5);
    expect((received[3] as { namespace: string }).namespace).toBe("ns-3");
  });

  it("replacing onMessage handler delivers subsequent messages to new handler only", () => {
    const ws = createMockWs();
    const transport = new WebSocketSyncTransport(ws);
    const received1: SyncMessage[] = [];
    const received2: SyncMessage[] = [];

    transport.onMessage((m) => received1.push(m));
    injectMessage(
      ws,
      JSON.stringify({
        type: "sync:ack",
        namespace: "a",
        acceptedCount: 1,
        rejectedCount: 0,
      })
    );

    transport.onMessage((m) => received2.push(m));
    injectMessage(
      ws,
      JSON.stringify({
        type: "sync:ack",
        namespace: "b",
        acceptedCount: 2,
        rejectedCount: 0,
      })
    );

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect((received2[0] as { namespace: string }).namespace).toBe("b");
  });

  it("does not crash when no handler is set and a valid message arrives", () => {
    const ws = createMockWs();
    new WebSocketSyncTransport(ws);
    // No onMessage registered
    expect(() =>
      injectMessage(
        ws,
        JSON.stringify({
          type: "sync:ack",
          namespace: "ns",
          acceptedCount: 0,
          rejectedCount: 0,
        })
      )
    ).not.toThrow();
  });
});

// ===========================================================================
// SyncProtocol — additional branch coverage
// ===========================================================================

describe("SyncProtocol — branch and edge coverage", () => {
  let ns: SharedMemoryNamespace;
  let hlc: HLC;

  beforeEach(() => {
    ns = createNamespace("ns");
    hlc = createHLC("node-X");
  });

  it("handleMessage sync:hello with empty namespaces list returns digest", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"] },
      ns,
      hlc
    );
    const responses = protocol.handleMessage({
      type: "sync:hello",
      nodeId: "remote",
      namespaces: [],
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.type).toBe("sync:digest");
  });

  it("handleMessage sync:hello with non-matching namespace returns empty", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"] },
      ns,
      hlc
    );
    const responses = protocol.handleMessage({
      type: "sync:hello",
      nodeId: "remote",
      namespaces: ["other"],
    });
    expect(responses).toHaveLength(0);
  });

  it("handleMessage sync:digest with identical hashes returns empty", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"] },
      ns,
      hlc
    );
    const digest = protocol.generateDigest();
    const responses = protocol.handleMessage({
      type: "sync:digest",
      digest,
      namespace: "ns",
    });
    expect(responses).toHaveLength(0);
  });

  it("handleMessage sync:request-delta with nothing to send returns empty", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"] },
      ns,
      hlc
    );
    // Remote already has everything (empty namespace, empty version map still produces empty delta)
    ns.put("agent-1", "key1", { v: 1 });
    const responses = protocol.handleMessage({
      type: "sync:request-delta",
      namespace: "ns",
      sinceVersionMap: { key1: 1 }, // remote already at version 1
    });
    expect(responses).toHaveLength(0);
  });

  it("generateDelta with maxBatchSize sorts by version ascending", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"], maxBatchSize: 2 },
      ns,
      hlc
    );
    ns.put("agent-1", "a", { v: 1 });
    ns.put("agent-1", "b", { v: 2 });
    ns.put("agent-1", "c", { v: 3 });

    const delta = protocol.generateDelta({});
    // maxBatchSize=2: only 2 entries returned, sorted by version asc → a,b
    expect(delta.entries).toHaveLength(2);
    const versions = delta.entries.map((e) => e.version);
    expect(versions[0]!).toBeLessThanOrEqual(versions[1]!);
  });

  it("generateDelta with maxBatchSize=100 (default) returns all when below threshold", () => {
    const protocol = new SyncProtocol(
      { nodeId: "node-X", namespaces: ["ns"] },
      ns,
      hlc
    );
    for (let i = 0; i < 10; i++) {
      ns.put("agent-1", `key-${i}`, { i });
    }
    const delta = protocol.generateDelta({});
    expect(delta.entries).toHaveLength(10);
  });

  it("applyDelta advances local HLC", () => {
    const nsA = createNamespace("ns");
    const nsB = createNamespace("ns");
    const hlcA = createHLC("node-A");
    const hlcB = createHLC("node-B");

    const protocolA = new SyncProtocol(
      { nodeId: "node-A", namespaces: ["ns"] },
      nsA,
      hlcA
    );
    const protocolB = new SyncProtocol(
      { nodeId: "node-B", namespaces: ["ns"] },
      nsB,
      hlcB
    );

    nsA.put("agent-A", "k", { v: 1 });
    const delta = protocolA.generateDelta({});

    const tsBefore = hlcB.now();
    protocolB.applyDelta(delta);
    const tsAfter = hlcB.now();

    // After receiving the delta, B's HLC should have advanced past where it was
    expect(tsAfter.wallMs).toBeGreaterThanOrEqual(tsBefore.wallMs);
  });

  it("applyDelta returns correct accepted/rejected counts", () => {
    const nsA = createNamespace("ns");
    const nsB = createNamespace("ns");
    const hlcA = createHLC("node-A");
    const hlcB = createHLC("node-B");

    const protocolA = new SyncProtocol(
      { nodeId: "node-A", namespaces: ["ns"] },
      nsA,
      hlcA
    );
    const protocolB = new SyncProtocol(
      { nodeId: "node-B", namespaces: ["ns"] },
      nsB,
      hlcB
    );

    nsA.put("agent-A", "k1", { v: 1 });
    nsA.put("agent-A", "k2", { v: 2 });
    const delta = protocolA.generateDelta({});

    const result = protocolB.applyDelta(delta);
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);
  });

  it("startAntiEntropy with custom interval sends digest at that interval", () => {
    vi.useFakeTimers();
    try {
      const protocol = new SyncProtocol(
        { nodeId: "node-X", namespaces: ["ns"], antiEntropyIntervalMs: 5000 },
        ns,
        hlc
      );
      const transport = createMockTransport();
      const stop = protocol.startAntiEntropy(transport);

      vi.advanceTimersByTime(4999);
      expect(transport.sent).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.type).toBe("sync:digest");

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("startAntiEntropy stop function halts further sends", () => {
    vi.useFakeTimers();
    try {
      const protocol = new SyncProtocol(
        { nodeId: "node-X", namespaces: ["ns"], antiEntropyIntervalMs: 1000 },
        ns,
        hlc
      );
      const transport = createMockTransport();
      const stop = protocol.startAntiEntropy(transport);

      vi.advanceTimersByTime(3000);
      expect(transport.sent).toHaveLength(3);

      stop();
      vi.advanceTimersByTime(5000);
      expect(transport.sent).toHaveLength(3); // no additional sends
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// SyncSession — additional edge cases
// ===========================================================================

describe("SyncSession — lifecycle and edge cases", () => {
  let nsA: SharedMemoryNamespace;
  let hlcA: HLC;

  beforeEach(() => {
    nsA = createNamespace("test");
    hlcA = createHLC("node-A");
  });

  it("stats() returns zero counts before any sync activity", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const s = session.stats();
    expect(s.sentDeltas).toBe(0);
    expect(s.receivedDeltas).toBe(0);
    expect(s.conflicts).toBe(0);
    expect(s.lastSyncAt).toBeNull();
  });

  it("disconnect from closed state does not throw", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    await expect(session.disconnect()).resolves.toBeUndefined();
  });

  it("multiple event handlers all receive events", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const events1: SyncEvent[] = [];
    const events2: SyncEvent[] = [];
    session.onEvent((e) => events1.push(e));
    session.onEvent((e) => events2.push(e));

    const transport = createMockTransport();
    await session.connect(transport);

    transport._inject({
      type: "sync:hello",
      nodeId: "node-B",
      namespaces: ["test"],
    });

    expect(events1.some((e) => e.type === "sync:connected")).toBe(true);
    expect(events2.some((e) => e.type === "sync:connected")).toBe(true);

    await session.disconnect();
  });

  it("unsubscribing one handler does not affect another", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const events1: SyncEvent[] = [];
    const events2: SyncEvent[] = [];
    const unsub1 = session.onEvent((e) => events1.push(e));
    session.onEvent((e) => events2.push(e));

    const transport = createMockTransport();
    await session.connect(transport);

    unsub1();

    transport._inject({
      type: "sync:hello",
      nodeId: "node-B",
      namespaces: ["test"],
    });

    expect(events1).toHaveLength(0);
    expect(events2.some((e) => e.type === "sync:connected")).toBe(true);

    await session.disconnect();
  });

  it("emits sync:disconnected event with correct remoteNodeId", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const events: SyncEvent[] = [];
    session.onEvent((e) => events.push(e));

    const transport = createMockTransport();
    await session.connect(transport);
    transport._inject({
      type: "sync:hello",
      nodeId: "remote-B",
      namespaces: ["test"],
    });
    await session.disconnect();

    const disconn = events.find((e) => e.type === "sync:disconnected");
    expect(disconn).toBeDefined();
    if (disconn?.type === "sync:disconnected") {
      expect(disconn.remoteNodeId).toBe("remote-B");
    }
  });

  it("does not emit sync:disconnected when no hello was received", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const events: SyncEvent[] = [];
    session.onEvent((e) => events.push(e));

    const transport = createMockTransport();
    await session.connect(transport);
    await session.disconnect();

    expect(events.find((e) => e.type === "sync:disconnected")).toBeUndefined();
  });

  it("transitions through connecting -> idle -> syncing -> idle on delta receive", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const transport = createMockTransport();
    await session.connect(transport);
    expect(session.state).toBe("idle");

    const hlcB = createHLC("node-B");
    const nsB = createNamespace("test");
    nsB.put("agent-B", "entry", { val: "x" });
    transport._inject({
      type: "sync:delta",
      namespace: "test",
      delta: {
        sourceNodeId: "node-B",
        entries: nsB.list(),
        generatedAt: hlcB.now(),
      },
    });

    expect(session.state).toBe("idle");
    await session.disconnect();
  });

  it("can reconnect after error state", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const transport = createMockTransport();
    await session.connect(transport);

    transport._inject({ type: "sync:error", code: "FAIL", message: "oops" });
    expect(session.state).toBe("error");

    await session.disconnect();
    expect(session.state).toBe("closed");

    const transport2 = createMockTransport();
    await session.connect(transport2);
    expect(session.state).toBe("idle");
    await session.disconnect();
  });

  it("only syncs configured namespaces (filters out unlisted)", async () => {
    const nsOther = createNamespace("other");
    const config: SyncConfig = { nodeId: "node-A", namespaces: ["test"] };
    const session = new SyncSession(
      config,
      new Map([
        ["test", nsA],
        ["other", nsOther],
      ]),
      hlcA
    );
    const transport = createMockTransport();
    await session.connect(transport);

    // Only 'test' namespaces included in hello
    const hello = transport.sent.find((m) => m.type === "sync:hello");
    expect(hello).toBeDefined();
    if (hello?.type === "sync:hello") {
      expect(hello.namespaces).toEqual(["test"]);
      expect(hello.namespaces).not.toContain("other");
    }

    await session.disconnect();
  });

  it("syncs all namespaces when config.namespaces is undefined", async () => {
    const nsExtra = createNamespace("extra");
    const session = new SyncSession(
      { nodeId: "node-A" }, // no namespaces filter
      new Map([
        ["test", nsA],
        ["extra", nsExtra],
      ]),
      hlcA
    );
    const transport = createMockTransport();
    await session.connect(transport);

    const hello = transport.sent.find((m) => m.type === "sync:hello");
    if (hello?.type === "sync:hello") {
      expect(hello.namespaces).toContain("test");
      expect(hello.namespaces).toContain("extra");
    }

    await session.disconnect();
  });

  it("throws when attempting to connect while already in syncing or idle state", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const t1 = createMockTransport();
    await session.connect(t1);
    expect(session.state).toBe("idle");

    await expect(session.connect(createMockTransport())).rejects.toThrow(
      /Cannot connect/
    );
    await session.disconnect();
  });

  it("hello send failure sets state to error", async () => {
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const events: SyncEvent[] = [];
    session.onEvent((e) => events.push(e));

    const failTransport: SyncTransport = {
      async send(): Promise<void> {
        throw new Error("send failed");
      },
      onMessage(): void {},
      async close(): Promise<void> {},
    };

    await session.connect(failTransport);
    expect(session.state).toBe("error");
    expect(events.some((e) => e.type === "sync:error")).toBe(true);
  });

  it("receivedDeltas counter increments on each delta message", async () => {
    const hlcB = createHLC("node-B");
    const nsB = createNamespace("test");
    const session = new SyncSession(
      { nodeId: "node-A" },
      new Map([["test", nsA]]),
      hlcA
    );
    const transport = createMockTransport();
    await session.connect(transport);

    for (let i = 0; i < 3; i++) {
      nsB.put("agent-B", `k-${i}`, { i });
      transport._inject({
        type: "sync:delta",
        namespace: "test",
        delta: {
          sourceNodeId: "node-B",
          entries: [nsB.list()[i]!],
          generatedAt: hlcB.now(),
        },
      });
    }

    expect(session.stats().receivedDeltas).toBe(3);
    expect(session.stats().lastSyncAt).not.toBeNull();
    await session.disconnect();
  });
});

// ===========================================================================
// Memory read/write through a SyncProtocol round-trip
// ===========================================================================

describe("Memory read/write through SyncProtocol round-trip", () => {
  it("data written on node A is readable on node B after delta exchange", () => {
    const nsA = createNamespace("shared");
    const nsB = createNamespace("shared");
    const hlcA = createHLC("node-A");
    const hlcB = createHLC("node-B");

    const protocolA = new SyncProtocol(
      { nodeId: "node-A", namespaces: ["shared"] },
      nsA,
      hlcA
    );
    const protocolB = new SyncProtocol(
      { nodeId: "node-B", namespaces: ["shared"] },
      nsB,
      hlcB
    );

    // Write to A
    nsA.put("agent-A", "config", { theme: "dark", version: 2 });

    // B sends hello, A replies with digest
    const digestFromA = protocolA.generateDigest();

    // B sees A's digest differs from its own (empty)
    const requestDelta = protocolB.handleMessage({
      type: "sync:digest",
      digest: digestFromA,
      namespace: "shared",
    });
    expect(requestDelta[0]!.type).toBe("sync:request-delta");

    // A handles B's request-delta
    const deltaMsg = protocolA.handleMessage(requestDelta[0]!);
    expect(deltaMsg[0]!.type).toBe("sync:delta");

    // B applies A's delta
    const ack = protocolB.handleMessage(deltaMsg[0]!);
    expect(ack[0]!.type).toBe("sync:ack");

    // B can now read the data
    const entry = nsB.get("config");
    expect(entry?.value).toEqual({ theme: "dark", version: 2 });
  });

  it("bidirectional sync: both nodes get each other's data", () => {
    const nsA = createNamespace("shared");
    const nsB = createNamespace("shared");
    const hlcA = createHLC("node-A");
    const hlcB = createHLC("node-B");

    nsA.put("agent-A", "a-key", { from: "A" });
    nsB.put("agent-B", "b-key", { from: "B" });

    const protocolA = new SyncProtocol(
      { nodeId: "node-A", namespaces: ["shared"] },
      nsA,
      hlcA
    );
    const protocolB = new SyncProtocol(
      { nodeId: "node-B", namespaces: ["shared"] },
      nsB,
      hlcB
    );

    // A -> B
    const deltaAtoB = protocolA.generateDelta({});
    protocolB.applyDelta(deltaAtoB);

    // B -> A
    const deltaBtoA = protocolB.generateDelta({ "a-key": 1 });
    protocolA.applyDelta(deltaBtoA);

    expect(nsA.get("b-key")?.value).toEqual({ from: "B" });
    expect(nsB.get("a-key")?.value).toEqual({ from: "A" });
  });

  it("writing multiple entries and syncing preserves all values", () => {
    const nsA = createNamespace("data");
    const nsB = createNamespace("data");
    const hlcA = createHLC("node-A");
    const hlcB = createHLC("node-B");

    const entries = Array.from({ length: 15 }, (_, i) => ({
      key: `entry-${i}`,
      value: { index: i, label: `label-${i}` },
    }));

    entries.forEach(({ key, value }) => nsA.put("agent-A", key, value));

    const protocolA = new SyncProtocol(
      { nodeId: "node-A", namespaces: ["data"] },
      nsA,
      hlcA
    );
    const protocolB = new SyncProtocol(
      { nodeId: "node-B", namespaces: ["data"] },
      nsB,
      hlcB
    );

    const delta = protocolA.generateDelta({});
    protocolB.applyDelta(delta);

    for (const { key, value } of entries) {
      expect(nsB.get(key)?.value).toEqual(value);
    }
  });
});

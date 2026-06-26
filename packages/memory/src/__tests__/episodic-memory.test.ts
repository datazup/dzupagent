/**
 * Comprehensive tests for EpisodicMemory — episodic event log with:
 *   - Event logging (timestamp, type, payload)
 *   - Event retrieval in chronological order
 *   - Filtering by type and time range
 *   - Episode boundary detection (inactivity gap, explicit end)
 *   - Episode start / end / listing / retrieval
 *   - Timeline reconstruction and gap detection
 *   - Recent episodes
 *   - Episode summarization
 *   - Cross-episode search
 *   - Event count by type
 *   - Serialization / deserialization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EpisodicMemory,
  type EpisodicEvent,
  type Episode,
} from "../episodic-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(inactivityGapMs = 60_000): EpisodicMemory {
  let counter = 0;
  return new EpisodicMemory({
    inactivityGapMs,
    idFactory: () => `evt-${++counter}`,
  });
}

/** Log N events of the same type, each 1 ms apart from base */
function logN(
  mem: EpisodicMemory,
  n: number,
  type: string,
  base: number,
): EpisodicEvent[] {
  const events: EpisodicEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(mem.logEvent({ type, timestamp: base + i }));
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. Event logging
// ---------------------------------------------------------------------------

describe("EpisodicMemory — event logging", () => {
  it("logs an event and returns it with an id, timestamp, type and payload", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ev = mem.logEvent({
      type: "user_message",
      payload: { text: "hello" },
      timestamp: 1000,
    });

    expect(ev.id).toBeTruthy();
    expect(ev.timestamp).toBe(1000);
    expect(ev.type).toBe("user_message");
    expect(ev.payload).toEqual({ text: "hello" });
  });

  it("assigns the event to the current episode", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ev = mem.logEvent({ type: "tool_call", timestamp: 2000 });
    expect(ev.episodeId).toBe("ep-1");
  });

  it("defaults payload to {} when omitted", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ev = mem.logEvent({ type: "ping" });
    expect(ev.payload).toEqual({});
  });

  it("auto-starts an episode when none is open", () => {
    const mem = makeMemory();
    const ev = mem.logEvent({ type: "auto", timestamp: 5000 });
    expect(ev.episodeId).toBeTruthy();
    expect(mem.listEpisodeIds()).toHaveLength(1);
  });

  it("each event id is unique within a session", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ids = logN(mem, 10, "ping", 0).map((e) => e.id);
    expect(new Set(ids).size).toBe(10);
  });

  it("uses Date.now() when no timestamp is provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ev = mem.logEvent({ type: "tick" });
    expect(ev.timestamp).toBe(new Date("2025-01-01T00:00:00Z").getTime());
    vi.useRealTimers();
  });

  it("stores arbitrary payload fields", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ev = mem.logEvent({
      type: "tool_result",
      payload: { rows: 42, query: "SELECT 1", nested: { ok: true } },
    });
    expect(ev.payload.rows).toBe(42);
    expect(ev.payload.nested).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Event retrieval — chronological order
// ---------------------------------------------------------------------------

describe("EpisodicMemory — event retrieval", () => {
  it("getEpisodeEvents returns events in insertion order", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 5, "ping", 100);
    const events = mem.getEpisodeEvents("ep-1");
    expect(events).toHaveLength(5);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(
        events[i - 1].timestamp,
      );
    }
  });

  it("getEpisodeEvents returns an empty array for an unknown episode", () => {
    const mem = makeMemory();
    expect(mem.getEpisodeEvents("nonexistent")).toEqual([]);
  });

  it("getTimeline returns all events sorted by timestamp across episodes", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 3, "a", 100);
    mem.endEpisode();

    mem.startEpisode("ep-2");
    logN(mem, 3, "b", 200);
    mem.endEpisode();

    const tl = mem.getTimeline();
    expect(tl).toHaveLength(6);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i].timestamp).toBeGreaterThanOrEqual(tl[i - 1].timestamp);
    }
  });

  it("getTimeline includes events from all episodes", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "x", timestamp: 1 });
    mem.endEpisode();

    mem.startEpisode("ep-2");
    mem.logEvent({ type: "y", timestamp: 2 });

    const types = mem.getTimeline().map((e) => e.type);
    expect(types).toContain("x");
    expect(types).toContain("y");
  });

  it("getTimeline returns empty array when no events logged", () => {
    const mem = makeMemory();
    expect(mem.getTimeline()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Event filtering by type
// ---------------------------------------------------------------------------

describe("EpisodicMemory — filter by type", () => {
  it("filterByType returns only events matching that type", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 3, "user_message", 100);
    logN(mem, 2, "tool_call", 200);

    const msgs = mem.filterByType("user_message");
    expect(msgs).toHaveLength(3);
    expect(msgs.every((e) => e.type === "user_message")).toBe(true);
  });

  it("filterByType returns empty array when no events match", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 2, "ping", 0);
    expect(mem.filterByType("missing")).toEqual([]);
  });

  it("filterByType spans multiple episodes", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "x", timestamp: 1 });
    mem.endEpisode();

    mem.startEpisode("ep-2");
    mem.logEvent({ type: "x", timestamp: 2 });

    expect(mem.filterByType("x")).toHaveLength(2);
  });

  it("filterByType is exact — partial type strings do not match", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "user_message_sent", timestamp: 1 });
    expect(mem.filterByType("user_message")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Event filtering by time range
// ---------------------------------------------------------------------------

describe("EpisodicMemory — filter by time range", () => {
  let mem: EpisodicMemory;
  beforeEach(() => {
    mem = makeMemory();
    mem.startEpisode("ep-1");
    for (let t = 100; t <= 500; t += 100) {
      mem.logEvent({ type: "tick", timestamp: t });
    }
  });

  it("returns events whose timestamp falls within [start, end]", () => {
    const result = mem.filterByTimeRange(200, 400);
    expect(result.map((e) => e.timestamp)).toEqual([200, 300, 400]);
  });

  it("includes boundary timestamps", () => {
    const result = mem.filterByTimeRange(100, 100);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(100);
  });

  it("returns empty array when no events fall in range", () => {
    expect(mem.filterByTimeRange(600, 900)).toEqual([]);
  });

  it("returns all events when range spans entire timeline", () => {
    expect(mem.filterByTimeRange(0, 10_000)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 5. Episode boundary — explicit start/end
// ---------------------------------------------------------------------------

describe("EpisodicMemory — explicit episode boundaries", () => {
  it("startEpisode marks episode start with a timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const mem = makeMemory();
    const ep = mem.startEpisode("ep-1");
    expect(ep.startedAt).toBe(1_000_000);
    vi.useRealTimers();
  });

  it("first event in a session marks episode start", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-first");
    const ev = mem.logEvent({ type: "begin", timestamp: 9999 });
    expect(ev.episodeId).toBe("ep-first");
    const ep = mem.getEpisode("ep-first")!;
    expect(ep.events[0].type).toBe("begin");
  });

  it("endEpisode marks episode endedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.endEpisode();
    const ep = mem.getEpisode("ep-1")!;
    expect(ep.endedAt).toBe(2_000_000);
    vi.useRealTimers();
  });

  it("endEpisode is idempotent when no episode is open", () => {
    const mem = makeMemory();
    expect(() => mem.endEpisode()).not.toThrow();
  });

  it("starting a new episode auto-ends the previous one", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.startEpisode("ep-2");
    const ep1 = mem.getEpisode("ep-1")!;
    expect(ep1.endedAt).toBeDefined();
  });

  it("events logged after endEpisode go to a new auto episode", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.endEpisode();
    const ev = mem.logEvent({ type: "post", timestamp: 1 });
    expect(ev.episodeId).not.toBe("ep-1");
    expect(mem.listEpisodeIds()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Episode boundary — inactivity gap
// ---------------------------------------------------------------------------

describe("EpisodicMemory — inactivity gap auto-close", () => {
  it("inactivity gap closes the current episode and opens a new one", () => {
    const mem = new EpisodicMemory({ inactivityGapMs: 1000 });
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "a", timestamp: 0 });
    // Log an event 1000 ms later — triggers gap closure
    const ev2 = mem.logEvent({ type: "b", timestamp: 1000 });
    expect(ev2.episodeId).not.toBe("ep-1");
    expect(mem.listEpisodeIds()).toHaveLength(2);
  });

  it("no gap close when events are within the inactivity window", () => {
    const mem = new EpisodicMemory({ inactivityGapMs: 1000 });
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "a", timestamp: 0 });
    const ev2 = mem.logEvent({ type: "b", timestamp: 999 });
    expect(ev2.episodeId).toBe("ep-1");
    expect(mem.listEpisodeIds()).toHaveLength(1);
  });

  it("gap-closed episode has an endedAt set", () => {
    const mem = new EpisodicMemory({ inactivityGapMs: 500 });
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "a", timestamp: 0 });
    mem.logEvent({ type: "b", timestamp: 600 }); // triggers gap close
    const ep1 = mem.getEpisode("ep-1")!;
    expect(ep1.endedAt).toBeDefined();
  });

  it("multiple gap-based episode splits produce ordered episode list", () => {
    const mem = new EpisodicMemory({ inactivityGapMs: 100 });
    mem.logEvent({ type: "a", timestamp: 0 });
    mem.logEvent({ type: "b", timestamp: 200 }); // gap => ep 2
    mem.logEvent({ type: "c", timestamp: 400 }); // gap => ep 3
    expect(mem.listEpisodeIds()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Episode retrieval
// ---------------------------------------------------------------------------

describe("EpisodicMemory — episode retrieval", () => {
  it("getEpisode returns the episode object", () => {
    const mem = makeMemory();
    mem.startEpisode("my-ep");
    const ep = mem.getEpisode("my-ep");
    expect(ep).toBeDefined();
    expect(ep!.id).toBe("my-ep");
  });

  it("getEpisode returns undefined for unknown id", () => {
    const mem = makeMemory();
    expect(mem.getEpisode("ghost")).toBeUndefined();
  });

  it("getEpisodeEvents returns only events from that episode", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-A");
    logN(mem, 3, "a", 100);
    mem.endEpisode();

    mem.startEpisode("ep-B");
    logN(mem, 4, "b", 200);
    mem.endEpisode();

    expect(mem.getEpisodeEvents("ep-A")).toHaveLength(3);
    expect(mem.getEpisodeEvents("ep-B")).toHaveLength(4);
  });

  it("getEpisodeEvents returns a copy — mutating does not affect internal state", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "x" });
    const copy = mem.getEpisodeEvents("ep-1");
    copy.push({
      id: "fake",
      timestamp: 0,
      type: "evil",
      payload: {},
      episodeId: "ep-1",
    });
    expect(mem.getEpisodeEvents("ep-1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Episode listing
// ---------------------------------------------------------------------------

describe("EpisodicMemory — episode listing", () => {
  it("listEpisodeIds returns IDs in start order", () => {
    const mem = makeMemory();
    mem.startEpisode("first");
    mem.endEpisode();
    mem.startEpisode("second");
    mem.endEpisode();
    mem.startEpisode("third");

    expect(mem.listEpisodeIds()).toEqual(["first", "second", "third"]);
  });

  it("listEpisodeIds is empty when no episodes have been started", () => {
    const mem = makeMemory();
    expect(mem.listEpisodeIds()).toEqual([]);
  });

  it("listEpisodeIds returns a copy — mutating does not affect state", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const ids = mem.listEpisodeIds();
    ids.push("injected");
    expect(mem.listEpisodeIds()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Timeline reconstruction
// ---------------------------------------------------------------------------

describe("EpisodicMemory — timeline reconstruction", () => {
  it("full chronological event log across three episodes", () => {
    const mem = makeMemory();

    mem.startEpisode("A");
    logN(mem, 2, "typeA", 10);
    mem.endEpisode();

    mem.startEpisode("B");
    logN(mem, 3, "typeB", 20);
    mem.endEpisode();

    mem.startEpisode("C");
    logN(mem, 1, "typeC", 30);

    const tl = mem.getTimeline();
    expect(tl).toHaveLength(6);
    expect(tl.map((e) => e.type)).toEqual([
      "typeA",
      "typeA",
      "typeB",
      "typeB",
      "typeB",
      "typeC",
    ]);
  });

  it("getTimeline sorts across out-of-insertion-order timestamps", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "late", timestamp: 500 });
    mem.logEvent({ type: "early", timestamp: 100 });

    const tl = mem.getTimeline();
    expect(tl[0].type).toBe("early");
    expect(tl[1].type).toBe("late");
  });
});

// ---------------------------------------------------------------------------
// 10. Timeline gaps
// ---------------------------------------------------------------------------

describe("EpisodicMemory — timeline gaps", () => {
  it("identifies a gap between two closed episodes", () => {
    const mem = makeMemory();

    mem.startEpisode("ep-1");
    mem.logEvent({ type: "a", timestamp: 100 });
    const ep1 = mem.getEpisode("ep-1")!;
    ep1.endedAt = 200;
    mem.endEpisode();

    mem.startEpisode("ep-2");
    const ep2 = mem.getEpisode("ep-2")!;
    ep2.startedAt = 500;
    mem.logEvent({ type: "b", timestamp: 600 });
    ep2.endedAt = 700;
    mem.endEpisode();

    const gaps = mem.getTimelineGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].afterEpisodeId).toBe("ep-1");
    expect(gaps[0].beforeEpisodeId).toBe("ep-2");
    expect(gaps[0].gapMs).toBe(300);
  });

  it("no gaps when episodes are back-to-back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    vi.setSystemTime(100);
    mem.endEpisode();
    vi.setSystemTime(100); // same time = no gap
    mem.startEpisode("ep-2");
    vi.setSystemTime(200);
    mem.endEpisode();
    vi.useRealTimers();

    const gaps = mem.getTimelineGaps();
    // gap = ep2.startedAt(100) - ep1.endedAt(100) = 0 → not > 0, no gap
    expect(gaps).toHaveLength(0);
  });

  it("open (unclosed) episodes are excluded from gap calculation", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.endEpisode();
    mem.startEpisode("ep-2"); // still open

    const gaps = mem.getTimelineGaps();
    // ep-2 is open so only 1 closed ep — no pair to gap
    expect(gaps).toHaveLength(0);
  });

  it("returns empty when fewer than 2 closed episodes", () => {
    const mem = makeMemory();
    expect(mem.getTimelineGaps()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Recent episodes
// ---------------------------------------------------------------------------

describe("EpisodicMemory — recent episodes", () => {
  let mem: EpisodicMemory;
  beforeEach(() => {
    mem = makeMemory();
    for (let i = 1; i <= 5; i++) {
      mem.startEpisode(`ep-${i}`);
      mem.endEpisode();
    }
  });

  it("getRecentEpisodes(3) returns the last 3 episodes most-recent-first", () => {
    const recent = mem.getRecentEpisodes(3);
    expect(recent.map((e) => e.id)).toEqual(["ep-5", "ep-4", "ep-3"]);
  });

  it("getRecentEpisodes(1) returns only the most recent episode", () => {
    const recent = mem.getRecentEpisodes(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("ep-5");
  });

  it("getRecentEpisodes(N) when N > total returns all episodes most-recent-first", () => {
    const recent = mem.getRecentEpisodes(100);
    expect(recent.map((e) => e.id)).toEqual([
      "ep-5",
      "ep-4",
      "ep-3",
      "ep-2",
      "ep-1",
    ]);
  });

  it("getRecentEpisodes(0) returns empty array", () => {
    expect(mem.getRecentEpisodes(0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. Episode summary
// ---------------------------------------------------------------------------

describe("EpisodicMemory — episode summary", () => {
  it("summarizeEpisode returns correct counts and type breakdown", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 3, "user_message", 0);
    logN(mem, 2, "tool_call", 10);
    mem.endEpisode();

    const summary = mem.summarizeEpisode("ep-1");
    expect(summary).toBeDefined();
    expect(summary!.id).toBe("ep-1");
    expect(summary!.eventCount).toBe(5);
    expect(summary!.typeCounts.user_message).toBe(3);
    expect(summary!.typeCounts.tool_call).toBe(2);
  });

  it("summarizeEpisode returns undefined for unknown episode", () => {
    const mem = makeMemory();
    expect(mem.summarizeEpisode("ghost")).toBeUndefined();
  });

  it("summarizeEpisode includes endedAt when episode is closed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.endEpisode();
    const summary = mem.summarizeEpisode("ep-1");
    expect(summary!.endedAt).toBe(9_000_000);
    vi.useRealTimers();
  });

  it("summarizeEpisode shows endedAt=undefined for open episode", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    const summary = mem.summarizeEpisode("ep-1");
    expect(summary!.endedAt).toBeUndefined();
  });

  it("summarizeEpisode reports eventCount=0 for episode with no events", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-empty");
    const summary = mem.summarizeEpisode("ep-empty");
    expect(summary!.eventCount).toBe(0);
    expect(summary!.typeCounts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 13. Cross-episode search
// ---------------------------------------------------------------------------

describe("EpisodicMemory — cross-episode search", () => {
  it("search finds events matching a payload field across episodes", () => {
    const mem = makeMemory();

    mem.startEpisode("ep-1");
    mem.logEvent({ type: "msg", payload: { userId: "alice" }, timestamp: 1 });
    mem.logEvent({ type: "msg", payload: { userId: "bob" }, timestamp: 2 });
    mem.endEpisode();

    mem.startEpisode("ep-2");
    mem.logEvent({ type: "msg", payload: { userId: "alice" }, timestamp: 3 });

    const aliceEvents = mem.search((e) => e.payload.userId === "alice");
    expect(aliceEvents).toHaveLength(2);
    expect(aliceEvents.every((e) => e.payload.userId === "alice")).toBe(true);
  });

  it("search returns empty array when predicate matches nothing", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 3, "ping", 0);
    expect(mem.search((e) => e.type === "pong")).toEqual([]);
  });

  it("search can filter by both type and payload simultaneously", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "error", payload: { code: 500 }, timestamp: 1 });
    mem.logEvent({ type: "error", payload: { code: 404 }, timestamp: 2 });
    mem.logEvent({ type: "info", payload: { code: 200 }, timestamp: 3 });

    const serverErrors = mem.search(
      (e) => e.type === "error" && e.payload.code === 500,
    );
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0].payload.code).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 14. Event count by type
// ---------------------------------------------------------------------------

describe("EpisodicMemory — event count by type", () => {
  it("countByType returns correct frequencies across all episodes", () => {
    const mem = makeMemory();

    mem.startEpisode("ep-1");
    logN(mem, 3, "ping", 0);
    logN(mem, 2, "pong", 10);
    mem.endEpisode();

    mem.startEpisode("ep-2");
    logN(mem, 1, "ping", 20);

    const counts = mem.countByType();
    expect(counts.ping).toBe(4);
    expect(counts.pong).toBe(2);
  });

  it("countByType returns {} when no events", () => {
    const mem = makeMemory();
    expect(mem.countByType()).toEqual({});
  });

  it("countByType includes all types present", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    ["a", "b", "c", "a", "b"].forEach((t, i) =>
      mem.logEvent({ type: t, timestamp: i }),
    );

    const counts = mem.countByType();
    expect(counts.a).toBe(2);
    expect(counts.b).toBe(2);
    expect(counts.c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Serialization / deserialization
// ---------------------------------------------------------------------------

describe("EpisodicMemory — serialization", () => {
  it("serialize produces a JSON-safe object with all episodes", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "x", payload: { v: 1 }, timestamp: 10 });
    mem.endEpisode();

    const data = mem.serialize();
    expect(data.episodes).toHaveLength(1);
    expect(data.episodes[0].id).toBe("ep-1");
    expect(data.episodes[0].events).toHaveLength(1);
    // must be JSON-round-trippable
    const json = JSON.stringify(data);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("deserialize restores all episodes, events, and ordering", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-A");
    mem.logEvent({ type: "ping", timestamp: 1 });
    mem.endEpisode();
    mem.startEpisode("ep-B");
    mem.logEvent({ type: "pong", timestamp: 2 });

    const restored = EpisodicMemory.deserialize(mem.serialize());
    expect(restored.listEpisodeIds()).toEqual(["ep-A", "ep-B"]);
    expect(restored.getEpisodeEvents("ep-A")).toHaveLength(1);
    expect(restored.getEpisodeEvents("ep-B")).toHaveLength(1);
  });

  it("serialize / deserialize preserves event payloads", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({
      type: "data",
      payload: { foo: "bar", nested: { n: 42 } },
      timestamp: 5,
    });

    const restored = EpisodicMemory.deserialize(mem.serialize());
    const ev = restored.getEpisodeEvents("ep-1")[0];
    expect(ev.payload.foo).toBe("bar");
    expect((ev.payload.nested as Record<string, number>).n).toBe(42);
  });

  it("deserialize preserves episode endedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.endEpisode();
    const endedAt = mem.getEpisode("ep-1")!.endedAt;

    const restored = EpisodicMemory.deserialize(mem.serialize());
    expect(restored.getEpisode("ep-1")!.endedAt).toBe(endedAt);
    vi.useRealTimers();
  });

  it("deserialize preserves currentEpisodeId and lastEventAt", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-open");
    mem.logEvent({ type: "t", timestamp: 999 });

    const data = mem.serialize();
    expect(data.currentEpisodeId).toBe("ep-open");
    expect(data.lastEventAt).toBe(999);

    const restored = EpisodicMemory.deserialize(data);
    // restored instance's internal serialization matches
    const data2 = restored.serialize();
    expect(data2.currentEpisodeId).toBe("ep-open");
    expect(data2.lastEventAt).toBe(999);
  });

  it("serialize is a deep copy — mutating result does not affect internal state", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    mem.logEvent({ type: "x", timestamp: 1 });

    const data = mem.serialize();
    data.episodes[0].events[0].type = "mutated";

    expect(mem.getEpisodeEvents("ep-1")[0].type).toBe("x");
  });

  it("round-trip through JSON.stringify / JSON.parse and deserialize", () => {
    const mem = makeMemory();
    mem.startEpisode("ep-1");
    logN(mem, 5, "action", 0);
    mem.endEpisode();

    const json = JSON.stringify(mem.serialize());
    const restored = EpisodicMemory.deserialize(JSON.parse(json));
    expect(restored.getEpisodeEvents("ep-1")).toHaveLength(5);
    expect(restored.getTimeline()).toHaveLength(5);
  });
});

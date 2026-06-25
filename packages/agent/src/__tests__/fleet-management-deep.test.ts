/**
 * W27-C — Fleet Management Deep Coverage
 *
 * Covers InMemoryAgentCluster, ClusterRole, AgentCluster interface,
 * InMemoryMailboxStore, and all interaction paths including:
 * - Cluster lifecycle (create, add, remove roles)
 * - Message routing (routeMail, broadcast)
 * - Concurrency (simultaneous dispatches)
 * - Error cases (missing roles, duplicate roles, empty cluster)
 * - TTL / expiry behaviour via InMemoryMailboxStore
 * - Cluster type guards and structural contracts
 * - Multiple clusters, isolation, metric-like counters
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryAgentCluster } from "../cluster/in-memory-agent-cluster.js";
import type { InMemoryAgentClusterConfig } from "../cluster/in-memory-agent-cluster.js";
import type { AgentCluster, ClusterRole } from "../cluster/cluster-types.js";
import { InMemoryMailboxStore } from "../mailbox/in-memory-mailbox-store.js";
import type { MailboxStore, MailMessage } from "../mailbox/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMailbox(): InMemoryMailboxStore {
  return new InMemoryMailboxStore();
}

function makeCluster(
  overrides: Partial<InMemoryAgentClusterConfig> = {}
): InMemoryAgentCluster {
  return new InMemoryAgentCluster({
    clusterId: overrides.clusterId ?? "cluster-1",
    workspace:
      "workspace" in overrides ? overrides.workspace : { root: "/workspace" },
    mailbox: overrides.mailbox ?? makeMailbox(),
    roles: overrides.roles,
  });
}

function makeRole(partial: Partial<ClusterRole> = {}): ClusterRole {
  return {
    roleId: partial.roleId ?? "role-a",
    agentId: partial.agentId ?? "agent-a",
    capabilities: partial.capabilities,
  };
}

// ---------------------------------------------------------------------------
// 1. Cluster construction
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — construction", () => {
  it("stores clusterId", () => {
    const c = makeCluster({ clusterId: "my-cluster" });
    expect(c.clusterId).toBe("my-cluster");
  });

  it("stores workspace reference", () => {
    const ws = { root: "/repo" };
    const c = makeCluster({ workspace: ws });
    expect(c.workspace).toBe(ws);
  });

  it("stores mailbox reference", () => {
    const mb = makeMailbox();
    const c = makeCluster({ mailbox: mb });
    expect(c.mailbox).toBe(mb);
  });

  it("starts with empty roles when none provided", () => {
    const c = makeCluster();
    expect(c.roles).toHaveLength(0);
  });

  it("loads initial roles from config", () => {
    const roles: ClusterRole[] = [
      makeRole({ roleId: "planner", agentId: "agent-planner" }),
      makeRole({ roleId: "coder", agentId: "agent-coder" }),
    ];
    const c = makeCluster({ roles });
    expect(c.roles).toHaveLength(2);
  });

  it("initial roles are copied, not shared by reference", () => {
    const role = makeRole({ roleId: "planner", agentId: "agent-planner" });
    const c = makeCluster({ roles: [role] });
    role.agentId = "mutated";
    expect(c.roles[0]!.agentId).toBe("agent-planner");
  });

  it("roles property returns readonly snapshot", () => {
    const c = makeCluster();
    const snap1 = c.roles;
    c.addRole(makeRole({ roleId: "r1", agentId: "a1" }));
    const snap2 = c.roles;
    expect(snap1).toHaveLength(0);
    expect(snap2).toHaveLength(1);
  });

  it("workspace can be null / undefined-like opaque value", () => {
    const c = makeCluster({ workspace: null });
    expect(c.workspace).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. addRole
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — addRole", () => {
  it("adds a single role", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "reviewer", agentId: "agent-reviewer" }));
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0]!.roleId).toBe("reviewer");
    expect(c.roles[0]!.agentId).toBe("agent-reviewer");
  });

  it("adds multiple distinct roles", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "r1", agentId: "a1" }));
    c.addRole(makeRole({ roleId: "r2", agentId: "a2" }));
    c.addRole(makeRole({ roleId: "r3", agentId: "a3" }));
    expect(c.roles).toHaveLength(3);
  });

  it("throws when adding a duplicate roleId", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "dup", agentId: "a1" }));
    expect(() => c.addRole(makeRole({ roleId: "dup", agentId: "a2" }))).toThrow(
      /dup/
    );
  });

  it("error message includes clusterId on duplicate", () => {
    const c = makeCluster({ clusterId: "c-xyz" });
    c.addRole(makeRole({ roleId: "x", agentId: "a" }));
    expect(() => c.addRole(makeRole({ roleId: "x", agentId: "b" }))).toThrow(
      /c-xyz/
    );
  });

  it("stores capabilities on added role", () => {
    const c = makeCluster();
    c.addRole(
      makeRole({
        roleId: "worker",
        agentId: "w1",
        capabilities: ["search", "write"],
      })
    );
    expect(c.roles[0]!.capabilities).toEqual(["search", "write"]);
  });

  it("stores role without capabilities (capabilities undefined)", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "simple", agentId: "simple-agent" }));
    expect(c.roles[0]!.capabilities).toBeUndefined();
  });

  it("added role object is a copy, not the original reference", () => {
    const c = makeCluster();
    const role: ClusterRole = { roleId: "r", agentId: "a" };
    c.addRole(role);
    role.agentId = "mutated-after-add";
    expect(c.roles[0]!.agentId).toBe("a");
  });

  it("same agentId can serve different roleIds", () => {
    const c = makeCluster();
    c.addRole({ roleId: "writer", agentId: "multi-agent" });
    c.addRole({ roleId: "reviewer", agentId: "multi-agent" });
    expect(c.roles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. removeRole
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — removeRole", () => {
  it("removes an existing role", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "del", agentId: "a" }));
    c.removeRole("del");
    expect(c.roles).toHaveLength(0);
  });

  it("removes the correct role when multiple exist", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "keep", agentId: "k" }));
    c.addRole(makeRole({ roleId: "del", agentId: "d" }));
    c.removeRole("del");
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0]!.roleId).toBe("keep");
  });

  it("throws when removing a non-existent roleId", () => {
    const c = makeCluster();
    expect(() => c.removeRole("ghost")).toThrow(/ghost/);
  });

  it("error message includes clusterId on missing remove", () => {
    const c = makeCluster({ clusterId: "c-abc" });
    expect(() => c.removeRole("nope")).toThrow(/c-abc/);
  });

  it("can add then remove the same role repeatedly", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "toggle", agentId: "a" }));
    c.removeRole("toggle");
    c.addRole(makeRole({ roleId: "toggle", agentId: "a" }));
    c.removeRole("toggle");
    expect(c.roles).toHaveLength(0);
  });

  it("throws on second remove of same role", () => {
    const c = makeCluster();
    c.addRole(makeRole({ roleId: "once", agentId: "a" }));
    c.removeRole("once");
    expect(() => c.removeRole("once")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. routeMail
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — routeMail", () => {
  it("routes a message and resolves with a MailMessage", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "sender", agentId: "agent-sender" });
    c.addRole({ roleId: "receiver", agentId: "agent-receiver" });

    const msg = await c.routeMail("sender", "receiver", {
      subject: "Hello",
      body: { text: "world" },
    });

    expect(msg.id).toBeTruthy();
    expect(msg.from).toBe("agent-sender");
    expect(msg.to).toBe("agent-receiver");
    expect(msg.subject).toBe("Hello");
    expect(msg.body).toEqual({ text: "world" });
    expect(typeof msg.createdAt).toBe("number");
  });

  it("persists the message in the mailbox", async () => {
    const mailbox = makeMailbox();
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "from", agentId: "agent-from" });
    c.addRole({ roleId: "to", agentId: "agent-to" });

    await c.routeMail("from", "to", { subject: "test", body: {} });

    const stored = await mailbox.findByRecipient("agent-to", {
      unreadOnly: false,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.subject).toBe("test");
  });

  it("throws when sender role is not in cluster", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "to", agentId: "agent-to" });

    await expect(
      c.routeMail("unknown-from", "to", { subject: "s", body: {} })
    ).rejects.toThrow(/unknown-from/);
  });

  it("throws when recipient role is not in cluster", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "from", agentId: "agent-from" });

    await expect(
      c.routeMail("from", "unknown-to", { subject: "s", body: {} })
    ).rejects.toThrow(/unknown-to/);
  });

  it("throws when both roles are missing", async () => {
    const c = makeCluster();
    await expect(
      c.routeMail("no-from", "no-to", { subject: "s", body: {} })
    ).rejects.toThrow();
  });

  it("routes a message with TTL", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "from", agentId: "af" });
    c.addRole({ roleId: "to", agentId: "at" });

    const msg = await c.routeMail("from", "to", {
      subject: "ttl-msg",
      body: {},
      ttl: 60,
    });
    expect(msg.ttl).toBe(60);
  });

  it("routes a message without TTL (omits ttl field)", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const msg = await c.routeMail("f", "t", { subject: "no-ttl", body: {} });
    expect(msg.ttl).toBeUndefined();
  });

  it("message id is unique across multiple dispatches", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        c.routeMail("f", "t", { subject: "x", body: {} }).then((m) => m.id)
      )
    );
    expect(new Set(ids).size).toBe(10);
  });

  it("error message on missing sender includes clusterId", async () => {
    const c = makeCluster({ clusterId: "cluster-xyz" });
    c.addRole({ roleId: "to", agentId: "a-to" });

    await expect(
      c.routeMail("missing", "to", { subject: "x", body: {} })
    ).rejects.toThrow(/cluster-xyz/);
  });

  it("error message on missing recipient includes clusterId", async () => {
    const c = makeCluster({ clusterId: "cluster-xyz" });
    c.addRole({ roleId: "from", agentId: "a-from" });

    await expect(
      c.routeMail("from", "missing", { subject: "x", body: {} })
    ).rejects.toThrow(/cluster-xyz/);
  });

  it("calls mailbox.save exactly once per routeMail", async () => {
    const mailbox = makeMailbox();
    const saveSpy = vi.spyOn(mailbox, "save");
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    await c.routeMail("f", "t", { subject: "x", body: {} });
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("routeMail uses agentId (not roleId) for from/to fields", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "role-sender", agentId: "actual-sender-id" });
    c.addRole({ roleId: "role-receiver", agentId: "actual-receiver-id" });

    const msg = await c.routeMail("role-sender", "role-receiver", {
      subject: "id-check",
      body: {},
    });
    expect(msg.from).toBe("actual-sender-id");
    expect(msg.to).toBe("actual-receiver-id");
  });
});

// ---------------------------------------------------------------------------
// 5. broadcast
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — broadcast", () => {
  it("sends to all roles except sender", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "a", agentId: "agent-a" });
    c.addRole({ roleId: "b", agentId: "agent-b" });
    c.addRole({ roleId: "c", agentId: "agent-c" });

    const msgs = await c.broadcast("a", { subject: "all", body: {} });
    expect(msgs).toHaveLength(2);
    const tos = msgs.map((m) => m.to).sort();
    expect(tos).toEqual(["agent-b", "agent-c"].sort());
  });

  it("all broadcast messages originate from sender agentId", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "sender", agentId: "agent-sender" });
    c.addRole({ roleId: "r1", agentId: "a1" });
    c.addRole({ roleId: "r2", agentId: "a2" });

    const msgs = await c.broadcast("sender", { subject: "x", body: {} });
    for (const msg of msgs) {
      expect(msg.from).toBe("agent-sender");
    }
  });

  it("returns empty array when only sender is in cluster", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "alone", agentId: "solo" });

    const msgs = await c.broadcast("alone", { subject: "echo", body: {} });
    expect(msgs).toHaveLength(0);
  });

  it("throws when broadcast sender role does not exist", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "r1", agentId: "a1" });

    await expect(
      c.broadcast("ghost", { subject: "s", body: {} })
    ).rejects.toThrow(/ghost/);
  });

  it("persists all broadcast messages in the mailbox", async () => {
    const mailbox = makeMailbox();
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "src", agentId: "src-agent" });
    c.addRole({ roleId: "dst1", agentId: "dst1-agent" });
    c.addRole({ roleId: "dst2", agentId: "dst2-agent" });

    await c.broadcast("src", { subject: "broadcast", body: { v: 1 } });

    const m1 = await mailbox.findByRecipient("dst1-agent", {
      unreadOnly: false,
    });
    const m2 = await mailbox.findByRecipient("dst2-agent", {
      unreadOnly: false,
    });
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
  });

  it("each broadcast message has a unique id", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "from", agentId: "af" });
    c.addRole({ roleId: "t1", agentId: "at1" });
    c.addRole({ roleId: "t2", agentId: "at2" });
    c.addRole({ roleId: "t3", agentId: "at3" });

    const msgs = await c.broadcast("from", { subject: "ids", body: {} });
    const ids = msgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("broadcast with TTL passes TTL to each message", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "src", agentId: "src" });
    c.addRole({ roleId: "dst", agentId: "dst" });

    const msgs = await c.broadcast("src", {
      subject: "ttl",
      body: {},
      ttl: 30,
    });
    expect(msgs[0]!.ttl).toBe(30);
  });

  it("broadcast calls mailbox.save once per recipient", async () => {
    const mailbox = makeMailbox();
    const saveSpy = vi.spyOn(mailbox, "save");
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "from", agentId: "af" });
    c.addRole({ roleId: "t1", agentId: "at1" });
    c.addRole({ roleId: "t2", agentId: "at2" });
    c.addRole({ roleId: "t3", agentId: "at3" });

    await c.broadcast("from", { subject: "x", body: {} });
    expect(saveSpy).toHaveBeenCalledTimes(3);
  });

  it("sender is not included in broadcast recipients list", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "src", agentId: "src-agent" });
    c.addRole({ roleId: "dst", agentId: "dst-agent" });

    const msgs = await c.broadcast("src", {
      subject: "self-exclude",
      body: {},
    });
    const tos = msgs.map((m) => m.to);
    expect(tos).not.toContain("src-agent");
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency — multiple simultaneous dispatches
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — concurrency", () => {
  it("handles 20 concurrent routeMail calls without data loss", async () => {
    const mailbox = makeMailbox();
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "sender", agentId: "sender-a" });
    c.addRole({ roleId: "receiver", agentId: "receiver-b" });

    const dispatches = Array.from({ length: 20 }, (_, i) =>
      c.routeMail("sender", "receiver", { subject: `msg-${i}`, body: { i } })
    );
    const msgs = await Promise.all(dispatches);
    expect(msgs).toHaveLength(20);

    const stored = await mailbox.findByRecipient("receiver-b", {
      unreadOnly: false,
      limit: 50,
    });
    expect(stored).toHaveLength(20);
  });

  it("all concurrent messages have unique ids", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const msgs = await Promise.all(
      Array.from({ length: 30 }, () =>
        c.routeMail("f", "t", { subject: "concurrent", body: {} })
      )
    );
    const ids = msgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(30);
  });

  it("concurrent broadcast calls each complete independently", async () => {
    const mailbox = makeMailbox();
    const c = makeCluster({ mailbox });
    c.addRole({ roleId: "src", agentId: "src-a" });
    c.addRole({ roleId: "d1", agentId: "d1-a" });
    c.addRole({ roleId: "d2", agentId: "d2-a" });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        c.broadcast("src", { subject: `bc-${i}`, body: {} })
      )
    );
    // 5 broadcasts × 2 recipients = 10 messages
    const totalMsgs = results.reduce((acc, r) => acc + r.length, 0);
    expect(totalMsgs).toBe(10);
  });

  it("addRole during active routing does not corrupt state", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const routePromise = c.routeMail("f", "t", { subject: "x", body: {} });
    c.addRole({ roleId: "new-role", agentId: "new-agent" });
    await routePromise;

    expect(c.roles).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Cluster type contracts (ClusterRole, AgentCluster interface conformance)
// ---------------------------------------------------------------------------

describe("ClusterRole type contracts", () => {
  it("minimal ClusterRole has roleId and agentId", () => {
    const role: ClusterRole = { roleId: "r", agentId: "a" };
    expect(role.roleId).toBe("r");
    expect(role.agentId).toBe("a");
    expect(role.capabilities).toBeUndefined();
  });

  it("ClusterRole with capabilities array", () => {
    const role: ClusterRole = {
      roleId: "r",
      agentId: "a",
      capabilities: ["search", "generate"],
    };
    expect(role.capabilities).toHaveLength(2);
  });

  it("capabilities can be an empty array", () => {
    const role: ClusterRole = { roleId: "r", agentId: "a", capabilities: [] };
    expect(role.capabilities).toEqual([]);
  });
});

describe("AgentCluster interface conformance", () => {
  it("InMemoryAgentCluster satisfies AgentCluster interface", () => {
    const c: AgentCluster = makeCluster();
    expect(typeof c.clusterId).toBe("string");
    expect(Array.isArray(c.roles)).toBe(true);
    expect(typeof c.addRole).toBe("function");
    expect(typeof c.removeRole).toBe("function");
    expect(typeof c.routeMail).toBe("function");
    expect(typeof c.broadcast).toBe("function");
  });

  it("roles property is readonly (returns frozen-like snapshot)", () => {
    const c: AgentCluster = makeCluster();
    c.addRole({ roleId: "r", agentId: "a" });
    const snap = c.roles;
    expect(snap).toHaveLength(1);
    // Adding another role should not mutate the captured reference (new array each call)
    c.addRole({ roleId: "r2", agentId: "a2" });
    expect(snap).toHaveLength(1);
    expect(c.roles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Multiple isolated clusters
// ---------------------------------------------------------------------------

describe("Multiple cluster isolation", () => {
  it("two clusters with the same roleId do not interfere", async () => {
    const c1 = makeCluster({ clusterId: "c1" });
    const c2 = makeCluster({ clusterId: "c2" });

    c1.addRole({ roleId: "shared-role", agentId: "agent-c1" });
    c2.addRole({ roleId: "shared-role", agentId: "agent-c2" });

    expect(c1.roles[0]!.agentId).toBe("agent-c1");
    expect(c2.roles[0]!.agentId).toBe("agent-c2");
  });

  it("removing a role from one cluster does not affect another", () => {
    const c1 = makeCluster({ clusterId: "c1" });
    const c2 = makeCluster({ clusterId: "c2" });

    c1.addRole({ roleId: "r", agentId: "a" });
    c2.addRole({ roleId: "r", agentId: "a" });
    c1.removeRole("r");

    expect(c1.roles).toHaveLength(0);
    expect(c2.roles).toHaveLength(1);
  });

  it("two clusters can share a mailbox store (different recipient spaces)", async () => {
    const sharedMailbox = makeMailbox();
    const c1 = makeCluster({ clusterId: "c1", mailbox: sharedMailbox });
    const c2 = makeCluster({ clusterId: "c2", mailbox: sharedMailbox });

    c1.addRole({ roleId: "f", agentId: "c1-from" });
    c1.addRole({ roleId: "t", agentId: "c1-to" });
    c2.addRole({ roleId: "f", agentId: "c2-from" });
    c2.addRole({ roleId: "t", agentId: "c2-to" });

    await c1.routeMail("f", "t", { subject: "from-c1", body: {} });
    await c2.routeMail("f", "t", { subject: "from-c2", body: {} });

    const c1msgs = await sharedMailbox.findByRecipient("c1-to", {
      unreadOnly: false,
    });
    const c2msgs = await sharedMailbox.findByRecipient("c2-to", {
      unreadOnly: false,
    });

    expect(c1msgs).toHaveLength(1);
    expect(c2msgs).toHaveLength(1);
    expect(c1msgs[0]!.subject).toBe("from-c1");
    expect(c2msgs[0]!.subject).toBe("from-c2");
  });
});

// ---------------------------------------------------------------------------
// 9. InMemoryMailboxStore — standalone coverage
// ---------------------------------------------------------------------------

describe("InMemoryMailboxStore — save and findByRecipient", () => {
  let store: InMemoryMailboxStore;

  beforeEach(() => {
    store = makeMailbox();
  });

  it("saves and retrieves a message", async () => {
    await store.save({
      id: "msg-1",
      from: "a",
      to: "b",
      subject: "hi",
      body: {},
      createdAt: Date.now(),
    });
    const msgs = await store.findByRecipient("b", { unreadOnly: false });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe("msg-1");
  });

  it("returns empty array for unknown recipient", async () => {
    const msgs = await store.findByRecipient("nobody");
    expect(msgs).toEqual([]);
  });

  it("respects unreadOnly default (true)", async () => {
    const now = Date.now();
    await store.save({
      id: "m1",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
    });
    await store.save({
      id: "m2",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
      readAt: now,
    });

    const unread = await store.findByRecipient("b");
    expect(unread).toHaveLength(1);
    expect(unread[0]!.id).toBe("m1");
  });

  it("returns all messages when unreadOnly is false", async () => {
    const now = Date.now();
    await store.save({
      id: "m1",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
    });
    await store.save({
      id: "m2",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
      readAt: now,
    });

    const all = await store.findByRecipient("b", { unreadOnly: false });
    expect(all).toHaveLength(2);
  });

  it("respects limit parameter", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.save({
        id: `m${i}`,
        from: "a",
        to: "b",
        subject: "s",
        body: {},
        createdAt: now + i,
      });
    }
    const limited = await store.findByRecipient("b", {
      unreadOnly: false,
      limit: 3,
    });
    expect(limited).toHaveLength(3);
  });

  it("default limit is 10", async () => {
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      await store.save({
        id: `m${i}`,
        from: "a",
        to: "b",
        subject: "s",
        body: {},
        createdAt: now + i,
      });
    }
    const results = await store.findByRecipient("b", { unreadOnly: false });
    expect(results).toHaveLength(10);
  });

  it("respects since filter", async () => {
    const base = 1_000_000;
    await store.save({
      id: "old",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: base,
    });
    await store.save({
      id: "new",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: base + 1000,
    });

    const results = await store.findByRecipient("b", {
      unreadOnly: false,
      since: base,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("new");
  });

  it("does not return messages for other recipients", async () => {
    const now = Date.now();
    await store.save({
      id: "m-a",
      from: "x",
      to: "a",
      subject: "s",
      body: {},
      createdAt: now,
    });
    await store.save({
      id: "m-b",
      from: "x",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
    });

    const forA = await store.findByRecipient("a", { unreadOnly: false });
    expect(forA).toHaveLength(1);
    expect(forA[0]!.id).toBe("m-a");
  });
});

describe("InMemoryMailboxStore — markRead", () => {
  it("marks a message as read", async () => {
    const store = makeMailbox();
    const now = Date.now();
    await store.save({
      id: "r1",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: now,
    });
    await store.markRead("r1");

    const unread = await store.findByRecipient("b");
    expect(unread).toHaveLength(0);

    const all = await store.findByRecipient("b", { unreadOnly: false });
    expect(all[0]!.readAt).toBeDefined();
  });

  it("markRead for unknown id does not throw", async () => {
    const store = makeMailbox();
    await expect(store.markRead("nonexistent")).resolves.toBeUndefined();
  });

  it("readAt is set to a recent timestamp after markRead", async () => {
    const store = makeMailbox();
    const before = Date.now();
    await store.save({
      id: "m",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: before,
    });
    await store.markRead("m");

    const all = await store.findByRecipient("b", { unreadOnly: false });
    expect(all[0]!.readAt).toBeGreaterThanOrEqual(before);
  });
});

describe("InMemoryMailboxStore — TTL and deleteExpired", () => {
  it("expired messages are filtered from findByRecipient", async () => {
    const store = makeMailbox();
    const longAgo = Date.now() - 10_000; // 10 seconds ago
    await store.save({
      id: "expired",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: longAgo,
      ttl: 1, // 1 second TTL — already expired
    });

    const msgs = await store.findByRecipient("b", { unreadOnly: false });
    expect(msgs).toHaveLength(0);
  });

  it("non-expired messages are returned normally", async () => {
    const store = makeMailbox();
    await store.save({
      id: "valid",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: Date.now(),
      ttl: 60, // 60 seconds from now
    });

    const msgs = await store.findByRecipient("b", { unreadOnly: false });
    expect(msgs).toHaveLength(1);
  });

  it("deleteExpired removes expired messages and returns count", async () => {
    const store = makeMailbox();
    const longAgo = Date.now() - 10_000;
    await store.save({
      id: "e1",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: longAgo,
      ttl: 1,
    });
    await store.save({
      id: "e2",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: longAgo,
      ttl: 1,
    });
    await store.save({
      id: "ok",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: Date.now(),
      ttl: 999,
    });

    const count = await store.deleteExpired();
    expect(count).toBe(2);

    const remaining = await store.findByRecipient("b", { unreadOnly: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("ok");
  });

  it("deleteExpired returns 0 when nothing is expired", async () => {
    const store = makeMailbox();
    await store.save({
      id: "m",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: Date.now(),
      ttl: 999,
    });

    const count = await store.deleteExpired();
    expect(count).toBe(0);
  });

  it("deleteExpired returns 0 on empty store", async () => {
    const store = makeMailbox();
    const count = await store.deleteExpired();
    expect(count).toBe(0);
  });

  it("messages without TTL never expire", async () => {
    const store = makeMailbox();
    const longAgo = Date.now() - 1_000_000;
    await store.save({
      id: "no-ttl",
      from: "a",
      to: "b",
      subject: "s",
      body: {},
      createdAt: longAgo,
    });

    const msgs = await store.findByRecipient("b", { unreadOnly: false });
    expect(msgs).toHaveLength(1);

    const count = await store.deleteExpired();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Cluster with initial roles from config
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — initial roles from config", () => {
  it("registers all initial roles", () => {
    const c = makeCluster({
      roles: [
        { roleId: "planner", agentId: "a-planner" },
        { roleId: "coder", agentId: "a-coder" },
        { roleId: "reviewer", agentId: "a-reviewer" },
      ],
    });
    expect(c.roles).toHaveLength(3);
    const ids = c.roles.map((r) => r.roleId).sort();
    expect(ids).toEqual(["coder", "planner", "reviewer"]);
  });

  it("can add new roles after initial registration", () => {
    const c = makeCluster({
      roles: [{ roleId: "existing", agentId: "a-existing" }],
    });
    c.addRole({ roleId: "new", agentId: "a-new" });
    expect(c.roles).toHaveLength(2);
  });

  it("last-write-wins when duplicate roleId provided in initial roles", () => {
    // The constructor uses Map.set() directly (not addRole), so the second
    // entry silently overwrites the first — resulting in one role with a2.
    const c = makeCluster({
      roles: [
        { roleId: "dup", agentId: "a1" },
        { roleId: "dup", agentId: "a2" },
      ],
    });
    expect(c.roles).toHaveLength(1);
    expect(c.roles[0]!.agentId).toBe("a2");
  });

  it("can routeMail between initial roles immediately", async () => {
    const c = makeCluster({
      roles: [
        { roleId: "from", agentId: "agent-from" },
        { roleId: "to", agentId: "agent-to" },
      ],
    });
    const msg = await c.routeMail("from", "to", { subject: "init", body: {} });
    expect(msg.from).toBe("agent-from");
    expect(msg.to).toBe("agent-to");
  });

  it("can broadcast from initial roles immediately", async () => {
    const c = makeCluster({
      roles: [
        { roleId: "src", agentId: "agent-src" },
        { roleId: "dst1", agentId: "agent-dst1" },
        { roleId: "dst2", agentId: "agent-dst2" },
      ],
    });
    const msgs = await c.broadcast("src", { subject: "hello", body: {} });
    expect(msgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 11. Error resilience — mailbox failure
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — mailbox failure propagation", () => {
  it("routeMail propagates mailbox.save rejection", async () => {
    const failingMailbox: MailboxStore = {
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      findByRecipient: vi.fn().mockResolvedValue([]),
      markRead: vi.fn().mockResolvedValue(undefined),
      deleteExpired: vi.fn().mockResolvedValue(0),
    };
    const c = makeCluster({ mailbox: failingMailbox });
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    await expect(
      c.routeMail("f", "t", { subject: "x", body: {} })
    ).rejects.toThrow("disk full");
  });

  it("broadcast propagates mailbox.save rejection on first message", async () => {
    const failingMailbox: MailboxStore = {
      save: vi.fn().mockRejectedValue(new Error("io error")),
      findByRecipient: vi.fn().mockResolvedValue([]),
      markRead: vi.fn().mockResolvedValue(undefined),
      deleteExpired: vi.fn().mockResolvedValue(0),
    };
    const c = makeCluster({ mailbox: failingMailbox });
    c.addRole({ roleId: "src", agentId: "src-agent" });
    c.addRole({ roleId: "dst", agentId: "dst-agent" });

    await expect(
      c.broadcast("src", { subject: "x", body: {} })
    ).rejects.toThrow("io error");
  });
});

// ---------------------------------------------------------------------------
// 12. Subject and body pass-through
// ---------------------------------------------------------------------------

describe("InMemoryAgentCluster — payload fidelity", () => {
  it("preserves complex body structure", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const body = {
      nested: { deep: { value: 42 } },
      list: [1, 2, 3],
      flag: true,
    };
    const msg = await c.routeMail("f", "t", { subject: "complex", body });
    expect(msg.body).toEqual(body);
  });

  it("preserves subject exactly", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const subject = "Task: re-run pipeline for job #42 — urgent!";
    const msg = await c.routeMail("f", "t", { subject, body: {} });
    expect(msg.subject).toBe(subject);
  });

  it("createdAt is set to recent timestamp", async () => {
    const before = Date.now();
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const msg = await c.routeMail("f", "t", { subject: "ts", body: {} });
    const after = Date.now();

    expect(msg.createdAt).toBeGreaterThanOrEqual(before);
    expect(msg.createdAt).toBeLessThanOrEqual(after);
  });

  it("readAt is omitted when not provided", async () => {
    const c = makeCluster();
    c.addRole({ roleId: "f", agentId: "af" });
    c.addRole({ roleId: "t", agentId: "at" });

    const msg = await c.routeMail("f", "t", { subject: "x", body: {} });
    expect(msg.readAt).toBeUndefined();
  });
});

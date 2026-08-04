import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLivePostgresClient,
  createLiveRedisClient,
} from "../sdlc-mvp-evidence.js";

/**
 * Covers the two live-backend client factories (DZUPAGENT-TEST-C-15 floor
 * work), which sit alongside the RESP protocol coverage in
 * `sdlc-mvp-evidence-resp.test.ts`:
 *
 *  - `createLivePostgresClient` dynamically imports `pg` (via
 *    `new Function('specifier', 'return import(specifier)')`) and wires
 *    connect/query/close. That dynamic-import construction deliberately
 *    escapes static analysis (it's how the module avoids a hard `pg`
 *    dependency at parse time), which also means `vi.mock('pg', ...)`
 *    cannot intercept it — the call reaches the real installed `pg`
 *    package. The connection-refused case below is deterministic and
 *    portable (no server listening on the port) and proves the
 *    connect-error propagation path without needing credentials. The
 *    happy-path wiring (query/close) is proven against the workspace's
 *    local dev Postgres on :5432 using its default trust-auth
 *    `postgres:postgres` credentials (see workspace memory: "Dev PG
 *    :5432"); it is skipped automatically if that instance is not reachable
 *    so the file stays portable across environments.
 *  - `createLiveRedisClient`'s AUTH/SELECT-on-connect branches (when the
 *    connection URL carries a password or a DB path segment) are exercised
 *    here since the sibling RESP file's `connect()` helper never passes
 *    those.
 */

const DEV_POSTGRES_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";

async function isDevPostgresReachable(): Promise<boolean> {
  try {
    const client = await createLivePostgresClient(DEV_POSTGRES_URL);
    await client.close();
    return true;
  } catch {
    return false;
  }
}

describe("createLivePostgresClient", () => {
  it("propagates a connection failure instead of swallowing it", async () => {
    // Nothing listening on this port — connect() rejects before any
    // credential exchange, so this is deterministic without needing a
    // real database.
    await expect(
      createLivePostgresClient("postgres://user:pass@127.0.0.1:1/db")
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("connects, runs a query, and closes cleanly against a real Postgres instance", async () => {
    if (!(await isDevPostgresReachable())) {
      // eslint-disable-next-line no-console
      console.warn(
        "[sdlc-mvp-evidence-live-clients] dev Postgres on :5432 not reachable — skipping happy-path wiring assertion"
      );
      return;
    }
    const client = await createLivePostgresClient(DEV_POSTGRES_URL);
    try {
      const result = (await client.query("SELECT 1 + 1 AS sum", [])) as {
        rows: Array<{ sum: number }>;
      };
      expect(result.rows).toEqual([{ sum: 2 }]);
    } finally {
      await client.close();
    }
  });
});

describe("createLiveRedisClient — connection-time AUTH/SELECT", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  async function startScriptedServer(
    onCommand: (command: string, args: string[]) => string
  ): Promise<string> {
    server = createServer((socket: Socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        // A full RESP array command ends in the trailing element's \r\n once
        // all declared parts have arrived.
        const headerMatch = /^\*(\d+)\r\n/.exec(buffer);
        if (!headerMatch) return;
        const count = Number(headerMatch[1]);
        const parts: string[] = [];
        let rest = buffer.slice(headerMatch[0].length);
        for (let i = 0; i < count; i += 1) {
          const lenMatch = /^\$(\d+)\r\n/.exec(rest);
          if (!lenMatch) return; // incomplete
          const len = Number(lenMatch[1]);
          const afterHeader = rest.slice(lenMatch[0].length);
          if (afterHeader.length < len + 2) return; // incomplete
          parts.push(afterHeader.slice(0, len));
          rest = afterHeader.slice(len + 2);
        }
        buffer = rest;
        const [command, ...args] = parts;
        socket.write(onCommand(command ?? "", args));
      });
    });
    return new Promise((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(`redis://127.0.0.1:${port}`);
      });
    });
  }

  it("sends AUTH with the URL password before any other command", async () => {
    const seenCommands: string[] = [];
    const url = await startScriptedServer((command) => {
      seenCommands.push(command);
      return "+OK\r\n";
    });
    const withAuth = url.replace("//", "//:secret@");

    const client = await createLiveRedisClient(withAuth);
    try {
      expect(seenCommands).toEqual(["AUTH"]);
    } finally {
      client.close();
    }
  });

  it("sends SELECT with the URL path segment as the DB index", async () => {
    const seenCommands: Array<{ command: string; args: string[] }> = [];
    const url = await startScriptedServer((command, args) => {
      seenCommands.push({ command, args });
      return "+OK\r\n";
    });
    const withDb = `${url}/3`;

    const client = await createLiveRedisClient(withDb);
    try {
      expect(seenCommands).toEqual([{ command: "SELECT", args: ["3"] }]);
    } finally {
      client.close();
    }
  });

  it("sends both AUTH and SELECT, in that order, when both are present", async () => {
    const seenCommands: string[] = [];
    const url = await startScriptedServer((command) => {
      seenCommands.push(command);
      return "+OK\r\n";
    });
    const withBoth = url.replace("//", "//:secret@") + "/2";

    const client = await createLiveRedisClient(withBoth);
    try {
      expect(seenCommands).toEqual(["AUTH", "SELECT"]);
    } finally {
      client.close();
    }
  });

  it("issues no AUTH/SELECT when the URL has neither a password nor a db path", async () => {
    const seenCommands: string[] = [];
    const url = await startScriptedServer((command) => {
      seenCommands.push(command);
      return "+OK\r\n";
    });

    const client = await createLiveRedisClient(url);
    try {
      // Send one real command; if AUTH/SELECT had fired they'd be visible
      // ahead of it.
      await client.set("k", "v");
      expect(seenCommands).toEqual(["SET"]);
    } finally {
      client.close();
    }
  });

  it("rejects when the TCP connection itself fails", async () => {
    // Nothing listening on this port.
    await expect(
      createLiveRedisClient("redis://127.0.0.1:1")
    ).rejects.toThrow();
  });
});

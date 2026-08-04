import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createLiveRedisClient } from "../sdlc-mvp-evidence.js";

/**
 * RESP protocol coverage for the minimal Redis client embedded in
 * `sdlc-mvp-evidence.ts` (DZUPAGENT-TEST-C-15 floor work).
 *
 * The parsers (`parseRedisReply` / `parseBulkRedisReply` /
 * `parseArrayRedisReply` / `redisReplyLength`) are module-private and are only
 * reached through a live socket, which is why they sat uncovered despite being
 * pure Buffer→value logic. Rather than export internals for the test, these
 * drive the real client against a local TCP server serving canned RESP bytes —
 * the same seam production uses, so the wire encoding is proven too.
 *
 * These matter because a parser bug does not throw: it silently yields the
 * wrong value for a checkpoint-verification reply, and the evidence report
 * then attests to a backend state that was never actually observed.
 */

/**
 * Start a server that replies to each command with scripted bytes.
 * `chunks` may split one reply across writes to exercise the incomplete-buffer
 * reassembly path in `writeCommand`'s `onData` handler.
 */
function startRespServer(replies: Array<string | string[]>): Promise<{
  server: Server;
  url: string;
  received: Buffer[];
}> {
  const received: Buffer[] = [];
  let index = 0;
  const server = createServer((socket: Socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk);
      const reply = replies[index++] ?? "+OK\r\n";
      const parts = Array.isArray(reply) ? reply : [reply];
      // Write split replies one event-loop turn apart so the client's `data`
      // handler actually runs on the partial buffer between chunks. The flush
      // callback alone is NOT enough — chunks coalesce into a single `data`
      // event and the reassembly path is never exercised, which silently makes
      // the split-chunk tests vacuous. setImmediate yields a full turn without
      // introducing the wall-clock dependency a timer would.
      const writeNext = (i: number) => {
        if (i >= parts.length) return;
        socket.write(parts[i] as string, () => {
          if (i + 1 < parts.length) setImmediate(() => writeNext(i + 1));
        });
      };
      writeNext(0);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `redis://127.0.0.1:${port}`, received });
    });
  });
}

const openServers: Server[] = [];
const openClients: Array<{ close(): void }> = [];

async function connect(replies: Array<string | string[]>) {
  const { server, url, received } = await startRespServer(replies);
  openServers.push(server);
  const client = await createLiveRedisClient(url);
  openClients.push(client);
  return { client, received };
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("LiveRedisClient — command encoding", () => {
  it("encodes commands as RESP arrays with byte-length prefixes", async () => {
    const { client, received } = await connect(["+OK\r\n"]);
    await client.set("k", "v");
    const wire = Buffer.concat(received).toString("utf8");
    expect(wire).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n");
  });

  it("uses byte length, not character length, for multi-byte values", async () => {
    const { client, received } = await connect(["+OK\r\n"]);
    await client.set("k", "é"); // 1 char, 2 bytes
    const wire = Buffer.concat(received).toString("utf8");
    expect(wire).toContain("$2\r\né\r\n");
  });

  it("stringifies numeric arguments", async () => {
    const { client, received } = await connect([":1\r\n"]);
    await client.expire("k", 60);
    const wire = Buffer.concat(received).toString("utf8");
    expect(wire).toBe("*3\r\n$6\r\nEXPIRE\r\n$1\r\nk\r\n$2\r\n60\r\n");
  });
});

describe("LiveRedisClient — reply parsing", () => {
  it("parses a simple string reply", async () => {
    const { client } = await connect(["+OK\r\n"]);
    await expect(client.set("k", "v")).resolves.toBe("OK");
  });

  it("parses an integer reply", async () => {
    const { client } = await connect([":3\r\n"]);
    await expect(client.del("a", "b", "c")).resolves.toBe(3);
  });

  it("parses a bulk string reply", async () => {
    const { client } = await connect(["$5\r\nhello\r\n"]);
    await expect(client.get("k")).resolves.toBe("hello");
  });

  it("parses a null bulk reply as null, not the string 'null'", async () => {
    const { client } = await connect(["$-1\r\n"]);
    await expect(client.get("missing")).resolves.toBeNull();
  });

  it("parses an empty bulk string as '' rather than null", async () => {
    const { client } = await connect(["$0\r\n\r\n"]);
    await expect(client.get("empty")).resolves.toBe("");
  });

  it("parses an array reply", async () => {
    const { client } = await connect(["*2\r\n$1\r\na\r\n$1\r\nb\r\n"]);
    await expect(client.smembers("s")).resolves.toEqual(["a", "b"]);
  });

  it("parses an empty array reply", async () => {
    const { client } = await connect(["*0\r\n"]);
    await expect(client.zrange("z", 0, -1)).resolves.toEqual([]);
  });

  it("parses an array containing a null bulk element", async () => {
    const { client } = await connect(["*2\r\n$-1\r\n$1\r\nb\r\n"]);
    await expect(client.zrange("z", 0, -1)).resolves.toEqual([null, "b"]);
  });

  it("parses a nested array reply", async () => {
    const { client } = await connect(["*2\r\n*1\r\n$1\r\na\r\n:7\r\n"]);
    await expect(client.zrange("z", 0, -1)).resolves.toEqual([["a"], 7]);
  });

  it("parses an array of integers", async () => {
    const { client } = await connect(["*2\r\n:1\r\n:2\r\n"]);
    await expect(client.zrange("z", 0, -1)).resolves.toEqual([1, 2]);
  });
});

describe("LiveRedisClient — error replies", () => {
  it("rejects with the server error message", async () => {
    const { client } = await connect(["-WRONGTYPE not a set\r\n"]);
    await expect(client.smembers("k")).rejects.toThrow("WRONGTYPE not a set");
  });

  it("rejects when an error appears inside an array reply", async () => {
    const { client } = await connect(["*2\r\n$1\r\na\r\n-ERR nested\r\n"]);
    await expect(client.zrange("z", 0, -1)).rejects.toThrow("ERR nested");
  });

  it("reports an unsupported reply prefix rather than hanging", async () => {
    const { client } = await connect(["%1\r\n"]);
    await expect(client.get("k")).rejects.toThrow(
      /Unsupported Redis reply prefix/
    );
  });
});

describe("LiveRedisClient — partial buffer reassembly", () => {
  it("waits for the rest of a bulk reply split across TCP chunks", async () => {
    const { client } = await connect([["$5\r\nhel", "lo\r\n"]]);
    await expect(client.get("k")).resolves.toBe("hello");
  });

  it("waits when the split lands mid-header", async () => {
    const { client } = await connect([["$5", "\r\nhello\r\n"]]);
    await expect(client.get("k")).resolves.toBe("hello");
  });

  it("waits for a simple string split before its terminator", async () => {
    const { client } = await connect([["+O", "K\r\n"]]);
    await expect(client.set("k", "v")).resolves.toBe("OK");
  });

  it("reassembles an array delivered one element per chunk", async () => {
    const { client } = await connect([
      ["*2\r\n", "$1\r\na\r\n", "$1\r\nb\r\n"],
    ]);
    await expect(client.smembers("s")).resolves.toEqual(["a", "b"]);
  });
});

describe("LiveRedisClient — command sequencing", () => {
  it("serialises concurrent commands so replies are not cross-matched", async () => {
    const { client } = await connect(["$1\r\na\r\n", "$1\r\nb\r\n"]);
    const [first, second] = await Promise.all([
      client.get("first"),
      client.get("second"),
    ]);
    expect(first).toBe("a");
    expect(second).toBe("b");
  });

  it("keeps the queue usable after a rejected command", async () => {
    const { client } = await connect(["-ERR boom\r\n", "+OK\r\n"]);
    await expect(client.get("bad")).rejects.toThrow("ERR boom");
    await expect(client.set("k", "v")).resolves.toBe("OK");
  });
});

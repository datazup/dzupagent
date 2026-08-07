/**
 * SHARED-KIT-AGENT-M-74 — an embedding provider must not hang forever.
 *
 * The failure this covers is not a slow response but a socket that is accepted
 * and then never answered: bare `fetch()` has no default timeout, so the
 * promise stays pending and the memory write path stalls with no error and no
 * log line. Each case here uses a real HTTP server that deliberately never
 * responds — a mocked fetch would prove nothing about the property at issue.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchWithEmbeddingTimeout,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
} from "../embeddings/request-timeout.js";
import { createInternalEmbedding } from "../embeddings/internal-embedding.js";
import { ForgeError } from "../../errors/forge-error.js";

let server: Server | undefined;

/** A server that accepts the connection and then never writes a response. */
async function startBlackHole(): Promise<string> {
  server = createServer(() => {
    /* deliberately no response, ever */
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.closeAllConnections?.();
      server!.close(() => resolve());
    });
    server = undefined;
  }
});

describe("fetchWithEmbeddingTimeout", () => {
  it("aborts a request that never gets a response", async () => {
    const baseUrl = await startBlackHole();
    const started = Date.now();

    await expect(
      fetchWithEmbeddingTimeout(
        `${baseUrl}/embed`,
        { method: "POST", body: "{}" },
        "test-provider",
        150,
      ),
    ).rejects.toBeInstanceOf(ForgeError);

    // The point of the fix: it returns, and it returns near the deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("classifies the timeout as recoverable so retry loops handle it", async () => {
    const baseUrl = await startBlackHole();
    try {
      await fetchWithEmbeddingTimeout(
        `${baseUrl}/embed`,
        { method: "POST", body: "{}" },
        "test-provider",
        150,
      );
      throw new Error("expected a timeout");
    } catch (err) {
      const forge = err as ForgeError;
      expect(forge.code).toBe("PROVIDER_TIMEOUT");
      expect(forge.recoverable).toBe(true);
      expect(forge.message).toContain("test-provider");
      expect(forge.message).toContain("150ms");
    }
  });

  it("passes a normal response straight through", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;

    const response = await fetchWithEmbeddingTimeout(
      `http://127.0.0.1:${port}/embed`,
      { method: "POST", body: "{}" },
      "test-provider",
      5_000,
    );
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("re-throws a caller's own cancellation as a cancellation", async () => {
    const baseUrl = await startBlackHole();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 50);

    // Not a ForgeError: the caller asked for this, so it must not be reported
    // as an upstream timeout (and must not be retried as one).
    await expect(
      fetchWithEmbeddingTimeout(
        `${baseUrl}/embed`,
        { method: "POST", body: "{}", signal: caller.signal },
        "test-provider",
        30_000,
      ),
    ).rejects.not.toBeInstanceOf(ForgeError);
  });

  it("has a default deadline at all", () => {
    expect(DEFAULT_EMBEDDING_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("provider wiring", () => {
  it("createInternalEmbedding honours its timeoutMs", async () => {
    const baseUrl = await startBlackHole();
    const provider = createInternalEmbedding({
      baseUrl,
      timeoutMs: 150,
      // Without this the recoverable timeout would be retried with backoff and
      // the test would measure the retry schedule rather than the deadline.
      maxRetries: 0,
    });

    await expect(provider.embed(["hello"])).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
    });
  });
});

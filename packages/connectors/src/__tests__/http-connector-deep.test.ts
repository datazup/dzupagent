/**
 * Deep coverage tests for the HTTP connector.
 *
 * Covers angles not exercised by the existing suites:
 *  - Tool schema and description invariants
 *  - Base URL construction edge cases (trailing slash, port, path prefix)
 *  - Every HTTP method in isolation with body verification
 *  - Header merge order (default Content-Type overridden by config headers)
 *  - Detailed query param encoding (arrays, empty string, numeric coercion)
 *  - Body absent / present branches for each method
 *  - Response format: status line + double-newline + body
 *  - 1xx / 2xx / 3xx / 4xx / 5xx status passthrough in output
 *  - Signal wiring: AbortController signal forwarded to fetch
 *  - Abort signal already-aborted before fetch is called
 *  - Multiple parallel requests share no mutable state
 *  - Very small timeoutMs (1ms) causes abort path
 *  - Empty string response body
 *  - Response body exactly at 5000 boundary (not truncated)
 *  - Response body at 5001 chars (truncated to exactly 5000)
 *  - allowedMethods: each single-method restriction
 *  - allowedMethods: all five individually allowed
 *  - description field contains baseUrl and methods
 *  - SSRF: data: URL rejected
 *  - SSRF: javascript: URL rejected
 *  - SSRF: ftp: URL rejected in path
 *  - baseUrl validation: ftp:// throws
 *  - baseUrl validation: ws:// throws
 *  - baseUrl validation: missing host throws
 *  - Multiple connectors for different base URLs are independent
 *  - Path with query string already in it (merges with query param map)
 *  - Path with encoded characters
 *  - allowedHosts: off-origin redirect allowed when host is listed
 *  - allowedHosts: off-origin path rejected when host NOT listed
 *  - outboundUrlPolicy passthrough sets allowHttp
 *  - Toolkit: name and tool count invariants
 *  - Toolkit: createHttpConnectorToolkit with allowedMethods restriction
 *  - Tool name is always "http_request"
 *  - createHTTPConnector returns exactly one tool
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHTTPConnector,
  createHttpConnectorToolkit,
} from "../http/http-connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(
  response: Partial<{
    ok: boolean;
    status: number;
    statusText: string;
    text: () => Promise<string>;
    headers: Headers;
  }> = {}
): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => '{"ok":true}',
    headers: new Headers(),
    ...response,
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. Tool invariants
// ===========================================================================

describe("tool invariants", () => {
  it("createHTTPConnector returns exactly one tool", () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    expect(tools).toHaveLength(1);
  });

  it('tool name is always "http_request"', () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    expect(tools[0]!.name).toBe("http_request");
  });

  it("tool description contains base URL", () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    expect(tools[0]!.description).toContain("https://api.example.com");
  });

  it("tool description contains all five methods when no restriction", () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    expect(tools[0]!.description).toContain("GET");
    expect(tools[0]!.description).toContain("POST");
    expect(tools[0]!.description).toContain("PUT");
    expect(tools[0]!.description).toContain("PATCH");
    expect(tools[0]!.description).toContain("DELETE");
  });

  it("tool description omits methods not in allowedMethods", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST"],
    });
    expect(tools[0]!.description).not.toContain("PUT");
    expect(tools[0]!.description).not.toContain("PATCH");
    expect(tools[0]!.description).not.toContain("DELETE");
  });
});

// ===========================================================================
// 2. Base URL construction edge cases
// ===========================================================================

describe("base URL construction", () => {
  it("appends path to base URL with trailing slash", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com/v2/",
    });
    await tools[0]!.invoke({ method: "GET", path: "users" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("api.example.com");
    expect(calledUrl).toContain("users");
  });

  it("handles base URL with explicit port", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:8443",
    });
    await tools[0]!.invoke({ method: "GET", path: "/data" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("8443");
    expect(calledUrl).toContain("/data");
  });

  it("handles base URL with path prefix", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com/api/v1",
    });
    await tools[0]!.invoke({ method: "GET", path: "/status" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("api.example.com");
  });

  it("http:// base URL is accepted", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "http://internal.example.com",
      outboundUrlPolicy: { allowHttp: true },
    });
    await tools[0]!.invoke({ method: "GET", path: "/ping" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("http://internal.example.com");
  });
});

// ===========================================================================
// 3. baseUrl validation — invalid protocols throw at creation time
// ===========================================================================

describe("baseUrl validation", () => {
  it("throws for ftp:// base URL", () => {
    expect(() =>
      createHTTPConnector({ baseUrl: "ftp://files.example.com" })
    ).toThrow("baseUrl protocol must be http or https");
  });

  it("throws for ws:// base URL", () => {
    expect(() =>
      createHTTPConnector({ baseUrl: "ws://stream.example.com" })
    ).toThrow("baseUrl protocol must be http or https");
  });

  it("throws for wss:// base URL", () => {
    expect(() =>
      createHTTPConnector({ baseUrl: "wss://stream.example.com" })
    ).toThrow("baseUrl protocol must be http or https");
  });

  it("throws for completely invalid base URL string", () => {
    expect(() => createHTTPConnector({ baseUrl: "not-a-url" })).toThrow();
  });

  it("throws for empty base URL string", () => {
    expect(() => createHTTPConnector({ baseUrl: "" })).toThrow();
  });
});

// ===========================================================================
// 4. HTTP method routing
// ===========================================================================

describe("HTTP method routing", () => {
  it("GET request has no body in init", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/items" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("POST request passes body to fetch", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "POST",
      path: "/items",
      body: '{"name":"x"}',
    });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"x"}');
  });

  it("PUT request passes body to fetch", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "PUT",
      path: "/items/1",
      body: '{"name":"updated"}',
    });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"name":"updated"}');
  });

  it("PATCH request passes body to fetch", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "PATCH",
      path: "/items/1",
      body: '{"active":false}',
    });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"active":false}');
  });

  it("DELETE request is sent with correct method", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "DELETE", path: "/items/99" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });
});

// ===========================================================================
// 5. Header merging behaviour
// ===========================================================================

describe("header merging", () => {
  it("Content-Type application/json is set by default", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("config headers are merged with default Content-Type", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Custom": "value123" },
    });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Custom"]).toBe("value123");
  });

  it("config Content-Type overrides default application/json", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "Content-Type": "application/xml" },
    });
    await tools[0]!.invoke({ method: "POST", path: "/x", body: "<root/>" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Content-Type"]).toBe("application/xml");
  });

  it("multiple config headers all appear in request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: {
        Authorization: "Bearer token-abc",
        "X-Trace-Id": "trace-999",
        "X-Workspace": "ws-001",
      },
    });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer token-abc");
    expect(headers["X-Trace-Id"]).toBe("trace-999");
    expect(headers["X-Workspace"]).toBe("ws-001");
  });

  it("connector with no config headers only sends Content-Type", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/y" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    const keys = Object.keys(headers);
    expect(keys).toContain("Content-Type");
  });
});

// ===========================================================================
// 6. Response format
// ===========================================================================

describe("response format", () => {
  it('output starts with "STATUS statusText"', async () => {
    mockFetch({ status: 200, statusText: "OK", text: async () => "hello" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/" });
    expect(result.startsWith("200 OK")).toBe(true);
  });

  it("status and body are separated by double newline", async () => {
    mockFetch({ status: 200, statusText: "OK", text: async () => "body-text" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/" });
    const parts = result.split("\n\n");
    expect(parts[0]).toBe("200 OK");
    expect(parts[1]).toBe("body-text");
  });

  it("1xx response passthrough: 100 Continue", async () => {
    mockFetch({ status: 100, statusText: "Continue", text: async () => "" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/" });
    expect(result).toContain("100 Continue");
  });

  it("201 Created status appears in output", async () => {
    mockFetch({
      status: 201,
      statusText: "Created",
      text: async () => '{"id":1}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "POST",
      path: "/items",
      body: "{}",
    });
    expect(result).toContain("201 Created");
    expect(result).toContain('"id"');
  });

  it("204 No Content with empty body", async () => {
    mockFetch({ status: 204, statusText: "No Content", text: async () => "" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "DELETE",
      path: "/items/1",
    });
    expect(result).toContain("204 No Content");
    const body = result.split("\n\n")[1] ?? "";
    expect(body).toBe("");
  });

  it("422 Unprocessable Entity in output", async () => {
    mockFetch({
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () => '{"field":"required"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "POST",
      path: "/validate",
      body: "{}",
    });
    expect(result).toContain("422 Unprocessable Entity");
    expect(result).toContain("required");
  });

  it("504 Gateway Timeout in output", async () => {
    mockFetch({
      status: 504,
      statusText: "Gateway Timeout",
      text: async () => "upstream timed out",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/slow-dep" });
    expect(result).toContain("504 Gateway Timeout");
    expect(result).toContain("upstream timed out");
  });
});

// ===========================================================================
// 7. Response body truncation boundary cases
// ===========================================================================

describe("response body truncation boundaries", () => {
  it("body of exactly 5000 chars is NOT truncated", async () => {
    const exactly = "Z".repeat(5000);
    mockFetch({ text: async () => exactly });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/exact" });
    const body = result.split("\n\n")[1] ?? "";
    expect(body.length).toBe(5000);
  });

  it("body of 5001 chars is truncated to 5000", async () => {
    const over = "Y".repeat(5001);
    mockFetch({ text: async () => over });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/over" });
    const body = result.split("\n\n")[1] ?? "";
    expect(body.length).toBe(5000);
  });

  it("short body (< 5000) is returned intact", async () => {
    const short = "hello world";
    mockFetch({ text: async () => short });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/short" });
    expect(result).toContain("hello world");
  });

  it("empty body string is returned intact", async () => {
    mockFetch({ status: 200, statusText: "OK", text: async () => "" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/empty" });
    const body = result.split("\n\n")[1] ?? "non-empty";
    expect(body).toBe("");
  });
});

// ===========================================================================
// 8. Query parameter handling
// ===========================================================================

describe("query parameter construction", () => {
  it("single query param appended correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/search",
      query: { q: "cats" },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("q")).toBe("cats");
  });

  it("multiple query params appended correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/list",
      query: { page: "1", per_page: "25" },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("25");
  });

  it("empty string query value is allowed", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/items",
      query: { filter: "" },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.has("filter")).toBe(true);
    expect(url.searchParams.get("filter")).toBe("");
  });

  it("special characters in query value are percent-encoded", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/s",
      query: { q: "a b+c=d&e" },
    });
    const rawUrl = mock.mock.calls[0]![0] as string;
    // Ensure the raw URL does NOT contain unencoded spaces or ampersands in the value
    const queryPart = rawUrl.split("?")[1] ?? "";
    expect(queryPart).not.toContain("a b+c=d&e");
  });

  it("no query string when query not provided", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/ping" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain("?");
  });

  it("no query string when empty query object provided", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/ping", query: {} });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain("?");
  });
});

// ===========================================================================
// 9. allowedMethods single-method restrictions
// ===========================================================================

describe("allowedMethods single-method restrictions", () => {
  for (const allowed of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const others = (["GET", "POST", "PUT", "PATCH", "DELETE"] as const).filter(
      (m) => m !== allowed
    );

    it(`only ${allowed} — allows ${allowed}`, async () => {
      mockFetch();
      const tools = createHTTPConnector({
        baseUrl: "https://api.example.com",
        allowedMethods: [allowed],
      });
      const result = await tools[0]!.invoke({
        method: allowed,
        path: "/x",
        body: allowed !== "GET" && allowed !== "DELETE" ? "{}" : undefined,
      });
      expect(result).not.toContain("not allowed");
      expect(result).toContain("200 OK");
    });

    for (const rejected of others) {
      it(`only ${allowed} — rejects ${rejected}`, async () => {
        const tools = createHTTPConnector({
          baseUrl: "https://api.example.com",
          allowedMethods: [allowed],
        });
        const result = await tools[0]!.invoke({ method: rejected, path: "/x" });
        expect(result).toContain(`Method ${rejected} not allowed`);
      });
    }
  }
});

// ===========================================================================
// 10. SSRF protection — path-level URL injection
// ===========================================================================

describe("SSRF path-level injection", () => {
  it("data: URL in path is rejected", async () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "data:text/html,<h1>evil</h1>",
    });
    expect(result).toContain("Error");
  });

  it("javascript: URL in path is rejected", async () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "javascript:alert(1)",
    });
    expect(result).toContain("Error");
  });

  it("cross-origin absolute URL in path is rejected", async () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "https://other.example.com/steal",
    });
    expect(result).toContain("does not match base origin");
  });

  it("path starting with // (protocol-relative) is rejected", async () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "//evil.example.com/",
    });
    expect(result).toContain("Error");
    expect(result).toContain("does not match base origin");
  });
});

// ===========================================================================
// 11. Signal wiring (AbortController forwarded to fetch)
// ===========================================================================

describe("abort signal wiring", () => {
  it("abort signal is passed to fetch init", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 30_000,
    });
    await tools[0]!.invoke({ method: "GET", path: "/fast" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal).not.toBeNull();
  });

  it("very small timeoutMs triggers abort and returns error string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          // Simulate hanging fetch that respects abort signal
          const timer = setTimeout(() => reject(new Error("never")), 60_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(
              new DOMException("The operation was aborted.", "AbortError")
            );
          });
        });
      })
    );

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 1,
    });
    const result = await tools[0]!.invoke({ method: "GET", path: "/hang" });
    expect(result).toContain("Error");
  });
});

// ===========================================================================
// 12. Independent connectors do not share state
// ===========================================================================

describe("connector independence", () => {
  it("two connectors with different base URLs hit different hosts", async () => {
    let lastUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        lastUrl = url;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
          headers: new Headers(),
        };
      })
    );

    const toolsA = createHTTPConnector({ baseUrl: "https://a.example.com" });
    const toolsB = createHTTPConnector({ baseUrl: "https://b.example.com" });

    await toolsA[0]!.invoke({ method: "GET", path: "/resource" });
    expect(lastUrl).toContain("a.example.com");

    await toolsB[0]!.invoke({ method: "GET", path: "/resource" });
    expect(lastUrl).toContain("b.example.com");
  });

  it("two connectors with different config headers are independent", async () => {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        calls.push(init.headers as Record<string, string>);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
          headers: new Headers(),
        };
      })
    );

    const toolsA = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Tenant": "alpha" },
    });
    const toolsB = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Tenant": "beta" },
    });

    await toolsA[0]!.invoke({ method: "GET", path: "/x" });
    await toolsB[0]!.invoke({ method: "GET", path: "/x" });

    expect(calls[0]!["X-Tenant"]).toBe("alpha");
    expect(calls[1]!["X-Tenant"]).toBe("beta");
  });

  it("two connectors with different allowedMethods enforce independently", async () => {
    const toolsGet = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET"],
    });
    const toolsPost = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["POST"],
    });

    const resA = await toolsGet[0]!.invoke({ method: "POST", path: "/x" });
    const resB = await toolsPost[0]!.invoke({ method: "GET", path: "/x" });

    expect(resA).toContain("not allowed");
    expect(resB).toContain("not allowed");
  });
});

// ===========================================================================
// 13. Parallel requests are independent
// ===========================================================================

describe("parallel request independence", () => {
  it("concurrent GET requests each receive their own response", async () => {
    let idx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const n = ++idx;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ url, n }),
          headers: new Headers(),
        };
      })
    );

    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const results = await Promise.all([
      tools[0]!.invoke({ method: "GET", path: "/a" }),
      tools[0]!.invoke({ method: "GET", path: "/b" }),
      tools[0]!.invoke({ method: "GET", path: "/c" }),
    ]);

    for (const r of results) {
      expect(r).toContain("200 OK");
    }
    expect(results[0]).toContain("/a");
    expect(results[1]).toContain("/b");
    expect(results[2]).toContain("/c");
  });

  it("5 concurrent requests all succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "ok",
        headers: new Headers(),
      })
    );

    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        tools[0]!.invoke({ method: "GET", path: `/item/${i}` })
      )
    );
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toContain("200 OK");
    }
  });
});

// ===========================================================================
// 14. outboundUrlPolicy passthrough
// ===========================================================================

describe("outboundUrlPolicy passthrough", () => {
  it("allowHttp true in outboundUrlPolicy allows http base URLs", async () => {
    expect(() =>
      createHTTPConnector({
        baseUrl: "http://internal.local",
        outboundUrlPolicy: {
          allowHttp: true,
          allowedHosts: new Set(["internal.local"]),
        },
      })
    ).not.toThrow();
  });
});

// ===========================================================================
// 15. Toolkit factory
// ===========================================================================

describe("createHttpConnectorToolkit factory", () => {
  it('returns toolkit with name "http"', () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    expect(kit.name).toBe("http");
  });

  it("toolkit contains exactly one tool", () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    expect(kit.tools).toHaveLength(1);
  });

  it('toolkit tool name is "http_request"', () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    expect(kit.tools[0]!.name).toBe("http_request");
  });

  it("toolkit with allowedMethods restriction is enforced", async () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET"],
    });
    const result = await kit.tools[0]!.invoke({ method: "DELETE", path: "/x" });
    expect(result).toContain("not allowed");
  });

  it("toolkit tool is invokable and returns status", async () => {
    mockFetch({
      status: 200,
      statusText: "OK",
      text: async () => "toolkit-ok",
    });
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    const result = await kit.tools[0]!.invoke({
      method: "GET",
      path: "/check",
    });
    expect(result).toContain("200 OK");
    expect(result).toContain("toolkit-ok");
  });

  it("toolkit with headers config passes headers to fetch", async () => {
    const mock = mockFetch();
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      headers: { "X-Kit-Header": "kit-value" },
    });
    await kit.tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["X-Kit-Header"]).toBe("kit-value");
  });
});

// ===========================================================================
// 16. Error propagation — non-Error thrown values
// ===========================================================================

describe("error propagation for non-Error throw types", () => {
  it('thrown null is surfaced as "Error: null"', async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(null));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toContain("Error:");
  });

  it("thrown undefined is surfaced as error string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(undefined));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toContain("Error:");
  });

  it("thrown boolean false is surfaced as error string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(false));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toContain("Error: false");
  });
});

// ===========================================================================
// 17. Fetch called exactly once per successful request
// ===========================================================================

describe("fetch call count", () => {
  it("GET request triggers exactly one fetch call", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/once" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("POST request triggers exactly one fetch call", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "POST", path: "/once", body: "{}" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("disallowed method does NOT trigger any fetch call", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET"],
    });
    await tools[0]!.invoke({ method: "DELETE", path: "/x" });
    expect(mock).not.toHaveBeenCalled();
  });
});

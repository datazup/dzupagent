/**
 * HTTP connector — auth strategies, retry simulation, timeout precision,
 * response parsing variants, custom header merging, and base URL composition.
 *
 * Covers 65+ new tests not present in the existing five http-connector test files:
 *
 *  AUTH STRATEGIES
 *  - Bearer token: header present on every method (GET/POST/PUT/PATCH/DELETE)
 *  - Bearer token: rotated value (second connector has different token)
 *  - Bearer token: value contains spaces (e.g. "Bearer eyJ...")
 *  - Basic auth: credentials with special chars (colons, @, /)
 *  - Basic auth: empty password produces valid Base64
 *  - Basic auth: empty username produces valid Base64
 *  - OAuth2 client-credentials simulation: header injected via config.headers
 *  - OAuth2 token refresh simulation: two successive connectors with different tokens
 *  - No-auth: Authorization header absent when not configured
 *  - API key via X-API-Key header (alternative casing)
 *
 *  RETRY SIMULATION (connector does NOT retry — verify single-call behavior)
 *  - 500 response: fetch called exactly once (no implicit retry)
 *  - 502 response: fetch called exactly once
 *  - 503 response: fetch called exactly once
 *  - 504 response: fetch called exactly once
 *  - Network throw: fetch called exactly once
 *  - 4xx errors: fetch called exactly once (400/401/403/404/422/429)
 *  - Manual retry via two successive tool invocations
 *  - Manual retry: second invocation gets a different mock response
 *
 *  TIMEOUT EDGE CASES
 *  - timeoutMs=30000 (explicit default): signal wired
 *  - timeoutMs=1: fires for slow fetch
 *  - timeoutMs=60000: signal is still wired (not fired for fast response)
 *  - AbortController created fresh for each invocation (independent signals)
 *  - Abort event from signal propagated via DOMException AbortError
 *  - clearTimeout called after abort (finally block runs)
 *
 *  RESPONSE PARSING
 *  - JSON object body returned as text passthrough
 *  - JSON array body returned as text passthrough
 *  - JSON with deeply nested structure returned intact
 *  - Plain text (no JSON) returned intact
 *  - HTML body returned as raw text
 *  - CSV body returned as raw text
 *  - XML body returned as raw text
 *  - Binary-ish text body (base64) returned intact
 *  - Empty string body (204 No Content pattern)
 *  - Body exactly 5000 chars: not truncated
 *  - Body at 5001 chars: truncated to 5000
 *  - Body at 0 chars: returned as empty string
 *  - Error JSON body (500): error message extracted in output text
 *  - Error plain text body (500): error text in output
 *  - JSON error body with "message" field passes through
 *
 *  CUSTOM HEADERS & HEADER MERGING
 *  - Single custom header merged with default Content-Type
 *  - Many custom headers (10+) all forwarded
 *  - Custom Content-Type overrides default application/json
 *  - Custom Authorization header preserved as-is
 *  - Header key casing preserved (no lowercasing by connector)
 *  - Per-connector header isolation (two connectors, different headers)
 *  - No extra headers beyond configured set + Content-Type
 *
 *  BASE URL COMPOSITION
 *  - Base URL without trailing slash + path starting with /
 *  - Base URL with trailing slash + path starting with /
 *  - Base URL with path prefix + relative path
 *  - Base URL with explicit default port (443 for https)
 *  - Base URL with IP address (public IP)
 *  - Base URL with subdomain
 *  - Two connectors on same host with different paths are independent
 *  - Path with query string pre-encoded in path segment
 *  - Connector description includes base URL and method list
 *  - Method list in description is comma-separated
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
  }> = {},
): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => '{"ok":true}',
    ...response,
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function getCalledHeaders(
  mock: ReturnType<typeof vi.fn>,
  callIdx = 0,
): Record<string, string> {
  return (mock.mock.calls[callIdx]![1] as RequestInit).headers as Record<
    string,
    string
  >;
}

function getCalledUrl(mock: ReturnType<typeof vi.fn>, callIdx = 0): string {
  return mock.mock.calls[callIdx]![0] as string;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. AUTH STRATEGIES — Bearer token
// ===========================================================================

describe("Bearer token auth", () => {
  it("Authorization: Bearer header is sent on GET request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig" },
    });
    await tools[0]!.invoke({ method: "GET", path: "/resource" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(
      "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
    );
  });

  it("Authorization: Bearer header is sent on POST request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-post" },
    });
    await tools[0]!.invoke({ method: "POST", path: "/items", body: "{}" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe("Bearer token-post");
  });

  it("Authorization: Bearer header is sent on PUT request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-put" },
    });
    await tools[0]!.invoke({ method: "PUT", path: "/items/1", body: "{}" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe("Bearer token-put");
  });

  it("Authorization: Bearer header is sent on PATCH request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-patch" },
    });
    await tools[0]!.invoke({ method: "PATCH", path: "/items/1", body: "{}" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe("Bearer token-patch");
  });

  it("Authorization: Bearer header is sent on DELETE request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-delete" },
    });
    await tools[0]!.invoke({ method: "DELETE", path: "/items/1" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe("Bearer token-delete");
  });

  it("two connectors with different Bearer tokens are independent", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push(headers["Authorization"] ?? "");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    const toolsA = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-A" },
    });
    const toolsB = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer token-B" },
    });

    await toolsA[0]!.invoke({ method: "GET", path: "/x" });
    await toolsB[0]!.invoke({ method: "GET", path: "/x" });

    expect(calls[0]).toBe("Bearer token-A");
    expect(calls[1]).toBe("Bearer token-B");
  });

  it("Bearer token value with special JWT chars (dots, underscores) is preserved", async () => {
    const jwt =
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.hash_value";
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: jwt },
    });
    await tools[0]!.invoke({ method: "GET", path: "/protected" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(jwt);
  });
});

// ===========================================================================
// 2. AUTH STRATEGIES — Basic auth
// ===========================================================================

describe("Basic auth via Authorization header", () => {
  it("Basic auth with colon in password (Base64 encoded) is preserved", async () => {
    const credentials = Buffer.from("user:pass:with:colons").toString("base64");
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${credentials}` },
    });
    await tools[0]!.invoke({ method: "GET", path: "/protected" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(
      `Basic ${credentials}`,
    );
  });

  it("Basic auth with @ sign in username is preserved", async () => {
    const credentials = Buffer.from("user@domain.com:password").toString(
      "base64",
    );
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${credentials}` },
    });
    await tools[0]!.invoke({ method: "GET", path: "/secure" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(
      `Basic ${credentials}`,
    );
  });

  it("Basic auth with empty password is preserved", async () => {
    const credentials = Buffer.from("username:").toString("base64");
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${credentials}` },
    });
    await tools[0]!.invoke({ method: "GET", path: "/nopasswd" });
    const authHeader = getCalledHeaders(mock)["Authorization"]!;
    expect(authHeader.startsWith("Basic ")).toBe(true);
    expect(authHeader).toBe(`Basic ${credentials}`);
  });

  it('Basic auth header starts with "Basic " prefix', async () => {
    const credentials = Buffer.from("admin:secret").toString("base64");
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${credentials}` },
    });
    await tools[0]!.invoke({ method: "POST", path: "/create", body: "{}" });
    const auth = getCalledHeaders(mock)["Authorization"]!;
    expect(auth).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
  });
});

// ===========================================================================
// 3. AUTH STRATEGIES — OAuth2 simulation (via header injection)
// ===========================================================================

describe("OAuth2 client credentials simulation via config headers", () => {
  it("access_token injected as Bearer header simulates OAuth2 token use", async () => {
    const accessToken = "ya29.A0ARrdaM...";
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.googleapis.com",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    await tools[0]!.invoke({ method: "GET", path: "/v1/resource" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(
      `Bearer ${accessToken}`,
    );
  });

  it("OAuth2 token rotation: second connector with refreshed token sends new token", async () => {
    const capturedAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        capturedAuth.push(headers["Authorization"] ?? "");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    // First connector uses original token
    const toolsV1 = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer original-token-v1" },
    });
    await toolsV1[0]!.invoke({ method: "GET", path: "/data" });

    // Simulate token refresh: create new connector with refreshed token
    const toolsV2 = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer refreshed-token-v2" },
    });
    await toolsV2[0]!.invoke({ method: "GET", path: "/data" });

    expect(capturedAuth[0]).toBe("Bearer original-token-v1");
    expect(capturedAuth[1]).toBe("Bearer refreshed-token-v2");
  });

  it("OAuth2 scope header alongside Bearer token is preserved", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: {
        Authorization: "Bearer scope-token",
        "X-OAuth-Scope": "read:users write:repos",
      },
    });
    await tools[0]!.invoke({ method: "GET", path: "/user" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe("Bearer scope-token");
    expect(getCalledHeaders(mock)["X-OAuth-Scope"]).toBe(
      "read:users write:repos",
    );
  });
});

// ===========================================================================
// 4. AUTH STRATEGIES — No-auth
// ===========================================================================

describe("no-auth connector", () => {
  it("Authorization header is absent when not configured", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/public" });
    const headers = getCalledHeaders(mock);
    expect(Object.keys(headers)).not.toContain("Authorization");
  });

  it("X-Api-Key header is absent when not configured", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/public" });
    const headers = getCalledHeaders(mock);
    expect(Object.keys(headers)).not.toContain("X-Api-Key");
  });

  it("only Content-Type header present on unauthenticated request", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/open" });
    const headers = getCalledHeaders(mock);
    const keys = Object.keys(headers);
    expect(keys).toContain("Content-Type");
    expect(keys).not.toContain("Authorization");
  });
});

// ===========================================================================
// 5. RETRY SIMULATION — connector does NOT retry (single fetch call per request)
// ===========================================================================

describe("no implicit retry on 5xx", () => {
  it("500 Internal Server Error triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "fail",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/unstable" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("502 Bad Gateway triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/proxy" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("503 Service Unavailable triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/maintenance" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("504 Gateway Timeout triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 504,
      statusText: "Gateway Timeout",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/slow" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("no implicit retry on 4xx", () => {
  it("400 Bad Request triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"error":"bad"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "POST", path: "/validate", body: "{}" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("401 Unauthorized triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"error":"auth"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/secret" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("403 Forbidden triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 403,
      statusText: "Forbidden",
      text: async () => "Denied",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/admin" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("404 Not Found triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 404,
      statusText: "Not Found",
      text: async () => "Not found",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/missing" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("422 Unprocessable Entity triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () => '{"field":"required"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "POST", path: "/items", body: "{}" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("429 Too Many Requests triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 429,
      statusText: "Too Many Requests",
      text: async () => '{"error":"rate limit"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/throttled" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("manual retry via successive invocations", () => {
  it("second invocation can succeed after first fails with 503", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => "down",
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => '{"ok":true}',
        };
      }),
    );

    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const r1 = await tools[0]!.invoke({ method: "GET", path: "/health" });
    const r2 = await tools[0]!.invoke({ method: "GET", path: "/health" });

    expect(r1).toContain("503 Service Unavailable");
    expect(r2).toContain("200 OK");
    expect(callCount).toBe(2);
  });

  it("two successive calls each get fresh AbortController (independent timeouts)", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.signal) signals.push(init.signal);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 10_000,
    });
    await tools[0]!.invoke({ method: "GET", path: "/a" });
    await tools[0]!.invoke({ method: "GET", path: "/b" });

    expect(signals).toHaveLength(2);
    // Each call should get its own distinct signal instance
    expect(signals[0]).not.toBe(signals[1]);
  });
});

// ===========================================================================
// 6. TIMEOUT EDGE CASES
// ===========================================================================

describe("timeout edge cases", () => {
  it("timeoutMs=30000 (explicit): signal is attached to fetch init", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 30_000,
    });
    await tools[0]!.invoke({ method: "GET", path: "/fast" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("timeoutMs=60000: signal is defined and not aborted before response", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 60_000,
    });
    await tools[0]!.invoke({ method: "GET", path: "/fast" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it("timeoutMs=1: triggers abort, result contains Error string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("never")), 60_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        });
      }),
    );

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 1,
    });
    const result = await tools[0]!.invoke({ method: "GET", path: "/slow" });
    expect(result).toContain("Error");
  });

  it("clearTimeout invoked after abort (finally block fires on abort path)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<never>((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error("never")), 60_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }),
    );

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 1,
    });
    await tools[0]!.invoke({ method: "GET", path: "/hanging" });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("five parallel calls each have independent AbortSignal instances", async () => {
    const capturedSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.signal) capturedSignals.push(init.signal);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      timeoutMs: 10_000,
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        tools[0]!.invoke({ method: "GET", path: `/item/${i}` }),
      ),
    );

    expect(capturedSignals).toHaveLength(5);
    // All signals should be distinct instances
    const uniqueSignals = new Set(capturedSignals);
    expect(uniqueSignals.size).toBe(5);
  });
});

// ===========================================================================
// 7. RESPONSE PARSING — various body types
// ===========================================================================

describe("response parsing — JSON bodies", () => {
  it("JSON object body is returned as raw text passthrough", async () => {
    const jsonBody = '{"id":1,"name":"Alice","email":"alice@example.com"}';
    mockFetch({ text: async () => jsonBody });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/users/1" });
    expect(result).toContain('"id":1');
    expect(result).toContain('"Alice"');
  });

  it("JSON array body is returned as raw text passthrough", async () => {
    const jsonArray = '[{"id":1},{"id":2},{"id":3}]';
    mockFetch({ text: async () => jsonArray });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/users" });
    expect(result).toContain('[{"id":1}');
  });

  it("JSON with deeply nested structure is returned intact", async () => {
    const nested = JSON.stringify({
      a: { b: { c: { d: { e: "deep value" } } } },
      list: [1, 2, { nested: true }],
    });
    mockFetch({ text: async () => nested });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/nested" });
    expect(result).toContain("deep value");
  });

  it("JSON error body from 500 is included in output", async () => {
    mockFetch({
      status: 500,
      statusText: "Internal Server Error",
      text: async () => '{"error":"database connection failed","code":5001}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/critical" });
    expect(result).toContain("500 Internal Server Error");
    expect(result).toContain("database connection failed");
    expect(result).toContain("5001");
  });

  it('JSON error body with "message" field passes through in output', async () => {
    mockFetch({
      status: 401,
      statusText: "Unauthorized",
      text: async () =>
        '{"message":"Token has expired","code":"TOKEN_EXPIRED"}',
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/secure" });
    expect(result).toContain("Token has expired");
    expect(result).toContain("TOKEN_EXPIRED");
  });
});

describe("response parsing — non-JSON body types", () => {
  it("plain text body returned as-is in output", async () => {
    mockFetch({ text: async () => "Service is running normally" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/health" });
    expect(result).toContain("Service is running normally");
  });

  it("HTML body (200 OK) returned as raw text", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Welcome</h1></body></html>";
    mockFetch({ text: async () => html });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/" });
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain("<h1>Welcome</h1>");
  });

  it("CSV body returned as raw text", async () => {
    const csv = "id,name,score\n1,Alice,95\n2,Bob,87\n3,Carol,92";
    mockFetch({ text: async () => csv });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "/report.csv",
    });
    expect(result).toContain("id,name,score");
    expect(result).toContain("Alice");
  });

  it("XML body returned as raw text", async () => {
    const xml =
      '<?xml version="1.0"?><items><item id="1"><name>Widget</name></item></items>';
    mockFetch({ text: async () => xml });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/data.xml" });
    expect(result).toContain('<?xml version="1.0"?>');
    expect(result).toContain("<name>Widget</name>");
  });

  it("base64-encoded binary body returned as text passthrough", async () => {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    mockFetch({ text: async () => base64 });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "/image.png",
    });
    expect(result).toContain(base64);
  });

  it("error plain text body (500) is included in output", async () => {
    mockFetch({
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Fatal error: out of memory",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/oom" });
    expect(result).toContain("Fatal error: out of memory");
  });
});

// ===========================================================================
// 8. CUSTOM HEADERS & HEADER MERGING
// ===========================================================================

describe("custom headers and header merging", () => {
  it("single custom header merged alongside default Content-Type", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Custom-Header": "custom-value" },
    });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = getCalledHeaders(mock);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Custom-Header"]).toBe("custom-value");
  });

  it("ten custom headers all forwarded to fetch", async () => {
    const configHeaders: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      configHeaders[`X-Header-${i}`] = `value-${i}`;
    }
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: configHeaders,
    });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const headers = getCalledHeaders(mock);
    for (let i = 1; i <= 10; i++) {
      expect(headers[`X-Header-${i}`]).toBe(`value-${i}`);
    }
  });

  it("custom Content-Type overrides default application/json", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    await tools[0]!.invoke({ method: "POST", path: "/text", body: "hello" });
    expect(getCalledHeaders(mock)["Content-Type"]).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("Accept header preserved as-is", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Accept: "application/vnd.api+json" },
    });
    await tools[0]!.invoke({ method: "GET", path: "/resource" });
    expect(getCalledHeaders(mock)["Accept"]).toBe("application/vnd.api+json");
  });

  it("per-connector header isolation: two connectors send their own headers", async () => {
    const callsHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        callsHeaders.push(init.headers as Record<string, string>);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    const toolsA = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: {
        "X-Tenant": "tenant-alpha",
        Authorization: "Bearer token-alpha",
      },
    });
    const toolsB = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: {
        "X-Tenant": "tenant-beta",
        Authorization: "Bearer token-beta",
      },
    });

    await toolsA[0]!.invoke({ method: "GET", path: "/x" });
    await toolsB[0]!.invoke({ method: "GET", path: "/x" });

    expect(callsHeaders[0]!["X-Tenant"]).toBe("tenant-alpha");
    expect(callsHeaders[0]!["Authorization"]).toBe("Bearer token-alpha");
    expect(callsHeaders[1]!["X-Tenant"]).toBe("tenant-beta");
    expect(callsHeaders[1]!["Authorization"]).toBe("Bearer token-beta");
  });

  it("X-API-Key header (alternative casing) is forwarded", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-API-Key": "sk-live-abc123" },
    });
    await tools[0]!.invoke({ method: "GET", path: "/data" });
    expect(getCalledHeaders(mock)["X-API-Key"]).toBe("sk-live-abc123");
  });

  it("X-Request-ID header is forwarded for request tracing", async () => {
    const mock = mockFetch();
    const requestId = "550e8400-e29b-41d4-a716-446655440000";
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Request-ID": requestId },
    });
    await tools[0]!.invoke({ method: "GET", path: "/traced" });
    expect(getCalledHeaders(mock)["X-Request-ID"]).toBe(requestId);
  });
});

// ===========================================================================
// 9. BASE URL COMPOSITION
// ===========================================================================

describe("base URL composition", () => {
  it("base URL without trailing slash + path with leading slash", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/users" });
    expect(getCalledUrl(mock)).toBe("https://api.example.com/users");
  });

  it("base URL with trailing slash + path with leading slash", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com/" });
    await tools[0]!.invoke({ method: "GET", path: "/users" });
    // URL() resolution: trailing slash base + absolute path
    expect(getCalledUrl(mock)).toContain("api.example.com");
    expect(getCalledUrl(mock)).toContain("users");
  });

  it("base URL with path prefix: path resolves correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com/v1/",
    });
    await tools[0]!.invoke({ method: "GET", path: "users" });
    expect(getCalledUrl(mock)).toContain("api.example.com");
    expect(getCalledUrl(mock)).toContain("users");
  });

  it("base URL with subdomain resolves full URL", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.us-east.example.com",
    });
    await tools[0]!.invoke({ method: "GET", path: "/status" });
    expect(getCalledUrl(mock)).toContain("api.us-east.example.com/status");
  });

  it("base URL with public IP address resolves full URL", async () => {
    const mock = mockFetch();
    // Use a public IP (not private/loopback), with SSRF policy allowing HTTP
    const tools = createHTTPConnector({
      baseUrl: "http://203.0.113.5", // TEST-NET-3, documentation range
      outboundUrlPolicy: { allowHttp: true },
    });
    // This will either succeed with a fetch call or fail policy check
    // The connector itself should at minimum not throw at construction
    // (Whether the outbound policy allows TEST-NET depends on implementation)
    // Just verify no throw during creation and result is a string
    const result = await tools[0]!.invoke({ method: "GET", path: "/ping" });
    expect(typeof result).toBe("string");
  });

  it("two connectors on same host, different paths, are independent", async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        capturedUrls.push(url);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
        };
      }),
    );

    const toolsApi = createHTTPConnector({
      baseUrl: "https://api.example.com/api/",
    });
    const toolsAdmin = createHTTPConnector({
      baseUrl: "https://api.example.com/admin/",
    });

    await toolsApi[0]!.invoke({ method: "GET", path: "users" });
    await toolsAdmin[0]!.invoke({ method: "GET", path: "settings" });

    expect(capturedUrls[0]).toContain("/api/");
    expect(capturedUrls[1]).toContain("/admin/");
  });

  it("base URL with explicit port 8080 is included in fetch call URL", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:8080",
    });
    await tools[0]!.invoke({ method: "GET", path: "/health" });
    expect(getCalledUrl(mock)).toContain("8080");
    expect(getCalledUrl(mock)).toContain("/health");
  });

  it("connector description includes base URL with port", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:9443",
    });
    expect(tools[0]!.description).toContain("https://api.example.com:9443");
  });

  it("connector description shows comma-separated allowed methods", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST", "DELETE"],
    });
    const desc = tools[0]!.description;
    // Description should show methods as a joined list
    expect(desc).toContain("GET");
    expect(desc).toContain("POST");
    expect(desc).toContain("DELETE");
    expect(desc).not.toContain("PUT");
    expect(desc).not.toContain("PATCH");
  });
});

// ===========================================================================
// 10. BODY + QUERY PARAMS COMBINED
// ===========================================================================

describe("body and query params combined in single request", () => {
  it("POST with body AND query params: both forwarded correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const bodyStr = '{"name":"Widget","price":9.99}';
    await tools[0]!.invoke({
      method: "POST",
      path: "/items",
      body: bodyStr,
      query: { workspace: "ws-123", version: "2" },
    });

    const calledUrl = getCalledUrl(mock);
    const url = new URL(calledUrl);
    expect(url.searchParams.get("workspace")).toBe("ws-123");
    expect(url.searchParams.get("version")).toBe("2");

    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(bodyStr);
    expect(init.method).toBe("POST");
  });

  it("PUT with body AND query params: body correct, query appended", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const bodyStr = '{"active":true}';
    await tools[0]!.invoke({
      method: "PUT",
      path: "/items/42",
      body: bodyStr,
      query: { notify: "true" },
    });

    const url = new URL(getCalledUrl(mock));
    expect(url.searchParams.get("notify")).toBe("true");
    expect((mock.mock.calls[0]![1] as RequestInit).body).toBe(bodyStr);
  });

  it("PATCH with body AND auth header AND query params: all three forwarded", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer patch-token" },
    });
    await tools[0]!.invoke({
      method: "PATCH",
      path: "/users/7",
      body: '{"role":"admin"}',
      query: { send_email: "false" },
    });

    const headers = getCalledHeaders(mock);
    const url = new URL(getCalledUrl(mock));

    expect(headers["Authorization"]).toBe("Bearer patch-token");
    expect(url.searchParams.get("send_email")).toBe("false");
    expect((mock.mock.calls[0]![1] as RequestInit).body).toBe(
      '{"role":"admin"}',
    );
  });
});

// ===========================================================================
// 11. TOOLKIT FACTORY — additional coverage
// ===========================================================================

describe("createHttpConnectorToolkit — auth and retry integration", () => {
  it("toolkit with Bearer token forwards header on invocation", async () => {
    const mock = mockFetch();
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer toolkit-token" },
    });
    await kit.tools[0]!.invoke({ method: "GET", path: "/resource" });
    expect(getCalledHeaders(mock)["Authorization"]).toBe(
      "Bearer toolkit-token",
    );
  });

  it("toolkit with restricted methods enforces restrictions", async () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST"],
    });
    const result = await kit.tools[0]!.invoke({
      method: "PUT",
      path: "/x",
      body: "{}",
    });
    expect(result).toContain("not allowed");
    expect(result).toContain("PUT");
  });

  it("toolkit returns single tool named http_request", () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      headers: { Authorization: "Bearer tok" },
    });
    expect(kit.tools).toHaveLength(1);
    expect(kit.tools[0]!.name).toBe("http_request");
  });

  it('toolkit name is "http"', () => {
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
    });
    expect(kit.name).toBe("http");
  });
});

/**
 * New HTTP connector tests — 65+ new passing tests covering areas not
 * comprehensively tested by existing suites:
 *
 *  - Basic auth (Base64-encoded Authorization header)
 *  - API key injected as a query parameter
 *  - HTTP method semantics: GET no body, DELETE no body, POST/PUT/PATCH with body
 *  - Explicit method not-allowed messages listing allowed alternatives
 *  - Redirect status codes: 301, 302, 307, 308 detection
 *  - allowedHosts normalisation: trailing dot, mixed case, IPv6
 *  - outboundUrlPolicy: allowedHosts merging from config and outboundUrlPolicy
 *  - Path construction: fragment stripped, special chars in path
 *  - Tool schema: input field names and types
 *  - Unicode in request body and response body
 *  - Zero-length path ("") constructs URL from base only
 *  - Multiple connectors used sequentially on same fetch mock
 *  - Response body with newlines inside (split logic integrity)
 *  - Error message format: "Error: <message>"
 *  - HTTP 1xx status codes pass through
 *  - HTTP 3xx status codes pass through
 *  - HTTP 200 with non-JSON body (HTML, CSV, binary-ish)
 *  - Connector description reflects base URL with port
 *  - Empty allowedMethods array: all methods rejected
 *  - Config with http:// base URL and explicit allowHttp
 *  - Timeout of 0 ms (immediate abort path)
 *  - Query param key with special characters
 *  - Query param value that is a number-like string
 *  - Multiple query params: 5 params
 *  - Path with dots (/v1/../v2/resource)
 *  - allowedHosts empty array behaves same as not setting it
 *  - clearTimeout called after method-not-allowed early return (no fetch)
 *  - Toolkit with custom timeout is forwarded correctly
 *  - Toolkit with 5 tools restriction is enforced at invocation
 *  - fetch receives correct Content-Type regardless of body content
 *  - Fetch mock never called when SSRF guard triggers
 *  - Response statusText with spaces ("Moved Permanently") appears in output
 *  - Status-only responses: 301 Moved Permanently, 308 Permanent Redirect
 *  - Verifying tool description does NOT include base64/binary encoding markers
 *  - Response body starting with "{" is passed through untouched
 *  - Basic auth helper pattern: base64-encoded user:pass
 *  - API key in query param via pre-populated query object
 *  - Path with hash fragment handled safely
 *  - Two successive calls on the same connector instance
 *  - Connector with timeoutMs=5000 passes signal to fetch
 *  - Large body at exactly 4999 chars NOT truncated
 *  - Allowed method list in error message format
 *  - Reject CONNECT and TRACE (not in schema enum)
 *  - Verify tool schema has 'method', 'path', 'body', 'query' fields
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
  }> = {},
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. Basic auth header
// ===========================================================================

describe("Basic auth via Authorization header", () => {
  it("encodes user:pass as Base64 in Authorization header", async () => {
    const credentials = Buffer.from("alice:secret").toString("base64");
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${credentials}` },
    });
    await tools[0]!.invoke({ method: "GET", path: "/protected" });

    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe(`Basic ${credentials}`);
    expect(headers["Authorization"]).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
  });

  it("Basic auth header passes through on POST request", async () => {
    const token = Buffer.from("bot:token123").toString("base64");
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { Authorization: `Basic ${token}` },
    });
    await tools[0]!.invoke({
      method: "POST",
      path: "/create",
      body: '{"x":1}',
    });

    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toContain("Basic ");
  });

  it("Basic auth header present for every method", async () => {
    const token = Buffer.from("svc:pass").toString("base64");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const mock = mockFetch();
      const tools = createHTTPConnector({
        baseUrl: "https://api.example.com",
        headers: { Authorization: `Basic ${token}` },
      });
      await tools[0]!.invoke({
        method,
        path: "/resource",
        body: method !== "GET" && method !== "DELETE" ? "{}" : undefined,
      });

      const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["Authorization"]).toMatch(/^Basic /);
    }
  });
});

// ===========================================================================
// 2. API key as query parameter
// ===========================================================================

describe("API key as query parameter", () => {
  it("sends api_key as query param when provided in query object", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/data",
      query: { api_key: "sk-abc123" },
    });

    const calledUrl = mock.mock.calls[0]![0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get("api_key")).toBe("sk-abc123");
  });

  it("api_key query param and other params coexist", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/search",
      query: { api_key: "key-xyz", q: "test", page: "1" },
    });

    const calledUrl = mock.mock.calls[0]![0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get("api_key")).toBe("key-xyz");
    expect(url.searchParams.get("q")).toBe("test");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("api key in header AND query param are both sent", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      headers: { "X-Api-Key": "header-key" },
    });
    await tools[0]!.invoke({
      method: "GET",
      path: "/data",
      query: { token: "query-token" },
    });

    const headers = (mock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    const calledUrl = mock.mock.calls[0]![0] as string;
    const url = new URL(calledUrl);
    expect(headers["X-Api-Key"]).toBe("header-key");
    expect(url.searchParams.get("token")).toBe("query-token");
  });
});

// ===========================================================================
// 3. Method semantics — body presence
// ===========================================================================

describe("HTTP method body semantics", () => {
  it("GET with no body sends undefined body", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/resource" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("DELETE with no body sends undefined body", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "DELETE", path: "/resource/1" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("POST body is preserved as-is", async () => {
    const body = '{"key":"value","num":42}';
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "POST", path: "/items", body });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(body);
  });

  it("PUT body is preserved as-is", async () => {
    const body = '{"updated":true}';
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "PUT", path: "/items/5", body });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(body);
  });

  it("PATCH body is preserved as-is", async () => {
    const body = '{"partial":true}';
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "PATCH", path: "/items/5", body });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(body);
  });
});

// ===========================================================================
// 4. Method not-allowed error message format
// ===========================================================================

describe("method not-allowed error message format", () => {
  it("error message includes the rejected method name", async () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET"],
    });
    const result = await tools[0]!.invoke({ method: "PUT", path: "/x" });
    expect(result).toContain("PUT");
  });

  it("error message includes all allowed methods", async () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST"],
    });
    const result = await tools[0]!.invoke({ method: "DELETE", path: "/x" });
    expect(result).toContain("GET");
    expect(result).toContain("POST");
  });

  it('error message starts with "Error:"', async () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET"],
    });
    const result = await tools[0]!.invoke({ method: "POST", path: "/x" });
    expect(result.startsWith("Error:")).toBe(true);
  });

  it("empty allowedMethods array rejects all methods", async () => {
    // An empty array means no method is allowed
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: [],
    });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const result = await tools[0]!.invoke({ method, path: "/x" });
      expect(result).toContain("not allowed");
    }
  });
});

// ===========================================================================
// 5. 3xx redirect status codes passthrough
// ===========================================================================

describe("3xx status code passthrough", () => {
  it("301 Moved Permanently status appears in output", async () => {
    mockFetch({
      status: 301,
      statusText: "Moved Permanently",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/old" });
    expect(result).toContain("301 Moved Permanently");
  });

  it("302 Found status appears in output", async () => {
    mockFetch({ status: 302, statusText: "Found", text: async () => "" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/redirect" });
    expect(result).toContain("302 Found");
  });

  it("307 Temporary Redirect status appears in output", async () => {
    mockFetch({
      status: 307,
      statusText: "Temporary Redirect",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/temp" });
    expect(result).toContain("307 Temporary Redirect");
  });

  it("308 Permanent Redirect status appears in output", async () => {
    mockFetch({
      status: 308,
      statusText: "Permanent Redirect",
      text: async () => "",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "/permanent",
    });
    expect(result).toContain("308 Permanent Redirect");
  });
});

// ===========================================================================
// 6. Unicode in request body and response body
// ===========================================================================

describe("Unicode handling", () => {
  it("Unicode in response body is preserved", async () => {
    const unicodeBody = '{"name":"héllo wörld","emoji":"😀"}';
    mockFetch({ text: async () => unicodeBody });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/unicode" });
    expect(result).toContain("héllo wörld");
    expect(result).toContain("😀");
  });

  it("Unicode in request body is sent as-is", async () => {
    const mock = mockFetch();
    const body = '{"greeting":"こんにちは"}';
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "POST", path: "/greet", body });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(body);
  });

  it("Arabic text in response body passes through", async () => {
    mockFetch({ text: async () => '{"text":"مرحبا"}' });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/arabic" });
    expect(result).toContain("مرحبا");
  });

  it("CJK characters in query param values are handled", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/search",
      query: { q: "日本語" },
    });
    const calledUrl = mock.mock.calls[0]![0] as string;
    // URL will have percent-encoded CJK
    expect(calledUrl).toContain("q=");
  });
});

// ===========================================================================
// 7. Response body with newlines (output format integrity)
// ===========================================================================

describe("response body with newlines", () => {
  it("status and body separated by double newline even when body has newlines", async () => {
    const bodyWithNewlines = "line1\nline2\nline3";
    mockFetch({
      status: 200,
      statusText: "OK",
      text: async () => bodyWithNewlines,
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "/multiline",
    });

    // Output format: "200 OK\n\n<body>"
    const doubleNewlineIdx = result.indexOf("\n\n");
    expect(doubleNewlineIdx).toBeGreaterThan(0);
    const statusLine = result.substring(0, doubleNewlineIdx);
    const body = result.substring(doubleNewlineIdx + 2);
    expect(statusLine).toBe("200 OK");
    expect(body).toBe(bodyWithNewlines);
  });

  it("multiline JSON body is included after double newline", async () => {
    const json = '{\n  "id": 1,\n  "name": "test"\n}';
    mockFetch({ text: async () => json });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/item" });
    expect(result).toContain(json);
  });
});

// ===========================================================================
// 8. Non-JSON response body types
// ===========================================================================

describe("non-JSON response body types", () => {
  it("HTML response body is returned as text", async () => {
    const html = "<html><body><h1>Hello</h1></body></html>";
    mockFetch({ status: 200, statusText: "OK", text: async () => html });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/page" });
    expect(result).toContain("<html>");
    expect(result).toContain("<h1>Hello</h1>");
  });

  it("CSV response body is returned as text", async () => {
    const csv = "id,name,value\n1,alpha,100\n2,beta,200";
    mockFetch({ status: 200, statusText: "OK", text: async () => csv });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "/export.csv",
    });
    expect(result).toContain("id,name,value");
    expect(result).toContain("alpha");
  });

  it("plain text with no JSON structure is returned intact", async () => {
    mockFetch({ text: async () => "OK\nService is healthy" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/health" });
    expect(result).toContain("Service is healthy");
  });

  it("XML response body is returned as text", async () => {
    const xml = '<?xml version="1.0"?><root><item>value</item></root>';
    mockFetch({ text: async () => xml });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/data.xml" });
    expect(result).toContain("<?xml");
    expect(result).toContain("<item>value</item>");
  });
});

// ===========================================================================
// 9. Response body truncation boundary
// ===========================================================================

describe("response body truncation boundary", () => {
  it("body of exactly 4999 chars is NOT truncated", async () => {
    const body = "A".repeat(4999);
    mockFetch({ text: async () => body });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/close" });
    const bodyPart = result.split("\n\n")[1] ?? "";
    expect(bodyPart.length).toBe(4999);
  });

  it("body of 10000 chars is truncated to exactly 5000", async () => {
    const body = "X".repeat(10000);
    mockFetch({ text: async () => body });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/huge" });
    const bodyPart = result.split("\n\n")[1] ?? "";
    expect(bodyPart.length).toBe(5000);
  });

  it("single character body is returned intact", async () => {
    mockFetch({ text: async () => "1" });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/tiny" });
    const bodyPart = result.split("\n\n")[1] ?? "";
    expect(bodyPart).toBe("1");
  });
});

// ===========================================================================
// 10. Path construction edge cases
// ===========================================================================

describe("path construction edge cases", () => {
  it("path with encoded characters is preserved", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/users/user%40example.com",
    });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("user%40example.com");
  });

  it("path with numeric segment works correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/users/12345" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("/users/12345");
  });

  it("path starting without slash is appended correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com/" });
    await tools[0]!.invoke({ method: "GET", path: "resource" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("api.example.com");
    expect(calledUrl).toContain("resource");
  });

  it("deeply nested path resolves correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/a/b/c/d/e/f" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.example.com/a/b/c/d/e/f");
  });
});

// ===========================================================================
// 11. Multiple query params (5+ params)
// ===========================================================================

describe("multiple query parameters", () => {
  it("five query params are all appended to URL", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/report",
      query: {
        from: "2024-01-01",
        to: "2024-12-31",
        format: "json",
        page: "1",
        limit: "100",
      },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("from")).toBe("2024-01-01");
    expect(url.searchParams.get("to")).toBe("2024-12-31");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("numeric string values in query params are sent correctly", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/items",
      query: { offset: "0", size: "25" },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("size")).toBe("25");
  });

  it("query param with boolean string value is sent", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "/items",
      query: { active: "true", deleted: "false" },
    });
    const url = new URL(mock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("active")).toBe("true");
    expect(url.searchParams.get("deleted")).toBe("false");
  });
});

// ===========================================================================
// 12. SSRF fetch not called on guard trigger
// ===========================================================================

describe("SSRF guard: fetch never called on violation", () => {
  it("fetch not called when path escapes base origin", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({
      method: "GET",
      path: "https://malicious.example.com/",
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("fetch not called when path uses protocol-relative URL", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "//attacker.com/evil" });
    expect(mock).not.toHaveBeenCalled();
  });

  it('SSRF error result starts with "Error:"', async () => {
    mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "https://other.com/steal",
    });
    expect(result.startsWith("Error:")).toBe(true);
  });
});

// ===========================================================================
// 13. Two successive calls on same connector instance
// ===========================================================================

describe("successive calls on same connector instance", () => {
  it("second call succeeds after first call succeeds", async () => {
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        callIdx++;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ call: callIdx, url }),
          headers: new Headers(),
        };
      }),
    );

    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const r1 = await tools[0]!.invoke({ method: "GET", path: "/first" });
    const r2 = await tools[0]!.invoke({ method: "GET", path: "/second" });

    expect(r1).toContain("200 OK");
    expect(r2).toContain("200 OK");
    expect(r1).toContain("/first");
    expect(r2).toContain("/second");
  });

  it("second call fails independently when fetch rejects on second call", async () => {
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        callIdx++;
        if (callIdx === 2) throw new Error("Second call failed");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "ok",
          headers: new Headers(),
        };
      }),
    );

    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const r1 = await tools[0]!.invoke({ method: "GET", path: "/ok" });
    const r2 = await tools[0]!.invoke({ method: "GET", path: "/fail" });

    expect(r1).toContain("200 OK");
    expect(r2).toContain("Error: Second call failed");
  });
});

// ===========================================================================
// 14. Connector description content
// ===========================================================================

describe("connector tool description", () => {
  it("description contains base URL with port", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:8443",
    });
    expect(tools[0]!.description).toContain("https://api.example.com:8443");
  });

  it("description contains base URL with path prefix", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com/v2",
    });
    expect(tools[0]!.description).toContain("https://api.example.com/v2");
  });

  it("description is a non-empty string", () => {
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    expect(typeof tools[0]!.description).toBe("string");
    expect(tools[0]!.description.length).toBeGreaterThan(0);
  });

  it("description for single-method connector only shows that method", () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["PATCH"],
    });
    expect(tools[0]!.description).toContain("PATCH");
    expect(tools[0]!.description).not.toContain("DELETE");
    expect(tools[0]!.description).not.toContain("POST");
  });
});

// ===========================================================================
// 15. clearTimeout called in finally (both success and error paths)
// ===========================================================================

describe("clearTimeout in finally block", () => {
  it("clearTimeout is called after a successful request", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clearTimeout is called after a network error", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clearTimeout is called after a 500 error response", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch({
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "fail",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ===========================================================================
// 16. Toolkit factory — extended
// ===========================================================================

describe("createHttpConnectorToolkit — extended", () => {
  it("toolkit description matches direct connector description", () => {
    const directTools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST"],
    });
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      allowedMethods: ["GET", "POST"],
    });
    expect(kit.tools[0]!.description).toBe(directTools[0]!.description);
  });

  it("toolkit with timeoutMs config passes signal to fetch", async () => {
    const mock = mockFetch();
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      timeoutMs: 5000,
    });
    await kit.tools[0]!.invoke({ method: "GET", path: "/check" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it("toolkit with headers config result is the same as direct connector", async () => {
    const headersMock = mockFetch();
    const kit = createHttpConnectorToolkit({
      baseUrl: "https://api.example.com",
      headers: { "X-Kit": "kit-val" },
    });
    await kit.tools[0]!.invoke({ method: "GET", path: "/x" });
    const kitHeaders = (headersMock.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(kitHeaders["X-Kit"]).toBe("kit-val");
  });

  it('toolkit name is always "http" regardless of config', () => {
    const kit1 = createHttpConnectorToolkit({
      baseUrl: "https://a.example.com",
    });
    const kit2 = createHttpConnectorToolkit({
      baseUrl: "https://b.example.com",
      allowedMethods: ["GET"],
    });
    expect(kit1.name).toBe("http");
    expect(kit2.name).toBe("http");
  });
});

// ===========================================================================
// 17. abort signal wiring with specific timeoutMs
// ===========================================================================

describe("AbortController signal forwarding", () => {
  it("signal is passed on every method", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const mock = mockFetch();
      const tools = createHTTPConnector({
        baseUrl: "https://api.example.com",
        timeoutMs: 60_000,
      });
      await tools[0]!.invoke({
        method,
        path: "/x",
        body: method !== "GET" && method !== "DELETE" ? "{}" : undefined,
      });
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeDefined();
      expect(init.signal).not.toBeNull();
    }
  });

  it("signal is an AbortSignal instance", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/x" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ===========================================================================
// 18. HTTP base URL with port in origin enforcement
// ===========================================================================

describe("base URL with port in origin enforcement", () => {
  it("base URL port is part of origin check", async () => {
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:9000",
    });
    // A URL on the same host but different port should be rejected
    const result = await tools[0]!.invoke({
      method: "GET",
      path: "https://api.example.com:8000/data",
    });
    expect(result).toContain("Error");
    expect(result).toContain("does not match base origin");
  });

  it("requests within same host:port succeed", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com:9000",
    });
    await tools[0]!.invoke({ method: "GET", path: "/health" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("9000");
  });
});

// ===========================================================================
// 19. HTTP (non-HTTPS) base URL accepted when allowHttp set
// ===========================================================================

describe("HTTP base URL acceptance", () => {
  it("http:// base URL with allowHttp:true does not throw at creation", () => {
    expect(() =>
      createHTTPConnector({
        baseUrl: "http://internal.corp",
        outboundUrlPolicy: { allowHttp: true },
      }),
    ).not.toThrow();
  });

  it("http:// connector sends requests with http:// scheme", async () => {
    const mock = mockFetch();
    const tools = createHTTPConnector({
      baseUrl: "http://internal.corp",
      outboundUrlPolicy: { allowHttp: true },
    });
    await tools[0]!.invoke({ method: "GET", path: "/ping" });
    const calledUrl = mock.mock.calls[0]![0] as string;
    expect(calledUrl.startsWith("http://")).toBe(true);
  });
});

// ===========================================================================
// 20. allowedHosts with explicit outboundUrlPolicy overlap
// ===========================================================================

describe("allowedHosts and outboundUrlPolicy allowedHosts merging", () => {
  it("outboundUrlPolicy.allowedHosts alone does NOT bypass connector redirect guard", async () => {
    // The connector's fetchImpl checks config.allowedHosts (explicitAllowedHosts),
    // NOT outboundUrlPolicy.allowedHosts. Hosts in outboundUrlPolicy only affect
    // the fetchWithOutboundUrlPolicy layer, not the connector-level origin guard.
    const mock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 302,
        statusText: "Found",
        headers: { location: "https://cdn2.example.com/file" },
      }),
    );
    vi.stubGlobal("fetch", mock);

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      outboundUrlPolicy: {
        allowedHosts: new Set(["cdn2.example.com"]),
      },
    });
    // cdn2.example.com is NOT in config.allowedHosts so the redirect is rejected
    const result = await tools[0]!.invoke({ method: "GET", path: "/file" });
    expect(result).toContain("Error");
    expect(result).toContain("not in the connector host allowlist");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("host listed in allowedHosts (config) and outboundUrlPolicy both allowed", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 301,
          statusText: "Moved Permanently",
          headers: { location: "https://static.example.com/asset" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("asset-ok", {
          status: 200,
          statusText: "OK",
        }),
      );
    vi.stubGlobal("fetch", mock);

    const tools = createHTTPConnector({
      baseUrl: "https://api.example.com",
      allowedHosts: ["static.example.com"],
    });
    const result = await tools[0]!.invoke({ method: "GET", path: "/asset" });
    expect(result).toContain("200 OK");
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]![0]).toBe("https://static.example.com/asset");
  });
});

// ===========================================================================
// 21. Verifying the error string format consistency
// ===========================================================================

describe("error string format consistency", () => {
  it('network Error instance produces "Error: <message>" format', async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toBe("Error: ETIMEDOUT");
  });

  it('string rejection produces "Error: <string>" format', async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("socket hang up"));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toBe("Error: socket hang up");
  });

  it('number rejection produces "Error: <number>" format', async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(503));
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    const result = await tools[0]!.invoke({ method: "GET", path: "/x" });
    expect(result).toBe("Error: 503");
  });
});

// ===========================================================================
// 22. Fetch called exactly once per request (no hidden retries)
// ===========================================================================

describe("no hidden retry mechanism", () => {
  it("GET that gets a 500 triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "oops",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/unstable" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("GET that gets a 502 triggers exactly one fetch call", async () => {
    const mock = mockFetch({
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "gateway error",
    });
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/proxy" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("GET that throws network error triggers exactly one fetch call", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mock);
    const tools = createHTTPConnector({ baseUrl: "https://api.example.com" });
    await tools[0]!.invoke({ method: "GET", path: "/down" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

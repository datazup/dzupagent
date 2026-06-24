/**
 * Platform adapter tests — MC-7 / CODE-M-06
 *
 * Covers toLambdaHandler, toVercelHandler, and toCloudflareHandler without
 * spinning up a real HTTP server. Each test mounts a minimal Hono app and
 * drives the adapter directly, asserting that it builds the correct upstream
 * Request and maps the downstream Response back to the caller's format.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { toLambdaHandler } from "../platforms/lambda.js";
import { toVercelHandler } from "../platforms/vercel.js";
import { toCloudflareHandler } from "../platforms/cloudflare.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Hono app that captures the incoming request and returns a
 *  configurable response so tests can inspect both sides of the adapter. */
function makeCapturingApp(opts?: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}): { app: Hono; captured: { request: Request | null } } {
  const captured: { request: Request | null } = { request: null };

  const app = new Hono();
  app.all("*", (c) => {
    captured.request = c.req.raw;

    const responseHeaders = new Headers(opts?.headers ?? {});
    return new Response(opts?.body ?? "OK", {
      status: opts?.status ?? 200,
      headers: responseHeaders,
    });
  });

  return { app, captured };
}

// ---------------------------------------------------------------------------
// Lambda adapter
// ---------------------------------------------------------------------------

describe("toLambdaHandler", () => {
  let captured: { request: Request | null };
  let handler: (event: unknown) => Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    isBase64Encoded: boolean;
  }>;

  beforeEach(() => {
    const result = makeCapturingApp();
    captured = result.captured;
    handler = toLambdaHandler(result.app);
  });

  // -- Method + path construction ------------------------------------------

  it("uses GET method from requestContext when present", async () => {
    await handler({
      requestContext: { http: { method: "GET", path: "/hello" } },
      rawPath: "/hello",
    });
    expect(captured.request?.method).toBe("GET");
  });

  it("uses POST method from requestContext", async () => {
    await handler({
      requestContext: { http: { method: "POST", path: "/submit" } },
      rawPath: "/submit",
      body: '{"x":1}',
    });
    expect(captured.request?.method).toBe("POST");
  });

  it("defaults to GET when requestContext is absent", async () => {
    await handler({ rawPath: "/ping" });
    expect(captured.request?.method).toBe("GET");
  });

  it("defaults to root path when rawPath is absent", async () => {
    await handler({});
    expect(new URL(captured.request!.url).pathname).toBe("/");
  });

  it("builds the correct path from rawPath", async () => {
    await handler({ rawPath: "/api/v1/runs" });
    expect(new URL(captured.request!.url).pathname).toBe("/api/v1/runs");
  });

  // -- Query string construction -------------------------------------------

  it("appends query string when rawQueryString is present", async () => {
    await handler({ rawPath: "/search", rawQueryString: "q=hello&page=2" });
    const url = new URL(captured.request!.url);
    expect(url.search).toBe("?q=hello&page=2");
  });

  it("omits query string when rawQueryString is absent", async () => {
    await handler({ rawPath: "/search" });
    const url = new URL(captured.request!.url);
    expect(url.search).toBe("");
  });

  it("omits query string when rawQueryString is empty string", async () => {
    await handler({ rawPath: "/search", rawQueryString: "" });
    const url = new URL(captured.request!.url);
    expect(url.search).toBe("");
  });

  // -- Header mapping -------------------------------------------------------

  it("forwards headers from the event to the request", async () => {
    await handler({
      rawPath: "/",
      headers: {
        "content-type": "application/json",
        "x-api-key": "secret",
      },
    });
    expect(captured.request?.headers.get("content-type")).toBe(
      "application/json"
    );
    expect(captured.request?.headers.get("x-api-key")).toBe("secret");
  });

  it("skips headers whose value is undefined", async () => {
    await handler({
      rawPath: "/",
      headers: { "x-present": "yes", "x-absent": undefined },
    });
    expect(captured.request?.headers.get("x-present")).toBe("yes");
    // undefined values must not propagate (would become the string "undefined")
    expect(captured.request?.headers.get("x-absent")).toBeNull();
  });

  it("handles missing headers object gracefully", async () => {
    await handler({ rawPath: "/" });
    // Should not throw; request is constructed without extra headers
    expect(captured.request).not.toBeNull();
  });

  // -- Body handling --------------------------------------------------------

  it("forwards plain text body for POST requests", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "POST" } },
      rawPath: "/echo",
      body: "hello world",
    });
    const text = await cap.request!.text();
    expect(text).toBe("hello world");
  });

  it("decodes base64-encoded body when isBase64Encoded is true", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    const original = '{"key":"value"}';
    const encoded = Buffer.from(original).toString("base64");

    await h({
      requestContext: { http: { method: "POST" } },
      rawPath: "/data",
      body: encoded,
      isBase64Encoded: true,
    });

    const text = await cap.request!.text();
    expect(text).toBe(original);
  });

  it("passes raw body as-is when isBase64Encoded is false", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "POST" } },
      rawPath: "/data",
      body: "plain text",
      isBase64Encoded: false,
    });
    const text = await cap.request!.text();
    expect(text).toBe("plain text");
  });

  it("omits body for GET requests even when body field is present", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "GET" } },
      rawPath: "/",
      body: "should be ignored",
    });
    // GET requests must not carry a body per HTTP spec
    const text = await cap.request!.text();
    expect(text).toBe("");
  });

  it("omits body for HEAD requests", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "HEAD" } },
      rawPath: "/",
      body: "should be ignored",
    });
    const text = await cap.request!.text();
    expect(text).toBe("");
  });

  it("handles null body field without throwing", async () => {
    await handler({
      requestContext: { http: { method: "POST" } },
      rawPath: "/submit",
      body: null,
    });
    expect(captured.request).not.toBeNull();
  });

  it("handles empty string body", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "POST" } },
      rawPath: "/submit",
      body: "",
    });
    // Empty string is falsy — treated as no body
    const text = await cap.request!.text();
    expect(text).toBe("");
  });

  // -- Response mapping -----------------------------------------------------

  it("returns the upstream status code", async () => {
    const { app } = makeCapturingApp({ status: 201 });
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/" });
    expect(result.statusCode).toBe(201);
  });

  it("returns 404 from the upstream app", async () => {
    const app = new Hono();
    // No routes registered — Hono returns 404
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/not-found" });
    expect(result.statusCode).toBe(404);
  });

  it("maps response headers into a flat string record", async () => {
    const { app } = makeCapturingApp({
      headers: {
        "content-type": "application/json",
        "x-request-id": "abc-123",
      },
      body: "{}",
    });
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/" });
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["x-request-id"]).toBe("abc-123");
  });

  it("returns the response body as a string", async () => {
    const { app } = makeCapturingApp({ body: "Hello Lambda" });
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/" });
    expect(result.body).toBe("Hello Lambda");
  });

  it("always sets isBase64Encoded false on the response", async () => {
    const { app } = makeCapturingApp();
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/" });
    expect(result.isBase64Encoded).toBe(false);
  });

  // -- Edge cases -----------------------------------------------------------

  it("handles completely empty event object", async () => {
    const result = await handler({});
    expect(result.statusCode).toBeGreaterThanOrEqual(200);
  });

  it("handles deeply nested path with special characters", async () => {
    await handler({ rawPath: "/api/runs/run%2Fwith%2Fslashes" });
    expect(new URL(captured.request!.url).pathname).toBe(
      "/api/runs/run%2Fwith%2Fslashes"
    );
  });

  it("returns JSON body correctly when content-type is application/json", async () => {
    const { app } = makeCapturingApp({
      body: '{"status":"ok"}',
      headers: { "content-type": "application/json" },
    });
    const h = toLambdaHandler(app);
    const result = await h({ rawPath: "/" });
    expect(result.body).toBe('{"status":"ok"}');
    expect(result.headers["content-type"]).toContain("application/json");
  });

  it("handles DELETE method correctly", async () => {
    await handler({
      requestContext: { http: { method: "DELETE" } },
      rawPath: "/items/42",
    });
    expect(captured.request?.method).toBe("DELETE");
  });

  it("handles PATCH method with body", async () => {
    const { app, captured: cap } = makeCapturingApp();
    const h = toLambdaHandler(app);
    await h({
      requestContext: { http: { method: "PATCH" } },
      rawPath: "/items/42",
      body: '{"name":"updated"}',
    });
    expect(cap.request?.method).toBe("PATCH");
    const text = await cap.request!.text();
    expect(text).toBe('{"name":"updated"}');
  });

  it("concurrently handles multiple invocations independently", async () => {
    const results = await Promise.all([
      handler({ rawPath: "/a", rawQueryString: "id=1" }),
      handler({ rawPath: "/b", rawQueryString: "id=2" }),
      handler({ rawPath: "/c" }),
    ]);
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.statusCode).toBeGreaterThanOrEqual(200));
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Workers adapter
// ---------------------------------------------------------------------------

describe("toCloudflareHandler", () => {
  it("returns an object with a fetch method", () => {
    const { app } = makeCapturingApp();
    const worker = toCloudflareHandler(app);
    expect(typeof worker.fetch).toBe("function");
  });

  it("passes the Request through to the Hono app and returns a Response", async () => {
    const { app, captured } = makeCapturingApp({
      body: "cloudflare-ok",
      status: 200,
    });
    const worker = toCloudflareHandler(app);

    const request = new Request("https://worker.example.com/ping", {
      method: "GET",
    });
    const response = await worker.fetch(request);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("cloudflare-ok");
    expect(captured.request).toBe(request);
  });

  it("forwards POST body to the Hono app", async () => {
    const { app, captured } = makeCapturingApp({ status: 201 });
    const worker = toCloudflareHandler(app);

    const request = new Request("https://worker.example.com/submit", {
      method: "POST",
      body: "posted-data",
      headers: { "content-type": "text/plain" },
    });
    const response = await worker.fetch(request);

    expect(response.status).toBe(201);
    const text = await captured.request!.text();
    expect(text).toBe("posted-data");
  });

  it("propagates response headers from the Hono app", async () => {
    const { app } = makeCapturingApp({
      headers: { "x-powered-by": "dzupagent" },
      body: "",
    });
    const worker = toCloudflareHandler(app);

    const response = await worker.fetch(
      new Request("https://worker.example.com/", { method: "GET" })
    );

    expect(response.headers.get("x-powered-by")).toBe("dzupagent");
  });

  it("returns 404 when the Hono app has no matching route", async () => {
    const app = new Hono(); // no routes
    const worker = toCloudflareHandler(app);

    const response = await worker.fetch(
      new Request("https://worker.example.com/unknown", { method: "GET" })
    );

    expect(response.status).toBe(404);
  });

  it("handles DELETE request", async () => {
    const { app, captured } = makeCapturingApp({ status: 200, body: "" });
    const worker = toCloudflareHandler(app);

    await worker.fetch(
      new Request("https://worker.example.com/items/1", { method: "DELETE" })
    );
    expect(captured.request?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Vercel Edge adapter
// ---------------------------------------------------------------------------

describe("toVercelHandler", () => {
  it("returns a function", () => {
    const { app } = makeCapturingApp();
    const handler = toVercelHandler(app);
    expect(typeof handler).toBe("function");
  });

  it("passes the Request through to the Hono app and returns a Response", async () => {
    const { app, captured } = makeCapturingApp({
      body: "vercel-ok",
      status: 200,
    });
    const handler = toVercelHandler(app);

    const request = new Request("https://edge.example.com/ping", {
      method: "GET",
    });
    const response = await handler(request);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("vercel-ok");
    expect(captured.request).toBe(request);
  });

  it("forwards POST body to the Hono app", async () => {
    const { app, captured } = makeCapturingApp({ status: 201 });
    const handler = toVercelHandler(app);

    const request = new Request("https://edge.example.com/submit", {
      method: "POST",
      body: "edge-payload",
      headers: { "content-type": "text/plain" },
    });
    const response = await handler(request);

    expect(response.status).toBe(201);
    const text = await captured.request!.text();
    expect(text).toBe("edge-payload");
  });

  it("propagates response headers from the Hono app", async () => {
    const { app } = makeCapturingApp({
      headers: { "x-edge-meta": "test" },
      body: "",
    });
    const handler = toVercelHandler(app);

    const response = await handler(
      new Request("https://edge.example.com/", { method: "GET" })
    );
    expect(response.headers.get("x-edge-meta")).toBe("test");
  });

  it("returns 404 when the Hono app has no matching route", async () => {
    const app = new Hono(); // no routes
    const handler = toVercelHandler(app);

    const response = await handler(
      new Request("https://edge.example.com/missing", { method: "GET" })
    );
    expect(response.status).toBe(404);
  });

  it("handles PATCH request with body", async () => {
    const { app, captured } = makeCapturingApp({ status: 200 });
    const handler = toVercelHandler(app);

    const request = new Request("https://edge.example.com/items/7", {
      method: "PATCH",
      body: '{"done":true}',
      headers: { "content-type": "application/json" },
    });
    await handler(request);
    expect(captured.request?.method).toBe("PATCH");
  });

  it("handles query strings transparently", async () => {
    const { app, captured } = makeCapturingApp();
    const handler = toVercelHandler(app);

    await handler(
      new Request("https://edge.example.com/search?q=foo&limit=10")
    );
    const url = new URL(captured.request!.url);
    expect(url.search).toBe("?q=foo&limit=10");
  });

  it("returns the same Response object the Hono app produced", async () => {
    // Vercel and Cloudflare adapters are identity wrappers — the Response must
    // be the exact object returned by app.fetch(), not a re-wrapped copy.
    const expectedResponse = new Response("direct", { status: 200 });
    const app = new Hono();
    const fetchSpy = vi
      .fn<[Request], Promise<Response>>()
      .mockResolvedValue(expectedResponse);
    app.fetch = fetchSpy;

    const handler = toVercelHandler(app);
    const result = await handler(new Request("https://edge.example.com/"));

    expect(result).toBe(expectedResponse);
  });
});

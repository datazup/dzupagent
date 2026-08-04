/**
 * SEC-C-01 regression suite.
 *
 * The adapter HTTP control plane used to fail OPEN: a handler constructed
 * without `validateApiKey`/`tokenValidator` served every endpoint — including
 * `POST /run`, which spawns an external agent CLI — to anonymous callers, and
 * the free-form `options` bag forwarded arbitrary keys into `AgentInput`.
 *
 * These tests pin the fail-closed behaviour and the strict options allowlist.
 */

import { describe, it, expect, vi } from "vitest";

import { AdapterHttpHandler } from "../adapter-http-handler.js";
import type { HttpRequest, HttpResponse } from "../http-types.js";
import type { OrchestratorFacade } from "../../facade/orchestrator-facade.js";

function createMockOrchestrator(): OrchestratorFacade {
  return {
    run: vi.fn().mockResolvedValue({
      result: "run result",
      providerId: "claude",
      durationMs: 1,
    }),
    getCostReport: vi.fn().mockReturnValue({ totalCostCents: 0, providers: {} }),
    registry: {
      getHealthStatus: vi.fn().mockResolvedValue({
        claude: {
          healthy: true,
          providerId: "claude",
          sdkInstalled: true,
          cliAvailable: true,
        },
      }),
      listAdapters: vi.fn().mockReturnValue(["claude"]),
    },
  } as unknown as OrchestratorFacade;
}

function runRequest(body: unknown): HttpRequest {
  return { method: "POST", path: "/run", body, headers: {} };
}

function asJson(result: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  const response = result as HttpResponse;
  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
  };
}

describe("SEC-C-01 — fail-closed auth", () => {
  it("returns 500 AUTH_NOT_CONFIGURED on POST /run when no validator is configured", async () => {
    const orchestrator = createMockOrchestrator();
    const handler = new AdapterHttpHandler({ orchestrator });

    const json = asJson(await handler.handle(runRequest({ prompt: "hello" })));

    expect(json.status).toBe(500);
    expect(json.body["code"]).toBe("AUTH_NOT_CONFIGURED");
    // The run must never reach the orchestrator.
    expect(orchestrator.run).not.toHaveBeenCalled();
    // No configuration detail is disclosed beyond the stable code.
    const message = String(json.body["error"] ?? "");
    expect(message).not.toContain("validateApiKey");
    expect(message).not.toContain("tokenValidator");
    expect(message).not.toContain("allowUnauthenticated");
  });

  it("still serves requests when allowUnauthenticated is true (dev path)", async () => {
    const orchestrator = createMockOrchestrator();
    const handler = new AdapterHttpHandler({
      orchestrator,
      allowUnauthenticated: true,
    });

    const json = asJson(await handler.handle(runRequest({ prompt: "hello" })));

    expect(json.status).toBe(200);
    expect(orchestrator.run).toHaveBeenCalled();
  });

  it("keeps public endpoints reachable on an unconfigured handler", async () => {
    const handler = new AdapterHttpHandler({
      orchestrator: createMockOrchestrator(),
      publicEndpoints: ["/health"],
    });

    const json = asJson(
      await handler.handle({
        method: "GET",
        path: "/health",
        body: undefined,
        headers: {},
      })
    );

    expect(json.status).not.toBe(500);
    expect(json.body["code"]).not.toBe("AUTH_NOT_CONFIGURED");
  });
});

describe("SEC-C-01 — strict run options schema", () => {
  function authedHandler(): {
    handler: AdapterHttpHandler;
    orchestrator: OrchestratorFacade;
  } {
    const orchestrator = createMockOrchestrator();
    return {
      orchestrator,
      handler: new AdapterHttpHandler({
        orchestrator,
        allowUnauthenticated: true,
      }),
    };
  }

  it("rejects a CLI flag smuggled through options.blockedTools with 400", async () => {
    const { handler, orchestrator } = authedHandler();

    const json = asJson(
      await handler.handle(
        runRequest({
          prompt: "hello",
          options: { blockedTools: ["--dangerously-skip-permissions"] },
        })
      )
    );

    expect(json.status).toBe(400);
    expect(orchestrator.run).not.toHaveBeenCalled();
  });

  it("rejects an unknown options.sandboxMode value with 400", async () => {
    const { handler, orchestrator } = authedHandler();

    const json = asJson(
      await handler.handle(
        runRequest({ prompt: "hello", options: { sandboxMode: "banana" } })
      )
    );

    expect(json.status).toBe(400);
    expect(orchestrator.run).not.toHaveBeenCalled();
  });

  it("rejects unknown option keys (strict allowlist)", async () => {
    const { handler } = authedHandler();

    const json = asJson(
      await handler.handle(
        runRequest({ prompt: "hello", options: { cwd: "/" } })
      )
    );

    expect(json.status).toBe(400);
  });

  it("accepts the allow-listed options", async () => {
    const { handler, orchestrator } = authedHandler();

    const json = asJson(
      await handler.handle(
        runRequest({
          prompt: "hello",
          options: {
            sandboxMode: "read-only",
            allowedTools: ["Read", "Bash"],
            blockedTools: ["Write"],
            model: "claude-sonnet-4",
            reasoning: "high",
          },
        })
      )
    );

    expect(json.status).toBe(200);
    expect(orchestrator.run).toHaveBeenCalled();
  });
});

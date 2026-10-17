/**
 * Review follow-up (AUDIT-FOLLOWUPS-20261017-R1): `POST /run` realpath-jails a
 * body `workingDirectory`. `POST /supervisor` and `POST /parallel` have no
 * working-directory field at all, so a smuggled `workingDirectory` (or an
 * untyped `options` bag) must be dropped by schema validation and never reach
 * the orchestrator; the children keep the orchestrator's configured cwd.
 */
import { describe, it, expect, vi } from "vitest";

import { AdapterHttpHandler, type HttpResponse } from "../http/adapter-http-handler.js";
import type { OrchestratorFacade } from "../facade/orchestrator-facade.js";

function orchestrator(): OrchestratorFacade {
  return {
    supervisor: vi.fn().mockResolvedValue({ goal: "g", subtaskResults: [], totalDurationMs: 1 }),
    parallel: vi.fn().mockResolvedValue({ results: [], mergeStrategy: "all", totalDurationMs: 1 }),
  } as unknown as OrchestratorFacade;
}

const SMUGGLED = {
  workingDirectory: "/etc",
  options: { sandboxMode: "full-access" },
  cwd: "/",
};

function forwardedKeys(mock: unknown): string[] {
  const call = (mock as ReturnType<typeof vi.fn>).mock.calls[0];
  return Object.keys((call?.[1] ?? {}) as Record<string, unknown>);
}

describe("adapter HTTP: supervisor/parallel bodies cannot choose a working directory", () => {
  it("POST /supervisor drops workingDirectory/options/cwd before the orchestrator", async () => {
    const orch = orchestrator();
    const handler = new AdapterHttpHandler({ orchestrator: orch, allowUnauthenticated: true });
    const res = (await handler.handle({
      method: "POST",
      path: "/supervisor",
      body: { goal: "Review", ...SMUGGLED },
      headers: {},
    })) as HttpResponse;
    expect(res.status).toBe(200);
    expect(orch.supervisor).toHaveBeenCalledTimes(1);
    expect(forwardedKeys(orch.supervisor)).toEqual(["maxConcurrentDelegations"]);
  });

  it("POST /parallel drops workingDirectory/options/cwd before the orchestrator", async () => {
    const orch = orchestrator();
    const handler = new AdapterHttpHandler({ orchestrator: orch, allowUnauthenticated: true });
    const res = (await handler.handle({
      method: "POST",
      path: "/parallel",
      body: { prompt: "Solve", providers: ["claude"], ...SMUGGLED },
      headers: {},
    })) as HttpResponse;
    expect(res.status).toBe(200);
    expect(orch.parallel).toHaveBeenCalledTimes(1);
    expect(forwardedKeys(orch.parallel).sort()).toEqual(["mergeStrategy", "providers"]);
  });
});

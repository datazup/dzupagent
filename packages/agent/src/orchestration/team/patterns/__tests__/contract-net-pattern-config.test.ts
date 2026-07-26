/**
 * Config-threading tests for the contract-net coordination pattern.
 *
 * The pattern used to call `ContractNetManager.execute` with only
 * `{ specialists, task }`, so every other supported `ContractNetConfig` field
 * was unreachable through a team run — most importantly the ENFORCED
 * `maxCostCents` ceiling, plus `signal` (cancellation) and `eventBus`
 * (`contractnet:*` observability). These tests pin the threading and, crucially,
 * guard that a run configuring none of it behaves exactly as it did before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@dzupagent/core/events";
import { ContractNetManager } from "../../../contract-net/contract-net-manager.js";
import type {
  BidEvaluationStrategy,
  ContractNetConfig,
} from "../../../contract-net/contract-net-types.js";
import { contractNetPattern } from "../contract-net-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spy on the manager, capturing the exact config the pattern passes it. */
function spyOnManager(): { configs: ContractNetConfig[] } {
  const configs: ContractNetConfig[] = [];
  vi.spyOn(ContractNetManager, "execute").mockImplementation(async (config) => {
    configs.push(config);
    return {
      cfpId: "cfp-cfg",
      agentId: "s1",
      success: true,
      result: "ok",
      actualDurationMs: 1,
    };
  });
  return { configs };
}

const TWO_SPECIALISTS = () => [
  buildResolved("mgr", { role: "supervisor" }),
  buildResolved("s1", { role: "specialist" }),
  buildResolved("s2", { role: "specialist" }),
];

describe("contractNetPattern — ContractNetConfig threading", () => {
  describe("regression guard: no policy, no runtime plumbing", () => {
    it("passes exactly the pre-existing two-field config", async () => {
      const { configs } = spyOnManager();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS());

      await contractNetPattern.execute(ctx);

      const config = configs[0]!;
      // The whole point: no extra keys leak in as `undefined`. A config with
      // `maxCostCents: undefined` present would still be a behaviour change for
      // anything doing `'maxCostCents' in config`.
      expect(Object.keys(config).sort()).toEqual(["specialists", "task"]);
      expect(config.task).toBe("mock task");
      expect(config.specialists.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("leaves the returned team result shape unchanged", async () => {
      spyOnManager();
      const { ctx, calls } = buildContext("contract_net", TWO_SPECIALISTS());

      const result = await contractNetPattern.execute(ctx);

      expect(result.pattern).toBe("contract-net");
      expect(result.content).toBe("ok");
      expect(calls.starts).toEqual(["mgr", "s1", "s2"]);
      expect(result.agentResults.find((r) => r.agentId === "s1")!.content).toBe(
        "ok"
      );
      expect(result.agentResults.find((r) => r.agentId === "s2")!.content).toBe(
        ""
      );
    });

    it("omits fields individually when only some of the policy is set", async () => {
      const { configs } = spyOnManager();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        policies: { contractNet: { maxCostCents: 100 } },
      });

      await contractNetPattern.execute(ctx);

      const config = configs[0]!;
      expect(config.maxCostCents).toBe(100);
      // Unset siblings must stay absent, not become explicit undefined.
      expect("bidDeadlineMs" in config).toBe(false);
      expect("requiredCapabilities" in config).toBe(false);
      expect("retryOnNoBids" in config).toBe(false);
      expect("strategy" in config).toBe(false);
      expect("signal" in config).toBe(false);
      expect("eventBus" in config).toBe(false);
    });
  });

  describe("declarative policy fields", () => {
    it("threads every policies.contractNet field to the manager", async () => {
      const { configs } = spyOnManager();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        policies: {
          contractNet: {
            maxCostCents: 250,
            requiredCapabilities: ["typescript", "sql"],
            bidDeadlineMs: 1234,
            retryOnNoBids: true,
          },
        },
      });

      await contractNetPattern.execute(ctx);

      const config = configs[0]!;
      expect(config.maxCostCents).toBe(250);
      expect(config.requiredCapabilities).toEqual(["typescript", "sql"]);
      expect(config.bidDeadlineMs).toBe(1234);
      expect(config.retryOnNoBids).toBe(true);
    });

    it("threads maxCostCents: 0 (a real ceiling, not a falsy omission)", async () => {
      const { configs } = spyOnManager();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        policies: { contractNet: { maxCostCents: 0 } },
      });

      await contractNetPattern.execute(ctx);

      expect(configs[0]!.maxCostCents).toBe(0);
      expect("maxCostCents" in configs[0]!).toBe(true);
    });

    it("threads retryOnNoBids: false explicitly", async () => {
      const { configs } = spyOnManager();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        policies: { contractNet: { retryOnNoBids: false } },
      });

      await contractNetPattern.execute(ctx);

      expect(configs[0]!.retryOnNoBids).toBe(false);
    });
  });

  describe("runtime plumbing (signal / eventBus / strategy)", () => {
    it("threads the abort signal from the context", async () => {
      const { configs } = spyOnManager();
      const controller = new AbortController();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        signal: controller.signal,
      });

      await contractNetPattern.execute(ctx);

      expect(configs[0]!.signal).toBe(controller.signal);
    });

    it("threads the event bus from the context", async () => {
      const { configs } = spyOnManager();
      const eventBus = createEventBus();
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        eventBus,
      });

      await contractNetPattern.execute(ctx);

      expect(configs[0]!.eventBus).toBe(eventBus);
    });

    it("threads the bid-evaluation strategy from the context", async () => {
      const { configs } = spyOnManager();
      const strategy: BidEvaluationStrategy = { evaluate: (bids) => bids };
      const { ctx } = buildContext("contract_net", TWO_SPECIALISTS(), {
        contractNet: { strategy },
      });

      await contractNetPattern.execute(ctx);

      expect(configs[0]!.strategy).toBe(strategy);
    });
  });
});

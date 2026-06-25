import { describe, it, expect } from "vitest";
import { validateTeamPolicies } from "../team-runtime-policy-validator.js";
import type { TeamPolicies } from "../team-policy.js";
import type { CoordinatorPattern } from "../team-definition.js";

const SUPERVISOR: CoordinatorPattern = "supervisor";
const COUNCIL: CoordinatorPattern = "council";
const BLACKBOARD: CoordinatorPattern = "blackboard";

describe("validateTeamPolicies", () => {
  describe("empty / no-op cases", () => {
    it("passes with empty policies object", () => {
      expect(() => validateTeamPolicies(SUPERVISOR, {})).not.toThrow();
    });

    it("passes with all policy groups undefined", () => {
      const p: TeamPolicies = {
        execution: undefined,
        governance: undefined,
        memory: undefined,
        isolation: undefined,
        mailbox: undefined,
        evaluation: undefined,
      };
      expect(() => validateTeamPolicies(SUPERVISOR, p)).not.toThrow();
    });
  });

  describe("execution policy", () => {
    it("accepts a valid maxParallelParticipants of 1", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { maxParallelParticipants: 1 },
        })
      ).not.toThrow();
    });

    it("accepts a valid maxParallelParticipants of 10", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { maxParallelParticipants: 10 },
        })
      ).not.toThrow();
    });

    it("rejects maxParallelParticipants of 0", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { maxParallelParticipants: 0 },
        })
      ).toThrow(/maxParallelParticipants.*positive integer/);
    });

    it("rejects negative maxParallelParticipants", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { maxParallelParticipants: -1 },
        })
      ).toThrow(/maxParallelParticipants/);
    });

    it("rejects non-integer maxParallelParticipants (float)", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { maxParallelParticipants: 2.5 },
        })
      ).toThrow(/maxParallelParticipants/);
    });

    it("rejects reserved field timeoutMs", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, { execution: { timeoutMs: 5000 } })
      ).toThrow(/timeoutMs.*not supported/);
    });

    it("rejects reserved field retryOnFailure", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { retryOnFailure: true },
        })
      ).toThrow(/retryOnFailure.*not supported/);
    });

    it("rejects reserved field maxRetries", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, { execution: { maxRetries: 3 } })
      ).toThrow(/maxRetries.*not supported/);
    });

    it("timeoutMs check fires before maxParallelParticipants check (first reserved field wins)", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          execution: { timeoutMs: 1000, maxParallelParticipants: -1 },
        })
      ).toThrow(/timeoutMs/);
    });
  });

  describe("governance policy", () => {
    it("accepts governance on council pattern", () => {
      expect(() =>
        validateTeamPolicies(COUNCIL, {
          governance: { judgeModel: "claude-opus-4-8" },
        })
      ).not.toThrow();
    });

    it("rejects governance on supervisor pattern", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          governance: { judgeModel: "claude-opus-4-8" },
        })
      ).toThrow(/governance.*council/);
    });

    it("rejects governance on blackboard pattern", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          governance: { judgeModel: "claude-opus-4-8" },
        })
      ).toThrow(/governance.*council/);
    });

    it("rejects reserved field minScore even on council", () => {
      expect(() =>
        validateTeamPolicies(COUNCIL, {
          governance: { judgeModel: "m", minScore: 0.8 },
        })
      ).toThrow(/minScore.*not supported/);
    });

    it("rejects reserved field requireUnanimous even on council", () => {
      expect(() =>
        validateTeamPolicies(COUNCIL, {
          governance: { judgeModel: "m", requireUnanimous: true },
        })
      ).toThrow(/requireUnanimous.*not supported/);
    });
  });

  describe("memory policy", () => {
    const baseMemory: TeamPolicies["memory"] = {
      tier: "ephemeral",
      shareAcrossParticipants: false,
    };

    it("accepts memory policy on blackboard pattern", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, { memory: baseMemory })
      ).not.toThrow();
    });

    it("rejects memory policy on supervisor pattern", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, { memory: baseMemory })
      ).toThrow(/memory.*blackboard/);
    });

    it("rejects memory policy on council pattern", () => {
      expect(() =>
        validateTeamPolicies(COUNCIL, { memory: baseMemory })
      ).toThrow(/memory.*blackboard/);
    });

    it("accepts blackboardContext with valid positive-integer budgets", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxSerializedChars: 4096, maxEntryChars: 512 },
          },
        })
      ).not.toThrow();
    });

    it("rejects blackboardContext.maxSerializedChars of 0", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxSerializedChars: 0 },
          },
        })
      ).toThrow(/maxSerializedChars.*positive integer/);
    });

    it("rejects blackboardContext.maxSerializedChars negative", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxSerializedChars: -100 },
          },
        })
      ).toThrow(/maxSerializedChars/);
    });

    it("rejects blackboardContext.maxSerializedChars float", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxSerializedChars: 1.5 },
          },
        })
      ).toThrow(/maxSerializedChars/);
    });

    it("rejects blackboardContext.maxEntryChars of 0", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxEntryChars: 0 },
          },
        })
      ).toThrow(/maxEntryChars.*positive integer/);
    });

    it("rejects blackboardContext.maxEntryChars negative", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { maxEntryChars: -1 },
          },
        })
      ).toThrow(/maxEntryChars/);
    });

    it("accepts blackboardContext with only overflowBehavior set (no budget fields)", () => {
      expect(() =>
        validateTeamPolicies(BLACKBOARD, {
          memory: {
            ...baseMemory,
            blackboardContext: { overflowBehavior: "compact" },
          },
        })
      ).not.toThrow();
    });
  });

  describe("unsupported policy groups", () => {
    it("rejects non-undefined isolation policy", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          isolation: { sandboxed: false, sharedWorkspace: true },
        })
      ).toThrow(/isolation.*not supported/);
    });

    it("rejects non-undefined mailbox policy", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          mailbox: { deliveryMode: "broadcast" },
        })
      ).toThrow(/mailbox.*not supported/);
    });

    it("rejects non-undefined evaluation policy", () => {
      expect(() =>
        validateTeamPolicies(SUPERVISOR, {
          evaluation: { scorerModel: "claude-opus-4-8" },
        })
      ).toThrow(/evaluation.*not supported/);
    });
  });

  describe("error message content", () => {
    it("error for timeoutMs mentions the field name", () => {
      try {
        validateTeamPolicies(SUPERVISOR, { execution: { timeoutMs: 1 } });
        expect.fail("should throw");
      } catch (e) {
        expect((e as Error).message).toContain("timeoutMs");
      }
    });

    it("error for governance pattern mismatch mentions 'council'", () => {
      try {
        validateTeamPolicies(SUPERVISOR, {
          governance: { judgeModel: "m" },
        });
        expect.fail("should throw");
      } catch (e) {
        expect((e as Error).message).toContain("council");
      }
    });

    it("error for memory pattern mismatch mentions 'blackboard'", () => {
      try {
        validateTeamPolicies(SUPERVISOR, {
          memory: { tier: "ephemeral", shareAcrossParticipants: false },
        });
        expect.fail("should throw");
      } catch (e) {
        expect((e as Error).message).toContain("blackboard");
      }
    });
  });
});

export const VALID_HASH =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export function minimalTrace(overrides = {}) {
  return {
    runId: "run-1",
    runSpecHash: VALID_HASH,
    verbSequence: [],
    runSpec: {
      mode: "deliberate",
      participants: [],
      turns: [],
    },
    turns: [],
    ...overrides,
  };
}

/** @returns {import("./typecheck-types.d.ts").DeepMutable<import("../src/golden-trace.ts").GoldenTrace>} */
export function maximalTrace() {
  const validationSpec = {
    commandId: "test",
    args: ["--run"],
    cwdRoot: "workspace",
    timeoutMs: 1_000,
    env: { FIXTURE_MODE: "true" },
    maxOutputBytes: 4_096,
    tenantScope: "fixture",
    sandboxPolicy: "workspace-write",
  };

  return /** @type {import("./typecheck-types.d.ts").DeepMutable<import("../src/golden-trace.ts").GoldenTrace>} */ ({
    runId: "maximal-run",
    runSpecHash: VALID_HASH,
    verbSequence: [
      "deliberate",
      "implement",
      "validate",
      "review",
      "decide",
      "handoff",
    ],
    runSpec: {
      mode: "build",
      participants: [
        {
          id: "participant-1",
          provider: "fixture",
          model: "fixture-model",
          role: "builder",
          systemPrompt: "Build deterministically.",
        },
      ],
      turns: [
        {
          id: "turn-1",
          verb: "handoff",
          participantId: "participant-1",
          prompt: "Complete the task.",
          validation: structuredClone(validationSpec),
          handoff: {
            fromParticipantId: "participant-1",
            toParticipantId: "participant-2",
            reason: "review",
          },
          branch: {
            id: "branch-1",
            fromTurnId: "turn-1",
            paths: [
              {
                id: "path-1",
                condition: {
                  sourceTurnId: "turn-1",
                  expression: "continue",
                },
                turnIds: ["turn-2"],
              },
            ],
            defaultPathId: "path-1",
          },
        },
      ],
      loops: [
        {
          id: "loop-1",
          condition: "continue",
          turnIds: ["turn-1"],
          maxIterations: 2,
        },
      ],
      decidePolicy: { kind: "agent", participantId: "participant-1" },
      budget: {
        maxUsd: 0.5,
        maxInputTokens: 100,
        maxOutputTokens: 200,
      },
      maxIterations: 10,
      allowEscape: true,
      dirtyPolicy: "isolate",
    },
    turns: [
      {
        turnId: "turn-1",
        verb: "implement",
        agentCalls: [
          {
            request: {
              runId: "maximal-run",
              runSpecHash: VALID_HASH,
              turnIndex: 0,
              turnType: "implement",
              participantId: "participant-1",
              provider: "fixture",
              model: "fixture-model",
              mode: "build",
              input: {
                prompt: "Implement.",
                role: "builder",
                systemPrompt: "Build deterministically.",
                scopeFiles: [
                  { path: "README.md", content: "fixture contents" },
                ],
              },
              escape: false,
            },
            result: {
              raw: "implemented",
              usage: {
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
              },
            },
          },
        ],
        validatorCalls: [
          {
            spec: structuredClone(validationSpec),
            result: {
              ok: true,
              exitCode: 0,
              output: "passed",
              durationMs: 25,
            },
          },
        ],
        workspaceSnapshots: [
          { baseRevision: "base", treeHash: "tree-before" },
        ],
        workspaceEffects: [
          {
            beforeSnapshot: {
              baseRevision: "base",
              treeHash: "tree-before",
            },
            effect: {
              diff: "diff --git a/file b/file",
              changedFiles: ["file"],
              postRevision: "post",
              treeHash: "tree-after",
              applyStatus: "clean",
            },
          },
        ],
      },
    ],
  });
}

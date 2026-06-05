import assert from "node:assert/strict";
import test from "node:test";

import { baseRunSpec, loadDialogueCore, validationSpec } from "./fakes.mjs";

test("runSpecHash is stable across canonical key order and repeat hashing", async () => {
  const { canonicalizeRunSpec, hashRunSpec } = await loadDialogueCore();
  const first = baseRunSpec({
    mode: "build",
    allowEscape: false,
    budget: {
      maxOutputTokens: 20,
      maxInputTokens: 10,
    },
    turns: [
      {
        id: "validate",
        verb: "validate",
        participantId: "critic",
        validation: {
          commandId: "fake-order",
          cwdRoot: "repo",
          args: ["--one", "--two"],
          env: {
            BETA: "2",
            ALPHA: "1",
          },
        },
      },
    ],
  });
  const sameSemanticSpec = {
    turns: [
      {
        validation: {
          env: {
            ALPHA: "1",
            BETA: "2",
          },
          args: ["--one", "--two"],
          cwdRoot: "repo",
          commandId: "fake-order",
        },
        participantId: "critic",
        verb: "validate",
        id: "validate",
      },
    ],
    budget: {
      maxInputTokens: 10,
      maxOutputTokens: 20,
    },
    participants: [...first.participants],
    allowEscape: false,
    mode: "build",
  };

  assert.notEqual(JSON.stringify(first), JSON.stringify(sameSemanticSpec));
  assert.equal(canonicalizeRunSpec(first), canonicalizeRunSpec(sameSemanticSpec));

  const firstHash = hashRunSpec(first);
  const reorderedHash = hashRunSpec(sameSemanticSpec);

  assert.equal(firstHash, reorderedHash);
  assert.equal(hashRunSpec(first), firstHash);
  assert.equal(hashRunSpec(sameSemanticSpec), reorderedHash);
});

test("runSpecHash changes when semantic fields change", async () => {
  const { hashRunSpec } = await loadDialogueCore();
  const baseline = baseRunSpec({
    mode: "build",
    turns: [
      {
        id: "implement",
        verb: "implement",
        participantId: "builder",
        prompt: "apply fake change",
      },
      {
        id: "validate",
        verb: "validate",
        participantId: "critic",
        validation: validationSpec("fake-baseline"),
      },
    ],
  });
  const promptChanged = baseRunSpec({
    ...baseline,
    turns: [
      {
        ...baseline.turns[0],
        prompt: "apply a different fake change",
      },
      baseline.turns[1],
    ],
  });
  const escapeChanged = baseRunSpec({
    ...baseline,
    allowEscape: true,
  });
  const omittedEscape = baseRunSpec({
    ...baseline,
    allowEscape: undefined,
  });
  const explicitFalseEscape = baseRunSpec({
    ...baseline,
    allowEscape: false,
  });

  assert.notEqual(hashRunSpec(baseline), hashRunSpec(promptChanged));
  assert.notEqual(hashRunSpec(baseline), hashRunSpec(escapeChanged));
  assert.equal(hashRunSpec(omittedEscape), hashRunSpec(explicitFalseEscape));
});

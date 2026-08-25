#!/usr/bin/env node
/**
 * run-gates.mjs
 *
 * Runs a list of verification gates and reports the status of EVERY one,
 * instead of stopping at the first failure.
 *
 * Why this exists
 * ---------------
 * `verify:strict*` was a single `&&` chain of ~24 clauses. One red clause
 * short-circuits everything after it, so the operator learns about exactly one
 * failure per run and knows nothing about the state of the remaining gates.
 *
 * That property is not cosmetic — it is why DZUPAGENT-TEST-C-13 recurred as
 * C-14. `check:test-typecheck` sat at position 16 of the chain; while it was
 * red, `test:scripts`, the turbo `build:verify typecheck lint test` run and the
 * four artifact gates after it never executed, so nobody could see whether they
 * were also broken. Fixing the visible failure just uncovered the next one.
 *
 * Running every gate turns one debugging session per failure into one session
 * for all of them.
 *
 * Fail-fast semantics are preserved where they are load-bearing: a gate marked
 * `blocking` aborts the run, because gates after it would produce meaningless
 * results (e.g. artifact checks against a tree that never built).
 *
 * Usage:
 *   node scripts/run-gates.mjs --profile strict-ci
 *   node scripts/run-gates.mjs --profile strict-ci --fail-fast
 *   node scripts/run-gates.mjs --list
 *
 * Exit code is 0 only when every gate passed.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A gate is `{ name, run, blocking? }`.
 *
 * `blocking: true` means "stop here on failure" — reserved for the build step,
 * whose output every later gate inspects. Everything else runs unconditionally
 * so a single red gate cannot hide the rest.
 */
export const BUILD_GATE_NAME = "build+typecheck+lint+test";

const BUILD_STEP = {
  name: BUILD_GATE_NAME,
  // Run through `yarn` like every other gate (see `asGate`): `turbo` is a
  // Yarn-managed binary and is NOT on PATH, so spawning this string with bare
  // `node` fails with "build-custody: spawn turbo ENOENT" — which, because this
  // gate is blocking, aborted the profile and hid the four gates after it.
  run: "yarn node scripts/run-with-build-custody.mjs turbo run build:verify typecheck lint test --concurrency=4 --output-logs=new-only",
  // Artifact/coverage gates below read the build output. Running them against
  // a failed build reports noise, not signal.
  blocking: true,
};

const STATIC_CHECKS = [
  "check:turbo:typecheck-order",
  "test:inventory:runtime:strict",
  "check:improvements:drift",
  "check:gitleaks-allowlist",
  "check:waiver-expiry",
  "check:capability-matrix",
  "check:memory-api-census",
  "check:memory-conformance",
  "check:package-tiers",
  "check:domain-boundaries",
  "check:layer-boundaries",
  "check:control-plane-freeze",
  "check:server-api-surface",
  "check:terminal-tool-event-guards",
  "check:test-sleeps",
  "check:test-naming",
  "check:test-typecheck",
  "test:scripts",
];

// Runs after the build because the corpus round-trip loads compiled flow
// packages; it is not an artifact check, hence its own list.
const POST_BUILD_CHECKS = ["check:flow-corpus-losslessness"];

const ARTIFACT_CHECKS = [
  "check:build-artifact-integrity",
  "check:package-export-artifacts",
  "check:dts-budgets",
  "check:barrel-budgets",
  // Last, matching its position in the verify:strict chain. CI runs ONLY the
  // profile, so while this was absent the dependency audit never ran in CI at
  // all — one of the three independent reasons a runtime-reachable High CVE
  // survived three audit cycles.
  "audit:deps",
];

const asGate = (script) => ({ name: script, run: `yarn ${script}` });

export const PROFILES = {
  "strict-ci": [
    ...STATIC_CHECKS.map(asGate),
    BUILD_STEP,
    ...POST_BUILD_CHECKS.map(asGate),
    ...ARTIFACT_CHECKS.map(asGate),
  ],
};

/**
 * The `&&` chain in package.json is the human-authored source of truth for
 * which gates exist. The profile above is a hand-transcribed copy of it, and a
 * hand-transcribed copy drifts: `check:memory-api-census`,
 * `check:memory-conformance` and `check:flow-corpus-losslessness` were dropped
 * when this runner was first written and were never noticed, because CI runs
 * ONLY the profile. Two of the three had rotted red by the time anyone looked.
 *
 * `compareProfileToChain` is the guard that makes that class of drift
 * impossible to reintroduce silently; `scripts/__tests__/run-gates.test.mjs`
 * asserts it against the real package.json, and `test:scripts` is itself a gate
 * in the profile.
 */
export function parseChainGates(script) {
  return script
    .split("&&")
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause) =>
      // The build clause is spelled out inline rather than as a `yarn <script>`
      // indirection, so it is identified by what it runs, not by its prefix.
      clause.includes("turbo run build:verify")
        ? BUILD_GATE_NAME
        : clause.startsWith("yarn ")
          ? clause.slice("yarn ".length).trim()
          : clause
    );
}

export function compareProfileToChain(gates, chainScript) {
  const chain = parseChainGates(chainScript);
  const profile = gates.map((g) => g.name);
  const messages = [];

  for (const name of chain) {
    if (!profile.includes(name)) {
      messages.push(
        `gate "${name}" is in the verify chain but NOT in the profile — CI runs the profile, so this gate never runs`
      );
    }
  }
  for (const name of profile) {
    if (!chain.includes(name)) {
      messages.push(`gate "${name}" is in the profile but NOT in the verify chain`);
    }
  }
  if (messages.length === 0 && profile.join("\u0000") !== chain.join("\u0000")) {
    messages.push(
      `profile and verify chain hold the same gates in a different order:\n  profile: ${profile.join(", ")}\n  chain:   ${chain.join(", ")}`
    );
  }

  return { ok: messages.length === 0, messages };
}

function parseArgs(argv) {
  return {
    profile: argv.includes("--profile")
      ? argv[argv.indexOf("--profile") + 1]
      : "strict-ci",
    failFast: argv.includes("--fail-fast"),
    list: argv.includes("--list"),
  };
}

function main() {
  const { profile, failFast, list } = parseArgs(process.argv.slice(2));
  const gates = PROFILES[profile];

  if (!gates) {
    console.error(
      `[run-gates] unknown profile "${profile}". Known: ${Object.keys(PROFILES).join(", ")}`
    );
    process.exit(2);
  }

  if (list) {
    for (const g of gates) {
      console.log(`${g.name}${g.blocking ? "  (blocking)" : ""}`);
    }
    return;
  }

  const results = [];
  let aborted = null;

  for (const gate of gates) {
    process.stdout.write(`\n[run-gates] ── ${gate.name}\n`);
    const started = process.hrtime.bigint();
    const proc = spawnSync(gate.run, {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
    });
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const ok = proc.status === 0;
    results.push({ name: gate.name, ok, ms });

    if (!ok && (failFast || gate.blocking)) {
      aborted = gate;
      break;
    }
  }

  const failed = results.filter((r) => !r.ok);

  console.log(`\n[run-gates] ${"─".repeat(52)}`);
  for (const r of results) {
    console.log(
      `[run-gates] ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.ms}ms)`
    );
  }

  const skipped = gates.length - results.length;
  if (aborted) {
    console.log(
      `\n[run-gates] aborted after blocking gate "${aborted.name}" — ${skipped} gate(s) not run.`
    );
  }

  if (failed.length > 0) {
    console.log(
      `\n[run-gates] FAIL: ${failed.length} of ${results.length} gate(s) failed: ${failed
        .map((f) => f.name)
        .join(", ")}`
    );
    process.exit(1);
  }

  console.log(`\n[run-gates] OK — ${results.length} gate(s) passed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

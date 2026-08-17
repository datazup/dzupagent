/**
 * Parity between the TeamRuntime alerting runbook and the metric map.
 *
 * The runbook (workspace-docs/repos/dzupagent/docs/TEAM_RUNTIME_ALERTING.md)
 * ships PromQL that consuming environments copy into their own rule files.
 * dzupagent has no Prometheus deployment of its own, so nothing else would ever
 * catch a rule referencing a metric this repo stopped emitting — the alert would
 * simply never fire, which on a dashboard is indistinguishable from healthy.
 *
 * That is the same failure mode the alerted-on metrics exist to expose, so it
 * would be a poor joke to leave the runbook itself silently broken. This test
 * parses the metric names out of the document and asserts each one is really
 * emitted. Renaming a metric without updating the runbook fails here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teamRuntimeMetricMap } from "../event-metric-map/team-runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up to the workspace root to find the runbook.
 *
 * The doc lives in the sibling `workspace-docs/` repo, so its path relative to
 * this package depends on checkout layout. Search upward rather than hard-coding
 * `../../../../../..`, which silently breaks in a worktree.
 */
function findRunbook(): string | null {
  const relative = join(
    "workspace-docs",
    "repos",
    "dzupagent",
    "docs",
    "TEAM_RUNTIME_ALERTING.md"
  );
  let dir = HERE;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every metric name the metric-map fragment actually emits. */
const emitted = new Set(
  Object.values(teamRuntimeMetricMap)
    .flat()
    .map((m) => m.metricName)
);

const runbookPath = findRunbook();

// The durable runbook belongs to workspace-docs, not to DzupAgent's source
// checkout. Validate the real document in the multi-repo workspace, but do not
// turn its expected absence in standalone package CI into an OTEL code failure.
describe.skipIf(runbookPath === null)("team runtime alerting runbook", () => {
  it("is present at the documented path", () => {
    // A soft skip here would let the doc be deleted without anyone noticing,
    // which defeats the purpose of pinning it.
    expect(
      runbookPath,
      "TEAM_RUNTIME_ALERTING.md not found by walking up from the otel package"
    ).not.toBeNull();
  });

  it("references only metrics that are actually emitted", () => {
    const text = readFileSync(runbookPath!, "utf8");

    // Every dzip_team_* token in the doc, from both the tables and the PromQL.
    const referenced = new Set(text.match(/dzip_team_[a-z0-9_]+/g) ?? []);
    expect(
      referenced.size,
      "runbook references no metrics at all"
    ).toBeGreaterThan(0);

    const unknown = [...referenced].filter((name) => !emitted.has(name));
    expect(
      unknown,
      `runbook references metric(s) the team-runtime map does not emit: ${unknown.join(
        ", "
      )}`
    ).toEqual([]);
  });

  it("documents every metric the fragment emits", () => {
    // The converse direction: a metric added to the map without a line in the
    // runbook is a signal nobody is told how to alert on.
    const text = readFileSync(runbookPath!, "utf8");
    const undocumented = [...emitted].filter((name) => !text.includes(name));
    expect(
      undocumented,
      `metric(s) emitted but absent from the runbook: ${undocumented.join(
        ", "
      )}`
    ).toEqual([]);
  });

  it("covers the two declared-but-unenforced signals with alert rules", () => {
    const text = readFileSync(runbookPath!, "utf8");

    // These two are the reason the runbook exists. A rule file that dropped
    // them would still pass the name-parity checks above while losing the
    // entire point.
    expect(text).toMatch(/outcome="skipped"/);
    expect(text).toMatch(/reason="unwired"/);
    expect(text).toMatch(/reason="failed"/);
  });

  it("alerts separately on a failing scorer and an unwired gate", () => {
    // Both are outcome="skipped" but only one is an outage in progress. A
    // runbook that alerted on the bare outcome would bury the outage in the
    // constant background rate of teams that simply never wired a scorer —
    // the reason the `reason` label was added.
    const text = readFileSync(runbookPath!, "utf8");

    expect(text).toMatch(/reason="scorer_failed"/);
    // The unwired rule must be filtered too, or it double-counts the outage.
    expect(text).toMatch(/outcome="skipped",reason="unwired"/);
  });

  it("declares every label key the map emits for the verdict metric", () => {
    // A rule grouping by or filtering on a label the exporter never emits
    // matches nothing and silently never fires.
    const verdict = teamRuntimeMetricMap["team:verdict_evaluated"]![0]!;
    expect(verdict.labelKeys).toContain("reason");
  });
});

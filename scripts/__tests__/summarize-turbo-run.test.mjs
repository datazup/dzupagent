import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareTurboRunSummaries,
  formatTurboRunComparison,
  formatTurboRunSummary,
  summarizeTurboRun,
} from '../summarize-turbo-run.mjs';

function makeTask(taskId, durationMs, dependencies = []) {
  const [pkg, task] = taskId.split('#');
  return {
    taskId,
    task,
    package: pkg,
    command: 'echo test',
    cache: { status: 'MISS' },
    dependencies,
    execution: {
      startTime: 1_000,
      endTime: 1_000 + durationMs,
      exitCode: 0,
    },
  };
}

test('summarizes slow tasks and dependency-duration chain', () => {
  const summary = summarizeTurboRun({
    id: 'run-1',
    turboVersion: '2.9.0',
    execution: {
      startTime: 1_000,
      endTime: 11_000,
    },
    tasks: [
      makeTask('@dzupagent/core#build', 5_000),
      makeTask('@dzupagent/agent#build', 7_000, ['@dzupagent/core#build']),
      makeTask('@dzupagent/server#build', 3_000, ['@dzupagent/agent#build']),
      makeTask('@dzupagent/flow-dsl#build', 9_000),
    ],
  });

  assert.equal(summary.taskCount, 4);
  assert.equal(summary.wallTimeMs, 10_000);
  assert.deepEqual(
    summary.slowestTasks.map((task) => task.taskId),
    [
      '@dzupagent/flow-dsl#build',
      '@dzupagent/agent#build',
      '@dzupagent/core#build',
      '@dzupagent/server#build',
    ],
  );
  assert.deepEqual(
    summary.criticalPath.path.map((task) => task.taskId),
    [
      '@dzupagent/core#build',
      '@dzupagent/agent#build',
      '@dzupagent/server#build',
    ],
  );
  assert.equal(summary.criticalPath.durationMs, 15_000);
});

test('filters by task name before computing the chain', () => {
  const summary = summarizeTurboRun(
    {
      id: 'run-2',
      tasks: [
        makeTask('@dzupagent/core#build', 5_000),
        makeTask('@dzupagent/core#typecheck', 6_000, ['@dzupagent/core#build']),
        makeTask('@dzupagent/agent#typecheck', 7_000, ['@dzupagent/core#typecheck']),
      ],
    },
    { task: 'typecheck' },
  );

  assert.equal(summary.taskCount, 2);
  assert.deepEqual(
    summary.criticalPath.path.map((task) => task.taskId),
    ['@dzupagent/core#typecheck', '@dzupagent/agent#typecheck'],
  );
});

test('formats a readable report', () => {
  const report = formatTurboRunSummary(
    summarizeTurboRun({
      id: 'run-3',
      tasks: [makeTask('@dzupagent/core#build', 1_250)],
    }),
    { top: 1 },
  );

  assert.match(report, /Turbo run run-3/);
  assert.match(report, /@dzupagent\/core#build 1\.25s cache=MISS/);
  assert.match(report, /Total task duration on chain: 1\.25s/);
});

test('compares two run summaries by wall time, critical path, and task deltas', () => {
  const baseline = summarizeTurboRun({
    id: 'baseline',
    execution: {
      startTime: 1_000,
      endTime: 21_000,
    },
    tasks: [
      makeTask('@dzupagent/core#build', 10_000),
      makeTask('@dzupagent/agent#build', 8_000, ['@dzupagent/core#build']),
      makeTask('@dzupagent/old#build', 2_000),
    ],
  });
  const current = summarizeTurboRun({
    id: 'current',
    execution: {
      startTime: 1_000,
      endTime: 16_000,
    },
    tasks: [
      makeTask('@dzupagent/core#build', 7_000),
      makeTask('@dzupagent/agent#build', 6_000, ['@dzupagent/core#build']),
      makeTask('@dzupagent/new#build', 1_000),
    ],
  });

  const comparison = compareTurboRunSummaries(baseline, current);

  assert.equal(comparison.wallTimeDeltaMs, -5_000);
  assert.equal(comparison.criticalPathDeltaMs, -5_000);
  assert.deepEqual(
    comparison.taskDeltas.map((taskDelta) => [taskDelta.taskId, taskDelta.deltaMs, taskDelta.status]),
    [
      ['@dzupagent/core#build', -3_000, 'present'],
      ['@dzupagent/agent#build', -2_000, 'present'],
      ['@dzupagent/old#build', -2_000, 'removed'],
      ['@dzupagent/new#build', 1_000, 'added'],
    ],
  );
});

test('formats a readable comparison report', () => {
  const report = formatTurboRunComparison(
    compareTurboRunSummaries(
      summarizeTurboRun({
        id: 'baseline',
        tasks: [makeTask('@dzupagent/core#build', 2_500)],
      }),
      summarizeTurboRun({
        id: 'current',
        tasks: [makeTask('@dzupagent/core#build', 1_250)],
      }),
    ),
    { top: 1 },
  );

  assert.match(report, /Turbo run comparison/);
  assert.match(report, /Baseline: baseline/);
  assert.match(report, /Current: current/);
  assert.match(report, /@dzupagent\/core#build 2\.50s -> 1\.25s \(-1\.25s\) present/);
});

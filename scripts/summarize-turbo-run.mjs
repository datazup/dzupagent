import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNS_DIR = '.turbo/runs';
const DEFAULT_TOP_COUNT = 10;

function parseArgs(argv) {
  const options = {
    comparePath: undefined,
    json: false,
    latest: false,
    task: undefined,
    top: DEFAULT_TOP_COUNT,
    summaryPath: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--latest') {
      options.latest = true;
      continue;
    }
    if (arg === '--compare') {
      const value = argv[index + 1];
      if (!value) throw new Error('--compare requires a baseline summary path');
      options.comparePath = value;
      index += 1;
      continue;
    }
    if (arg === '--task') {
      const value = argv[index + 1];
      if (!value) throw new Error('--task requires a value');
      options.task = value;
      index += 1;
      continue;
    }
    if (arg === '--top') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--top requires a positive integer');
      }
      options.top = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.summaryPath) {
      throw new Error(`Unexpected extra summary path: ${arg}`);
    }
    options.summaryPath = arg;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/summarize-turbo-run.mjs [options] [summary.json]

Summarizes a Turbo --summarize run JSON by task duration and dependency chain.
If no summary path is provided, the newest .turbo/runs/*.json file is used.

Options:
  --compare <path>  Compare a baseline summary with the selected/current summary
  --latest          Use the newest .turbo/runs/*.json summary
  --task <name>     Only include a task name such as build, typecheck, lint, or test
  --top <count>     Number of slowest tasks to print (default: ${DEFAULT_TOP_COUNT})
  --json            Print machine-readable JSON
  -h, --help        Show this help`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function findLatestTurboSummary(root) {
  const runsDir = path.join(root, DEFAULT_RUNS_DIR);
  const entries = await readdir(runsDir, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(runsDir, entry.name);
    const fileStat = await stat(filePath);
    candidates.push({ filePath, mtimeMs: fileStat.mtimeMs });
  }

  if (candidates.length === 0) {
    throw new Error(`No Turbo summary files found in ${runsDir}`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].filePath;
}

function getTaskDurationMs(task) {
  const startTime = task.execution?.startTime;
  const endTime = task.execution?.endTime;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
    return 0;
  }
  return endTime - startTime;
}

function taskCacheStatus(task) {
  if (task.cache?.local || task.cache?.remote) return 'HIT';
  return task.cache?.status ?? 'UNKNOWN';
}

function createTaskRow(task) {
  return {
    taskId: task.taskId,
    task: task.task,
    package: task.package,
    command: task.command,
    directory: task.directory,
    cacheStatus: taskCacheStatus(task),
    durationMs: getTaskDurationMs(task),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    dependents: Array.isArray(task.dependents) ? task.dependents : [],
  };
}

function computeCriticalPath(tasks) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const memo = new Map();
  const visiting = new Set();

  function visit(taskId) {
    if (memo.has(taskId)) return memo.get(taskId);

    const task = taskById.get(taskId);
    if (!task) return { durationMs: 0, path: [] };
    if (visiting.has(taskId)) {
      throw new Error(`Cycle detected while computing Turbo dependency chain at ${taskId}`);
    }

    visiting.add(taskId);
    let bestDependency = { durationMs: 0, path: [] };

    for (const dependencyId of task.dependencies) {
      if (!taskById.has(dependencyId)) continue;
      const candidate = visit(dependencyId);
      if (candidate.durationMs > bestDependency.durationMs) {
        bestDependency = candidate;
      }
    }

    visiting.delete(taskId);

    const result = {
      durationMs: bestDependency.durationMs + task.durationMs,
      path: [...bestDependency.path, task],
    };
    memo.set(taskId, result);
    return result;
  }

  let criticalPath = { durationMs: 0, path: [] };
  for (const task of tasks) {
    const candidate = visit(task.taskId);
    if (candidate.durationMs > criticalPath.durationMs) {
      criticalPath = candidate;
    }
  }

  return criticalPath;
}

export function summarizeTurboRun(turboSummary, options = {}) {
  const taskName = options.task;
  const allTasks = Array.isArray(turboSummary.tasks)
    ? turboSummary.tasks.map(createTaskRow)
    : [];
  const tasks = taskName
    ? allTasks.filter((task) => task.task === taskName)
    : allTasks;
  const sortedByDuration = [...tasks].sort((left, right) => right.durationMs - left.durationMs);
  const cache = tasks.reduce(
    (accumulator, task) => {
      if (task.cacheStatus === 'HIT') accumulator.hits += 1;
      else accumulator.misses += 1;
      return accumulator;
    },
    { hits: 0, misses: 0 },
  );

  const startTime = turboSummary.execution?.startTime;
  const endTime = turboSummary.execution?.endTime;
  const wallTimeMs = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime
    ? endTime - startTime
    : undefined;

  return {
    id: turboSummary.id,
    turboVersion: turboSummary.turboVersion,
    task: taskName,
    taskCount: tasks.length,
    wallTimeMs,
    cache,
    slowestTasks: sortedByDuration,
    criticalPath: computeCriticalPath(tasks),
  };
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return 'unknown';
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(2)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1000).toFixed(2).padStart(5, '0');
  return `${minutes}m${seconds}s`;
}

function formatTask(task) {
  return `${task.taskId} ${formatDuration(task.durationMs)} cache=${task.cacheStatus}`;
}

function formatDelta(durationMs) {
  if (durationMs === 0) return formatDuration(0);
  const sign = durationMs > 0 ? '+' : '-';
  return `${sign}${formatDuration(Math.abs(durationMs))}`;
}

export function formatTurboRunSummary(summary, options = {}) {
  const lines = [];
  const top = options.top ?? DEFAULT_TOP_COUNT;
  const titleTask = summary.task ? ` (${summary.task})` : '';

  lines.push(`Turbo run ${summary.id ?? '<unknown>'}${titleTask}`);
  if (summary.turboVersion) lines.push(`Turbo version: ${summary.turboVersion}`);
  if (summary.wallTimeMs !== undefined) lines.push(`Wall time: ${formatDuration(summary.wallTimeMs)}`);
  lines.push(`Tasks: ${summary.taskCount}; cache hits: ${summary.cache.hits}; cache misses: ${summary.cache.misses}`);
  lines.push('');
  lines.push(`Slowest tasks (top ${Math.min(top, summary.slowestTasks.length)}):`);

  for (const [index, task] of summary.slowestTasks.slice(0, top).entries()) {
    lines.push(`${index + 1}. ${formatTask(task)}`);
  }

  lines.push('');
  lines.push('Longest dependency-duration chain:');
  if (summary.criticalPath.path.length === 0) {
    lines.push('<none>');
  } else {
    for (const task of summary.criticalPath.path) {
      lines.push(`- ${formatTask(task)}`);
    }
    lines.push(`Total task duration on chain: ${formatDuration(summary.criticalPath.durationMs)}`);
  }

  return lines.join('\n');
}

function mapTasksById(summary) {
  return new Map(summary.slowestTasks.map((task) => [task.taskId, task]));
}

export function compareTurboRunSummaries(baseline, current) {
  const baselineTasksById = mapTasksById(baseline);
  const currentTasksById = mapTasksById(current);
  const taskIds = new Set([...baselineTasksById.keys(), ...currentTasksById.keys()]);
  const taskDeltas = [];

  for (const taskId of taskIds) {
    const baselineTask = baselineTasksById.get(taskId);
    const currentTask = currentTasksById.get(taskId);
    const baselineDurationMs = baselineTask?.durationMs ?? 0;
    const currentDurationMs = currentTask?.durationMs ?? 0;
    taskDeltas.push({
      taskId,
      baselineDurationMs,
      currentDurationMs,
      deltaMs: currentDurationMs - baselineDurationMs,
      status: baselineTask && currentTask ? 'present' : baselineTask ? 'removed' : 'added',
    });
  }

  taskDeltas.sort((left, right) => Math.abs(right.deltaMs) - Math.abs(left.deltaMs));

  return {
    baselineId: baseline.id,
    currentId: current.id,
    task: current.task ?? baseline.task,
    baselineWallTimeMs: baseline.wallTimeMs,
    currentWallTimeMs: current.wallTimeMs,
    wallTimeDeltaMs: current.wallTimeMs !== undefined && baseline.wallTimeMs !== undefined
      ? current.wallTimeMs - baseline.wallTimeMs
      : undefined,
    baselineCriticalPathMs: baseline.criticalPath.durationMs,
    currentCriticalPathMs: current.criticalPath.durationMs,
    criticalPathDeltaMs: current.criticalPath.durationMs - baseline.criticalPath.durationMs,
    taskDeltas,
  };
}

export function formatTurboRunComparison(comparison, options = {}) {
  const lines = [];
  const top = options.top ?? DEFAULT_TOP_COUNT;
  const titleTask = comparison.task ? ` (${comparison.task})` : '';

  lines.push(`Turbo run comparison${titleTask}`);
  lines.push(`Baseline: ${comparison.baselineId ?? '<unknown>'}`);
  lines.push(`Current: ${comparison.currentId ?? '<unknown>'}`);
  if (comparison.wallTimeDeltaMs !== undefined) {
    lines.push(
      `Wall time: ${formatDuration(comparison.baselineWallTimeMs)} -> ${formatDuration(comparison.currentWallTimeMs)} (${formatDelta(comparison.wallTimeDeltaMs)})`,
    );
  }
  lines.push(
    `Critical path: ${formatDuration(comparison.baselineCriticalPathMs)} -> ${formatDuration(comparison.currentCriticalPathMs)} (${formatDelta(comparison.criticalPathDeltaMs)})`,
  );
  lines.push('');
  lines.push(`Largest task deltas (top ${Math.min(top, comparison.taskDeltas.length)}):`);

  for (const [index, taskDelta] of comparison.taskDeltas.slice(0, top).entries()) {
    lines.push(
      `${index + 1}. ${taskDelta.taskId} ${formatDuration(taskDelta.baselineDurationMs)} -> ${formatDuration(taskDelta.currentDurationMs)} (${formatDelta(taskDelta.deltaMs)}) ${taskDelta.status}`,
    );
  }

  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const root = process.cwd();
  const summaryPath = options.summaryPath
    ? path.resolve(root, options.summaryPath)
    : await findLatestTurboSummary(root);
  const turboSummary = await readJson(summaryPath);
  const summary = summarizeTurboRun(turboSummary, { task: options.task });

  if (options.json) {
    if (options.comparePath) {
      const baselinePath = path.resolve(root, options.comparePath);
      const baseline = summarizeTurboRun(await readJson(baselinePath), { task: options.task });
      console.log(JSON.stringify({
        baselinePath,
        summaryPath,
        ...compareTurboRunSummaries(baseline, summary),
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({ summaryPath, ...summary }, null, 2));
    return;
  }

  if (options.comparePath) {
    const baselinePath = path.resolve(root, options.comparePath);
    const baseline = summarizeTurboRun(await readJson(baselinePath), { task: options.task });
    console.log(`Baseline summary file: ${path.relative(root, baselinePath)}`);
    console.log(`Current summary file: ${path.relative(root, summaryPath)}`);
    console.log(formatTurboRunComparison(compareTurboRunSummaries(baseline, summary), { top: options.top }));
    return;
  }

  console.log(`Summary file: ${path.relative(root, summaryPath)}`);
  console.log(formatTurboRunSummary(summary, { top: options.top }));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

/**
 * Stuck detector — identifies when an agent is making no progress.
 *
 * Canonical 5-mode implementation, unified for both `@dzupagent/agent` and
 * `@dzupagent/agent-adapters`. Detects:
 *
 * 1. Repeated identical tool calls (same name + same input hash)
 * 2. High error rate within a rolling time window
 * 3. No-progress (idle) iterations with no tool calls
 * 4. Repeated non-overlapping tool-name block patterns ("progress hash")
 * 5. Semantic plateau: fixation on a single tool across a configurable window
 */
import type { StuckDetectorConfig } from "@dzupagent/agent-types";
import { hashToolInput } from "../utils/hash.js";

export type { StuckDetectorConfig };

export interface StuckStatus {
  stuck: boolean;
  reason?: string;
}

/** Fully-resolved config with all defaults applied. */
type ResolvedStuckDetectorConfig = Required<StuckDetectorConfig>;

const DEFAULT_CONFIG: ResolvedStuckDetectorConfig = {
  maxRepeatCalls: 3,
  maxErrorsInWindow: 5,
  errorWindowMs: 60_000,
  maxIdleIterations: 3,
  semanticPlateauWindow: 0,
};

export class StuckDetector {
  private recentCalls: Array<{
    name: string;
    hash: string;
    timestamp: number;
  }> = [];
  private recentErrors: Array<{ message: string; timestamp: number }> = [];
  private idleCount = 0;
  private _lastToolCallCount = 0;
  private readonly config: ResolvedStuckDetectorConfig;

  // Progress-hash detection state (non-overlapping block hashing)
  private readonly hashWindow = 5;
  private readonly hashRepeatThreshold = 3;
  private currentBlock: string[] = [];
  private lastCompletedBlock: string[] = [];
  private hashHistory: string[] = [];

  // Semantic plateau: recent tool names window (FIFO, bounded to semanticPlateauWindow)
  private semanticWindow: string[] = [];

  constructor(config?: StuckDetectorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Number of tool calls in the most recent iteration */
  get lastToolCalls(): number {
    return this._lastToolCallCount;
  }

  /** Record a tool call. Returns stuck status. */
  recordToolCall(name: string, input: unknown): StuckStatus {
    const hash = this.hashInput(input);
    this.recentCalls.push({ name, hash, timestamp: Date.now() });
    // DZUPAGENT-AGENT-L-08: cap the ring buffer to the detection window. The
    // repeated-identical-call check only ever inspects the last
    // `maxRepeatCalls` entries, so older entries can never change a decision
    // and would otherwise grow unbounded for the lifetime of a long run.
    if (this.recentCalls.length > this.config.maxRepeatCalls) {
      this.recentCalls = this.recentCalls.slice(-this.config.maxRepeatCalls);
    }
    this.idleCount = 0; // tool call = progress

    // Check for repeated identical calls
    const tail = this.recentCalls.slice(-this.config.maxRepeatCalls);
    if (tail.length >= this.config.maxRepeatCalls) {
      const first = tail[0]!;
      const allSame = tail.every(
        (c) => c.name === first.name && c.hash === first.hash
      );
      if (allSame) {
        return {
          stuck: true,
          reason: `Tool "${name}" called ${this.config.maxRepeatCalls} times with identical input`,
        };
      }
    }

    // Progress-hash check: detect repeated identical non-overlapping blocks
    this.recordToolNameForHash(name);
    if (this.isStuckByHash()) {
      return {
        stuck: true,
        reason: `Identical tool sequence repeated ${
          this.hashRepeatThreshold
        } times: [${this.lastCompletedBlock.join(", ")}]`,
      };
    }

    // Semantic plateau: detect fixation on a single tool with varied arguments
    if (this.config.semanticPlateauWindow > 0) {
      this.semanticWindow.push(name);
      if (this.semanticWindow.length > this.config.semanticPlateauWindow) {
        this.semanticWindow.shift();
      }
      if (this.semanticWindow.length >= this.config.semanticPlateauWindow) {
        const uniqueTools = new Set(this.semanticWindow);
        if (uniqueTools.size === 1) {
          return {
            stuck: true,
            reason: `Semantic plateau: tool "${name}" called ${this.config.semanticPlateauWindow} consecutive times with no other tools`,
          };
        }
      }
    }

    return { stuck: false };
  }

  /**
   * Accumulate tool names into non-overlapping blocks of `hashWindow`.
   * Each time a block is complete its hash is appended to `hashHistory`.
   * Called internally on every tool call.
   */
  private recordToolNameForHash(toolName: string): void {
    this.currentBlock.push(toolName);
    if (this.currentBlock.length === this.hashWindow) {
      const blockHash = this.currentBlock.join("|");
      this.hashHistory.push(blockHash);
      if (this.hashHistory.length > this.hashRepeatThreshold) {
        this.hashHistory.shift();
      }
      this.lastCompletedBlock = [...this.currentBlock];
      this.currentBlock = [];
    }
  }

  /**
   * Returns true when the last `hashRepeatThreshold` non-overlapping blocks
   * all produced the same hash — meaning the agent called the exact same
   * sequence of `hashWindow` tool names that many consecutive times.
   */
  private isStuckByHash(): boolean {
    if (this.hashHistory.length < this.hashRepeatThreshold) return false;
    const first = this.hashHistory[0]!;
    return this.hashHistory.every((h) => h === first);
  }

  /**
   * Record an error. Accepts either an Error instance or a raw string message
   * (the latter is convenient for adapter event streams whose error payloads
   * are already serialized).
   */
  recordError(error: Error | string): StuckStatus {
    const message = typeof error === "string" ? error : error.message;
    this.recentErrors.push({ message, timestamp: Date.now() });

    // DZUPAGENT-AGENT-L-08: prune to the detection window on every push so the
    // buffer is bounded to in-window entries instead of growing unbounded.
    // Entries older than `errorWindowMs` can never count toward the rate check.
    const windowStart = Date.now() - this.config.errorWindowMs;
    this.recentErrors = this.recentErrors.filter(
      (e) => e.timestamp >= windowStart
    );

    // Check error rate in window (buffer is already pruned to the window).
    const recent = this.recentErrors;
    if (recent.length >= this.config.maxErrorsInWindow) {
      return {
        stuck: true,
        reason: `${recent.length} errors in ${Math.round(
          this.config.errorWindowMs / 1000
        )}s window`,
      };
    }

    return { stuck: false };
  }

  /** Record an iteration tick. Detects idle (no tool calls) iterations. */
  recordIteration(toolCallsThisIteration: number): StuckStatus {
    if (toolCallsThisIteration === 0) {
      this.idleCount++;
    } else {
      this.idleCount = 0;
    }
    this._lastToolCallCount = toolCallsThisIteration;

    if (this.idleCount >= this.config.maxIdleIterations) {
      return {
        stuck: true,
        reason: `${this.idleCount} consecutive iterations with no tool calls`,
      };
    }

    return { stuck: false };
  }

  /** Reset all tracking state */
  reset(): void {
    this.recentCalls = [];
    this.recentErrors = [];
    this.idleCount = 0;
    this._lastToolCallCount = 0;
    this.currentBlock = [];
    this.lastCompletedBlock = [];
    this.hashHistory = [];
    this.semanticWindow = [];
  }

  /**
   * Signal that a paused/suspended agent has been resumed (REC-M-03).
   *
   * Under parallel-mode pause/resume, the idle-iteration counter must be
   * reset at resume time — not at the next iteration's entry — so a run
   * that was paused for human approval (or any other suspend gate) is
   * not falsely flagged as stuck on the very first iteration after
   * resume. Idle counter accumulates across iterations with no tool
   * calls; pause/resume is not idleness and must clear that signal.
   *
   * Other progress signals (recent-call hashes, error window, semantic
   * plateau, progress-hash blocks) are intentionally preserved — they
   * track inter-iteration patterns that remain valid across a pause.
   * To clear all state, use {@link reset}.
   */
  notifyResumed(): void {
    this.idleCount = 0;
    this._lastToolCallCount = 0;
  }

  private hashInput(input: unknown): string {
    return hashToolInput(input);
  }
}

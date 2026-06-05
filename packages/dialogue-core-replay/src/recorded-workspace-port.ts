import { isDeepStrictEqual } from "node:util";

import type {
  WorkspaceEffect,
  WorkspacePort,
  WorkspaceSnapshot,
} from "@dzupagent/dialogue-core";

import { ReplayExhaustedError } from "./errors.js";

export interface RecordedWorkspaceEffectCapture {
  readonly beforeSnapshot?: WorkspaceSnapshot;
  readonly effect: WorkspaceEffect;
}

export interface RecordedWorkspacePortOptions {
  readonly snapshots: readonly WorkspaceSnapshot[];
  readonly effects: readonly RecordedWorkspaceEffectCapture[];
}

export class RecordedWorkspacePort implements WorkspacePort {
  private snapshotCallIndex = 0;
  private captureEffectCallIndex = 0;
  private mismatchCount = 0;

  constructor(private readonly options: RecordedWorkspacePortOptions) {}

  get dialogueReplayRecordedPortCallCount(): number {
    return this.snapshotCallIndex + this.captureEffectCallIndex;
  }

  get dialogueReplayWorkspaceWriteMismatchCount(): number {
    return this.mismatchCount;
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const callIndex = this.snapshotCallIndex;
    const snapshot = this.options.snapshots[callIndex];
    if (snapshot === undefined) {
      throw new ReplayExhaustedError("workspace", "snapshot", callIndex);
    }

    this.snapshotCallIndex += 1;
    return { ...snapshot };
  }

  async captureEffect(
    beforeSnapshot: WorkspaceSnapshot,
  ): Promise<WorkspaceEffect> {
    const callIndex = this.captureEffectCallIndex;
    const capture = this.options.effects[callIndex];
    if (capture === undefined) {
      throw new ReplayExhaustedError(
        "workspace",
        "captureEffect",
        callIndex,
      );
    }

    this.captureEffectCallIndex += 1;
    if (
      capture.beforeSnapshot !== undefined &&
      !isDeepStrictEqual(beforeSnapshot, capture.beforeSnapshot)
    ) {
      this.mismatchCount += 1;
      throw new Error(
        `Recorded workspace effect input mismatch at call index ${callIndex}.`,
      );
    }

    return cloneWorkspaceEffect(capture.effect);
  }
}

function cloneWorkspaceEffect(effect: WorkspaceEffect): WorkspaceEffect {
  return {
    diff: effect.diff,
    changedFiles: [...effect.changedFiles],
    postRevision: effect.postRevision,
    treeHash: effect.treeHash,
    applyStatus: effect.applyStatus,
  };
}

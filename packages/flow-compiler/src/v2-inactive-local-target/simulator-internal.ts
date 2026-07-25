import type { PrimitiveDefinitionV2 } from "@dzupagent/flow-dsl";
import type { PrimitiveMultiPortSaveContract } from "@dzupagent/flow-dsl/v2-multi-port-save";
import type { PrimitivePolicyLimits } from "@dzupagent/flow-dsl/v2-policy-narrowing";
import type { PrimitiveRetryPolicy } from "@dzupagent/flow-dsl/v2-retry-policy";
import type { PrimitiveTerminalCatchContract } from "@dzupagent/flow-dsl/v2-terminal-catch";

import type {
  V2InactiveLocalAttemptReceipt,
  V2InactiveLocalSimulationRequest,
} from "./simulator-contracts.js";

export interface SimulationContext {
  readonly request: V2InactiveLocalSimulationRequest;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly primitive: PrimitiveDefinitionV2;
  readonly authoredPath: string;
  readonly condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  };
  readonly policy: PrimitivePolicyLimits;
  readonly retry: PrimitiveRetryPolicy;
  readonly terminalCatch: PrimitiveTerminalCatchContract;
  readonly save: PrimitiveMultiPortSaveContract;
  readonly stateBefore: Readonly<Record<string, unknown>>;
}

export interface MutableSimulationProgress {
  state: Record<string, unknown>;
  attempts: V2InactiveLocalAttemptReceipt[];
  nextAttempt: number;
  cumulativeDurationMs: number;
  cumulativeCostCents: number;
}

export interface SimulationTerminalResult {
  readonly code: string;
  readonly catchAction?: "continue" | "complete" | "fail";
}

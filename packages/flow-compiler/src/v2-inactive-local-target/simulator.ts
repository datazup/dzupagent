import { executeSimulation } from "./simulator-execution.js";
import { prepareSimulationContext } from "./simulator-plan.js";
import {
  restoreSimulationProgress,
  simulationFailure,
} from "./simulator-receipts.js";
import type {
  V2InactiveLocalSimulationRequest,
  V2InactiveLocalSimulationResult,
} from "./simulator-contracts.js";

/**
 * Deterministically execute one qualified five-capability V2 step from local
 * scripted outcomes. This function never invokes a runtime handler or provider
 * and never writes outside its returned in-memory state snapshot.
 */
export async function simulateV2InactiveLocalTarget(
  input: V2InactiveLocalSimulationRequest
): Promise<V2InactiveLocalSimulationResult> {
  const prepared = await prepareSimulationContext(input);
  if (!prepared.ok) return simulationFailure(prepared.error);
  const restored = restoreSimulationProgress(prepared.context);
  if (!restored.ok) return simulationFailure(restored.error);
  return executeSimulation(prepared.context, restored.progress);
}

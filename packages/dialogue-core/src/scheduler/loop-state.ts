export interface LoopAdvanceDecision {
  shouldEnter: boolean;
  stopReason?: string;
}

export interface LoopState {
  loopId: string;
  iteration: number;
  maxIterations: number;
}

export function createLoopState(
  loopId: string,
  maxIterations: number,
): LoopState {
  return {
    loopId,
    iteration: 0,
    maxIterations: Math.max(0, maxIterations),
  };
}

export function evaluateLoopAdvance(
  state: LoopState,
  condition: string,
): LoopAdvanceDecision {
  if (state.iteration >= state.maxIterations) {
    return {
      shouldEnter: false,
      stopReason: "loop=maxIterations",
    };
  }

  if (!evaluateConditionExpression(condition)) {
    return {
      shouldEnter: false,
      stopReason: "loop=condition-false",
    };
  }

  return {
    shouldEnter: true,
  };
}

export function advanceLoopState(state: LoopState): LoopState {
  return {
    ...state,
    iteration: state.iteration + 1,
  };
}

export function evaluateConditionExpression(expression: string): boolean {
  const normalized = expression.trim().toLowerCase();

  if (
    normalized === "" ||
    normalized === "false" ||
    normalized === "never" ||
    normalized === "0" ||
    normalized === "stop"
  ) {
    return false;
  }

  return true;
}

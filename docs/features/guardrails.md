# Agent Guardrails

Guardrails in `dzipagent` are safety mechanisms designed to prevent infinite loops, control costs, and ensure agent reliability during long-running autonomous tasks.

## Overview

Guardrails are configured at the agent level and applied automatically during the `generate` and `stream` loops.

```ts
const agent = new DzipAgent({
  name: 'SafeAgent',
  guardrails: {
    maxIterations: 10,
    maxTokens: 50000,
    maxCostCents: 50, // 0.50 USD
    stuckDetector: true,
  }
});
```

## Key Features

### 1. Iteration Budget

The `IterationBudget` tracker monitors cumulative resource usage across a single run (including calls made by child agents).

- **`maxIterations`**: Limits the number of ReAct loop iterations (tool call -> result -> reasoning).
- **`maxTokens`**: Limits the total (input + output) tokens consumed.
- **`maxCostCents`**: Limits the estimated cost based on model-specific pricing.
- **`budgetWarnings`**: Configurable thresholds (e.g., `[0.7, 0.9]`) that emit events when the budget is nearly exhausted.

### 2. Stuck Detection

The `StuckDetector` identifies when an agent is making no progress and can intervene to prevent wasted resources. It detects:

- **Repeated Tool Calls**: Identical tool calls (same tool + same input hash) repeated multiple times (default: 3).
- **High Error Rate**: A burst of errors within a short time window (e.g., 5 errors in 60s).
- **Idle Iterations**: Consecutive iterations where the agent makes no new tool calls or provides no new output.

When stuck is detected, the agent can emit a `agent:stuck_detected` event, and the loop may be nudged or aborted depending on the severity.

### 3. Output Filtering

Agents can be configured with an `outputFilter` to sanitize or validate the final response before it is returned to the user.

```ts
const agent = new DzipAgent({
  guardrails: {
    outputFilter: async (content) => {
      if (content.includes('SECRET_KEY')) {
        return '[REDACTED]';
      }
      return content;
    }
  }
});
```

### 4. Blocked Tools

You can explicitly prevent an agent from using specific tools, or dynamically block tools at runtime if they are identified as problematic by the stuck detector.

## Events and Monitoring

Guardrails emit events via the `EventBus` for real-time monitoring:

- `agent:stuck_detected`: Fired when the stuck detector flags an issue.
- `agent:stop_reason`: Fired at the end of a run, indicating if it finished normally or was stopped by a guardrail (e.g., `max_iterations`).

## Best Practices

1. **Always set a `maxIterations`**: This is your primary defense against runaway agents.
2. **Use Cost Limits**: Essential for production environments to prevent unexpected bill spikes.
3. **Monitor Stuck Events**: Use these to identify brittle tools or prompts that cause the agent to loop.

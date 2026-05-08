/**
 * Default strategy generator for the {@link RecoveryCopilot}.
 *
 * Produces a built-in catalogue of recovery strategies keyed by the
 * failure type identified by {@link FailureAnalyzer}. Users may supply
 * a custom {@link StrategyGenerator} for domain-specific strategies.
 *
 * @module recovery/default-strategy-generator
 */

import type { FailureAnalysis } from './failure-analyzer.js'
import type { FailureContext, RecoveryStrategy } from './recovery-types.js'

/**
 * A function that generates recovery strategies for a given failure.
 * Users can supply a custom generator for domain-specific strategies.
 */
export type StrategyGenerator = (
  analysis: FailureAnalysis,
  context: FailureContext,
) => RecoveryStrategy[]

/**
 * Built-in strategy generator covering the failure types emitted by
 * {@link FailureAnalyzer}. Adds a `human_escalation` fallback to every
 * result, then applies confidence adjustments based on prior resolutions
 * and recurrence count.
 */
export function defaultStrategyGenerator(
  analysis: FailureAnalysis,
  context: FailureContext,
): RecoveryStrategy[] {
  const strategies: RecoveryStrategy[] = []

  switch (analysis.type) {
    case 'build_failure':
      strategies.push(
        {
          name: 'retry_with_fix_prompt',
          description: 'Retry the build with an error-aware prompt that includes the build error details',
          confidence: 0.7,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'modify_params',
              params: { injectError: context.error, promptSuffix: 'Fix the build error shown above.' },
              description: 'Modify generation params to include build error context',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry the generation with error-aware prompt',
            },
          ],
        },
        {
          name: 'reduce_scope',
          description: 'Reduce the scope of generation to avoid the failing component',
          confidence: 0.5,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { extractedInfo: analysis.extractedInfo },
              description: 'Reduce generation scope to isolate failing component',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
      )
      break

    case 'test_failure':
      strategies.push(
        {
          name: 'retry_with_test_context',
          description: 'Retry generation with the failing test output as additional context',
          confidence: 0.65,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'modify_params',
              params: { testError: context.error },
              description: 'Inject test failure details into generation context',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with test failure context',
            },
          ],
        },
        {
          name: 'skip_failing_tests',
          description: 'Skip the failing tests and continue with generation',
          confidence: 0.4,
          risk: 'medium',
          estimatedSteps: 1,
          actions: [
            {
              type: 'skip',
              params: { skipTests: true },
              description: 'Skip the failing test step and continue',
            },
          ],
        },
      )
      break

    case 'timeout':
      strategies.push(
        {
          name: 'retry_with_smaller_scope',
          description: 'Reduce scope and retry with a smaller workload to avoid timeout',
          confidence: 0.6,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { factor: 0.5 },
              description: 'Halve the workload scope',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
        {
          name: 'simple_retry',
          description: 'Simple retry — the timeout may have been transient',
          confidence: 0.3,
          risk: 'low',
          estimatedSteps: 1,
          actions: [
            {
              type: 'retry',
              params: {},
              description: 'Retry the operation',
            },
          ],
        },
      )
      break

    case 'resource_exhaustion':
      strategies.push(
        {
          name: 'fallback_to_cheaper_model',
          description: 'Switch to a cheaper/smaller model to reduce resource usage',
          confidence: 0.7,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'fallback_model',
              params: { reason: 'resource_exhaustion' },
              description: 'Switch to a fallback (cheaper/smaller) model',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with fallback model',
            },
          ],
        },
        {
          name: 'reduce_scope_and_retry',
          description: 'Reduce the scope to fit within resource limits',
          confidence: 0.6,
          risk: 'low',
          estimatedSteps: 2,
          actions: [
            {
              type: 'reduce_scope',
              params: { factor: 0.3 },
              description: 'Significantly reduce workload scope',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with reduced scope',
            },
          ],
        },
      )
      break

    case 'generation_failure':
      strategies.push(
        {
          name: 'simple_retry',
          description: 'Retry the generation — the failure may be transient',
          confidence: 0.5,
          risk: 'low',
          estimatedSteps: 1,
          actions: [
            {
              type: 'retry',
              params: {},
              description: 'Retry the generation',
            },
          ],
        },
        {
          name: 'fallback_model',
          description: 'Switch to a different model and retry',
          confidence: 0.6,
          risk: 'medium',
          estimatedSteps: 2,
          actions: [
            {
              type: 'fallback_model',
              params: { reason: 'generation_failure' },
              description: 'Switch to fallback model',
            },
            {
              type: 'retry',
              params: {},
              description: 'Retry with fallback model',
            },
          ],
        },
      )
      break
  }

  // Always add human escalation as a fallback strategy
  strategies.push({
    name: 'escalate_to_human',
    description: 'Escalate to a human operator for manual resolution',
    confidence: 1.0,
    risk: 'low',
    estimatedSteps: 1,
    actions: [
      {
        type: 'human_escalation',
        params: { error: context.error, type: analysis.type },
        description: 'Request human intervention',
      },
    ],
  })

  // Boost confidence for strategies that previously resolved this fingerprint
  if (analysis.previousResolutions.length > 0) {
    for (const strategy of strategies) {
      for (const resolution of analysis.previousResolutions) {
        if (resolution.toLowerCase().includes(strategy.name.replace(/_/g, ' '))) {
          strategy.confidence = Math.min(strategy.confidence + 0.2, 1.0)
        }
      }
    }
  }

  // Decrease confidence on recurring failures
  if (analysis.isRecurring && analysis.occurrenceCount > 2) {
    for (const strategy of strategies) {
      if (strategy.actions.some(a => a.type === 'retry')) {
        strategy.confidence *= 0.7
      }
    }
  }

  return strategies
}

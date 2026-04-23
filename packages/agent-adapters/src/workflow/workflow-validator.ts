/**
 * Workflow validation for adapter workflows.
 *
 * Validates step uniqueness, template resolvability, and structural
 * correctness before compilation.
 */

import type { WorkflowStepResolver } from './template-resolver.js'

// ---------------------------------------------------------------------------
// Types (re-declare the node union locally to avoid circular imports)
// ---------------------------------------------------------------------------

import type { AdapterStepConfig, LoopConfig } from './adapter-workflow.js'

/** A workflow node as exposed by the builder. */
export type AdapterWorkflowNode =
  | { type: 'step'; config: AdapterStepConfig }
  | { type: 'parallel'; steps: AdapterStepConfig[]; mergeStrategy: string }
  | { type: 'branch'; condition: (state: Record<string, unknown>) => string; branches: Record<string, AdapterStepConfig[]> }
  | { type: 'transform'; id: string; fn: (state: Record<string, unknown>) => Record<string, unknown> }
  | { type: 'loop'; config: LoopConfig }

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export interface ValidationError {
  stepId: string
  field: string
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

// ---------------------------------------------------------------------------
// WorkflowValidator
// ---------------------------------------------------------------------------

/**
 * Validates adapter workflow nodes before compilation.
 *
 * Checks for:
 * - Duplicate step IDs
 * - Unresolvable template references (warnings, since parallel steps may set them)
 */
export class WorkflowValidator {
  constructor(private readonly templateResolver: WorkflowStepResolver) {}

  /**
   * Run all validations on the workflow nodes.
   */
  validate(nodes: AdapterWorkflowNode[]): ValidationResult {
    const errors: ValidationError[] = [
      ...this.validateUniqueIds(nodes),
    ]
    const warnings: ValidationError[] = [
      ...this.validateTemplates(nodes),
    ]

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Check that step IDs are unique across all nodes.
   */
  validateUniqueIds(nodes: AdapterWorkflowNode[]): ValidationError[] {
    const errors: ValidationError[] = []
    const seen = new Set<string>()

    for (const node of nodes) {
      const ids = this.extractStepIds(node)
      for (const id of ids) {
        if (seen.has(id)) {
          errors.push({
            stepId: id,
            field: 'id',
            message: `Duplicate step ID "${id}"`,
            severity: 'error',
          })
        }
        seen.add(id)
      }
    }

    return errors
  }

  /**
   * Check template references resolve against known state keys.
   *
   * State keys become available as steps complete:
   * - After a step with id "research", `state.research` becomes available
   * - After a parallel block, all parallel step IDs become available
   * - `prev` is always available
   * - Unresolvable references are warnings (not errors)
   */
  validateTemplates(nodes: AdapterWorkflowNode[]): ValidationError[] {
    const warnings: ValidationError[] = []
    const availableKeys = new Set<string>()

    for (const node of nodes) {
      switch (node.type) {
        case 'step': {
          this.checkStepTemplates(node.config, availableKeys, warnings)
          availableKeys.add(node.config.id)
          break
        }
        case 'parallel': {
          for (const step of node.steps) {
            this.checkStepTemplates(step, availableKeys, warnings)
          }
          // After parallel, all parallel step IDs become available
          for (const step of node.steps) {
            availableKeys.add(step.id)
          }
          break
        }
        case 'branch': {
          for (const branchSteps of Object.values(node.branches)) {
            const branchKeys = new Set(availableKeys)
            for (const step of branchSteps) {
              this.checkStepTemplates(step, branchKeys, warnings)
              branchKeys.add(step.id)
            }
          }
          // After branch, we conservatively add all branch step IDs
          for (const branchSteps of Object.values(node.branches)) {
            for (const step of branchSteps) {
              availableKeys.add(step.id)
            }
          }
          break
        }
        case 'transform': {
          availableKeys.add(node.id)
          break
        }
        case 'loop': {
          const loopKeys = new Set(availableKeys)
          for (const step of node.config.steps) {
            this.checkStepTemplates(step, loopKeys, warnings)
            loopKeys.add(step.id)
          }
          // After loop, step IDs and the loop ID become available
          for (const step of node.config.steps) {
            availableKeys.add(step.id)
          }
          availableKeys.add(node.config.id)
          break
        }
      }
    }

    return warnings
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private extractStepIds(node: AdapterWorkflowNode): string[] {
    switch (node.type) {
      case 'step':
        return [node.config.id]
      case 'parallel':
        return node.steps.map((s) => s.id)
      case 'branch': {
        const ids: string[] = []
        for (const branchSteps of Object.values(node.branches)) {
          for (const step of branchSteps) {
            ids.push(step.id)
          }
        }
        return ids
      }
      case 'transform':
        return [node.id]
      case 'loop':
        return [node.config.id, ...node.config.steps.map((s) => s.id)]
    }
  }

  private checkStepTemplates(
    step: AdapterStepConfig,
    availableKeys: Set<string>,
    warnings: ValidationError[],
  ): void {
    const unresolvable = this.templateResolver.validate(
      step.prompt,
      [...availableKeys],
    )

    for (const ref of unresolvable) {
      warnings.push({
        stepId: step.id,
        field: 'prompt',
        message: `Template reference ${ref.raw} may not be resolvable at this point`,
        severity: 'warning',
      })
    }
  }
}

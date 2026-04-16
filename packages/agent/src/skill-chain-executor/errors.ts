import { ForgeError } from '@dzupagent/core'
import type { ChainValidationResult, CandidateInterpretation } from '@dzupagent/core'

export type { CandidateInterpretation }

export class SkillNotFoundError extends ForgeError {
  readonly skillId: string
  readonly availableSkills: string[]

  constructor(skillId: string, availableSkills: string[]) {
    super({
      code: 'TOOL_NOT_FOUND',
      message: `Skill "${skillId}" not found. Available: [${availableSkills.join(', ')}]`,
      recoverable: false,
    })
    this.skillId = skillId
    this.availableSkills = availableSkills
  }
}

export class ChainValidationError extends ForgeError {
  readonly chainName: string
  readonly validationResult: ChainValidationResult

  constructor(chainName: string, validationResult: ChainValidationResult) {
    super({
      code: 'VALIDATION_FAILED',
      message: `Chain "${chainName}" validation failed. Missing skills: [${validationResult.missingSkills.join(', ')}]`,
    })
    this.chainName = chainName
    this.validationResult = validationResult
  }
}

export class StepExecutionError extends ForgeError {
  readonly stepIndex: number
  readonly skillId: string
  readonly partialState: Record<string, unknown>

  constructor(
    stepIndex: number,
    skillId: string,
    cause: unknown,
    partialState: Record<string, unknown>,
  ) {
    super({
      code: 'PIPELINE_PHASE_FAILED',
      message: `Step ${stepIndex} ("${skillId}") failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause: cause instanceof Error ? cause : undefined,
      recoverable: false,
      context: { stepIndex, skillId },
    })
    this.stepIndex = stepIndex
    this.skillId = skillId
    this.partialState = partialState
  }
}

export class ConditionEvaluationError extends ForgeError {
  readonly stepIndex: number
  readonly skillId: string

  constructor(stepIndex: number, skillId: string, cause: unknown) {
    super({
      code: 'VALIDATION_FAILED',
      message: `Condition for step ${stepIndex} ("${skillId}") threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause: cause instanceof Error ? cause : undefined,
      recoverable: false,
      context: { stepIndex, skillId },
    })
    this.stepIndex = stepIndex
    this.skillId = skillId
  }
}

export class WorkflowParseError extends ForgeError {
  readonly inputText: string
  readonly parseReason: string
  readonly candidateInterpretations: CandidateInterpretation[]

  constructor(
    inputText: string,
    parseReason: string,
    candidates: CandidateInterpretation[],
  ) {
    super({
      code: 'INVALID_CONFIG',
      message: `Cannot parse workflow command: ${parseReason}`,
      context: { inputText },
    })
    this.inputText = inputText
    this.parseReason = parseReason
    this.candidateInterpretations = candidates
  }
}

import type { FlowNode } from '../types.js'
import { joinPath } from '../validation-helpers.js'
import { validateCommonNodeFields } from './shared.js'
import type { SchemaIssue } from './shared.js'

export function validateClassify(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues)
  const prompt = obj['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    issues.push({
      path: joinPath(path, 'prompt'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.prompt is required (non-empty string)',
    })
    return null
  }
  const choices = obj['choices']
  if (!Array.isArray(choices) || choices.length === 0 || !choices.every((c) => typeof c === 'string')) {
    issues.push({
      path: joinPath(path, 'choices'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.choices is required (non-empty string array)',
    })
    return null
  }
  const outputKey = obj['outputKey']
  if (typeof outputKey !== 'string' || outputKey.length === 0) {
    issues.push({
      path: joinPath(path, 'outputKey'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'classify.outputKey is required (non-empty string)',
    })
    return null
  }
  const normalizedChoices = choices as string[]
  const defaultChoice = obj['defaultChoice']
  if (defaultChoice !== undefined) {
    if (typeof defaultChoice !== 'string' || defaultChoice.length === 0) {
      issues.push({
        path: joinPath(path, 'defaultChoice'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'classify.defaultChoice must be a non-empty string when present',
      })
      return null
    }
    if (!normalizedChoices.includes(defaultChoice)) {
      issues.push({
        path: joinPath(path, 'defaultChoice'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'classify.defaultChoice must match one of classify.choices',
      })
      return null
    }
  }
  return {
    type: 'classify',
    ...common,
    prompt,
    choices: normalizedChoices,
    outputKey,
    ...(typeof defaultChoice === 'string' ? { defaultChoice } : {}),
  }
}

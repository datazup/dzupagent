import type { FlowDocumentV1 } from '../types.js'
import {
  describeJsType,
  isFlowValue,
  isPlainObject,
  joinPath,
} from '../validation-helpers.js'
import { validateCanonicalNodeIds } from '../validation-traversal.js'
import {
  validateOptionalObjectField,
  validateOptionalStringArrayField,
  validateOptionalStringField,
} from './shared.js'
import type { SchemaIssue } from './shared.js'
import { validateFlowNode } from './dispatch.js'

export function validateFlowDocument(
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1 | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'MISSING_REQUIRED_FIELD',
      message: `Expected workflow document object, received ${describeJsType(value)}`,
    })
    return null
  }

  const dsl = value['dsl']
  if (dsl !== 'dzupflow/v1') {
    issues.push({
      path: joinPath(path, 'dsl'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.dsl must equal "dzupflow/v1", received ${describeJsType(dsl) === 'string' ? JSON.stringify(dsl) : describeJsType(dsl)}`,
    })
  }

  const id = value['id']
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({
      path: joinPath(path, 'id'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'document.id is required (non-empty string)',
    })
  }

  const version = value['version']
  if (!Number.isInteger(version) || (version as number) <= 0) {
    issues.push({
      path: joinPath(path, 'version'),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'document.version is required (positive integer)',
    })
  }

  const title = validateOptionalStringField(value, path, 'title', issues)
  const description = validateOptionalStringField(value, path, 'description', issues)
  const tags = validateOptionalStringArrayField(value, path, 'tags', issues)
  const meta = validateOptionalObjectField(value, path, 'meta', issues)
  const inputs = validateOptionalInputs(value, path, issues)
  const defaults = validateOptionalDefaults(value, path, issues)

  const rootNode = validateFlowNode(value['root'], joinPath(path, 'root'), issues)
  if (rootNode === null) return null
  if (rootNode.type !== 'sequence') {
    issues.push({
      path: joinPath(path, 'root'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.root must be a sequence node, received ${rootNode.type}`,
    })
    return null
  }

  validateCanonicalNodeIds(rootNode, joinPath(path, 'root'), issues, new Map<string, string>())

  const doc: FlowDocumentV1 = {
    dsl: 'dzupflow/v1',
    id: typeof id === 'string' ? id : '',
    version: Number.isInteger(version) ? (version as number) : 0,
    root: rootNode,
  }
  if (title !== undefined) doc.title = title
  if (description !== undefined) doc.description = description
  if (tags !== undefined) doc.tags = tags
  if (meta !== undefined) doc.meta = meta
  if (inputs !== undefined) doc.inputs = inputs
  if (defaults !== undefined) doc.defaults = defaults
  return doc
}

function validateOptionalInputs(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1['inputs'] | undefined {
  if (!('inputs' in obj) || obj['inputs'] === undefined) return undefined
  const value = obj['inputs']
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, 'inputs'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.inputs must be an object when present, received ${describeJsType(value)}`,
    })
    return undefined
  }

  const inputs: NonNullable<FlowDocumentV1['inputs']> = {}
  for (const [key, rawSpec] of Object.entries(value)) {
    if (!isPlainObject(rawSpec)) {
      issues.push({
        path: joinPath(joinPath(path, 'inputs'), key),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'input spec must be an object',
      })
      continue
    }

    const type = rawSpec['type']
    if (
      type !== 'string'
      && type !== 'number'
      && type !== 'boolean'
      && type !== 'object'
      && type !== 'array'
      && type !== 'any'
    ) {
      issues.push({
        path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'type'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'input spec.type must be one of string|number|boolean|object|array|any',
      })
      continue
    }

    const spec: NonNullable<FlowDocumentV1['inputs']>[string] = { type }
    if ('required' in rawSpec && rawSpec['required'] !== undefined) {
      if (typeof rawSpec['required'] === 'boolean') spec.required = rawSpec['required']
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'required'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.required must be a boolean when present',
        })
      }
    }
    if ('description' in rawSpec && rawSpec['description'] !== undefined) {
      if (typeof rawSpec['description'] === 'string') spec.description = rawSpec['description']
      else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'description'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.description must be a string when present',
        })
      }
    }
    if ('default' in rawSpec && rawSpec['default'] !== undefined) {
      if (isFlowValue(rawSpec['default'])) {
        spec.default = rawSpec['default']
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'inputs'), key), 'default'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'input spec.default must be a JSON-like value when present',
        })
      }
    }
    inputs[key] = spec
  }
  return inputs
}

function validateOptionalDefaults(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowDocumentV1['defaults'] | undefined {
  if (!('defaults' in obj) || obj['defaults'] === undefined) return undefined
  const value = obj['defaults']
  if (!isPlainObject(value)) {
    issues.push({
      path: joinPath(path, 'defaults'),
      code: 'MISSING_REQUIRED_FIELD',
      message: `document.defaults must be an object when present, received ${describeJsType(value)}`,
    })
    return undefined
  }

  const defaults: NonNullable<FlowDocumentV1['defaults']> = {}
  if ('personaRef' in value && value['personaRef'] !== undefined) {
    if (typeof value['personaRef'] === 'string') defaults.personaRef = value['personaRef']
    else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'personaRef'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.personaRef must be a string when present',
      })
    }
  }
  if ('timeoutMs' in value && value['timeoutMs'] !== undefined) {
    if (typeof value['timeoutMs'] === 'number' && Number.isFinite(value['timeoutMs']) && value['timeoutMs'] > 0) {
      defaults.timeoutMs = value['timeoutMs']
    } else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'timeoutMs'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.timeoutMs must be a positive number when present',
      })
    }
  }
  if ('retry' in value && value['retry'] !== undefined) {
    const retry = value['retry']
    if (isPlainObject(retry)) {
      const attempts = retry['attempts']
      if (typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0) {
        defaults.retry = { attempts }
        const delayMs = retry['delayMs']
        if (delayMs !== undefined) {
          if (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0) {
            defaults.retry.delayMs = delayMs
          } else {
            issues.push({
              path: joinPath(joinPath(joinPath(path, 'defaults'), 'retry'), 'delayMs'),
              code: 'MISSING_REQUIRED_FIELD',
              message: 'defaults.retry.delayMs must be a non-negative number when present',
            })
          }
        }
      } else {
        issues.push({
          path: joinPath(joinPath(joinPath(path, 'defaults'), 'retry'), 'attempts'),
          code: 'MISSING_REQUIRED_FIELD',
          message: 'defaults.retry.attempts must be a positive integer',
        })
      }
    } else {
      issues.push({
        path: joinPath(joinPath(path, 'defaults'), 'retry'),
        code: 'MISSING_REQUIRED_FIELD',
        message: 'defaults.retry must be an object when present',
      })
    }
  }

  return Object.keys(defaults).length > 0 ? defaults : {}
}

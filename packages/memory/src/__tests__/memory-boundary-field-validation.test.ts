import { test, expect } from 'vitest'
import { createInMemoryMemoryOutbox } from '../workers/in-memory-outbox.js'
import { prepareInput } from '../workers/__tests__/fixtures.js'
import { makeCapturedRecord } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryRecordV1 } from '../records/decoder.js'
import { activeFixture } from '../projections/__tests__/fixtures.js'
import { projectMemoryRecordV1, diffMemoryProjections } from '../projections/index.js'
import { makeCaptureCommand } from '../lifecycle/__tests__/fixtures.js'
import { decodeMemoryCommandV1 } from '../lifecycle/validation.js'
import { decodeMemoryEventV1, decodeMemoryTransitionReceiptV1 } from '../lifecycle/ledger.js'
import { capturedRecord, captureInput } from '../service/__tests__/fixtures.js'
import { decodeLifecycleWriteInputV1 } from '../service/validation.js'

// Each case corrupts one schema field in otherwise valid serialized input.
// Arbitrary user content is intentionally left intact: its JSON types are open.
function wrongTypeCases(input: unknown): Array<[string, unknown]> {
  const output: Array<[string, unknown]> = []
  const visit = (value: unknown, path: string[]) => {
    if (value === null || value === undefined || path.includes('content')) return
    if (typeof value !== 'object' || Array.isArray(value)) {
      const copy = structuredClone(input)
      let parent = copy as Record<string, unknown>
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>
      parent[path.at(-1)!] = { wrongType: true }
      output.push([path.join('.'), copy])
    }
    if (typeof value === 'object') for (const [key, nested] of Object.entries(value)) visit(nested, [...path, key])
  }
  if (input && typeof input === 'object') for (const [key, value] of Object.entries(input)) visit(value, [key])
  return output
}

function missingFieldCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).map(([path]) => {
    const copy = structuredClone(input) as Record<string, unknown>
    const parts = path.split('.')
    let parent = copy
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    delete parent[parts.at(-1)!]
    return [path, copy]
  })
}

function emptyStringCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).flatMap(([path]) => {
    const parts = path.split('.')
    const original = parts.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], input)
    if (typeof original !== 'string') return []
    const copy = structuredClone(input) as Record<string, unknown>
    let parent = copy
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    parent[parts.at(-1)!] = ''
    return [[path, copy] as [string, unknown]]
  })
}

test.each(wrongTypeCases(makeCapturedRecord()))('serialized memory record rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})

const optionalRecordFields = new Set(['scope.workspaceId', 'temporal.validFrom', 'quality.extractionQuality'])

test.each(missingFieldCases(makeCapturedRecord()).filter(([path]) => !optionalRecordFields.has(path)))('serialized memory record requires field %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})

test.each(emptyStringCases(makeCapturedRecord()))('serialized memory record rejects empty string at %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})

test.each(wrongTypeCases(makeCaptureCommand()))('lifecycle command rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryCommandV1(input)).toThrow()
})

const projectionRequest = activeFixture().request

test.each(wrongTypeCases(projectionRequest))('projection request rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(projectMemoryRecordV1, undefined, [input])).toThrow()
})

const projection = projectMemoryRecordV1(projectionRequest)

function nullFieldCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).map(([path]) => {
    const copy = structuredClone(input) as Record<string, unknown>
    const parts = path.split('.')
    let parent = copy
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
    parent[parts.at(-1)!] = null
    return [path, copy]
  })
}

test.each(nullFieldCases(makeCapturedRecord()))('record admission rejects null for typed field %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})

test.each(nullFieldCases(projection))('projection restore rejects null for typed field %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(nullFieldCases(makeCaptureCommand()))('command admission rejects null for typed field %s', (_path, input) => {
  expect(() => decodeMemoryCommandV1(input)).toThrow()
})

function invalidScalarCases(input: unknown): Array<[string, unknown]> {
  return wrongTypeCases(input).flatMap(([path]) => {
    const parts = path.split('.')
    const value = parts.reduce<unknown>((parent, key) => (parent as Record<string, unknown>)[key], input)
    // These contracts constrain every number to a nonnegative range; retain
    // legitimate fractional confidence values and arbitrary text identifiers.
    const replacements = typeof value === 'number' ? [-1, ...(path.includes('quality') ? [] : [0.5])]
      : typeof value === 'string' && (value.startsWith('sha256:') || /^\d{4}-\d\d-\d\dT/.test(value)) ? ['malformed'] : []
    return replacements.map(replacement => {
      const copy = structuredClone(input) as Record<string, unknown>
      let parent = copy
      for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
      parent[parts.at(-1)!] = replacement
      return [`${path}=${replacement}`, copy] as [string, unknown]
    })
  })
}

test.each(invalidScalarCases(makeCapturedRecord()))('record admission rejects scalar outside its range or format: %s', (_path, input) => {
  expect(() => decodeMemoryRecordV1(input)).toThrow()
})

test.each(invalidScalarCases(projection))('projection restore rejects scalar outside its range or format: %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(invalidScalarCases(makeCaptureCommand()))('command admission rejects scalar outside its range or format: %s', (_path, input) => {
  expect(() => decodeMemoryCommandV1(input)).toThrow()
})

test.each(wrongTypeCases(projection).flatMap(([path]) => {
  const copy = structuredClone(projection) as unknown as Record<string, unknown>
  const parts = path.split('.')
  let parent = copy
  for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>
  const key = parts.at(-1)!
  const value = parent[key]
  parent[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : typeof value === 'string' ? value.startsWith('sha256:') ? `sha256:${'f'.repeat(64)}` : 'tampered' : []
  return JSON.stringify(parent[key]) === JSON.stringify(value) ? [] : [[path, copy] as [string, unknown]]
}))('retained projection rejects well-typed tampering at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(wrongTypeCases(projection))('retained projection rejects wrong type at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(missingFieldCases(projection))('retained projection requires field %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(wrongTypeCases(projection.events[0]))('retained lifecycle event rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryEventV1(input)).toThrow()
})

test.each(wrongTypeCases(projection.receipts[0]))('retained lifecycle receipt rejects wrong type at %s', (_path, input) => {
  expect(() => decodeMemoryTransitionReceiptV1(input)).toThrow()
})

test.each(emptyStringCases(projection))('retained projection rejects empty string at %s', (_path, input) => {
  expect(() => Reflect.apply(diffMemoryProjections, undefined, [projection, input])).toThrow()
})

test.each(wrongTypeCases(captureInput(capturedRecord())))('service write envelope rejects wrong type at %s', (_path, input) => {
  expect(() => decodeLifecycleWriteInputV1(input)).toThrow()
})

test.each(wrongTypeCases(prepareInput()))('outbox envelope rejects wrong type at %s', (_path, input) => {
  expect(() => createInMemoryMemoryOutbox().prepare(input)).toThrow()
})

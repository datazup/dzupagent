import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'

import type { TokenCounter } from '../../token-lifecycle.js'
import { compactCompletedToolResults } from '../compact-completed-tool-results.js'
import type {
  CompletedToolCompactionProfileV1,
  CompletedToolCompactionResultV1,
} from '../types.js'

export const MEMORY_COMPACTION_CONFORMANCE_CANARY = 'INVENTED_CANARY_ALPHA_7F9D'

const exactCounter: TokenCounter = {
  count: text => Math.ceil(text.length / 4),
  countDetailed: text => ({
    tokens: Math.ceil(text.length / 4),
    method: 'exact',
    model: 'invented-exact-v1',
  }),
}

export async function runContextCompactionConformanceScenario(
  input: { readonly scenario: string },
): Promise<unknown> {
  switch (input.scenario) {
    case 'complete-pairs': return completePairs()
    case 'incomplete-pairs': return incompletePairs()
    case 'malformed-pairs': return malformedPairs()
    case 'metadata-and-canary': return metadataAndCanary()
    case 'measurement-provenance': return measurementProvenance()
    case 'idempotence': return idempotence()
    case 'bounded-target': return boundedTarget()
    case 'hostile-input': return hostileInput()
    default: throw new Error('unknown invented compaction scenario')
  }
}

function completePairs() {
  const messages: BaseMessage[] = [
    new HumanMessage('invented start'),
    ...pair('call-old'),
    ...pair('call-recent'),
  ]
  const originalOld = messages[2]?.content
  const result = compactCompletedToolResults(messages, profile(), {
    tokenCounter: exactCounter,
  })
  const structurePreserved = result.messages[0] === messages[0]
    && result.messages[1] === messages[1]
    && result.messages[3] === messages[3]
    && result.messages[4] === messages[4]
    && (result.messages[2] as ToolMessage | undefined)?.tool_call_id === 'call-old'
  return observation('complete-pairs', [result], {
    inputUnchanged: messages[2]?.content === originalOld,
    structurePreserved,
  })
}

function incompletePairs() {
  const messages: BaseMessage[] = [
    new AIMessage({
      content: 'invented two calls',
      tool_calls: [
        { id: 'call-one', name: 'lookup', args: {} },
        { id: 'call-two', name: 'lookup', args: {} },
      ],
    }),
    toolResult('call-one'),
    new HumanMessage('invented interruption'),
  ]
  const result = compactCompletedToolResults(messages, profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: exactCounter })
  return observation('incomplete-pairs', [result], {
    inputUnchanged: result.messages === messages,
    structurePreserved: result.messages === messages,
  })
}

function malformedPairs() {
  const cases: BaseMessage[][] = [
    [toolResult('missing')],
    [multiCall(), toolResult('call-two'), toolResult('call-one')],
    [toolCall('call-one'), toolResult('call-one'), toolResult('call-one')],
    [toolCall('call-one'), new HumanMessage('late'), toolResult('call-one')],
  ]
  const results = cases.map(messages => compactCompletedToolResults(
    messages,
    profile({ preserveRecentCompletedPairs: 0 }),
    { tokenCounter: exactCounter },
  ))
  let inputUnchanged = results.length === cases.length
  for (const [index, result] of results.entries()) {
    inputUnchanged = inputUnchanged && result.messages === cases[index]
  }
  return observation('malformed-pairs', results, {
    inputUnchanged,
    structurePreserved: inputUnchanged,
  })
}

function metadataAndCanary() {
  const original = new ToolMessage({
    content: `${MEMORY_COMPACTION_CONFORMANCE_CANARY} ${'invented-output '.repeat(40)}`,
    tool_call_id: 'call-metadata',
    name: 'lookup',
    status: 'error',
    artifact: { retained: ['invented-artifact'] },
    metadata: { trace: 'invented-trace' },
    additional_kwargs: { provider: { request: 'invented-request' } },
    response_metadata: { usage: { input_tokens: 12 } },
  })
  const messages: BaseMessage[] = [toolCall('call-metadata'), original]
  const result = compactCompletedToolResults(messages, profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: exactCounter })
  const replacement = result.messages[1] as ToolMessage
  const metadataPreserved = replacement.tool_call_id === original.tool_call_id
    && replacement.name === original.name
    && replacement.status === original.status
    && JSON.stringify(replacement.artifact) === JSON.stringify(original.artifact)
    && JSON.stringify(replacement.metadata) === JSON.stringify(original.metadata)
    && JSON.stringify(replacement.additional_kwargs) === JSON.stringify(original.additional_kwargs)
    && JSON.stringify(replacement.response_metadata) === JSON.stringify(original.response_metadata)
  return observation('metadata-and-canary', [result], {
    inputUnchanged: original.content.toString().includes(MEMORY_COMPACTION_CONFORMANCE_CANARY),
    structurePreserved: replacement.tool_call_id === 'call-metadata',
    metadataPreserved,
    canaryAbsent: !replacement.content.toString().includes(
      MEMORY_COMPACTION_CONFORMANCE_CANARY,
    ),
  })
}

function measurementProvenance() {
  const exact = compactCompletedToolResults(pair('call-exact'), profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: exactCounter })
  const heuristic = compactCompletedToolResults(pair('call-heuristic'), profile({
    preserveRecentCompletedPairs: 0,
    measurement: 'allow-heuristic',
  }))
  let detailedCalls = 0
  const intermittent: TokenCounter = {
    count: text => Math.ceil(text.length / 4),
    countDetailed: text => {
      detailedCalls += 1
      if (detailedCalls === 3) throw new Error('invented tokenizer loss')
      return { tokens: Math.ceil(text.length / 4), method: 'exact' }
    },
  }
  const degradedMessages = pair('call-degraded')
  const degraded = compactCompletedToolResults(degradedMessages, profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: intermittent })
  return observation('measurement-provenance', [exact, heuristic, degraded], {
    inputUnchanged: degraded.messages === degradedMessages,
  })
}

function idempotence() {
  const messages = pair('call-idempotent')
  const first = compactCompletedToolResults(messages, profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: exactCounter })
  const second = compactCompletedToolResults(first.messages, profile({
    preserveRecentCompletedPairs: 0,
  }), { tokenCounter: exactCounter })
  return observation('idempotence', [first, second], {
    inputUnchanged: (messages[1] as ToolMessage).content.toString().includes('invented-output'),
    structurePreserved: second.messages === first.messages,
    idempotent: second.messages === first.messages,
  })
}

function boundedTarget() {
  const messages = [...pair('call-bounded-one'), ...pair('call-bounded-two')]
  const secondContent = messages[3]?.content
  const result = compactCompletedToolResults(messages, profile({
    preserveRecentCompletedPairs: 0,
    maxCompactedResults: 1,
    targetReclaimedTokens: 10_000,
  }), { tokenCounter: exactCounter })
  return observation('bounded-target', [result], {
    inputUnchanged: messages[3]?.content === secondContent,
    structurePreserved: result.messages[3]?.content === secondContent,
  })
}

function hostileInput() {
  const hostileMessages = new Proxy([] as BaseMessage[], {
    get(target, property, receiver) {
      if (property === 'length') throw new Error(MEMORY_COMPACTION_CONFORMANCE_CANARY)
      return Reflect.get(target, property, receiver)
    },
  })
  const hostileProfile = new Proxy(profile(), {
    ownKeys() {
      throw new Error(MEMORY_COMPACTION_CONFORMANCE_CANARY)
    },
  })
  const invalidInput = compactCompletedToolResults(hostileMessages, profile())
  const invalidProfile = compactCompletedToolResults([], hostileProfile)
  return observation('hostile-input', [invalidInput, invalidProfile], {
    canaryAbsent: ![invalidInput.reason, invalidProfile.reason]
      .join(',')
      .includes(MEMORY_COMPACTION_CONFORMANCE_CANARY),
  })
}

function profile(
  overrides: Partial<CompletedToolCompactionProfileV1> = {},
): CompletedToolCompactionProfileV1 {
  return {
    schema: 'datazup.context.completed-tool-compaction-profile/v1',
    preserveRecentCompletedPairs: 1,
    minimumResultTokens: 8,
    maxCompactedResults: 8,
    measurement: 'require-tokenizer',
    ...overrides,
  }
}

function pair(id: string): BaseMessage[] {
  return [toolCall(id), toolResult(id)]
}

function toolCall(id: string): AIMessage {
  return new AIMessage({
    content: 'invented call',
    tool_calls: [{ id, name: 'lookup', args: { invented: id } }],
  })
}

function multiCall(): AIMessage {
  return new AIMessage({
    content: 'invented calls',
    tool_calls: [
      { id: 'call-one', name: 'lookup', args: {} },
      { id: 'call-two', name: 'lookup', args: {} },
    ],
  })
}

function toolResult(id: string): ToolMessage {
  return new ToolMessage({
    content: 'invented-output '.repeat(80),
    tool_call_id: id,
    name: 'lookup',
  })
}

function observation(
  scenario: string,
  results: readonly CompletedToolCompactionResultV1[],
  overrides: Record<string, unknown> = {},
) {
  const first = results[0]
  return {
    schema: 'datazup.memory.compaction-conformance-observation/v1',
    scenario,
    statuses: results.map(result => result.status),
    reasons: results.map(result => result.reason),
    measurementMethods: results.map(result => result.measurementMethod),
    inputUnchanged: true,
    structurePreserved: true,
    metadataPreserved: false,
    idempotent: false,
    canaryAbsent: true,
    beforeTokens: first?.beforeTokens ?? 0,
    afterTokens: first?.afterTokens ?? 0,
    reclaimedTokens: first?.reclaimedTokens ?? 0,
    compactedCount: results.reduce(
      (total, result) => total + result.compactedToolCallIds.length,
      0,
    ),
    ...overrides,
  }
}

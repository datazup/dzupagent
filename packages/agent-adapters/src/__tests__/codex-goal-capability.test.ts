import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  ProviderSessionCapabilityDescriptor,
} from '@dzupagent/runtime-contracts/provider-session'
import { describe, expect, it } from 'vitest'

import {
  materializeCodexGoalCapabilityDescriptor,
  observeInstalledCodexGoalCapabilityForTesting,
  type CodexGoalProtocolObservation,
} from '../codex/codex-goal-capability.js'
import {
  createInternalSafeProbeRunner,
  type ProbeFailureClassification,
  type ProbeResult,
} from '../introspection/probe-runner.js'

const OBSERVED_AT = '2026-08-13T00:00:00.000Z'
const VERSION = '0.147.0'
const DIGEST = `sha256:${'a'.repeat(64)}`
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`
const STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]

function request(method: string, paramsName: string) {
  return {
    type: 'object',
    required: ['id', 'method', 'params'],
    properties: {
      id: { $ref: '#/definitions/RequestId' },
      method: { type: 'string', enum: [method] },
      params: { $ref: `#/definitions/${paramsName}` },
    },
  }
}

function notification(method: string, paramsName?: string) {
  return {
    type: 'object',
    required: paramsName ? ['method', 'params'] : ['method'],
    properties: {
      method: { type: 'string', enum: [method] },
      ...(paramsName ? { params: { $ref: `#/definitions/${paramsName}` } } : {}),
    },
  }
}

function threadDefinition() {
  return {
    type: 'object',
    required: [
      'cliVersion',
      'createdAt',
      'cwd',
      'ephemeral',
      'id',
      'modelProvider',
      'preview',
      'sessionId',
      'source',
      'status',
      'turns',
      'updatedAt',
    ],
    properties: {
      cliVersion: { type: 'string' },
      createdAt: { type: 'integer', format: 'int64' },
      cwd: { allOf: [{ $ref: '#/definitions/AbsolutePathBuf' }] },
      ephemeral: { type: 'boolean' },
      id: { type: 'string' },
      modelProvider: { type: 'string' },
      preview: { type: 'string' },
      sessionId: { type: 'string' },
      source: { allOf: [{ $ref: '#/definitions/SessionSource' }] },
      status: { allOf: [{ $ref: '#/definitions/ThreadStatus' }] },
      turns: { type: 'array' },
      updatedAt: { type: 'integer', format: 'int64' },
    },
  }
}

function turnDefinitions() {
  return {
    TurnStatus: {
      type: 'string',
      enum: ['completed', 'interrupted', 'failed', 'inProgress'],
    },
    Turn: {
      type: 'object',
      required: ['id', 'items', 'status'],
      properties: {
        id: { type: 'string' },
        items: { type: 'array' },
        status: { $ref: '#/definitions/TurnStatus' },
      },
    },
  }
}

function interactionParams(extra: Record<string, unknown> = {}) {
  return {
    type: 'object',
    required: ['itemId', 'startedAtMs', 'threadId', 'turnId'],
    properties: {
      itemId: { type: 'string' },
      startedAtMs: { type: 'integer' },
      threadId: { type: 'string' },
      turnId: { type: 'string' },
      ...extra,
    },
  }
}

function threadGoalDefinitions() {
  return {
    ThreadGoalStatus: { type: 'string', enum: [...STATUSES] },
    ThreadGoal: {
      type: 'object',
      required: [
        'createdAt',
        'objective',
        'status',
        'threadId',
        'timeUsedSeconds',
        'tokensUsed',
        'updatedAt',
      ],
      properties: {
        createdAt: { type: 'integer', format: 'int64' },
        objective: { type: 'string' },
        status: { $ref: '#/definitions/ThreadGoalStatus' },
        threadId: { type: 'string' },
        timeUsedSeconds: { type: 'integer', format: 'int64' },
        tokenBudget: { type: ['integer', 'null'], format: 'int64' },
        tokensUsed: { type: 'integer', format: 'int64' },
        updatedAt: { type: 'integer', format: 'int64' },
      },
    },
  }
}

function protocolDocuments(): Record<string, unknown> {
  return {
    'ClientRequest.json': {
      oneOf: [
        request('initialize', 'InitializeParams'),
        request('thread/start', 'ThreadStartParams'),
        request('thread/resume', 'ThreadResumeParams'),
        request('turn/start', 'TurnStartParams'),
        request('turn/interrupt', 'TurnInterruptParams'),
        request('thread/goal/get', 'ThreadGoalGetParams'),
        request('thread/goal/set', 'ThreadGoalSetParams'),
        request('thread/goal/clear', 'ThreadGoalClearParams'),
      ],
    },
    'ClientNotification.json': {
      oneOf: [notification('initialized')],
    },
    'ServerNotification.json': {
      oneOf: [
        notification('thread/started', 'ThreadStartedNotification'),
        notification('turn/started', 'TurnStartedNotification'),
        notification('item/agentMessage/delta', 'AgentMessageDeltaNotification'),
        notification('thread/tokenUsage/updated', 'ThreadTokenUsageUpdatedNotification'),
        notification('turn/completed', 'TurnCompletedNotification'),
      ],
    },
    'ServerRequest.json': {
      oneOf: [
        request('item/commandExecution/requestApproval', 'CommandExecutionRequestApprovalParams'),
        request('item/fileChange/requestApproval', 'FileChangeRequestApprovalParams'),
        request('item/tool/requestUserInput', 'ToolRequestUserInputParams'),
      ],
    },
    'CommandExecutionRequestApprovalParams.json': interactionParams(),
    'FileChangeRequestApprovalParams.json': interactionParams(),
    'ToolRequestUserInputParams.json': {
      type: 'object',
      required: ['isBlocking', 'itemId', 'questions', 'threadId', 'turnId'],
      properties: {
        isBlocking: { type: 'boolean' },
        itemId: { type: 'string' },
        questions: { type: 'array' },
        threadId: { type: 'string' },
        turnId: { type: 'string' },
      },
    },
    'v1/InitializeParams.json': {
      type: 'object',
      required: ['clientInfo'],
      properties: {
        clientInfo: { $ref: '#/definitions/ClientInfo' },
      },
      definitions: {
        ClientInfo: {
          type: 'object',
          required: ['name', 'version'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
          },
        },
        InitializeCapabilities: {
          type: 'object',
          properties: { experimentalApi: { type: 'boolean' } },
        },
      },
    },
    'v1/InitializeResponse.json': {
      type: 'object',
      required: ['codexHome', 'platformFamily', 'platformOs', 'userAgent'],
      properties: {
        codexHome: { allOf: [{ $ref: '#/definitions/AbsolutePathBuf' }] },
        platformFamily: { type: 'string' },
        platformOs: { type: 'string' },
        userAgent: { type: 'string' },
      },
    },
    'v2/ThreadStartParams.json': {
      type: 'object',
      properties: {
        cwd: { type: ['string', 'null'] },
        model: { type: ['string', 'null'] },
        developerInstructions: { type: ['string', 'null'] },
        sandbox: {
          anyOf: [
            { $ref: '#/definitions/SandboxMode' },
            { type: 'null' },
          ],
        },
      },
      definitions: {
        SandboxMode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
        },
      },
    },
    'v2/ThreadStartResponse.json': {
      type: 'object',
      required: [
        'approvalPolicy',
        'approvalsReviewer',
        'cwd',
        'model',
        'modelProvider',
        'sandbox',
        'thread',
      ],
      properties: { thread: { $ref: '#/definitions/Thread' } },
      definitions: { Thread: threadDefinition() },
    },
    'v2/ThreadResumeParams.json': {
      type: 'object',
      required: ['threadId'],
      properties: {
        threadId: { type: 'string' },
        cwd: { type: ['string', 'null'] },
        model: { type: ['string', 'null'] },
      },
    },
    'v2/ThreadResumeResponse.json': {
      type: 'object',
      required: [
        'approvalPolicy',
        'approvalsReviewer',
        'cwd',
        'model',
        'modelProvider',
        'sandbox',
        'thread',
      ],
      properties: { thread: { $ref: '#/definitions/Thread' } },
      definitions: { Thread: threadDefinition() },
    },
    'v2/ThreadStartedNotification.json': {
      type: 'object',
      required: ['thread'],
      properties: { thread: { $ref: '#/definitions/Thread' } },
      definitions: { Thread: threadDefinition() },
    },
    'v2/TurnStartParams.json': {
      type: 'object',
      required: ['input', 'threadId'],
      properties: {
        threadId: { type: 'string' },
        input: {
          type: 'array',
          items: { $ref: '#/definitions/UserInput' },
        },
      },
      definitions: {
        UserInput: {
          oneOf: [{
            type: 'object',
            required: ['text', 'type'],
            properties: {
              text: { type: 'string' },
              type: { type: 'string', enum: ['text'] },
            },
          }],
        },
      },
    },
    'v2/TurnStartResponse.json': {
      type: 'object',
      required: ['turn'],
      properties: { turn: { $ref: '#/definitions/Turn' } },
      definitions: turnDefinitions(),
    },
    'v2/TurnInterruptParams.json': {
      type: 'object',
      required: ['threadId', 'turnId'],
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' },
      },
    },
    'v2/TurnInterruptResponse.json': { type: 'object' },
    'v2/TurnStartedNotification.json': {
      type: 'object',
      required: ['threadId', 'turn'],
      properties: {
        threadId: { type: 'string' },
        turn: { $ref: '#/definitions/Turn' },
      },
      definitions: turnDefinitions(),
    },
    'v2/TurnCompletedNotification.json': {
      type: 'object',
      required: ['threadId', 'turn'],
      properties: {
        threadId: { type: 'string' },
        turn: { $ref: '#/definitions/Turn' },
      },
      definitions: turnDefinitions(),
    },
    'v2/AgentMessageDeltaNotification.json': {
      type: 'object',
      required: ['delta', 'itemId', 'threadId', 'turnId'],
      properties: {
        delta: { type: 'string' },
        itemId: { type: 'string' },
        threadId: { type: 'string' },
        turnId: { type: 'string' },
      },
    },
    'v2/ThreadTokenUsageUpdatedNotification.json': {
      type: 'object',
      required: ['threadId', 'tokenUsage', 'turnId'],
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' },
        tokenUsage: { $ref: '#/definitions/ThreadTokenUsage' },
      },
      definitions: {
        ThreadTokenUsage: {
          type: 'object',
          required: ['last', 'total'],
          properties: {
            last: { $ref: '#/definitions/TokenUsageBreakdown' },
            total: { $ref: '#/definitions/TokenUsageBreakdown' },
          },
        },
        TokenUsageBreakdown: {
          type: 'object',
          required: [
            'cachedInputTokens',
            'inputTokens',
            'outputTokens',
            'reasoningOutputTokens',
            'totalTokens',
          ],
          properties: {
            cachedInputTokens: { type: 'integer', format: 'int64' },
            inputTokens: { type: 'integer', format: 'int64' },
            outputTokens: { type: 'integer', format: 'int64' },
            reasoningOutputTokens: { type: 'integer', format: 'int64' },
            totalTokens: { type: 'integer', format: 'int64' },
          },
        },
      },
    },
    'v2/ThreadGoalGetParams.json': {
      type: 'object',
      required: ['threadId'],
      properties: { threadId: { type: 'string' } },
    },
    'v2/ThreadGoalSetParams.json': {
      type: 'object',
      required: ['threadId'],
      definitions: {
        ThreadGoalStatus: { type: 'string', enum: [...STATUSES] },
      },
      properties: {
        threadId: { type: 'string' },
        objective: { type: ['string', 'null'] },
        status: {
          anyOf: [
            { $ref: '#/definitions/ThreadGoalStatus' },
            { type: 'null' },
          ],
        },
        tokenBudget: { type: ['integer', 'null'], format: 'int64' },
      },
    },
    'v2/ThreadGoalClearParams.json': {
      type: 'object',
      required: ['threadId'],
      properties: { threadId: { type: 'string' } },
    },
    'v2/ThreadGoalGetResponse.json': {
      type: 'object',
      definitions: threadGoalDefinitions(),
      properties: {
        goal: {
          anyOf: [
            { $ref: '#/definitions/ThreadGoal' },
            { type: 'null' },
          ],
        },
      },
    },
    'v2/ThreadGoalSetResponse.json': {
      type: 'object',
      definitions: threadGoalDefinitions(),
      required: ['goal'],
      properties: { goal: { $ref: '#/definitions/ThreadGoal' } },
    },
    'v2/ThreadGoalClearResponse.json': {
      type: 'object',
      required: ['cleared'],
      properties: { cleared: { type: 'boolean' } },
    },
  }
}

function protocol(
  documents: Readonly<Record<string, unknown>> = protocolDocuments(),
): CodexGoalProtocolObservation {
  return {
    generatedForVersion: VERSION,
    schemaRef: `codex-app-server://generated-json-schema/${VERSION}?experimental=1&files=${Object.keys(documents).length}`,
    schemaDigest: DIGEST,
    documents,
  }
}

function descriptor(
  overrides: Partial<Parameters<typeof materializeCodexGoalCapabilityDescriptor>[0]> = {},
): ProviderSessionCapabilityDescriptor {
  return materializeCodexGoalCapabilityDescriptor({
    backendKind: 'app-server',
    installedVersion: VERSION,
    executableArtifactDigest: ARTIFACT_DIGEST,
    protocol: protocol(),
    observedAt: OBSERVED_AT,
    ...overrides,
  })
}

function ok(stdout = ''): ProbeResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    truncated: false,
  }
}

function failed(failure: ProbeFailureClassification): ProbeResult {
  return {
    exitCode: failure === 'exit-nonzero' ? 1 : null,
    stdout: '',
    stderr: `[probe:${failure}]`,
    timedOut: failure === 'timeout',
    spawnFailed: failure !== 'timeout' && failure !== 'output-limit',
    failure,
    truncated: failure === 'output-limit',
  }
}

async function writeProtocolCorpus(
  output: string,
  documents: Readonly<Record<string, unknown>> = protocolDocuments(),
): Promise<void> {
  for (const [relativePath, value] of Object.entries(documents)) {
    const path = join(output, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value), 'utf8')
  }
}

function observationOptions() {
  return {
    executable: {
      name: 'codex',
      path: '/fixture/codex',
      realPath: '/fixture/codex',
      artifactDigest: ARTIFACT_DIGEST,
    },
    cwd: '/fixture/repository',
    observedAt: OBSERVED_AT,
  } as const
}

describe('Codex App Server capability descriptor materialization', () => {
  it('advertises only the exact admitted base, stream, usage, interrupt, and goal surfaces', () => {
    const result = descriptor()

    expect(result).toEqual(expect.objectContaining({
      schema: 'dzupagent.providerSessionCapabilityDescriptor/v2',
      providerId: 'codex',
      backend: expect.objectContaining({
        kind: 'app-server',
        version: VERSION,
        protocolSchemaRef: protocol().schemaRef,
        protocolSchemaDigest: DIGEST,
        artifactDigest: ARTIFACT_DIGEST,
      }),
      observedAt: OBSERVED_AT,
      evidenceRef: `codex-app-server-schema/${DIGEST}`,
    }))
    for (const capability of [
      'execute',
      'stream',
      'resume',
      'cancel',
      'usage',
      'interrupt-turn',
      'goal-control',
    ] as const) {
      expect(result.capabilities[capability]).toEqual({
        status: 'native',
        emulation: 'forbidden',
      })
    }
    expect(result.capabilities['interaction']).toEqual({
      status: 'unsupported',
      emulation: 'forbidden',
      reason: 'interaction-resolution-not-qualified',
    })
    expect(result.capabilities['fork-session']).toEqual(expect.objectContaining({
      status: 'unsupported',
      emulation: 'forbidden',
    }))
    expect(result).not.toHaveProperty('effectAuthorities')
    expect(result).not.toHaveProperty('attemptBinding')
  })

  it.each([
    'thread/goal/get',
    'thread/goal/set',
    'thread/goal/clear',
  ])('fails closed when %s is absent', (missingMethod) => {
    const documents = protocolDocuments()
    const clientRequest = documents['ClientRequest.json'] as {
      oneOf: Array<{ properties: { method: { enum: string[] } } }>
    }
    clientRequest.oneOf = clientRequest.oneOf.filter(
      (candidate) => candidate.properties.method.enum[0] !== missingMethod,
    )

    expect(descriptor({ protocol: protocol(documents) }).capabilities['goal-control'])
      .toEqual({
        status: 'unsupported',
        emulation: 'forbidden',
        reason: `protocol-method-missing:${missingMethod}`,
      })
  })

  it('rejects a goal RPC with a drifted parameter or result shape', () => {
    const documents = protocolDocuments()
    const setParams = documents['v2/ThreadGoalSetParams.json'] as {
      properties: { threadId: { type: string } }
    }
    setParams.properties.threadId.type = 'integer'

    expect(descriptor({ protocol: protocol(documents) }).capabilities['goal-control'])
      .toEqual(expect.objectContaining({
        status: 'unsupported',
        emulation: 'forbidden',
        reason: 'protocol-shape-mismatch:ThreadGoalSetParams',
      }))
  })

  it.each(['sdk', 'cli'] as const)('classifies the %s backend as unsupported without emulation', (backendKind) => {
    expect(descriptor({ backendKind }).capabilities['goal-control']).toEqual({
      status: 'unsupported',
      emulation: 'forbidden',
      reason: 'app-server-capabilities-require-app-server-backend',
    })
  })

  it.each([
    ['execute', 'thread/start', 'protocol-method-missing:thread/start'],
    ['resume', 'thread/resume', 'protocol-method-missing:thread/resume'],
    ['cancel', 'turn/interrupt', 'protocol-method-missing:turn/interrupt'],
  ] as const)('fails %s closed when %s is absent', (capability, missingMethod, reason) => {
    const documents = protocolDocuments()
    const clientRequest = documents['ClientRequest.json'] as {
      oneOf: Array<{ properties: { method: { enum: string[] } } }>
    }
    clientRequest.oneOf = clientRequest.oneOf.filter(
      (candidate) => candidate.properties.method.enum[0] !== missingMethod,
    )

    expect(descriptor({ protocol: protocol(documents) }).capabilities[capability])
      .toEqual({ status: 'unsupported', emulation: 'forbidden', reason })
  })

  it.each([
    ['stream', 'turn/completed', 'protocol-method-missing:turn/completed'],
    ['usage', 'thread/tokenUsage/updated', 'protocol-method-missing:thread/tokenUsage/updated'],
  ] as const)('fails %s closed when %s is absent', (capability, missingMethod, reason) => {
    const documents = protocolDocuments()
    const serverNotification = documents['ServerNotification.json'] as {
      oneOf: Array<{ properties: { method: { enum: string[] } } }>
    }
    serverNotification.oneOf = serverNotification.oneOf.filter(
      (candidate) => candidate.properties.method.enum[0] !== missingMethod,
    )

    expect(descriptor({ protocol: protocol(documents) }).capabilities[capability])
      .toEqual({ status: 'unsupported', emulation: 'forbidden', reason })
  })

  it('records a missing approval surface without manufacturing interaction support', () => {
    const documents = protocolDocuments()
    const serverRequest = documents['ServerRequest.json'] as {
      oneOf: Array<{ properties: { method: { enum: string[] } } }>
    }
    serverRequest.oneOf = serverRequest.oneOf.filter(
      (candidate) => candidate.properties.method.enum[0]
        !== 'item/fileChange/requestApproval',
    )

    expect(descriptor({ protocol: protocol(documents) }).capabilities.interaction)
      .toEqual({
        status: 'unsupported',
        emulation: 'forbidden',
        reason: 'protocol-method-missing:item/fileChange/requestApproval',
      })
  })

  it.each([
    ['execute', 'v2/ThreadStartResponse.json', 'ThreadStartResponse'],
    ['resume', 'v2/ThreadResumeResponse.json', 'ThreadResumeResponse'],
  ] as const)('rejects a drifted %s result shape', (capability, path, shape) => {
    const documents = protocolDocuments()
    const response = documents[path] as { properties: { thread: Record<string, unknown> } }
    response.properties.thread = { type: 'string' }

    expect(descriptor({ protocol: protocol(documents) }).capabilities[capability])
      .toEqual(expect.objectContaining({
        status: 'unsupported',
        reason: `protocol-shape-mismatch:${shape}`,
      }))
  })

  it('rejects drifted cancel, stream, usage, and approval/input shapes', () => {
    const cancelDocuments = protocolDocuments()
    const interrupt = cancelDocuments['v2/TurnInterruptParams.json'] as {
      properties: { turnId: { type: string } }
    }
    interrupt.properties.turnId.type = 'integer'
    expect(descriptor({ protocol: protocol(cancelDocuments) }).capabilities.cancel.reason)
      .toBe('protocol-shape-mismatch:TurnInterruptParams')

    const streamDocuments = protocolDocuments()
    const delta = streamDocuments['v2/AgentMessageDeltaNotification.json'] as {
      properties: { delta: { type: string } }
    }
    delta.properties.delta.type = 'integer'
    expect(descriptor({ protocol: protocol(streamDocuments) }).capabilities.stream.reason)
      .toBe('protocol-shape-mismatch:AgentMessageDeltaNotification')

    const usageDocuments = protocolDocuments()
    const usage = usageDocuments['v2/ThreadTokenUsageUpdatedNotification.json'] as {
      definitions: { TokenUsageBreakdown: { properties: { inputTokens: { type: string } } } }
    }
    usage.definitions.TokenUsageBreakdown.properties.inputTokens.type = 'string'
    expect(descriptor({ protocol: protocol(usageDocuments) }).capabilities.usage.reason)
      .toBe('protocol-shape-mismatch:ThreadTokenUsageUpdatedNotification')

    const interactionDocuments = protocolDocuments()
    const approval = interactionDocuments['FileChangeRequestApprovalParams.json'] as {
      properties: { itemId: { type: string } }
    }
    approval.properties.itemId.type = 'integer'
    expect(descriptor({ protocol: protocol(interactionDocuments) }).capabilities.interaction.reason)
      .toBe('protocol-shape-mismatch:FileChangeRequestApprovalParams')
  })

  it('detects installed-version, generated-version, and schema-digest drift', () => {
    expect(descriptor({ expectedVersion: '0.148.0' }).capabilities['goal-control'])
      .toEqual(expect.objectContaining({ reason: 'expected-installed-version-drift' }))
    expect(descriptor({ expectedSchemaDigest: `sha256:${'b'.repeat(64)}` }).capabilities['goal-control'])
      .toEqual(expect.objectContaining({ reason: 'expected-protocol-schema-drift' }))
    expect(descriptor({
      protocol: { ...protocol(), generatedForVersion: '0.146.0' },
    }).capabilities['goal-control']).toEqual(expect.objectContaining({
      reason: 'installed-version-schema-version-drift',
    }))
  })

  it('withholds native capability when executable artifact identity is absent or invalid', () => {
    expect(descriptor({ executableArtifactDigest: undefined }).capabilities['execute'])
      .toEqual(expect.objectContaining({ reason: 'executable-artifact-digest-missing' }))
    expect(descriptor({ executableArtifactDigest: 'sha256:not-a-digest' }).capabilities['execute'])
      .toEqual(expect.objectContaining({ reason: 'executable-artifact-digest-invalid' }))
  })
})

describe('installed Codex App Server capability observation', () => {
  it('derives a source-bound descriptor and removes the generated schema corpus', async () => {
    let generatedOutput: string | undefined
    const runProbe = createInternalSafeProbeRunner(async ({ args }) => {
      if (args[0] === '--version') return ok(`codex-cli ${VERSION}\n`)
      if (args.at(-1) === '--help') return ok('  --experimental  Include experimental APIs\n')
      generatedOutput = args.at(-1)
      await writeProtocolCorpus(generatedOutput!)
      return ok()
    })

    const result = await observeInstalledCodexGoalCapabilityForTesting(
      observationOptions(),
      () => runProbe,
    )

    expect(result.capabilities['goal-control']).toEqual({
      status: 'native',
      emulation: 'forbidden',
    })
    expect(result.capabilities['execute']).toEqual({
      status: 'native',
      emulation: 'forbidden',
    })
    expect(result.backend).toEqual(expect.objectContaining({
      kind: 'app-server',
      version: VERSION,
      protocolSchemaRef: `codex-app-server://generated-json-schema/${VERSION}?experimental=1&files=${Object.keys(protocolDocuments()).length}`,
      protocolSchemaDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      artifactDigest: ARTIFACT_DIGEST,
    }))
    expect(generatedOutput).toBeDefined()
    await expect(access(generatedOutput!)).rejects.toThrow()
  })

  it.each([
    ['timeout', 'protocol-observation-timeout'],
    ['output-limit', 'protocol-observation-output-limit'],
    ['spawn-error', 'protocol-observation-process-failure'],
    ['exit-nonzero', 'protocol-observation-process-failure'],
  ] as const)('classifies %s without advertising native goal-control', async (failure, reason) => {
    const runProbe = createInternalSafeProbeRunner(async () => failed(failure))

    const result = await observeInstalledCodexGoalCapabilityForTesting(
      observationOptions(),
      () => runProbe,
    )

    expect(result.capabilities['goal-control']).toEqual({
      status: 'unsupported',
      emulation: 'forbidden',
      reason,
    })
  })

  it('rejects an oversized generated schema file and still cleans the directory', async () => {
    let generatedOutput: string | undefined
    const runProbe = createInternalSafeProbeRunner(async ({ args }) => {
      if (args[0] === '--version') return ok(`codex-cli ${VERSION}\n`)
      if (args.at(-1) === '--help') return ok('--experimental\n')
      generatedOutput = args.at(-1)
      await writeFile(
        join(generatedOutput!, 'ClientRequest.json'),
        'x'.repeat(1_000_001),
        'utf8',
      )
      return ok()
    })

    const result = await observeInstalledCodexGoalCapabilityForTesting(
      observationOptions(),
      () => runProbe,
    )

    expect(result.capabilities['goal-control']).toEqual({
      status: 'unsupported',
      emulation: 'forbidden',
      reason: 'protocol-schema-file-limit',
    })
    await expect(access(generatedOutput!)).rejects.toThrow()
  })
})

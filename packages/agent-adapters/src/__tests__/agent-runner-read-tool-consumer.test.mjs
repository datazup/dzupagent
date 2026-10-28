import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'
import ts from 'typescript'

// Use one module realm for the host and source entrypoints. Independent tsImport
// registrations can create distinct LangChain constructor identities, which the
// exact legacy-envelope contract intentionally rejects.
const loader = register({ namespace: 'r5q-consumer-source' })
after(() => loader.unregister())
const importSource = (specifier) => loader.import(specifier, import.meta.url)
const { AIMessage, HumanMessage, ToolMessage } = await importSource('@langchain/core/messages')
const { tool } = await importSource('@langchain/core/tools')
const { z } = await importSource('zod')
// Source counterparts of the public Agent subpaths: no rebuilding shared dist.
const { DzupAgent } = await importSource('../../../agent/src/agent.ts')
const { InMemoryAgentRunner, validateAgentRunnerReadToolDelegationAdmission } =
  await importSource('../../../agent/src/runner.ts')
const { agentRunnerItemsToLangChainMessages, langChainMessageToAgentRunnerModelResult } =
  await importSource('../integration/agent-runner-langchain-conversion.ts')

const clone = (value) => JSON.parse(JSON.stringify(value))
const optIn = (extra = {}) => ({ runId: 'r5q-consumer-run',
  experimentalReadToolGenerateDelegation: { enabled: true, preDispatchPolicy: 'fallback-to-legacy' },
  ...extra })
const comparable = (result) => ({ ...result,
  messages: result.messages.map((message) => message.toDict()),
  middlewareState: { ...result.middlewareState,
    messages: result.middlewareState.messages.map((message) => message.toDict()) },
})

// The host owns the bridge, model conversion and original LangChain envelopes.
// The caller-owned read port remains the only path to the configured tool.
function consumer({ mode = 'completed', controller, blocks = false } = {}) {
  let clock = 1000
  const counts = { legacyModels: 0, runnerModels: 0, reads: 0, dispatches: 0 }
  const requests = []
  const transcripts = []
  const call = { id: 'read-call', name: 'read-record', args: { id: 'one' } }
  function completion(turn) {
    return new AIMessage({
      content: turn === 1 ? 'Reading record.' : blocks ? [{ type: 'text', text: 'Value: one.' }] : 'Value: one.',
      ...(turn === 1 ? { tool_calls: [call] } : {}),
      usage_metadata: turn === 1
        ? { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
        : { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    })
  }
  const read = tool(async ({ id }) => {
    counts.reads += 1
    clock += 25
    if (mode === 'cancel-after-read') controller.abort()
    if (mode === 'read-error') throw new Error('fixture read failed')
    return `value:${id}`
  }, { name: call.name, description: 'Read one deterministic record.', schema: z.object({ id: z.string() }) })
  const bridge = {
    bridgeId: 'r5q-consumer/v1',
    binding: { toolId: call.name, toolRevision: '1', effectClass: 'read', maxCalls: 1,
      timingPolicy: 'host-elapsed-ms/v1' },
    async dispatch(request) {
      counts.dispatches += 1
      requests.push(request)
      assert.equal(validateAgentRunnerReadToolDelegationAdmission(clone(request.admission)), true)
      assert.equal(Object.isFrozen(request.admission.source), true)
      if (mode === 'refuse') return { status: 'rejected-before-dispatch', source: request.admission.source, code: 'fixture-unavailable' }
      const envelopes = []
      const ids = new Map()
      const result = await new InMemoryAgentRunner({
        model: { adapterId: 'r5q-langchain-fixture/v1', async invoke(modelRequest) {
          const convertedInput = agentRunnerItemsToLangChainMessages([
            ...modelRequest.input, ...modelRequest.committedItems,
          ])
          assert.equal(convertedInput.status, 'converted')
          assert.deepEqual(convertedInput.losses, [])
          transcripts.push(convertedInput.value)
          const message = completion(++counts.runnerModels)
          if (mode === 'lossy-model') message.additional_kwargs.unqualified = true
          envelopes.push(message)
          const converted = langChainMessageToAgentRunnerModelResult(message, {
            itemIdPrefix: modelRequest.requestId, accountingSource: 'r5q-fixture',
          })
          if (converted.status !== 'converted' || converted.losses.length !== 0) {
            throw new Error('model conversion is not lossless for this admitted profile')
          }
          if (mode === 'cancel-before-read') controller.abort()
          // This finite fake model supplies its terminal classification outside
          // the legacy envelope. R5P deliberately excludes response metadata;
          // do not infer these classifications for an unqualified live model.
          return { ...converted.value, finishReason: counts.runnerModels === 1 ? 'tool-calls' : 'stop' }
        } },
        tools: [request.readTool],
        maxModelTurns: request.admission.maxModelTurns,
        maxToolAttempts: request.admission.maxToolAttempts,
        createId(kind) {
          if (kind === 'run') return request.admission.source.runId
          ids.set(kind, (ids.get(kind) ?? 0) + 1)
          return `${kind}-${ids.get(kind)}`
        },
        now: () => '2026-10-28T18:00:00.000Z',
      }).run(request.input, { control: request.control })
      if (mode === 'unknown') return { status: 'outcome-unknown', source: request.admission.source, code: 'fixture-outcome-unknown' }
      if (mode === 'throw-after-read') throw new Error('fixture transport failure after dispatch')
      if (mode === 'false-refusal') return { status: 'rejected-before-dispatch', source: request.admission.source, code: 'fixture-false-refusal' }
      if (mode === 'cancel-before-read' || mode === 'cancel-after-read' || mode === 'read-error') {
        return { status: 'failed-after-dispatch', source: request.admission.source, code: 'fixture-run-failed' }
      }
      const retained = clone(result)
      if (mode === 'foreign-result') retained.state.runId = 'foreign-run'
      const output = retained.state.committedItems.find((item) => item.type === 'tool-result')
      return { status: 'completed', source: request.admission.source, result: retained,
        assistantCall: envelopes[0],
        toolMessage: new ToolMessage({ content: output.output, tool_call_id: output.callId, name: call.name }),
        finalAssistant: envelopes[1] }
    },
  }
  const legacyModel = { bindTools() { return this }, async invoke() {
    return completion(++counts.legacyModels)
  } }
  const agent = new DzupAgent({ id: 'r5q-consumer', instructions: 'Read one record.',
    model: legacyModel, tools: [read], memoryWriteBack: false,
    guardrails: { maxIterations: 4, stuckDetector: false },
    toolExecution: { wrapToolResults: false }, experimentalReadToolGenerateBridge: bridge })
  return { agent, counts, requests, transcripts, now: () => clock }
}

for (const blocks of [false, true]) {
  test(`host consumer matches complete legacy result with blocks=${blocks}`, async (t) => {
    const legacy = consumer({ blocks })
    const current = consumer({ blocks })
    const input = [new HumanMessage('Earlier'), new AIMessage('History'), new HumanMessage('Read one')]
    const timer = t.mock.method(Date, 'now', legacy.now)
    const expected = await legacy.agent.generate(input, { runId: 'r5q-consumer-run' })
    timer.mock.mockImplementation(current.now)
    const actual = await current.agent.generate(input, optIn({
      experimentalReadToolGenerateDelegation: { enabled: true, preDispatchPolicy: 'fail-closed' },
    }))
    assert.deepEqual(comparable(actual), comparable(expected))
    assert.deepEqual(actual.toolStats, [{ name: 'read-record', calls: 1, errors: 0, totalMs: 25, avgMs: 25 }])
    assert.deepEqual(current.counts, { legacyModels: 0, runnerModels: 2, reads: 1, dispatches: 1 })
    assert.equal(current.transcripts.length, 2)
    const toolResults = current.transcripts[1].filter((message) => ToolMessage.isInstance(message))
    assert.equal(toolResults.length, 1)
    assert.equal(toolResults[0].tool_call_id, 'read-call')
    assert.equal(toolResults[0].content, 'value:one')
  })
}

test('certified pre-dispatch refusal falls back once without running the runner', async (t) => {
  const value = consumer({ mode: 'refuse' })
  t.mock.method(Date, 'now', value.now)
  const result = await value.agent.generate([new HumanMessage('Read one')], optIn())
  assert.equal(result.content, 'Value: one.')
  assert.deepEqual(value.counts, { legacyModels: 2, runnerModels: 0, reads: 1, dispatches: 1 })
})

for (const mode of ['unknown', 'throw-after-read', 'false-refusal', 'foreign-result', 'read-error', 'lossy-model']) {
  test(`host ${mode} never replays through legacy`, async (t) => {
    const value = consumer({ mode })
    t.mock.method(Date, 'now', value.now)
    await assert.rejects(value.agent.generate([new HumanMessage('Read one')], optIn()), (error) => {
      assert.equal(error.name, 'AgentRunnerReadToolDelegationError')
      assert.notEqual(error.replay, 'not-dispatched')
      return true
    })
    assert.equal(value.counts.legacyModels, 0)
    assert.equal(value.counts.dispatches, 1)
    assert.equal(value.counts.reads, mode === 'lossy-model' ? 0 : 1)
  })
}

for (const mode of ['cancel-before-read', 'cancel-after-read']) {
  test(`host ${mode} keeps cancellation and effect custody`, async (t) => {
    const controller = new AbortController()
    const value = consumer({ mode, controller })
    t.mock.method(Date, 'now', value.now)
    await assert.rejects(value.agent.generate([new HumanMessage('Read one')], optIn({ signal: controller.signal })))
    assert.equal(value.counts.legacyModels, 0)
    assert.equal(value.counts.dispatches, 1)
    assert.equal(value.counts.reads, mode === 'cancel-before-read' ? 0 : 1)
  })
}

test('a retained caller-owned tool port cannot execute after the bridge returns', async (t) => {
  const value = consumer()
  t.mock.method(Date, 'now', value.now)
  await value.agent.generate([new HumanMessage('Read one')], optIn())
  await assert.rejects(value.requests[0].readTool.execute({ runId: 'r5q-consumer-run',
    invocationId: 'late-invocation', callId: 'late-call', attempt: 1, input: { id: 'two' } }),
  { code: 'read-port-single-use-violation' })
  assert.equal(value.counts.reads, 1)
})

test('existing conversion conformance includes the host-discovered string regression', async () => {
  assert.ok(process.env.TMPDIR?.startsWith('/data/storage/datazup-runtime/ninel/'))
  const { startVitest } = await import('vitest/node')
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
  const cacheDir = mkdtempSync(path.join(process.env.TMPDIR, 'r5q-conversion-'))
  let vitest
  try {
    vitest = await startVitest('test', [], {
      root: packageRoot, config: false, run: true, watch: false,
      include: ['src/__tests__/agent-runner-langchain-conversion.test.ts'],
      environment: 'node', globals: false, unstubEnvs: true, unstubGlobals: true,
      testTimeout: 30_000, fileParallelism: false, maxWorkers: 1, minWorkers: 1,
      pool: 'forks', cache: false, update: false, reporters: ['default'],
    }, { configFile: false, cacheDir })
    const files = vitest.state.getFiles()
    assert.equal(files.length, 1)
    assert.deepEqual(vitest.state.getUnhandledErrors(), [])
    assert.deepEqual(files.map((file) => file.result?.state), ['pass'])
  } finally {
    await vitest?.close()
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('Agent and Adapters typecheck against current source without rewriting shared declarations', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  for (const name of ['agent', 'agent-adapters']) {
    const packageRoot = path.join(root, 'packages', name)
    const config = ts.readConfigFile(path.join(packageRoot, 'tsconfig.json'), ts.sys.readFile)
    assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
    assert.deepEqual(parsed.errors, [])
    // Installed agent-types declarations can lag source. This checks the current
    // source contract explicitly; the unchanged installed-artifact gate remains
    // a separate result and must not be relabelled as passing.
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: {
      ...parsed.options, noEmit: true, incremental: false, composite: false, rootDir: root,
      paths: { ...parsed.options.paths,
        '@dzupagent/agent-types/run': [path.join(root, 'packages/agent-types/src/run.ts')],
        '@dzupagent/runtime-contracts': [path.join(root, 'packages/runtime-contracts/src/index.ts')],
      },
    } })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
      file: diagnostic.file ? path.relative(root, diagnostic.file.fileName) : '<configuration>',
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    }))
    assert.deepEqual(diagnostics, [], `${name} current-source diagnostics`)
  }
})

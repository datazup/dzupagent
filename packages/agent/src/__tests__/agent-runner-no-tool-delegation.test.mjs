import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { tsImport } from 'tsx/esm/api'
import { AIMessage, HumanMessage } from '@langchain/core/messages'

const { DzupAgent } = await tsImport('../agent/dzip-agent.ts', import.meta.url)
const {
  InMemoryAgentRunner,
  AgentRunnerNoToolDelegationError,
  digestRunnerJson,
  validateAgentRunnerNoToolDelegationAdmission,
  validateAgentRunnerNoToolDelegationSource,
} = await tsImport('../runner.ts', import.meta.url)

const usage = { input_tokens: 13, output_tokens: 5, total_tokens: 18 }
const clone = (value) => JSON.parse(JSON.stringify(value))
const optIn = (policy = 'fail-closed', extra = {}) => ({
  runId: 'r5n-native-run',
  experimentalNoToolGenerateDelegation: { enabled: true, preDispatchPolicy: policy },
  ...extra,
})
const message = (content = 'answer', extra = {}) => new AIMessage({
  content, usage_metadata: usage, ...extra,
})
const dicts = (result) => ({
  ...result,
  messages: result.messages.map((value) => value.toDict()),
  ...(result.middlewareState === undefined ? {} : {
    middlewareState: {
      ...result.middlewareState,
      messages: result.middlewareState.messages.map((value) => value.toDict()),
    },
  }),
})

function fixture({ content = 'answer', mode = 'completed', config = {}, onDispatch } = {}) {
  let legacyCalls = 0
  let modelCalls = 0
  const requests = []
  const model = {
    async invoke() { legacyCalls += 1; return message(content) },
    bindTools() { return this },
  }
  const bridge = {
    bridgeId: 'r5n-provider-free-bridge/v1',
    async dispatch(request) {
      requests.push(request)
      onDispatch?.(request)
      if (mode === 'rejected-before-dispatch') {
        return { status: mode, code: 'fixture-not-ready', source: request.admission.source }
      }
      if (mode === 'throw') throw new Error('untrusted provider detail')
      if (mode === 'malformed-completion') {
        return { status: 'completed', source: request.admission.source }
      }
      if (mode === 'mutate-admission') request.admission.source.runId = 'changed'
      if (mode === 'throw-before-dispatch-error') {
        throw new AgentRunnerNoToolDelegationError({
          code: 'untrusted-certification', phase: 'before-dispatch', replay: 'not-dispatched',
        })
      }
      const counts = new Map()
      const result = await new InMemoryAgentRunner({
        model: {
          adapterId: 'r5n-provider-free-model/v1',
          async invoke() {
            modelCalls += 1
            return {
              status: 'completed',
              item: { type: 'message', itemId: 'assistant-final', role: 'assistant', content:
                typeof content === 'string' ? [{ type: 'text', text: content }]
                  : content.map(({ text }) => ({ type: 'text', text })) },
              usage: mode === 'partial-usage'
                ? { accountingSource: 'native-fixture', inputTokens: 13 }
                : { accountingSource: 'native-fixture', inputTokens: 13, outputTokens: 5, totalTokens: 18 },
              finishReason: 'stop',
            }
          },
        },
        createId(kind) {
          if (kind === 'run') return request.admission.source.runId
          counts.set(kind, (counts.get(kind) ?? 0) + 1)
          return `${kind}-${counts.get(kind)}`
        },
        now: () => '2026-10-14T14:00:00.000Z',
        maxModelTurns: request.admission.maxModelTurns,
        maxToolAttempts: request.admission.maxToolAttempts,
      }).run(clone(request.input), { control: request.control })
      if (mode === 'failed-after-dispatch' || mode === 'outcome-unknown') {
        return { status: mode, code: 'fixture-failure', source: request.admission.source }
      }
      const source = clone(request.admission.source)
      if (mode === 'source-drift') source.inputDigest = 'sha256:changed'
      if (mode === 'run-drift') result.state.runId = 'another-run'
      if (mode === 'session-state') result.state.sessionBinding = { sessionId: 'unsupported' }
      if (mode === 'adapter-state') result.state.adapterState = {}
      if (mode === 'context-state') result.state.context = { state: 'inline', value: {} }
      if (mode === 'handoff-state') result.state.handoffs = [{ handoffId: 'unsupported' }]
      return {
        status: 'completed', source, result: clone(result),
        finalAssistant: message(content, mode === 'envelope-failure'
          ? { response_metadata: { unsupported: true } } : {}),
      }
    },
  }
  const agent = new DzupAgent({
    id: 'r5n-agent', instructions: 'Use only the deterministic fixture.', model,
    guardrails: { maxIterations: 4, stuckDetector: false }, memoryWriteBack: false,
    experimentalNoToolGenerateBridge: bridge, ...config,
  })
  return { agent, bridge, requests, counts: () => ({ legacyCalls, modelCalls }) }
}

for (const content of ['answer', [{ type: 'text', text: 'standard block' }]]) {
  test(`public opt-in matches the independently executed legacy ${typeof content} result`, async () => {
    const value = fixture({ content })
    const input = [new HumanMessage('first'), new AIMessage('history'), new HumanMessage('last')]
    const legacy = await value.agent.generate(input, { runId: 'r5n-native-run' })
    const actual = await value.agent.generate(input, optIn())
    assert.deepEqual(dicts(actual), dicts(legacy))
    assert.deepEqual(value.counts(), { legacyCalls: 1, modelCalls: 1 })
    assert.equal(value.requests.length, 1)
    assert.equal(validateAgentRunnerNoToolDelegationAdmission(clone(value.requests[0].admission)), true)
  })
}

test('default-off, missing bridge and explicit ineligible fallback invoke legacy once', async () => {
  for (const scenario of [
    { options: undefined },
    { config: { experimentalNoToolGenerateBridge: undefined }, options: optIn('fallback-to-legacy') },
    { config: { memoryWriteBack: true }, options: optIn('fallback-to-legacy') },
    { options: optIn('fallback-to-legacy', { context: 'unsupported' }) },
  ]) {
    const value = fixture(scenario)
    await value.agent.generate([new HumanMessage('default')], scenario.options)
    assert.deepEqual(value.counts(), { legacyCalls: 1, modelCalls: 0 })
    assert.equal(value.requests.length, 0)
  }
})

test('fail-closed admission rejects unsupported config/options before lifecycle hooks', async () => {
  let hookCalls = 0
  const cases = [
    { config: { memoryWriteBack: true } },
    { config: { security: {} } },
    { config: { guardrails: { maxIterations: 4, stuckDetector: false, maxTokens: 20 } } },
    { config: { hooks: { onRunStart() { hookCalls += 1 } } } },
    { config: { newUnqualifiedPolicy: true } },
    { options: optIn('fail-closed', { schemaName: 'unsupported' }) },
    { options: optIn('fail-closed', { temperature: 0.5 }) },
    { options: { ...optIn(), runId: undefined } },
    { options: { ...optIn(), experimentalNoToolGenerateDelegation: null } },
    { options: { ...optIn(), experimentalNoToolGenerateDelegation: { enabled: true } } },
    { input: [new HumanMessage({ content: 'named', name: 'unsupported' })] },
    { input: [new HumanMessage([{ type: 'image_url', image_url: { url: 'unsupported' } }])] },
  ]
  for (const scenario of cases) {
    const value = fixture(scenario)
    await assert.rejects(value.agent.generate(scenario.input ?? [new HumanMessage('reject')],
      scenario.options ?? optIn()), (error) => {
      assert.equal(error.name, 'AgentRunnerNoToolDelegationError')
      assert.equal(error.replay, 'not-dispatched')
      return true
    })
    assert.deepEqual(value.counts(), { legacyCalls: 0, modelCalls: 0 })
    assert.equal(value.requests.length, 0)
  }
  assert.equal(hookCalls, 0)
})

test('cancellation before admission or during preparation performs no dispatch', async () => {
  for (const alreadyAborted of [true, false]) {
    const value = fixture()
    const controller = new AbortController()
    if (alreadyAborted) controller.abort()
    const pending = value.agent.generate([new HumanMessage('cancel')], optIn('fallback-to-legacy', {
      signal: controller.signal,
    }))
    controller.abort()
    await assert.rejects(pending, { code: 'cancelled-before-dispatch', replay: 'not-dispatched' })
    assert.deepEqual(value.counts(), { legacyCalls: 0, modelCalls: 0 })
    assert.equal(value.requests.length, 0)
  }
})

test('non-enumerable and accessor policies cannot bypass fail-closed admission', async () => {
  for (const field of ['hooks', 'tools', 'experimentalNoToolGenerateBridge']) {
    for (const accessor of [false, true]) {
      let sideEffects = 0
      const value = fixture()
      Object.defineProperty(value.agent.agentConfig, field, accessor
        ? { enumerable: false, get() { sideEffects += 1; return {} } }
        : { enumerable: false, value: { onRunStart() { sideEffects += 1 } } })
      await assert.rejects(value.agent.generate([new HumanMessage('hidden policy')], optIn()), {
        code: 'configuration-extension-enabled', replay: 'not-dispatched',
      })
      assert.equal(sideEffects, 0)
      assert.deepEqual(value.counts(), { legacyCalls: 0, modelCalls: 0 })
    }
  }
})

test('bridge-certified pre-dispatch refusal follows the selected policy', async () => {
  const fallback = fixture({ mode: 'rejected-before-dispatch' })
  await fallback.agent.generate([new HumanMessage('fallback')], optIn('fallback-to-legacy'))
  assert.deepEqual(fallback.counts(), { legacyCalls: 1, modelCalls: 0 })
  assert.equal(fallback.requests.length, 1)
  const refused = fixture({ mode: 'rejected-before-dispatch' })
  await assert.rejects(refused.agent.generate([new HumanMessage('refuse')], optIn()), {
    phase: 'before-dispatch', replay: 'not-dispatched',
  })
  assert.deepEqual(refused.counts(), { legacyCalls: 0, modelCalls: 0 })
})

for (const mode of ['failed-after-dispatch', 'outcome-unknown', 'throw', 'throw-before-dispatch-error',
  'malformed-completion', 'mutate-admission',
  'partial-usage', 'source-drift', 'run-drift', 'envelope-failure', 'session-state', 'adapter-state',
  'context-state', 'handoff-state']) {
  test(`${mode} never replays through legacy even with fallback selected`, async () => {
    const value = fixture({ mode })
    await assert.rejects(value.agent.generate([new HumanMessage('no replay')], optIn('fallback-to-legacy')),
      (error) => {
        assert.equal(error.name, 'AgentRunnerNoToolDelegationError')
        assert.notEqual(error.replay, 'not-dispatched')
        assert.equal(error.message.includes('untrusted provider detail'), false)
        return true
      })
    assert.equal(value.counts().legacyCalls, 0)
    assert.equal(value.requests.length, 1)
    assert.ok(value.counts().modelCalls <= 1)
  })
}

test('input snapshots and source bindings survive caller mutation and JSON reconstruction', async () => {
  const user = new HumanMessage('original')
  const value = fixture({ onDispatch(request) {
    user.content = 'changed by caller'
    assert.equal(Object.isFrozen(request.preparedMessages), true)
    assert.equal(Object.isFrozen(request.admission.source), true)
    assert.equal(Object.isFrozen(request.input.items[0]), true)
    assert.equal(request.preparedMessages.at(-1).content, 'original')
    assert.equal(validateAgentRunnerNoToolDelegationSource(clone(request.admission.source)), true)
    assert.equal(request.admission.source.inputDigest, digestRunnerJson(clone(request.input)))
  } })
  const result = await value.agent.generate([user], optIn())
  assert.equal(result.messages.at(-2).content, 'original')
  assert.equal(user.content, 'changed by caller')
  assert.deepEqual(value.counts(), { legacyCalls: 0, modelCalls: 1 })
})

test('launch keeps the legacy path even when generate options include opt-in', async () => {
  const value = fixture()
  const handle = await value.agent.launch([new HumanMessage('background')], { generateOptions: optIn() })
  assert.equal((await handle.result()).status, 'completed')
  assert.deepEqual(value.counts(), { legacyCalls: 1, modelCalls: 0 })
  assert.equal(value.requests.length, 0)
})

test('production TypeScript passes without emitting into shared dependency artifacts', () => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
  function diagnostics(root) {
    const configFile = path.join(root, 'tsconfig.json')
    const config = ts.readConfigFile(configFile, ts.sys.readFile)
    assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
    assert.equal(parsed.errors.length, 0)
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true, incremental: false, composite: false },
    })
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
      file: diagnostic.file ? path.relative(root, diagnostic.file.fileName) : '<configuration>',
      code: diagnostic.code,
      line: diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').replaceAll(root, '<package>'),
    }))
  }
  assert.deepEqual(diagnostics(packageRoot).map(({ file, code, line, message }) => ({
    file, code, line, message,
  })), [])
})

test('public declaration emission stays within the existing budget without writing dist', () => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
  const configFile = path.join(packageRoot, 'tsconfig.build.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot)
  assert.equal(parsed.errors.length, 0)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: {
    ...parsed.options, noEmit: false, emitDeclarationOnly: true,
    declarationMap: false, incremental: false, composite: false,
  } })
  const declarations = new Map()
  const emission = program.emit(undefined, (file, text) => {
    if (!file.endsWith('.d.ts')) return
    const sourceFile = path.join(packageRoot, 'src', path.relative(path.join(packageRoot, 'dist'), file)
      .replace(/\.d\.ts$/, '.ts'))
    const comment = readFileSync(sourceFile, 'utf8').match(/^(\/\*\*[\s\S]*?\*\/)(?=\s*import\b)/)?.[1]
    declarations.set(file, comment && text.startsWith(comment)
      ? text.slice(comment.length).replace(/^\s*\n/, '') : text)
  })
  assert.equal(emission.emitSkipped, false)
  assert.deepEqual(emission.diagnostics.map(({ code }) => code), [])
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const retained = new Set()
  const pending = Object.values(manifest.exports).map((entry) => path.resolve(packageRoot, entry.types))
  while (pending.length > 0) {
    const file = pending.pop()
    if (retained.has(file)) continue
    const text = declarations.get(file)
    assert.notEqual(text, undefined, 'every public declaration must resolve')
    retained.add(file)
    for (const reference of ts.preProcessFile(text, true, true).importedFiles) {
      if (!reference.fileName.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), reference.fileName)
      const candidates = [target, target.replace(/\.js$/, '.d.ts'), `${target}.d.ts`,
        path.join(target, 'index.d.ts')]
      const dependency = candidates.find((candidate) => declarations.has(candidate))
      assert.notEqual(dependency, undefined, 'every relative declaration import must resolve')
      pending.push(dependency)
    }
  }
  const bytes = [...retained].reduce((sum, file) => sum + Buffer.byteLength(declarations.get(file)), 0)
  const budgets = JSON.parse(readFileSync(path.join(packageRoot, '../../scripts/dts-budgets.json'), 'utf8'))
  const budget = budgets.packages['@dzupagent/agent']
  assert.ok(retained.size <= budget.maxDeclarationFiles, `declaration count ${retained.size}/${budget.maxDeclarationFiles}`)
  assert.ok(bytes <= budget.maxDeclarationBytes, `declaration bytes ${bytes}/${budget.maxDeclarationBytes}`)
})

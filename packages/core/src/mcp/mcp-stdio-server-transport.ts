import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'
import type { DzupAgentMCPServer } from './mcp-server-core.js'
import type {
  MCPResponse,
  MCPStdioServerOptions,
  MCPStdioServerResult,
} from './mcp-server-types.js'
import { JSON_RPC_INVALID_REQUEST } from './mcp-server-types.js'
import { buildError, isMCPRequest } from './mcp-server-utils.js'

const DEFAULT_MAX_FRAME_BYTES = 1_048_576
const JSON_RPC_PARSE_ERROR = -32700

export async function serveMCPOverStdio(
  server: DzupAgentMCPServer,
  options: MCPStdioServerOptions = {},
): Promise<MCPStdioServerResult> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const error = options.error ?? process.stderr
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError('maxFrameBytes must be a positive safe integer')
  }

  let framesRead = 0
  let responsesWritten = 0
  let inputFailed = false
  let outputFailed = false
  let exitReason: MCPStdioServerResult['exitReason'] = 'eof'
  const onInputError = () => {
    inputFailed = true
  }
  const onOutputError = () => {
    outputFailed = true
  }
  input.on('error', onInputError)
  output.on('error', onOutputError)

  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      framesRead += 1
      const response = await dispatchLine(server, line, {
        maxFrameBytes,
        ...(options.protocolVersion !== undefined && {
          protocolVersion: options.protocolVersion,
        }),
      })
      if (response === null) continue

      await writeFrame(output, `${JSON.stringify(response)}\n`)
      responsesWritten += 1
      if (outputFailed) throw new Error('output stream failed')
    }
    if (inputFailed) exitReason = 'input_error'
  } catch {
    exitReason = outputFailed ? 'output_error' : 'input_error'
  } finally {
    lines.close()
    input.removeListener('error', onInputError)
    output.removeListener('error', onOutputError)
  }

  if (exitReason === 'input_error') {
    await writeDiagnostic(error, 'MCP stdio input error\n')
  } else if (exitReason === 'output_error') {
    await writeDiagnostic(error, 'MCP stdio output error\n')
  }

  if (
    exitReason === 'eof'
    && options.output !== undefined
    && options.endOutput === true
  ) {
    await endWritable(output)
  }

  return { framesRead, responsesWritten, exitReason }
}

async function dispatchLine(
  server: DzupAgentMCPServer,
  line: string,
  options: { maxFrameBytes: number; protocolVersion?: string },
): Promise<MCPResponse | null> {
  if (Buffer.byteLength(line, 'utf8') > options.maxFrameBytes) {
    return buildError(
      null,
      JSON_RPC_INVALID_REQUEST,
      'MCP input frame too large',
    )
  }
  if (line.length === 0) {
    return buildError(null, JSON_RPC_INVALID_REQUEST, 'Invalid MCP request')
  }

  let request: unknown
  try {
    request = JSON.parse(line) as unknown
  } catch {
    return buildError(null, JSON_RPC_PARSE_ERROR, 'Parse error')
  }
  if (!isMCPRequest(request)) {
    return buildError(null, JSON_RPC_INVALID_REQUEST, 'Invalid MCP request')
  }

  return server.handleRequest(
    request,
    options.protocolVersion === undefined
      ? {}
      : { protocolVersion: options.protocolVersion },
  )
}

async function writeFrame(output: Writable, frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let callbackComplete = false
    let drainComplete = false
    let settled = false
    const cleanup = () => {
      output.removeListener('drain', onDrain)
      output.removeListener('error', onError)
    }
    const settle = (error?: Error | null) => {
      if (settled) return
      if (error) {
        settled = true
        cleanup()
        reject(error)
        return
      }
      if (callbackComplete && drainComplete) {
        settled = true
        cleanup()
        resolve()
      }
    }
    const onDrain = () => {
      drainComplete = true
      settle()
    }
    const onError = (cause: Error) => {
      settle(cause)
    }

    output.once('error', onError)
    const accepted = output.write(frame, (cause?: Error | null) => {
      callbackComplete = true
      settle(cause)
    })
    drainComplete = accepted
    if (!accepted) output.once('drain', onDrain)
    settle()
  })
}

async function writeDiagnostic(error: Writable, message: string): Promise<void> {
  const swallowError = () => undefined
  error.on('error', swallowError)
  try {
    await writeFrame(error, message)
  } catch {
    // A diagnostic stream failure must not escape or write to protocol stdout.
  } finally {
    error.removeListener('error', swallowError)
  }
}

async function endWritable(output: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      output.removeListener('error', onError)
      output.removeListener('finish', onFinish)
    }
    output.once('error', onError)
    output.once('finish', onFinish)
    output.end()
  })
}

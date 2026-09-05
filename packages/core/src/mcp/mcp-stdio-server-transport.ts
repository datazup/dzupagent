import type { Readable, Writable } from 'node:stream'
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

  try {
    for await (const line of boundedLines(input, maxFrameBytes)) {
      framesRead += 1
      const response = line === null
        ? buildError(null, JSON_RPC_INVALID_REQUEST, 'MCP input frame too large')
        : await dispatchLine(server, line, {
          ...(options.protocolVersion !== undefined && {
            protocolVersion: options.protocolVersion,
          }),
        })
      // Consume the next frame only after this response clears backpressure.
      if (response === null) continue

      await writeFrame(output, `${JSON.stringify(response)}\n`)
      responsesWritten += 1
      if (outputFailed) throw new Error('output stream failed')
    }
    if (inputFailed) exitReason = 'input_error'
  } catch {
    exitReason = outputFailed ? 'output_error' : 'input_error'
  } finally {
    input.removeListener('error', onInputError)
    output.removeListener('error', onOutputError)
  }

  if (
    exitReason === 'eof'
    && options.output !== undefined
    && options.endOutput === true
  ) {
    try {
      await endWritable(output)
    } catch {
      exitReason = 'output_error'
    }
  }

  if (exitReason === 'input_error') {
    await writeDiagnostic(error, 'MCP stdio input error\n')
  } else if (exitReason === 'output_error') {
    await writeDiagnostic(error, 'MCP stdio output error\n')
  }

  return { framesRead, responsesWritten, exitReason }
}

/**
 * Bound transport-owned accumulation before a delimiter arrives. The producer
 * still owns its chunk/high-water-mark allocation. A null frame is one rejected
 * line; discard its remaining bytes until the next delimiter without buffering.
 */
async function* boundedLines(input: Readable, maxFrameBytes: number): AsyncGenerator<string | null> {
  let buffer = Buffer.allocUnsafe(Math.min(maxFrameBytes, 4096))
  let length = 0
  let discarding = false
  let skipLf = false
  for await (const chunk of boundedInputChunks(input)) {
    let offset = 0
    while (offset < chunk.length) {
      if (skipLf) {
        skipLf = false
        if (chunk[offset] === 10) { offset += 1; continue }
      }
      // Visit each byte once; searching separately for a missing delimiter
      // would rescan the entire suffix for every frame in a coalesced chunk.
      let segmentEnd = offset
      while (segmentEnd < chunk.length && chunk[segmentEnd] !== 10 && chunk[segmentEnd] !== 13) segmentEnd += 1
      const segmentLength = segmentEnd - offset
      if (!discarding) {
        if (segmentLength > maxFrameBytes - length) {
          length = 0
          discarding = true
          yield null
        } else {
          const needed = length + segmentLength
          if (needed > buffer.length) {
            const expanded = Buffer.allocUnsafe(Math.min(maxFrameBytes, Math.max(needed, buffer.length * 2)))
            buffer.copy(expanded, 0, 0, length)
            buffer = expanded
          }
          chunk.copy(buffer, length, offset, segmentEnd)
          length = needed
        }
      }
      if (segmentEnd === chunk.length) break
      skipLf = chunk[segmentEnd] === 13
      offset = segmentEnd + 1
      if (!discarding) {
        const line = buffer.toString('utf8', 0, length)
        length = 0
        yield line
      } else {
        discarding = false
      }
    }
  }
  if (!discarding && length > 0) yield buffer.toString('utf8', 0, length)
}

async function* boundedInputChunks(input: Readable): AsyncGenerator<Buffer> {
  for await (const raw of input.iterator({ destroyOnReturn: false })) {
    if (Buffer.isBuffer(raw)) {
      yield raw
    } else if (typeof raw === 'string') {
      // Text streams may supply arbitrarily large chunks. Encode at most 1024
      // code units per slice (<= 4096 UTF-8 bytes), without splitting a pair.
      let offset = 0
      while (offset < raw.length) {
        let end = Math.min(offset + 1024, raw.length)
        const last = raw.charCodeAt(end - 1)
        const next = raw.charCodeAt(end)
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
        yield Buffer.from(raw.slice(offset, end), 'utf8')
        offset = end
      }
    } else {
      throw new TypeError('MCP input must contain bytes or text')
    }
  }
}

async function dispatchLine(
  server: DzupAgentMCPServer,
  line: string,
  options: { protocolVersion?: string },
): Promise<MCPResponse | null> {
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

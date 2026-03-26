/**
 * Semaphore-based parallel tool executor.
 *
 * Executes tool calls concurrently with a configurable concurrency limit,
 * using a counting-semaphore pattern so that as soon as one slot frees up
 * the next pending call starts — unlike batch-based approaches that wait
 * for an entire batch to complete before starting the next one.
 */

/** A single tool call descriptor (matches LangChain's tool_call shape). */
export interface ParallelToolCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/** Result of executing a single tool call. */
export interface ToolExecutionResult {
  /** Tool name that was executed. */
  toolName: string
  /** The tool call ID passed in (or generated). */
  toolCallId: string
  /** Stringified result on success, undefined on error. */
  result?: string
  /** Error message if the tool threw. */
  error?: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** Index in the original calls array (for preserving order). */
  index: number
}

/** Registry-like interface: look up a tool by name and invoke it. */
export interface ToolLookup {
  get(name: string): { invoke(args: Record<string, unknown>): Promise<unknown> } | undefined
  keys(): IterableIterator<string>
}

export interface ParallelExecutorOptions {
  /** Maximum number of concurrent tool executions. Default: 5. */
  maxConcurrency: number
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal
  /** Called when each tool starts executing. */
  onToolStart?: (name: string, args: Record<string, unknown>) => void
  /** Called when each tool finishes (success or error). */
  onToolEnd?: (name: string, durationMs: number, error?: string) => void
}

/**
 * Execute tool calls in parallel with a concurrency-limiting semaphore.
 *
 * Uses `Promise.allSettled` internally so partial failures never crash
 * the batch. Results are returned in the same order as the input `calls`
 * array regardless of completion order.
 *
 * @param calls - Tool call descriptors from the LLM response.
 * @param registry - Tool lookup (Map or similar) for resolving tool names.
 * @param opts - Concurrency and cancellation options.
 * @returns Results array in the same order as `calls`.
 */
export async function executeToolsParallel(
  calls: ParallelToolCall[],
  registry: ToolLookup,
  opts: ParallelExecutorOptions,
): Promise<ToolExecutionResult[]> {
  if (calls.length === 0) return []

  const maxConcurrency = Math.max(1, opts.maxConcurrency)

  // Semaphore: tracks how many slots are in use
  let running = 0
  const waiting: Array<() => void> = []

  function acquire(): Promise<void> {
    if (running < maxConcurrency) {
      running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }

  function release(): void {
    const next = waiting.shift()
    if (next) {
      // Hand the slot directly to the next waiter
      next()
    } else {
      running--
    }
  }

  async function executeOne(
    call: ParallelToolCall,
    index: number,
  ): Promise<ToolExecutionResult> {
    const toolCallId = call.id ?? `call_${Date.now()}_${index}`

    // Check for abort before acquiring semaphore
    if (opts.signal?.aborted) {
      return {
        toolName: call.name,
        toolCallId,
        error: 'Aborted',
        durationMs: 0,
        index,
      }
    }

    await acquire()

    // Check again after acquiring (may have waited)
    if (opts.signal?.aborted) {
      release()
      return {
        toolName: call.name,
        toolCallId,
        error: 'Aborted',
        durationMs: 0,
        index,
      }
    }

    const tool = registry.get(call.name)
    if (!tool) {
      release()
      const available = [...registry.keys()].join(', ')
      return {
        toolName: call.name,
        toolCallId,
        error: `Tool "${call.name}" not found. Available tools: ${available}`,
        durationMs: 0,
        index,
      }
    }

    opts.onToolStart?.(call.name, call.args)
    const startMs = performance.now()

    try {
      const rawResult = await tool.invoke(call.args)
      const durationMs = Math.round(performance.now() - startMs)
      const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
      opts.onToolEnd?.(call.name, durationMs)
      return { toolName: call.name, toolCallId, result, durationMs, index }
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startMs)
      const error = err instanceof Error ? err.message : String(err)
      opts.onToolEnd?.(call.name, durationMs, error)
      return { toolName: call.name, toolCallId, error, durationMs, index }
    } finally {
      release()
    }
  }

  // Launch all calls — the semaphore gates actual execution
  const settled = await Promise.allSettled(
    calls.map((call, index) => executeOne(call, index)),
  )

  // Collect results, preserving input order
  const results: ToolExecutionResult[] = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value)
    } else {
      // Should not happen since executeOne catches all errors, but be safe
      const call = calls[i]!
      results.push({
        toolName: call.name,
        toolCallId: call.id ?? `call_${Date.now()}_${i}`,
        error: String(outcome.reason),
        durationMs: 0,
        index: i,
      })
    }
  }

  // Sort by original index to guarantee order
  results.sort((a, b) => a.index - b.index)
  return results
}

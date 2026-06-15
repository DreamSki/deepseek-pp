import type { ToolCall, ToolExecutionRecord, ToolResult } from '../types';

export type ToolLoopExecuteTool = (call: ToolCall) => Promise<ToolExecutionRecord>;

export interface ExecuteToolCallsOptions {
  signal?: AbortSignal;
}

export async function executeToolCallsSequentially(
  calls: readonly ToolCall[],
  executeTool: ToolLoopExecuteTool,
  options?: ExecuteToolCallsOptions,
): Promise<ToolExecutionRecord[]> {
  const results: ToolExecutionRecord[] = [];
  for (const call of calls) {
    if (options?.signal?.aborted) break;
    results.push(await executeTool(call));
  }
  return results;
}

/**
 * Maximum number of subagent-level tool calls to run in parallel.
 * Beyond this we chunk batches to avoid API concurrency overload and
 * memory spikes that cause silent timeouts.
 */
const MAX_PARALLEL_SUBAGENTS = 4;

/**
 * Stagger between each parallel subagent start in milliseconds.
 * Prevents a thundering herd on createChatSession (4 simultaneous POSTs
 * trigger server-side rate limiting, causing ~2 of 4 to fail).
 * 300ms × 3 = 900ms overhead for 4 subagents, negligible vs 15-45s runtime.
 */
const SUBAGENT_STAGGER_MS = 300;

/**
 * Execute all tool calls in parallel. Use when the calls are known to be
 * independent (e.g. multiple spawn_subagent calls each in their own session).
 * Falls back to sequential if the calls might have side-effect dependencies.
 *
 * When more than MAX_PARALLEL_SUBAGENTS calls are in a batch, they are
 * executed in chunks to avoid overwhelming the API with concurrent sessions.
 *
 * Each subagent start is staggered by SUBAGENT_STAGGER_MS to avoid
 * server-side rate limits on chat session creation.
 */
export async function executeToolCallsInParallel(
  calls: readonly ToolCall[],
  executeTool: ToolLoopExecuteTool,
  options?: ExecuteToolCallsOptions,
): Promise<ToolExecutionRecord[]> {
  if (calls.length <= 1 || !canRunBatchInParallel(calls)) {
    return executeToolCallsSequentially(calls, executeTool, options);
  }

  // Chunk large batches to avoid API concurrency overload
  if (calls.length > MAX_PARALLEL_SUBAGENTS) {
    const results: ToolExecutionRecord[] = [];
    for (let i = 0; i < calls.length; i += MAX_PARALLEL_SUBAGENTS) {
      if (options?.signal?.aborted) break;
      const chunk = calls.slice(i, i + MAX_PARALLEL_SUBAGENTS);
      const chunkResults = await runParallelBatch(chunk, executeTool, options);
      results.push(...chunkResults);
    }
    return results;
  }

  return runParallelBatch(calls, executeTool, options);
}

async function runParallelBatch(
  calls: readonly ToolCall[],
  executeTool: ToolLoopExecuteTool,
  options?: ExecuteToolCallsOptions,
): Promise<ToolExecutionRecord[]> {
  const tasks = calls.map((call, i) => {
    if (options?.signal?.aborted) return Promise.resolve(null);

    // Stagger each task's start to avoid thundering herd on API endpoints.
    // Task 0 starts immediately, task 1 at +300ms, task 2 at +600ms, etc.
    const staggerMs = i * SUBAGENT_STAGGER_MS;
    const start = staggerMs > 0
      ? waitForDelay(staggerMs, options?.signal).then((shouldStart) =>
          shouldStart ? executeTool(call) : null,
        )
      : executeTool(call);

    return start.catch(
      (err): ToolExecutionRecord => ({
        name: call.name,
        provider: call.provider,
        descriptorId: call.descriptorId,
        result: {
          ok: false,
          summary: '并行执行异常',
          detail: err instanceof Error ? err.message : String(err),
          error: {
            code: 'parallel_execution_error',
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        },
      }),
    );
  });

  const settled = await Promise.all(tasks);
  return settled.filter((r): r is ToolExecutionRecord => r !== null);
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(true), delayMs);
    const onAbort = () => finish(false);

    function finish(shouldStart: boolean) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve(shouldStart);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Only subagents explicitly isolated in their own sessions are safe to run in
 * parallel. Other tools may mutate shared storage or depend on prior results.
 */
function canRunBatchInParallel(calls: readonly ToolCall[]): boolean {
  const allSubAgents = calls.every((c) => c.name === 'spawn_subagent');
  if (!allSubAgents) return false;

  const claimedFiles = new Set<string>();
  for (const call of calls) {
    const backupFiles = Array.isArray(call.payload.backupFiles)
      ? call.payload.backupFiles
      : [];
    for (const file of backupFiles) {
      if (typeof file !== 'string') continue;
      if (claimedFiles.has(file)) return false;
      claimedFiles.add(file);
    }
  }
  return true;
}

export interface ToolContinuationLoopInput<TTurn> {
  initialTurn: TTurn;
  /** Optional runtime-enforced calls for the first continuation step. */
  initialToolCalls?: ToolCall[];
  maxDepth: number;
  getAssistantText: (turn: TTurn) => string;
  getParentMessageId: (turn: TTurn) => number | null;
  extractToolCalls: (assistantText: string) => ToolCall[];
  executeToolCall: (call: ToolCall, parentMessageId: number) => Promise<ToolExecutionRecord>;
  buildContinuationPrompt: (executions: ToolExecutionRecord[]) => string;
  submitContinuation: (prompt: string, parentMessageId: number) => Promise<TTurn>;
}

export async function runToolContinuationLoop<TTurn>(
  input: ToolContinuationLoopInput<TTurn>,
): Promise<{ turn: TTurn; executions: ToolExecutionRecord[]; exhausted: boolean }> {
  let turn = input.initialTurn;
  let parentMessageId = input.getParentMessageId(turn);
  const executions: ToolExecutionRecord[] = [];

  for (let depth = 0; depth < input.maxDepth; depth++) {
    if (parentMessageId === null) break;

    const calls = depth === 0 && input.initialToolCalls
      ? input.initialToolCalls
      : input.extractToolCalls(input.getAssistantText(turn));
    if (calls.length === 0) break;

    const stepExecutions: ToolExecutionRecord[] = [];
    for (const call of calls) {
      const execution = await input.executeToolCall(call, parentMessageId);
      stepExecutions.push(execution);
      executions.push(execution);
    }

    turn = await input.submitContinuation(
      input.buildContinuationPrompt(stepExecutions),
      parentMessageId,
    );
    parentMessageId = input.getParentMessageId(turn);
  }

  const exhausted = parentMessageId !== null &&
    input.extractToolCalls(input.getAssistantText(turn)).length > 0;
  return { turn, executions, exhausted };
}

export function createToolExecutionRecord(
  call: ToolCall,
  result: ToolResult,
  limits: { detailMaxLength: number; outputMaxLength: number },
): ToolExecutionRecord {
  return {
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    result: {
      ok: result.ok,
      summary: result.summary,
      detail: clampText(result.detail, limits.detailMaxLength),
      output: result.output === undefined
        ? undefined
        : clampText(JSON.stringify(result.output), limits.outputMaxLength),
      truncated: result.truncated,
      error: result.error,
    },
  };
}

export function clampText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

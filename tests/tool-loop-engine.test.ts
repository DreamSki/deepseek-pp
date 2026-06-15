import { describe, expect, it } from 'vitest';
import {
  executeToolCallsInParallel,
  runToolContinuationLoop,
} from '../core/tool-loop/engine';
import type { ToolCall, ToolExecutionRecord } from '../core/types';

function subAgentCall(index: number): ToolCall {
  return {
    name: 'spawn_subagent',
    payload: { prompt: `task ${index}` },
    raw: '',
  };
}

function execution(call: ToolCall): ToolExecutionRecord {
  return {
    name: call.name,
    result: { ok: true, summary: 'done' },
  };
}

describe('executeToolCallsInParallel', () => {
  it('never runs more than four subagents concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    const promise = executeToolCallsInParallel(
      Array.from({ length: 6 }, (_, index) => subAgentCall(index)),
      async (call) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return execution(call);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(maxActive).toBe(4);
    expect(releases).toHaveLength(4);

    releases.splice(0, 4).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 400));
    releases.splice(0).forEach((release) => release());

    await expect(promise).resolves.toHaveLength(6);
  });

  it('does not start staggered calls after cancellation', async () => {
    const controller = new AbortController();
    const started: number[] = [];

    const promise = executeToolCallsInParallel(
      [subAgentCall(0), subAgentCall(1), subAgentCall(2)],
      async (call) => {
        started.push(Number(call.payload.prompt?.toString().split(' ')[1]));
        return execution(call);
      },
      { signal: controller.signal },
    );

    controller.abort();
    await promise;

    expect(started).toEqual([0]);
  });

  it('serializes subagents that declare the same backup file', async () => {
    let active = 0;
    let maxActive = 0;
    const calls = [subAgentCall(0), subAgentCall(1)];
    calls.forEach((call) => { call.payload.backupFiles = ['/tmp/shared.txt']; });

    await executeToolCallsInParallel(calls, async (call) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 500));
      active--;
      return execution(call);
    });

    expect(maxActive).toBe(1);
  });

  it('serializes non-subagent tool calls', async () => {
    let active = 0;
    let maxActive = 0;
    const calls: ToolCall[] = [
      { name: 'memory_update', payload: { id: 'a' }, raw: '' },
      { name: 'memory_update', payload: { id: 'b' }, raw: '' },
    ];

    await executeToolCallsInParallel(calls, async (call) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 400));
      active--;
      return execution(call);
    });

    expect(maxActive).toBe(1);
  });
});

describe('runToolContinuationLoop', () => {
  it('reports exhaustion when the final turn still contains tool calls', async () => {
    const result = await runToolContinuationLoop({
      initialTurn: { text: '<tool />', parentId: 1 },
      maxDepth: 1,
      getAssistantText: (turn) => turn.text,
      getParentMessageId: (turn) => turn.parentId,
      extractToolCalls: () => [subAgentCall(0)],
      executeToolCall: async (call) => execution(call),
      buildContinuationPrompt: () => 'continue',
      submitContinuation: async () => ({ text: '<tool />', parentId: 2 }),
    });

    expect(result.exhausted).toBe(true);
  });
});

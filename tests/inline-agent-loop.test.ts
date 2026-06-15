import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { extractTaskCompleteSignal, shouldNudge, submitPromptStreaming } = vi.hoisted(() => ({
  extractTaskCompleteSignal: vi.fn(),
  shouldNudge: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: vi.fn(() => ({})),
  createPowHeaders: vi.fn(async () => ({})),
  DeepSeekPayloadError: class DeepSeekPayloadError extends Error {},
  submitPromptStreaming,
}));

vi.mock('../core/inline-agent/prompt', () => ({
  buildContinuationPrompt: vi.fn(() => 'continue'),
  buildFinalizationPrompt: vi.fn(() => 'finish'),
  buildNudgePrompt: vi.fn(() => 'nudge'),
  extractTaskCompleteSignal,
  shouldNudge,
}));

import { runInlineAgentLoop } from '../core/inline-agent/loop';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';

describe('runInlineAgentLoop resume', () => {
  beforeEach(() => {
    extractTaskCompleteSignal.mockReset();
    extractTaskCompleteSignal.mockImplementation((text: string) =>
      text.includes('<task_complete') ? { summary: 'done', artifacts: [] } : null,
    );
    shouldNudge.mockReset();
    shouldNudge.mockReturnValue(false);
    submitPromptStreaming.mockReset();
    submitPromptStreaming.mockResolvedValue({
      assistantText: '<task_complete />',
      responseMessageId: 42,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues step numbering and totals from the persisted trace', async () => {
    const messages: Array<{ type: string; data: any }> = [];
    const payload: InlineAgentStartPayload = {
      loopId: 'loop-1',
      chatSessionId: 'chat-1',
      parentMessageId: 41,
      originalPrompt: 'finish the task',
      agentTaskPrompt: 'finish the task',
      toolExecutions: [],
      startingStepIndex: 3,
      promptOptions: {
        modelType: null,
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
      toolDescriptors: [],
    };

    await runInlineAgentLoop(payload, {
      post: (type, data) => messages.push({ type, data }),
      executeTool: vi.fn(),
      signal: new AbortController().signal,
    });

    expect(messages.find((message) => message.type === 'AGENT_STEP_STARTED')?.data.stepIndex).toBe(3);
    expect(messages.find((message) => message.type === 'AGENT_LOOP_COMPLETE')?.data.totalSteps).toBe(4);
  });

  it('does not request a redundant finalization after a visible answer is accepted', async () => {
    vi.useFakeTimers();
    submitPromptStreaming.mockResolvedValue({
      assistantText: '图片展示了一张带有坐标轴和折线的数据图。',
      responseMessageId: 43,
    });
    const messages: Array<{ type: string; data: any }> = [];
    const payload: InlineAgentStartPayload = {
      loopId: 'loop-vision',
      chatSessionId: 'chat-vision',
      parentMessageId: 42,
      originalPrompt: '识图 /private/tmp/chart.png',
      agentTaskPrompt: '识图 /private/tmp/chart.png',
      toolExecutions: [{
        name: 'shell_read_image',
        result: { ok: true, summary: '图片已上传' },
      }],
      promptOptions: {
        modelType: 'vision',
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: ['file-image'],
      },
      toolDescriptors: [],
    };

    const run = runInlineAgentLoop(payload, {
      post: (type, data) => messages.push({ type, data }),
      executeTool: vi.fn(),
      signal: new AbortController().signal,
    });
    await vi.runAllTimersAsync();
    await run;

    expect(submitPromptStreaming).toHaveBeenCalledTimes(1);
    expect(messages.find((message) => message.type === 'AGENT_LOOP_COMPLETE')?.data.finalText)
      .toBe('图片展示了一张带有坐标轴和折线的数据图。');
  });
});

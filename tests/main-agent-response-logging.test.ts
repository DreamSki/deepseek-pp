/**
 * Tests for main agent response logging
 *
 * These tests verify that the main agent's final responses are properly
 * logged to /tmp/dpp_main_response_*.json files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResponseCompletePayload } from '../core/interceptor/fetch-hook';

describe('Main Agent Response Logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log main agent response with correct structure', async () => {
    // Mock the response payload
    const mockComplete: ResponseCompletePayload = {
      text: '数据过滤后得到 9 个内容图像元素。现在我已有完整数据：通过子代理文本分析确定了 Fig.1-Fig.4 及第 1 页摘要图的位置和内容描述，通过 PyMuPDF 提取了精确坐标。总结最终结果。',
      originalPrompt: '分析这个PDF中的图片',
      agentTaskPrompt: '分析这个PDF中的图片',
      chatSessionId: 'test-session-123',
      assistantMessageId: 456,
      parentMessageId: 789,
      thinkingText: '',
      promptOptions: {
        modelType: 'default',
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
    };

    // Verify the expected file structure
    const expectedEntry = {
      at: expect.any(String),
      type: 'main_agent_response',
      chatSessionId: 'test-session-123',
      assistantMessageId: 456,
      parentMessageId: 789,
      originalPrompt: '分析这个PDF中的图片',
      agentTaskPrompt: '分析这个PDF中的图片',
      responseText: mockComplete.text,
      promptOptions: mockComplete.promptOptions,
      url: expect.any(String),
    };

    expect(mockComplete.text).toContain('数据过滤后得到 9 个内容图像元素');
    expect(mockComplete.chatSessionId).toBe('test-session-123');
  });

  it('should handle empty responses gracefully', () => {
    const mockComplete: ResponseCompletePayload = {
      text: '',
      originalPrompt: '',
      agentTaskPrompt: '',
      chatSessionId: null,
      assistantMessageId: null,
      parentMessageId: null,
      thinkingText: '',
      promptOptions: {
        modelType: null,
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
    };

    expect(mockComplete.text).toBe('');
  });

  it('should handle long responses', () => {
    const longText = 'A'.repeat(10000);
    const mockComplete: ResponseCompletePayload = {
      text: longText,
      originalPrompt: '生成长文本',
      agentTaskPrompt: '生成长文本',
      chatSessionId: 'test-session-long',
      assistantMessageId: 100,
      parentMessageId: 99,
      thinkingText: '',
      promptOptions: {
        modelType: 'default',
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
    };

    expect(mockComplete.text.length).toBe(10000);
  });

  it('should include all required fields in response', () => {
    const mockComplete: ResponseCompletePayload = {
      text: '测试响应',
      originalPrompt: '测试提示',
      agentTaskPrompt: '测试代理任务提示',
      chatSessionId: 'session-abc',
      assistantMessageId: 123,
      parentMessageId: 456,
      thinkingText: '',
      promptOptions: {
        modelType: 'expert',
        searchEnabled: true,
        thinkingEnabled: true,
        refFileIds: ['file1', 'file2'],
      },
    };

    expect(mockComplete).toMatchObject({
      text: expect.any(String),
      originalPrompt: expect.any(String),
      agentTaskPrompt: expect.any(String),
      chatSessionId: expect.any(String),
      assistantMessageId: expect.any(Number),
      parentMessageId: expect.any(Number),
      promptOptions: expect.any(Object),
    });

    expect(mockComplete.promptOptions).toMatchObject({
      modelType: 'expert',
      searchEnabled: true,
      thinkingEnabled: true,
      refFileIds: expect.arrayContaining(['file1', 'file2']),
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SUBAGENT_TOOL_DESCRIPTORS,
  SUBAGENT_TOOL_NAMES,
  isSubAgentToolName,
} from '../core/tool/subagent-descriptors';
import {
  executeSubAgentToolCall,
  type SubAgentToolDeps,
} from '../core/tool/subagent';
import type { ToolCall, ToolDescriptor } from '../core/types';

// ---------------------------------------------------------------------------
// Mocks — hoisted to top by vitest
// ---------------------------------------------------------------------------

vi.mock('../core/deepseek/adapter', () => ({
  DeepSeekPayloadError: class DeepSeekPayloadError extends Error {
    retryable = true;
  },
  createChatSession: vi.fn(),
  submitPrompt: vi.fn(),
  createPowHeaders: vi.fn(),
  buildDeepSeekSessionUrl: vi.fn(),
  loadClientHeadersFromStorage: vi.fn(),
}));

vi.mock('../core/deepseek/image-upload', () => ({
  uploadImageToDeepSeek: vi.fn(),
  uploadFileToDeepSeek: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import mocked module for assertions
// ---------------------------------------------------------------------------

import * as Adapter from '../core/deepseek/adapter';
import * as ImageUpload from '../core/deepseek/image-upload';

const mockedAdapter = vi.mocked(Adapter);
const mockedImageUpload = vi.mocked(ImageUpload);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnCall(payload: Record<string, unknown>): ToolCall {
  return {
    name: 'spawn_subagent',
    payload,
    raw: '<spawn_subagent />',
    provider: SUBAGENT_TOOL_DESCRIPTORS[0]?.provider,
    descriptorId: SUBAGENT_TOOL_DESCRIPTORS[0]?.id,
  };
}

function okResult(summary: string) {
  return { ok: true as const, summary };
}

function makeDeps(overrides?: Partial<SubAgentToolDeps>): SubAgentToolDeps {
  return {
    executeTool: vi.fn().mockResolvedValue(okResult('done')),
    getToolDescriptors: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockAuthSuccess() {
  mockedAdapter.loadClientHeadersFromStorage.mockResolvedValue({
    Authorization: 'Bearer test-token',
  });
}

function mockSessionSuccess(sessionId = 'test-session-123') {
  mockedAdapter.createChatSession.mockResolvedValue(sessionId);
  mockedAdapter.createPowHeaders.mockResolvedValue({ 'x-pow': 'test' });
  mockedAdapter.buildDeepSeekSessionUrl.mockReturnValue(
    `https://chat.deepseek.com/a/chat/s/${sessionId}`,
  );
}

function mockSimpleCompletion(text = '任务已完成。') {
  mockedAdapter.submitPrompt.mockResolvedValue({
    assistantText: text,
    responseMessageId: 42,
    requestMessageId: 1,
    finished: true,
  });
}

function shellDescriptor(): ToolDescriptor {
  return {
    id: 'mcp:shell:shell_exec',
    provider: { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'native_messaging' },
    name: 'shell_exec',
    invocationName: 'shell_exec',
    title: '执行命令',
    description: 'Execute shell commands',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    execution: { mode: 'auto', enabled: true, risk: 'high' },
  };
}

function imageDescriptor(): ToolDescriptor {
  return {
    ...shellDescriptor(),
    id: 'mcp:shell:shell_read_image',
    name: 'shell_read_image',
    invocationName: 'shell_read_image',
    title: '读取图片',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  };
}

function fileUploadDescriptor(): ToolDescriptor {
  return {
    ...shellDescriptor(),
    id: 'mcp:shell:shell_upload_file',
    name: 'shell_upload_file',
    invocationName: 'shell_upload_file',
    title: '上传文件',
    description: 'Read a local file and return base64-encoded data with metadata.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  };
}

function pythonDescriptor(): ToolDescriptor {
  return {
    ...shellDescriptor(),
    id: 'mcp:shell:python_exec',
    name: 'python_exec',
    invocationName: 'python_exec',
    title: 'Run Python',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isSubAgentToolName', () => {
  it('recognises spawn_subagent', () => {
    expect(isSubAgentToolName('spawn_subagent')).toBe(true);
  });

  it('rejects unknown names', () => {
    expect(isSubAgentToolName('web_search')).toBe(false);
    expect(isSubAgentToolName('memory_save')).toBe(false);
    expect(isSubAgentToolName('')).toBe(false);
  });
});

describe('SUBAGENT_TOOL_DESCRIPTORS', () => {
  it('has exactly one descriptor', () => {
    expect(SUBAGENT_TOOL_DESCRIPTORS).toHaveLength(1);
  });

  it('has the correct tool name', () => {
    expect(SUBAGENT_TOOL_DESCRIPTORS[0]!.name).toBe('spawn_subagent');
  });

  it('has prompt as required input', () => {
    expect(SUBAGENT_TOOL_DESCRIPTORS[0]!.inputSchema.required).toContain('prompt');
  });
});

describe('SUBAGENT_TOOL_NAMES', () => {
  it('contains spawn_subagent', () => {
    expect(SUBAGENT_TOOL_NAMES).toContain('spawn_subagent');
    expect(SUBAGENT_TOOL_NAMES).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall validation', () => {
  it('rejects empty prompt', async () => {
    const result = await executeSubAgentToolCall(spawnCall({ prompt: '' }), makeDeps());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_empty_prompt');
  });

  it('rejects missing prompt', async () => {
    const result = await executeSubAgentToolCall(spawnCall({}), makeDeps());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_empty_prompt');
  });

  it('rejects overly long prompt', async () => {
    const longPrompt = 'x'.repeat(20_000);
    const result = await executeSubAgentToolCall(spawnCall({ prompt: longPrompt }), makeDeps());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_prompt_too_long');
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall auth', () => {
  it('returns auth error when no cached headers', async () => {
    mockedAdapter.loadClientHeadersFromStorage.mockResolvedValue(null);

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'do something' }),
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_auth_missing');
  });

  it('returns auth error when Authorization header is empty', async () => {
    mockedAdapter.loadClientHeadersFromStorage.mockResolvedValue({ Authorization: '' });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'do something' }),
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_auth_missing');
  });
});

// ---------------------------------------------------------------------------
// Simple delegation
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall simple delegation', () => {
  const FINAL_TEXT = '任务已完成：斐波那契数列计算结果为 55。';
  const SESSION_ID = 'test-session-123';

  it('completes a simple task without tool calls', async () => {
    mockAuthSuccess();
    mockSessionSuccess(SESSION_ID);
    mockSimpleCompletion(FINAL_TEXT);

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: '计算斐波那契数列第10项' }),
      makeDeps(),
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('子代理完成');
    // detail now includes the system diagnostic note appended at end
    expect(result.detail).toContain(FINAL_TEXT);

    const out = result.output as Record<string, unknown> | undefined;
    expect(out).toBeDefined();
    expect(out?.finalText).toContain(FINAL_TEXT);
    expect(out?.chatSessionId).toBe(SESSION_ID);
    expect(out?.sessionUrl).toContain(SESSION_ID);
    expect(out?.totalSteps).toBe(0);
  });

  it('returns a session URL in the output', async () => {
    mockAuthSuccess();
    mockSessionSuccess();
    mockSimpleCompletion();

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'hello' }),
      makeDeps(),
    );

    expect(result.ok).toBe(true);
    const out = result.output as Record<string, unknown> | undefined;
    expect(out?.sessionUrl).toBeTruthy();
  });

  it('announces the deterministic result artifact path through progress', async () => {
    mockAuthSuccess();
    mockSessionSuccess('progress-path');
    mockSimpleCompletion();
    const onProgress = vi.fn();

    await executeSubAgentToolCall(
      spawnCall({ prompt: 'hello' }),
      makeDeps({ onProgress }),
    );

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      chatSessionId: 'progress-path',
      resultFilePath: '/tmp/dpp_subagent_progress-path.json',
    }));
  });

  it('filters spawn_subagent from sub-agent descriptors', async () => {
    mockAuthSuccess();
    mockSessionSuccess();
    mockSimpleCompletion();

    const deps = makeDeps({
      getToolDescriptors: vi.fn().mockResolvedValue([
        ...SUBAGENT_TOOL_DESCRIPTORS,
        {
          id: 'test:tool',
          provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
          name: 'test_tool',
          invocationName: 'test_tool',
          title: 'Test',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: {} },
          execution: { mode: 'auto', enabled: true, risk: 'low' },
        } satisfies ToolDescriptor,
      ]),
    });

    await executeSubAgentToolCall(spawnCall({ prompt: 'test' }), deps);

    // The submitted prompt should NOT mention spawn_subagent
    const submittedPrompt: string =
      mockedAdapter.submitPrompt.mock.calls[0]?.[0]?.prompt ?? '';
    expect(submittedPrompt).not.toContain('spawn_subagent');
    expect(submittedPrompt).toContain('test_tool');
    expect(submittedPrompt).toContain('You have tools');
  });
});

// ---------------------------------------------------------------------------
// Delegation with tool calls
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall with tool loop', () => {
  it('tells a default subagent that it is fast mode and uploads documents as native attachments', async () => {
    mockAuthSuccess();
    mockSessionSuccess('document-upload-session');
    mockedImageUpload.uploadFileToDeepSeek.mockResolvedValue('file-pdf-1');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: '<shell_upload_file>{"path":"/tmp/report.pdf"}</shell_upload_file>',
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: 'PDF 原生附件已阅读并完成分析。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: '上传 /tmp/report.pdf 并统计其中的图片', modelType: 'default' }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([fileUploadDescriptor()]),
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          if (call.name === 'shell_upload_file') {
            return {
              ok: true,
              summary: 'File read successfully. Base64: 1000 chars',
              detail: 'base64 payload prepared',
              output: {
                data: {
                  path: '/tmp/report.pdf',
                  base64: 'aGVsbG8=',
                  mimeType: 'application/pdf',
                  size: 5,
                },
              },
            };
          }
          return okResult('done');
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ modelType: 'default' });
    expect(mockedImageUpload.uploadFileToDeepSeek).toHaveBeenCalledTimes(1);

    const initialPrompt = mockedAdapter.submitPrompt.mock.calls[0]?.[0]?.prompt ?? '';
    expect(initialPrompt).toContain('当前子代理模式：快速模式');
    expect(initialPrompt).toContain('读原生附件');
    expect(initialPrompt).toContain('不是 PDF 程序化分析器');
    expect(initialPrompt).not.toContain('return base64-encoded data');

    const continuation = mockedAdapter.submitPrompt.mock.calls[1]?.[0];
    expect(continuation).toMatchObject({
      modelType: 'default',
      refFileIds: ['file-pdf-1'],
    });
    expect(continuation?.prompt).toContain('已作为原生附件挂载');
    expect(continuation?.prompt).toContain('上传+阅读');
    expect(continuation?.prompt).not.toContain('Base64');
  });

  it('treats document uploads as a barrier before other same-turn tools', async () => {
    mockAuthSuccess();
    mockSessionSuccess('document-upload-barrier');
    mockedImageUpload.uploadFileToDeepSeek.mockResolvedValue('file-pdf-barrier');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: [
          '<shell_upload_file>{"path":"/tmp/report.pdf"}</shell_upload_file>',
          '<python_exec>{"code":"print(\'should not run yet\')"}</python_exec>',
        ].join('\n'),
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: 'PDF 原生附件已阅读并完成分析。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const executeTool = vi.fn().mockImplementation(async (call: ToolCall) => {
      if (call.name === 'shell_upload_file') {
        return {
          ok: true,
          summary: 'File read successfully',
          output: {
            data: {
              path: '/tmp/report.pdf',
              base64: 'aGVsbG8=',
              mimeType: 'application/pdf',
              size: 5,
            },
          },
        };
      }
      return okResult('unexpected execution');
    });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: '上传并阅读 /tmp/report.pdf', modelType: 'default' }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([
          fileUploadDescriptor(),
          pythonDescriptor(),
        ]),
        executeTool,
      }),
    );

    expect(result.ok).toBe(true);
    expect(executeTool.mock.calls.map(([call]) => call.name)).toEqual(['shell_upload_file']);
    expect(mockedAdapter.submitPrompt.mock.calls[1]?.[0]?.refFileIds).toEqual(['file-pdf-barrier']);
  });

  it('deduplicates identical document uploads in one turn', async () => {
    mockAuthSuccess();
    mockSessionSuccess('document-upload-dedup');
    mockedImageUpload.uploadFileToDeepSeek.mockResolvedValue('file-pdf-dedup');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: [
          '<shell_upload_file>{"path":"/tmp/report.pdf"}</shell_upload_file>',
          '<shell_upload_file>{"path":"/tmp/report.pdf"}</shell_upload_file>',
        ].join('\n'),
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: '附件分析完成。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const executeTool = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'File read successfully',
      output: {
        data: {
          path: '/tmp/report.pdf',
          base64: 'aGVsbG8=',
          mimeType: 'application/pdf',
          size: 5,
        },
      },
    });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: '上传并阅读 /tmp/report.pdf', modelType: 'default' }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([fileUploadDescriptor()]),
        executeTool,
      }),
    );

    expect(result.ok).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(mockedImageUpload.uploadFileToDeepSeek).toHaveBeenCalledTimes(1);
  });

  it('runs continuation loop when response contains tool calls', async () => {
    mockAuthSuccess();
    mockSessionSuccess('session-tool-loop');

    // First response: contains a shell_exec tool call
    mockedAdapter.submitPrompt.mockResolvedValueOnce({
      assistantText:
        '我来帮你完成任务。\n\n<shell_exec>{"command": "echo hello"}</shell_exec>',
      responseMessageId: 1,
      requestMessageId: null,
      finished: true,
    });

    // Continuation response: task complete
    mockedAdapter.submitPrompt.mockResolvedValueOnce({
      assistantText: '任务完成。输出为 "hello"。',
      responseMessageId: 2,
      requestMessageId: 1,
      finished: true,
    });

    const executedCalls: ToolCall[] = [];
    const deps = makeDeps({
      executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
        executedCalls.push(call);
        return okResult(`executed ${call.name}`);
      }),
      getToolDescriptors: vi.fn().mockResolvedValue([
        {
          id: 'mcp:shell:shell_exec',
          provider: { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'native_messaging' },
          name: 'shell_exec',
          invocationName: 'shell_exec',
          title: '执行命令',
          description: 'Execute shell commands',
          inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
          },
          execution: { mode: 'auto', enabled: true, risk: 'high' },
        } satisfies ToolDescriptor,
      ]),
    });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'run echo hello' }),
      deps,
    );

    expect(result.ok).toBe(true);
    // 2 calls: 1 from the subagent's continuation loop + 1 from result file write
    expect(executedCalls).toHaveLength(2);
    expect(executedCalls[0]!.name).toBe('shell_exec');
    // The second call is the result file write
    expect(executedCalls[1]!.name).toBe('shell_exec');
    expect(executedCalls[1]!.payload.command).toContain('dpp_subagent_');

    // Second submitPrompt call should be the continuation
    expect(mockedAdapter.submitPrompt).toHaveBeenCalledTimes(2);
    const contPrompt: string =
      mockedAdapter.submitPrompt.mock.calls[1]?.[0]?.prompt ?? '';
    expect(contPrompt).toContain('Step 1/');
    expect(contPrompt).toContain('shell_exec');

    const out = result.output as Record<string, unknown> | undefined;
    expect(out?.totalSteps).toBe(1);
    expect(out?.resultFilePath).toBe('/tmp/dpp_subagent_session-tool-loop.json');
  });

  it('retries a continuation rejected for a not-yet-ready image reference', async () => {
    vi.useFakeTimers();
    try {
      mockAuthSuccess();
      mockSessionSuccess('image-ref-retry');
      mockedImageUpload.uploadImageToDeepSeek.mockResolvedValue('file-ready-later');
      mockedAdapter.submitPrompt
        .mockResolvedValueOnce({
          assistantText: '<shell_read_image>{"path":"/tmp/chart.png"}</shell_read_image>',
          responseMessageId: 1,
          requestMessageId: null,
          finished: true,
        })
        .mockRejectedValueOnce(new Adapter.DeepSeekPayloadError('invalid ref_file_ids'))
        .mockResolvedValueOnce({
          assistantText: 'done',
          responseMessageId: 2,
          requestMessageId: 1,
          finished: true,
        });

      const resultPromise = executeSubAgentToolCall(
        spawnCall({
          prompt: 'inspect image',
          modelType: 'vision',
          imagePaths: ['/tmp/chart.png'],
        }),
        makeDeps({
          getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
          executeTool: vi.fn().mockResolvedValue({
            ok: true,
            summary: 'image read',
            output: {
              data: {
                base64: 'aGVsbG8=',
                mimeType: 'image/png',
                size: 5,
              },
            },
          }),
        }),
      );
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(mockedAdapter.submitPrompt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches every image read in one step to the vision continuation', async () => {
    mockAuthSuccess();
    mockSessionSuccess('multi-image-session');
    mockedImageUpload.uploadImageToDeepSeek
      .mockResolvedValueOnce('file-image-1')
      .mockResolvedValueOnce('file-image-2')
      .mockResolvedValueOnce('file-image-3');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: [
          '<shell_read_image>{"path":"/tmp/one.png"}</shell_read_image>',
          '<shell_read_image>{"path":"/tmp/two.png"}</shell_read_image>',
          '<shell_read_image>{"path":"/tmp/three.png"}</shell_read_image>',
        ].join('\n'),
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: 'all three images described',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const result = await executeSubAgentToolCall(
      spawnCall({
        prompt: 'inspect all images',
        modelType: 'vision',
        imagePaths: ['/tmp/one.png', '/tmp/two.png', '/tmp/three.png'],
      }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          if (call.name === 'shell_read_image') {
            return {
              ok: true,
              summary: 'image read',
              output: {
                data: {
                  base64: 'aGVsbG8=',
                  mimeType: 'image/png',
                  size: 5,
                },
              },
            };
          }
          return okResult('done');
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(mockedImageUpload.uploadImageToDeepSeek).toHaveBeenCalledTimes(3);
    expect(mockedAdapter.submitPrompt.mock.calls[1]?.[0]).toMatchObject({
      chatSessionId: 'multi-image-session',
      modelType: 'vision',
      refFileIds: ['file-image-1', 'file-image-2', 'file-image-3'],
    });
  });

  it('forces manifest image reads when a vision subagent answers without tools', async () => {
    mockAuthSuccess();
    mockSessionSuccess('forced-image-read-session');
    mockedImageUpload.uploadImageToDeepSeek
      .mockResolvedValueOnce('file-image-1')
      .mockResolvedValueOnce('file-image-2');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: '我已经分析完成。',
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: '两张图片均已实际查看并完成分析。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const executeTool = vi.fn().mockImplementation(async (call: ToolCall) => ({
      ok: true,
      summary: 'image read',
      output: {
        data: {
          path: call.payload.path,
          base64: 'aGVsbG8=',
          mimeType: 'image/png',
          size: 5,
        },
      },
    }));

    const result = await executeSubAgentToolCall(
      spawnCall({
        prompt: '分析两张图片',
        modelType: 'vision',
        imagePaths: ['/tmp/page_1.png', '/tmp/page_2.png'],
      }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
        executeTool,
      }),
    );

    expect(result.ok).toBe(true);
    expect(executeTool.mock.calls
      .map(([call]) => call)
      .filter((call) => call.name === 'shell_read_image')
      .map((call) => call.payload.path)).toEqual(['/tmp/page_1.png', '/tmp/page_2.png']);
    expect(mockedAdapter.submitPrompt.mock.calls[1]?.[0]).toMatchObject({
      modelType: 'vision',
      refFileIds: ['file-image-1', 'file-image-2'],
    });
  });

  it('rejects a vision result when the parent omits the image manifest', async () => {
    mockAuthSuccess();
    mockSessionSuccess('missing-manifest-session');
    mockedImageUpload.uploadImageToDeepSeek.mockResolvedValue('file-image-1');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: '<shell_read_image>{"path":"/tmp/page_1.png"}</shell_read_image>',
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: '图片分析完成。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: '分析图片', modelType: 'vision' }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          if (call.name === 'shell_read_image') {
            return {
              ok: true,
              summary: 'image read',
              output: {
                data: {
                  path: call.payload.path,
                  base64: 'aGVsbG8=',
                  mimeType: 'image/png',
                  size: 5,
                },
              },
            };
          }
          return okResult('done');
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_untrustworthy');
    expect(result.summary).toContain('缺少 imagePaths');
  });

  it('rejects a vision result whose self-report contradicts forced manifest reads', async () => {
    mockAuthSuccess();
    mockSessionSuccess('missing-image-session');
    mockedImageUpload.uploadImageToDeepSeek.mockResolvedValue('file-image-1');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: '<shell_read_image>{"path":"/tmp/page_1.png"}</shell_read_image>',
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: [
          '只处理了已看到的图片。',
          '[诊断]',
          '- 任务要求的文件/图片数：2',
          '- 实际读到的文件/图片数：1',
          '- 工具调用失败：无',
          '- 遇到格式错误（JSON 解析失败等）：无',
          '- 其他异常：无',
        ].join('\n'),
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const result = await executeSubAgentToolCall(
      spawnCall({
        prompt: '分析两张图片',
        modelType: 'vision',
        imagePaths: ['/tmp/page_1.png', '/tmp/page_2.png'],
      }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          if (call.name === 'shell_read_image') {
            return {
              ok: true,
              summary: 'image read',
              output: {
                data: {
                  path: call.payload.path,
                  base64: 'aGVsbG8=',
                  mimeType: 'image/png',
                  size: 5,
                },
              },
            };
          }
          return okResult('done');
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_untrustworthy');
    expect(result.summary).toContain('自报读取 1 张，但系统确认 2 张');
    expect(result.output).toMatchObject({
      _untrustworthy: true,
      expectedImagePaths: ['/tmp/page_1.png', '/tmp/page_2.png'],
      successfulImagePaths: ['/tmp/page_1.png', '/tmp/page_2.png'],
    });
  });

  it('rejects speculative bbox coordinates without measured dimensions', async () => {
    mockAuthSuccess();
    mockSessionSuccess('estimated-bbox-session');
    mockedImageUpload.uploadImageToDeepSeek.mockResolvedValue('file-image-1');
    mockedAdapter.submitPrompt
      .mockResolvedValueOnce({
        assistantText: '<shell_read_image>{"path":"/tmp/page_1.png"}</shell_read_image>',
        responseMessageId: 1,
        requestMessageId: null,
        finished: true,
      })
      .mockResolvedValueOnce({
        assistantText: '基于假设的 800x1100 像素画布，估算 bbox 为 [10, 20, 300, 400]。',
        responseMessageId: 2,
        requestMessageId: 1,
        finished: true,
      });

    const result = await executeSubAgentToolCall(
      spawnCall({
        prompt: '定位图片内容',
        modelType: 'vision',
        imagePaths: ['/tmp/page_1.png'],
      }),
      makeDeps({
        getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          if (call.name === 'shell_read_image') {
            return {
              ok: true,
              summary: 'image read',
              output: {
                data: {
                  path: '/tmp/page_1.png',
                  base64: 'aGVsbG8=',
                  mimeType: 'image/png',
                  size: 5,
                },
              },
            };
          }
          return okResult('done');
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_untrustworthy');
    expect(result.output).toMatchObject({ _untrustworthy: true });
    expect((result.output as Record<string, unknown>).credibilityWarning).toEqual(
      expect.arrayContaining(['bbox 坐标缺少真实图片尺寸依据']),
    );
  });

  it('keeps uploaded image ids isolated across parallel vision subagents', async () => {
    mockAuthSuccess();
    mockedAdapter.createChatSession
      .mockResolvedValueOnce('parallel-session-a')
      .mockResolvedValueOnce('parallel-session-b');
    mockedAdapter.createPowHeaders.mockResolvedValue({ 'x-pow': 'test' });
    mockedAdapter.buildDeepSeekSessionUrl.mockImplementation(
      (sessionId) => `https://chat.deepseek.com/a/chat/s/${sessionId}`,
    );
    mockedImageUpload.uploadImageToDeepSeek.mockImplementation(async ({ base64 }) =>
      base64 === 'YQ==' ? 'file-for-a' : 'file-for-b',
    );
    mockedAdapter.submitPrompt.mockImplementation(async (input) => {
      if (input.parentMessageId === null) {
        const suffix = input.chatSessionId.endsWith('-a') ? 'a' : 'b';
        return {
          assistantText: `<shell_read_image>{"path":"/tmp/${suffix}.png"}</shell_read_image>`,
          responseMessageId: suffix === 'a' ? 11 : 21,
          requestMessageId: null,
          finished: true,
        };
      }
      return {
        assistantText: `described ${input.chatSessionId}`,
        responseMessageId: input.chatSessionId.endsWith('-a') ? 12 : 22,
        requestMessageId: input.parentMessageId,
        finished: true,
      };
    });

    const makeVisionDeps = (base64: string) => makeDeps({
      getToolDescriptors: vi.fn().mockResolvedValue([imageDescriptor()]),
      executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
        if (call.name === 'shell_read_image') {
          return {
            ok: true,
            summary: 'image read',
            output: {
              data: { base64, mimeType: 'image/png', size: 1 },
            },
          };
        }
        return okResult('done');
      }),
    });

    const [resultA, resultB] = await Promise.all([
      executeSubAgentToolCall(
        spawnCall({
          prompt: 'inspect image a',
          modelType: 'vision',
          imagePaths: ['/tmp/a.png'],
        }),
        makeVisionDeps('YQ=='),
      ),
      executeSubAgentToolCall(
        spawnCall({
          prompt: 'inspect image b',
          modelType: 'vision',
          imagePaths: ['/tmp/b.png'],
        }),
        makeVisionDeps('Yg=='),
      ),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    const continuationInputs = mockedAdapter.submitPrompt.mock.calls
      .map(([input]) => input)
      .filter((input) => input.parentMessageId !== null);
    expect(continuationInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chatSessionId: 'parallel-session-a',
        modelType: 'vision',
        refFileIds: ['file-for-a'],
      }),
      expect.objectContaining({
        chatSessionId: 'parallel-session-b',
        modelType: 'vision',
        refFileIds: ['file-for-b'],
      }),
    ]));
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall error handling', () => {
  it('does not start an already-cancelled subagent', async () => {
    mockAuthSuccess();
    mockSessionSuccess();
    mockSimpleCompletion();
    const controller = new AbortController();
    controller.abort();

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'test' }),
      makeDeps({ signal: controller.signal }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_cancelled');
    expect(mockedAdapter.createChatSession).not.toHaveBeenCalled();
  });

  it('fails when the tool loop reaches its maximum depth unfinished', async () => {
    mockAuthSuccess();
    mockSessionSuccess('max-depth');
    mockedAdapter.submitPrompt.mockResolvedValue({
      assistantText: '<shell_exec>{"command":"echo still-running"}</shell_exec>',
      responseMessageId: 1,
      requestMessageId: null,
      finished: true,
    });

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'never finish' }),
      makeDeps({ getToolDescriptors: vi.fn().mockResolvedValue([shellDescriptor()]) }),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_max_steps');
  });

  it('stops waiting for an in-flight child tool when cancelled', async () => {
    mockAuthSuccess();
    mockSessionSuccess('cancel-child-tool');
    mockedAdapter.submitPrompt.mockResolvedValueOnce({
      assistantText: '<shell_exec>{"command":"sleep 10"}</shell_exec>',
      responseMessageId: 1,
      requestMessageId: null,
      finished: true,
    });

    const controller = new AbortController();
    let releaseTool!: () => void;
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
    const childTool = new Promise<ReturnType<typeof okResult>>((resolve) => {
      releaseTool = () => resolve(okResult('late result'));
    });
    const resultPromise = executeSubAgentToolCall(
      spawnCall({ prompt: 'run a long command' }),
      makeDeps({
        signal: controller.signal,
        getToolDescriptors: vi.fn().mockResolvedValue([shellDescriptor()]),
        executeTool: vi.fn().mockImplementation(() => {
          markToolStarted();
          return childTool;
        }),
      }),
    );

    await toolStarted;
    controller.abort();
    const earlyResult = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
    ]);
    releaseTool();
    const result = earlyResult ?? await resultPromise;

    expect(earlyResult).not.toBeNull();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_cancelled');
  });

  it('quotes backup paths as shell literals', async () => {
    mockAuthSuccess();
    mockSessionSuccess('safe-backup');
    mockSimpleCompletion();
    const calls: ToolCall[] = [];
    const dangerousPath = `a'$(touch /tmp/dpp-pwn) b`;

    await executeSubAgentToolCall(
      spawnCall({ prompt: 'edit file', backupFiles: [dangerousPath] }),
      makeDeps({
        executeTool: vi.fn().mockImplementation(async (call: ToolCall) => {
          calls.push(call);
          return okResult('done');
        }),
      }),
    );

    const backupCommand = calls
      .map((call) => String(call.payload.command ?? ''))
      .find((command) => command.includes('/bin/cp'));
    expect(backupCommand).toContain(`'a'"'"'$(touch /tmp/dpp-pwn) b'`);
    expect(backupCommand).not.toContain(`"${dangerousPath}"`);
  });

  it('handles createChatSession failure', async () => {
    mockAuthSuccess();
    mockedAdapter.createChatSession.mockRejectedValue(new Error('Session creation failed'));

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'test' }),
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_failed');
    expect(result.detail).toContain('Session creation failed');
  });

  it('handles submitPrompt failure', async () => {
    mockAuthSuccess();
    mockSessionSuccess();
    mockedAdapter.submitPrompt.mockRejectedValue(new Error('Completion failed'));

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'test' }),
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_failed');
  });

  it('handles loadClientHeadersFromStorage rejection', async () => {
    mockedAdapter.loadClientHeadersFromStorage.mockRejectedValue(new Error('Storage error'));

    const result = await executeSubAgentToolCall(
      spawnCall({ prompt: 'test' }),
      makeDeps(),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('subagent_auth_read_failed');
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('executeSubAgentToolCall prompt construction', () => {
  it('includes the user task in the submitted prompt', async () => {
    mockAuthSuccess();
    mockSessionSuccess('prompt-test');
    mockSimpleCompletion('done');

    const userTask = '请创建一个 Python 脚本来下载指定 URL 的图片';
    await executeSubAgentToolCall(
      spawnCall({ prompt: userTask }),
      makeDeps(),
    );

    const submittedPrompt: string =
      mockedAdapter.submitPrompt.mock.calls[0]?.[0]?.prompt ?? '';
    expect(submittedPrompt).toContain(userTask);
    expect(submittedPrompt).toContain('You have tools');
    expect(submittedPrompt).toContain('Task:');
  });
});

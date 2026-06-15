import { describe, expect, it } from 'vitest';
import { buildToolCallLogEntry } from '../core/utils/tool-call-log';
import type { ToolCall, ToolResult } from '../core/types';

describe('buildToolCallLogEntry', () => {
  it('keeps structured failure details instead of only an ok flag and summary', () => {
    const call: ToolCall = {
      name: 'shell_exec',
      payload: {
        command: 'python -c "print(1)"',
        Authorization: 'Bearer secret',
      },
      raw: '',
    };
    const result: ToolResult = {
      ok: false,
      summary: 'MCP 工具返回错误',
      detail: 'native host exited before returning JSON-RPC response',
      durationMs: 1234,
      error: {
        code: 'mcp_transport_error',
        message: 'connection closed unexpectedly',
        retryable: true,
        details: { phase: 'execute' },
      },
    };

    const entry = buildToolCallLogEntry(
      call,
      result,
      'agent_run',
      new Date('2026-06-15T04:46:05.303Z'),
    );

    expect(entry).toMatchObject({
      at: '2026-06-15T04:46:05.303Z',
      source: 'agent_run',
      tool: 'shell_exec',
      payload: {
        command: 'python -c "print(1)"',
        Authorization: '[redacted]',
      },
      result: {
        ok: false,
        summary: 'MCP 工具返回错误',
        detail: 'native host exited before returning JSON-RPC response',
        durationMs: 1234,
        error: {
          code: 'mcp_transport_error',
          message: 'connection closed unexpectedly',
          retryable: true,
          details: { phase: 'execute' },
        },
      },
    });
    expect(() => JSON.parse(JSON.stringify(entry))).not.toThrow();
  });
});

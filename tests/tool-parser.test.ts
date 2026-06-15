import { describe, expect, it } from 'vitest';
import { extractToolCalls } from '../core/interceptor/tool-parser';
import type { ToolDescriptor } from '../core/types';

const shellUploadDescriptor: ToolDescriptor = {
  id: 'mcp:shell:shell_upload_file',
  provider: { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'native_messaging' },
  name: 'shell_upload_file',
  invocationName: 'shell_upload_file',
  title: 'Upload file',
  description: 'Upload a local file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  execution: { mode: 'auto', enabled: true, risk: 'high' },
};

describe('extractToolCalls Markdown boundaries', () => {
  it('ignores an inline-code example and executes only the real tool call', () => {
    const text = [
      '例如 `<shell_upload_file>{"path":"/tmp/example.pdf"}</shell_upload_file>`。',
      '<shell_upload_file>{"path":"/tmp/actual.pdf"}</shell_upload_file>',
    ].join('\n');

    const calls = extractToolCalls(text, { descriptors: [shellUploadDescriptor] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ path: '/tmp/actual.pdf' });
  });

  it('ignores tool-call examples inside fenced code blocks', () => {
    const text = [
      '```xml',
      '<shell_upload_file>{"path":"/tmp/example.pdf"}</shell_upload_file>',
      '```',
    ].join('\n');

    expect(extractToolCalls(text, { descriptors: [shellUploadDescriptor] })).toEqual([]);
  });

  it('preserves tool-call boundaries when astral Unicode appears before code', () => {
    const text = [
      '提示 🚀 `<shell_upload_file>{"path":"/tmp/example.pdf"}</shell_upload_file>`',
      '<shell_upload_file>{"path":"/tmp/actual.pdf"}</shell_upload_file>',
    ].join('');

    const calls = extractToolCalls(text, { descriptors: [shellUploadDescriptor] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ path: '/tmp/actual.pdf' });
  });
});

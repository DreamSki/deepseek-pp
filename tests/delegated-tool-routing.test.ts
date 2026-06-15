import { describe, expect, it } from 'vitest';
import { routeUploadIntoQueuedSubAgent } from '../core/tool/delegated-tool-routing';
import type { ToolCall } from '../core/types';

function call(name: string, payload: Record<string, unknown>): ToolCall {
  return {
    name,
    invocationName: name,
    payload,
    raw: '',
  };
}

describe('routeUploadIntoQueuedSubAgent', () => {
  it('does NOT route uploads automatically - feature is disabled', () => {
    const path = '/tmp/report.pdf';
    const spawn = call('spawn_subagent', {
      prompt: `分析 ${path} 的内容`,
      modelType: null,
    });
    const upload = call('shell_upload_file', { path });

    // 自动路由已禁用 - shell_upload_file 只在用户明确说"使用 shell_upload_file"时才调用
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
    expect(spawn.payload.prompt).not.toContain('由你调用 shell_upload_file');
  });

  it('leaves unrelated uploads in the main agent', () => {
    const spawn = call('spawn_subagent', { prompt: '分析 /tmp/a.pdf' });
    const upload = call('shell_upload_file', { path: '/tmp/b.pdf' });

    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
  });

  it('does NOT match a substring path - feature is disabled', () => {
    const spawn = call('spawn_subagent', { prompt: '请读取 /tmp/abc.pdf' });
    const upload = call('shell_upload_file', { path: '/tmp/a.pdf' });

    // 自动路由已禁用
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
  });

  it('does NOT match a path that is a suffix - feature is disabled', () => {
    const spawn = call('spawn_subagent', { prompt: '请读取 /tmp/img.png.bak' });
    const upload = call('shell_upload_file', { path: '/tmp/img.png' });

    // 自动路由已禁用
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
  });

  it('does NOT match a path surrounded by quotes - feature is disabled', () => {
    const path = '/tmp/data.csv';
    const spawn = call('spawn_subagent', { prompt: `请读取"${path}"的内容` });
    const upload = call('shell_upload_file', { path });

    // 自动路由已禁用
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
  });

  it('does NOT match a path on its own line - feature is disabled', () => {
    const path = '/tmp/chart.png';
    const spawn = call('spawn_subagent', { prompt: `读取以下图片:\n${path}\n并分析` });
    const upload = call('shell_upload_file', { path });

    // 自动路由已禁用
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
  });

  it('does NOT inject instructions on repeated calls - feature is disabled', () => {
    const path = '/tmp/report.pdf';
    const spawn = call('spawn_subagent', { prompt: `分析 ${path} 的内容` });
    const upload = call('shell_upload_file', { path });

    // 自动路由已禁用 - 所有调用都返回 false
    expect(routeUploadIntoQueuedSubAgent(upload, [spawn])).toBe(false);
    const upload2 = call('shell_upload_file', { path });
    expect(routeUploadIntoQueuedSubAgent(upload2, [spawn])).toBe(false);
    expect(spawn.payload.prompt).not.toContain('由你调用 shell_upload_file');
  });
});

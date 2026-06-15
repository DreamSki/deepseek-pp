import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_DESCRIPTORS } from '../core/tool';
import * as RequestAugmentation from '../core/interceptor/request-augmentation';
import { addPendingImageFileId } from '../core/tool/pending-image-ids';
import type { ToolDescriptor } from '../core/types';

const { augmentRequestBody } = RequestAugmentation;

const emptyState = {
  memories: [],
  skills: [],
  activePreset: null,
  modelType: 'expert' as const,
  toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
  messageCount: 0,
};

const imageRoutingDescriptors: ToolDescriptor[] = [
  descriptor('shell_exec'),
  descriptor('shell_read_image'),
  descriptor('spawn_subagent'),
];

const fileUploadDescriptors: ToolDescriptor[] = [
  descriptor('shell_exec'),
  descriptor('shell_status'),
  descriptor('shell_upload_file'),
  descriptor('spawn_subagent'),
];

describe('augmentRequestBody', () => {
  it('treats an omitted request model_type as fast mode instead of retaining expert state', () => {
    const resolver = (RequestAugmentation as unknown as {
      resolveRequestModelType: (value: unknown) => 'expert' | null;
    }).resolveRequestModelType;

    expect(typeof resolver).toBe('function');
    expect(resolver(undefined)).toBeNull();
    expect(resolver(null)).toBeNull();
    expect(resolver('default')).toBeNull();
    expect(resolver('deepseek_chat')).toBeNull();
    expect(resolver('expert')).toBe('expert');
    expect(resolver('deepseek_reasoner')).toBe('expert');
  });

  it('applies expert mode and advances request message count without exposing state to main-world', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: 'hello',
      parent_message_id: null,
      thinking_enabled: false,
    }), emptyState);

    expect(result?.messageCount).toBe(1);
    expect(JSON.parse(result?.body ?? '{}').model_type).toBe('expert');
    expect(result?.usedMemoryIds).toEqual([]);
  });

  it('does NOT inject pending image ids or override model_type (handled by inline-agent)', () => {
    addPendingImageFileId('file-image-1');
    addPendingImageFileId('file-image-1'); // dedup

    // augmentRequestBody does NOT drain pending-image-ids — the inline agent
    // loop is the exclusive consumer. Normal chat doesn't add pending IDs.
    const result = augmentRequestBody(JSON.stringify({
      prompt: 'describe this',
      parent_message_id: 10,
      ref_file_ids: ['existing-file'],
    }), emptyState);

    const body = JSON.parse(result?.body ?? '{}');
    // ref_file_ids unchanged (pending IDs are NOT injected here)
    expect(body.ref_file_ids).toEqual(['existing-file']);
    // model_type NOT overridden to vision
    expect(body.model_type).toBe('expert');
  });

  it('does not advertise shell_read_image as callable to a non-vision main agent', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: '识图 /tmp/chart.png',
      parent_message_id: null,
      model_type: 'expert',
    }), {
      ...emptyState,
      toolDescriptors: imageRoutingDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('使用 spawn_subagent 并指定 modelType:"vision"');
    expect(prompt).not.toContain('### Tool shell_read_image');
    expect(prompt).not.toMatch(/Available tool tag names:.*shell_read_image/);
    expect(prompt).not.toMatch(/Recognized shell tool names:.*shell_read_image/);
  });

  it('keeps shell_read_image callable in a vision main agent', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: '识图 /tmp/chart.png',
      parent_message_id: null,
      model_type: 'vision',
    }), {
      ...emptyState,
      toolDescriptors: imageRoutingDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('### Tool shell_read_image');
    expect(prompt).toMatch(/Available tool tag names:.*shell_read_image/);
  });

  it('teaches the main agent to route explicit local-file requests to shell_upload_file', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: '使用 shell_upload_file 读取 /tmp/report.pdf 并总结内容',
      parent_message_id: null,
      model_type: 'default',
    }), {
      ...emptyState,
      modelType: null,
      toolDescriptors: fileUploadDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('## 本地文件上传规则');
    expect(prompt).toContain('仅当用户明确说”使用 shell_upload_file”或明确提到工具名称时');
    expect(prompt).toContain('仅对用户明确指定的文件使用');
    expect(prompt).toContain('依赖 DeepSeek 原生解析结果');
  });

  it('declares fast mode and keeps direct document upload available there', () => {
    const result = RequestAugmentation.augmentRequestBody(JSON.stringify({
      prompt: '使用 shell_upload_file 读取 /tmp/report.pdf 并总结内容',
      parent_message_id: null,
      model_type: 'default',
    }), {
      ...emptyState,
      modelType: null,
      toolDescriptors: fileUploadDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('当前主代理模式：快速模式');
    expect(prompt).toContain('仅当用户明确说');
    expect(prompt).toContain('使用 shell_upload_file');
    expect(prompt).toContain('明确提到工具名称');
    expect(prompt).toContain('依赖 DeepSeek 原生解析结果');
    expect(prompt).not.toContain('当前主代理模式：专家模式');
  });

  it('declares expert mode and routes document upload to a fast subagent', () => {
    const result = RequestAugmentation.augmentRequestBody(JSON.stringify({
      prompt: '上传 /tmp/report.pdf 并总结内容',
      parent_message_id: null,
      model_type: 'expert',
    }), {
      ...emptyState,
      toolDescriptors: fileUploadDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('当前主代理模式：专家模式');
    expect(prompt).toContain('modelType:"default"');
    expect(prompt).toContain('由快速模式子代理调用 shell_upload_file');
    expect(prompt).not.toContain('### Tool shell_upload_file');
    expect(prompt).not.toMatch(/Available tool tag names:.*shell_upload_file/);
  });

  it('keeps delegated file uploads inside the subagent', () => {
    const result = augmentRequestBody(JSON.stringify({
      prompt: '启动一个默认快速模式的子代理，上传 /tmp/report.pdf 并分析内容',
      parent_message_id: null,
      model_type: 'expert',
    }), {
      ...emptyState,
      toolDescriptors: fileUploadDescriptors,
    });

    const prompt = JSON.parse(result?.body ?? '{}').prompt as string;
    expect(prompt).toContain('委派边界优先于本地文件直接上传规则');
    expect(prompt).toContain('主代理只调用 spawn_subagent');
    expect(prompt).toContain('由子代理调用 shell_upload_file');
    expect(prompt).toContain('不要在同一轮由主代理先调用 shell_upload_file');
  });

});

function descriptor(name: string): ToolDescriptor {
  return {
    id: `test:${name}`,
    name,
    invocationName: name,
    title: name,
    description: `${name} test descriptor`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    provider: {
      id: name === 'spawn_subagent' ? 'subagent' : 'shell',
      kind: name === 'spawn_subagent' ? 'local' : 'mcp',
      displayName: name,
      transport: name === 'spawn_subagent' ? 'in_process' : 'stdio_bridge',
    },
    execution: {
      enabled: true,
      mode: 'auto',
      risk: 'low',
    },
  };
}

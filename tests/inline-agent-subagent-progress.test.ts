import { describe, expect, it } from 'vitest';
import type { ToolExecutionRecord } from '../core/types';
import {
  canCompleteSubAgentRequirement,
  createQueuedSubAgentExecution,
  getDetectedSubAgentStatus,
  getSubAgentProgress,
} from '../core/inline-agent/subagent-progress';
import {
  buildContinuationPrompt,
  shouldNudge,
} from '../core/inline-agent/prompt';

function subAgentExecution(
  ok = true,
  modelType?: 'default' | 'vision',
): ToolExecutionRecord {
  return {
    name: 'spawn_subagent',
    result: {
      ok,
      summary: ok ? '子代理完成' : '子代理失败',
      ...(modelType ? { output: { modelType } } : {}),
    },
  };
}

describe('inline-agent subagent progress', () => {
  it('creates an immediate visible placeholder when a subagent call is detected', () => {
    const execution = createQueuedSubAgentExecution({
      name: 'spawn_subagent',
      payload: { modelType: 'vision', prompt: '分析图片' },
      raw: '<spawn_subagent />',
    }, 2);

    expect(execution.name).toBe('spawn_subagent');
    expect(execution.result.summary).toBe('子代理 #2 已检测，等待主代理本轮完成后启动…');
  });

  it('describes a detected vision subagent before execution starts', () => {
    expect(getDetectedSubAgentStatus({
      name: 'spawn_subagent',
      payload: { modelType: 'vision', prompt: '分析图片' },
      raw: '<spawn_subagent />',
    })).toBe('已检测识图子代理，等待本轮生成完成后启动…');
  });

  it('extracts an explicit requested subagent count from Chinese tasks', () => {
    const progress = getSubAgentProgress(
      '检查下载目录里的 PDF，启动 3 个子代理分配任务并逐份总结。',
      [subAgentExecution()],
    );

    expect(progress).toEqual({
      expected: 3,
      attempted: 1,
      completed: 1,
      pending: 2,
    });
  });

  it('supports Chinese numerals and ignores failed executions', () => {
    const progress = getSubAgentProgress(
      '请启动三个子代理并行检查这些文件。',
      [subAgentExecution(), subAgentExecution(false)],
    );

    expect(progress).toEqual({
      expected: 3,
      attempted: 2,
      completed: 1,
      pending: 2,
    });
  });

  it('counts only vision subagents when the task explicitly requires them', () => {
    const task = '主代理同时启动两个vision子代理分析插图。';

    expect(getSubAgentProgress(task, [
      subAgentExecution(true, 'default'),
      subAgentExecution(true, 'vision'),
    ])).toEqual({
      expected: 2,
      attempted: 1,
      completed: 1,
      pending: 1,
    });

    expect(canCompleteSubAgentRequirement(task, [
      subAgentExecution(true, 'default'),
      subAgentExecution(true, 'vision'),
      subAgentExecution(true, 'vision'),
    ])).toBe(true);
  });

  it('states the required subagent model in continuation prompts', () => {
    const prompt = buildContinuationPrompt(
      '主代理同时启动两个vision子代理分析插图。',
      [subAgentExecution(true, 'default'), subAgentExecution(true, 'vision')],
    );

    expect(prompt).toContain('vision 子代理要求: 1/2 已成功完成');
    expect(prompt).toContain('必须继续发出缺少的 vision spawn_subagent 调用');
  });

  it('does not invent a requirement when the task has no explicit count', () => {
    expect(getSubAgentProgress('请用子代理检查这些文件。', [])).toBeNull();
  });

  it('does not turn an upper bound into an exact completion requirement', () => {
    expect(getSubAgentProgress('请使用最多 3 个子代理检查这些文件。', [])).toBeNull();
  });

  it('rejects completion until the explicit requirement is satisfied', () => {
    const task = 'Start 3 subagents to review the documents.';

    expect(canCompleteSubAgentRequirement(task, [subAgentExecution()])).toBe(false);
    expect(canCompleteSubAgentRequirement(task, [
      subAgentExecution(),
      subAgentExecution(),
      subAgentExecution(),
    ])).toBe(true);
  });

  it('nudges instead of accepting a premature task_complete signal', () => {
    const task = '启动 3 个子代理处理所有 PDF。';
    const text = '<task_complete>{"summary":"已经总结完成"}</task_complete>';

    expect(shouldNudge(task, [subAgentExecution()], text, 0)).toBe(true);
    expect(shouldNudge(task, [
      subAgentExecution(),
      subAgentExecution(),
      subAgentExecution(),
    ], text, 0)).toBe(false);
  });

  it('injects machine-derived pending progress into continuation prompts', () => {
    const prompt = buildContinuationPrompt(
      '启动 3 个子代理处理所有 PDF。',
      [subAgentExecution()],
    );

    expect(prompt).toContain('<task_status>');
    expect(prompt).toContain('子代理要求: 1/3 已成功完成');
    expect(prompt).toContain('待完成: 2');
  });

  it('does not serialize uploaded image bytes into continuation prompts', () => {
    const prompt = buildContinuationPrompt('识图 /private/tmp/chart.png', [{
      name: 'shell_read_image',
      result: {
        ok: true,
        summary: '图片已成功上传至对话（file_id: file-image）。',
        detail: 'data:image/png;base64,SECRET_IMAGE_BYTES',
        output: {
          data: {
            path: '/private/tmp/chart.png',
            size: 1234,
            mimeType: 'image/png',
            base64: 'SECRET_IMAGE_BYTES',
            image: { mimeType: 'image/png', data: 'SECRET_IMAGE_BYTES' },
          },
          uploadedFileId: 'file-image',
        },
      },
    }]);

    expect(prompt).toContain('file-image');
    expect(prompt).toContain('/private/tmp/chart.png');
    expect(prompt).not.toContain('SECRET_IMAGE_BYTES');
    expect(prompt).not.toContain('base64');
  });

  it('drops legacy uploaded image payloads even when safe metadata is missing', () => {
    const prompt = buildContinuationPrompt('识图', [{
      name: 'shell_read_image',
      result: {
        ok: true,
        summary: '图片已成功上传至对话。',
        detail: 'data:image/png;base64,LEGACY_IMAGE_BYTES',
        output: {
          data: {
            base64: 'LEGACY_IMAGE_BYTES',
            image: { mimeType: 'image/png', data: 'LEGACY_IMAGE_BYTES' },
          },
        },
      },
    }]);

    expect(prompt).toContain('图片已成功上传至对话。');
    expect(prompt).not.toContain('LEGACY_IMAGE_BYTES');
    expect(prompt).not.toContain('base64');
  });
});

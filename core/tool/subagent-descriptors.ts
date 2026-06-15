import type { ToolDescriptor, ToolProviderIdentity } from '../types';

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_PROVIDER: ToolProviderIdentity = {
  kind: 'local',
  id: 'subagent',
  displayName: 'DeepSeek++ Sub-Agent Spawner',
  transport: 'in_process',
};

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_NAMES = ['spawn_subagent'] as const;
export type SubAgentToolName = typeof SUBAGENT_TOOL_NAMES[number];

// ---------------------------------------------------------------------------
// Descriptors — pure data, no runtime imports that could create cycles
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    id: 'local:subagent:spawn_subagent',
    provider: SUBAGENT_TOOL_PROVIDER,
    name: 'spawn_subagent',
    invocationName: 'spawn_subagent',
    title: '委派子代理',
    description:
      '在独立 DeepSeek 对话会话中委派子代理执行任务，完成后返回结果。适用于图片分析、多步工具调用、代码生成等。多个互不依赖的子代理可在同一轮并行发出，扩展会同时执行它们。子代理看不到当前对话历史，prompt 需包含完整上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '委派给子代理的任务描述，必须包含所有必要的上下文信息（子代理看不到当前对话历史）。',
        },
        modelType: {
          type: 'string',
          description: '可选。模型类型：expert（专家推理）、vision（识图看图片）、default（默认）。不填则使用默认模型。子代理需要看图时必须设为 vision。',
        },
        imagePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'vision 任务必填。待分析图片的完整路径清单；运行时会逐项核对实际读取和上传结果，防止漏图、串图或重复读图。',
        },
        backupFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。需要在子代理执行前备份的文件路径列表。系统会自动备份并在完成后报告变更（diff）。备份文件保留为 .subagent.bak。',
        },
        rollbackOnFailure: {
          type: 'boolean',
          description: '可选。子代理失败时是否自动从备份恢复文件。默认 false。',
        },
        timeoutMs: {
          type: 'number',
          description: '可选。单步超时毫秒数。超时后标记为待处理而非失败，主代理可决定重试或跳过。默认 120000（2 分钟），最大 300000（5 分钟）。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'medium',
    },
  },
];

// ---------------------------------------------------------------------------
// Name guard
// ---------------------------------------------------------------------------

export function isSubAgentToolName(name: string): name is SubAgentToolName {
  return (SUBAGENT_TOOL_NAMES as readonly string[]).includes(name);
}

import type { ToolExecutionRecord } from '../types';
import {
  canCompleteSubAgentRequirement,
  renderSubAgentTaskStatus,
} from './subagent-progress';

// Intent-to-continue patterns: the AI explicitly says it plans to take more
// actions. These override other stop signals.
const PENDING_ACTION_RE = /(?:我(?:将|会|先|直接|现在|继续|尝试|开始|需要|还要|还得|得先)|(?:接下来|下一步|然后|接着|再|还要|也需要).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|列|查看|读|跑|执行|确认|分析|启动|看|处理)|(?:还在|还没|尚未).{0,12}(?:完成|结束|做完)|(?:i(?:'ll| will| need to| still need to| have to)|let me|next,? i|i still).{0,48}(?:call|create|edit|inspect|validate|generate|save|try|check|list|read|run|analyze))/i;

// Completion-ish patterns: only treat as "done" when the text is clearly
// wrapping up — the pattern itself plus a short surrounding context.
const FINALISH_RE = /(?:任务已(?:完成|结束)|全部完成|以上是|总结|最终答案|final answer|all done|here(?:'s| is) the (?:final |complete )?result)/i;

const TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;

export function extractTaskCompleteSignal(text: string): { summary: string; artifacts: string[] } | null {
  const match = TASK_COMPLETE_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : match[1].trim(),
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((a: unknown) => typeof a === 'string') : [],
    };
  } catch {
    return { summary: match[1].trim(), artifacts: [] };
  }
}

export function shouldNudge(
  originalTask: string,
  executions: ToolExecutionRecord[],
  visibleText: string,
  nudgeCount: number,
): boolean {
  if (!canCompleteSubAgentRequirement(originalTask, executions)) return true;
  if (extractTaskCompleteSignal(visibleText)) return false;
  if (!visibleText) return true;

  // If the AI explicitly says it plans to take more actions, always nudge
  // regardless of text length or other signals.
  if (PENDING_ACTION_RE.test(visibleText)) return true;

  // If the text looks like a final wrap-up AND is relatively short, stop.
  // Long texts without tool calls that also don't match PENDING_ACTION
  // are still treated as final — the AI had plenty of room to signal
  // intent to continue and didn't.
  if (FINALISH_RE.test(visibleText) && visibleText.length < 600) return false;

  // First step with no tool calls: give one nudge unless the text already
  // looks like a definitive conclusion.
  if (nudgeCount === 0 && visibleText.length < 600) return true;

  return false;
}

// Thresholds for instruction compression: when the original task is long and
// we've already executed several tool calls, the continuation prompt replaces
// the full 8000-char task with a compressed progress summary to avoid context
// bloat that degrades reasoning quality.
const COMPRESS_TASK_IF_LONGER_THAN = 2000;
const COMPRESS_AFTER_TOOL_COUNT = 5;

export function buildContinuationPrompt(
  originalTask: string,
  executions: ToolExecutionRecord[],
  totalSteps = 0,
): string {
  const hasFailures = executions.some((e) => !e.result.ok);
  const results = renderToolResults(executions);
  const shouldCompress =
    originalTask.length > COMPRESS_TASK_IF_LONGER_THAN &&
    totalSteps > COMPRESS_AFTER_TOOL_COUNT;

  const taskBlock = shouldCompress
    ? buildCompressedTaskBlock(originalTask, executions)
    : `<original_task>\n${clampText(originalTask, 8000)}\n</original_task>`;
  const taskStatus = renderSubAgentTaskStatus(originalTask, executions);

  return [
    '以下是工具续跑任务刚刚执行的工具结果。请像真正的 Agent 一样，基于原始任务和这些工具结果继续推进。',
    '只有原始任务的所有子目标全部达成时才输出最终结论。只要还有未完成的步骤、未检查的文件、未验证的结果，就必须继续调用工具。不要过早停止。',
    '如果还需要继续执行，可以先输出一行进度说明再接着发工具调用。不要要求用户点击继续，也不要输出伪工具调用 JSON；需要继续操作时只输出可执行 XML 工具标签。',
    '',
    taskBlock,
    ...(taskStatus ? ['', taskStatus] : []),
    ...(hasFailures ? [
      '至少一个工具执行失败。不要因为可恢复错误就停止；先阅读 summary/detail/error，并修正参数或改用合适的下一步继续完成任务。',
    ] : []),
    '',
    '<tool_results>',
    JSON.stringify(results, null, 2),
    '</tool_results>',
  ].join('\n');
}

export function buildNudgePrompt(
  originalTask: string,
  previousText: string,
  executions: ToolExecutionRecord[],
  nudgeCount: number,
  totalSteps = 0,
): string {
  const results = renderToolResults(executions);
  const shouldCompress =
    originalTask.length > COMPRESS_TASK_IF_LONGER_THAN &&
    totalSteps > COMPRESS_AFTER_TOOL_COUNT;

  const taskBlock = shouldCompress
    ? buildCompressedTaskBlock(originalTask, executions)
    : `<original_task>\n${clampText(originalTask, 8000)}\n</original_task>`;
  const taskStatus = renderSubAgentTaskStatus(originalTask, executions);

  return [
    '上一轮回复没有包含任何可执行工具 XML，因此自动化续跑无法继续执行。',
    '请根据原始任务和工具结果二选一：',
    '1. 如果任务仍未完成，本轮必须直接输出下一步可执行工具 XML。',
    '2. 如果任务已经完成，输出 <task_complete>{"summary":"..."}</task_complete>。',
    `这是第 ${nudgeCount + 1} 次无工具调用纠偏。`,
    '',
    taskBlock,
    ...(taskStatus ? ['', taskStatus] : []),
    '',
    '<previous_assistant_text>',
    clampText(previousText, 4000),
    '</previous_assistant_text>',
    '',
    '<tool_results_so_far>',
    JSON.stringify(results, null, 2),
    '</tool_results_so_far>',
  ].join('\n');
}

export function buildFinalizationPrompt(originalTask: string, executions: ToolExecutionRecord[]): string {
  const results = renderToolResults(executions);
  const taskStatus = renderSubAgentTaskStatus(originalTask, executions);

  return [
    '以下是刚才已经自动执行完成的工具结果。请基于原始任务和这些结果给出最终回答。',
    '这是最终回答轮次：不要再调用任何工具。',
    '',
    '<original_task>',
    clampText(originalTask, 8000),
    '</original_task>',
    ...(taskStatus ? ['', taskStatus] : []),
    '',
    '<tool_results>',
    JSON.stringify(results, null, 2),
    '</tool_results>',
  ].join('\n');
}

/**
 * Build a compressed version of the original task for continuation prompts,
 * replacing the full 300-line instruction with a core-goal extract + progress
 * summary derived from tool execution results. This avoids context bloat.
 */
function buildCompressedTaskBlock(
  originalTask: string,
  executions: ToolExecutionRecord[],
): string {
  // Extract the first ~500 chars as the "core goal" (usually contains the
  // high-level objective and initial step list).
  const coreGoal = originalTask.slice(0, 500).trim();

  // Derive a progress summary from tool names and their summaries
  const toolSteps = executions
    .filter((e) => e.name !== 'spawn_subagent' || e.result.summary.includes('完成'))
    .map((e) => {
      const shortSummary = (e.result.summary || '').slice(0, 120);
      return `- ${e.name}: ${shortSummary}`;
    })
    .slice(-20); // keep last 20 tool results max

  const progressLines = toolSteps.length > 0
    ? ['', '已完成步骤摘要：', ...toolSteps]
    : [];

  return [
    '<original_task_summary>',
    '以下是指令核心目标（完整指令已在首轮执行，此处仅保留摘要以避免上下文膨胀）：',
    '',
    coreGoal,
    ...progressLines,
    '',
    '请根据工具执行结果和上述核心目标，继续推进剩余步骤。',
    '</original_task_summary>',
  ].join('\n');
}

function renderToolResults(executions: ToolExecutionRecord[]) {
  return executions.map((e) => {
    const uploadMetadata = extractUploadMetadata(e);
    const isUploadedFile = uploadMetadata !== null;
    return {
      tool: e.name,
      provider: e.provider?.displayName,
      ok: e.result.ok,
      summary: e.result.summary,
      detail: isUploadedFile ? undefined : clampText(e.result.detail, 4000),
      error: e.result.error,
      output: isUploadedFile
        ? Object.keys(uploadMetadata).length > 0 ? JSON.stringify(uploadMetadata) : undefined
        : clampText(
            e.result.output === undefined ? undefined : JSON.stringify(e.result.output),
            8000,
          ),
      truncated: e.result.truncated === true,
    };
  });
}

function extractUploadMetadata(execution: ToolExecutionRecord): Record<string, unknown> | null {
  if (execution.name !== 'shell_read_image' && execution.name !== 'shell_upload_file') return null;
  if (!execution.result.ok) return null;

  const output = parseOutputRecord(execution.result.output);
  const data = asRecord(output?.data);
  const metadata: Record<string, unknown> = {};
  copySafeMetadata(metadata, output, 'uploadedFileId');
  copySafeMetadata(metadata, data, 'path');
  copySafeMetadata(metadata, data, 'size');
  copySafeMetadata(metadata, data, 'mimeType');
  return metadata;
}

function parseOutputRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function copySafeMetadata(
  target: Record<string, unknown>,
  source: Record<string, unknown> | null,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === 'string' || typeof value === 'number') target[key] = value;
}

function clampText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

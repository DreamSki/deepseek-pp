import type { ToolCall, ToolExecutionRecord } from '../types';

export interface SubAgentProgress {
  expected: number;
  attempted: number;
  completed: number;
  pending: number;
}

const MAX_EXPLICIT_SUBAGENTS = 25;
const COUNT_TOKEN = '(\\d{1,2}|[一二两三四五六七八九十]+|one|two|three|four|five|six|seven|eight|nine|ten)';
const ACTION_TOKEN = '(?:启动|创建|发出|调用|使用|安排|分配|派出|start|spawn|launch|create|use|dispatch)';
const SUBAGENT_TOKEN = '(?:个|名|位)?\\s*(?:(vision|视觉|识图|图像)\\s*)?(?:子代理|子\\s*agent|sub[- ]?agents?|agents?)';
const EXPLICIT_SUBAGENT_COUNT_RE = new RegExp(
  `${ACTION_TOKEN}[^\\n。.!?]{0,20}?${COUNT_TOKEN}\\s*${SUBAGENT_TOKEN}`,
  'gi',
);

interface SubAgentRequirement {
  expected: number;
  modelType: 'vision' | null;
}

const WORD_COUNTS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function createQueuedSubAgentExecution(
  call: ToolCall,
  subAgentIndex: number,
): ToolExecutionRecord {
  return {
    name: call.name,
    result: {
      ok: false,
      summary: `子代理 #${subAgentIndex} 已检测，等待主代理本轮完成后启动…`,
    },
    provider: call.provider,
    descriptorId: call.descriptorId,
  };
}

export function getDetectedSubAgentStatus(call: ToolCall): string {
  const isVision = call.payload.modelType === 'vision';
  return isVision
    ? '已检测识图子代理，等待本轮生成完成后启动…'
    : '已检测子代理，等待本轮生成完成后启动…';
}

export function getSubAgentProgress(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
): SubAgentProgress | null {
  const requirement = extractExplicitSubAgentRequirement(originalTask);
  if (!requirement) return null;

  const subAgentExecutions = executions.filter((execution) => {
    if (execution.name !== 'spawn_subagent') return false;
    if (!requirement.modelType) return true;
    return getExecutionModelType(execution) === requirement.modelType;
  });
  const completed = subAgentExecutions.filter((execution) => execution.result.ok).length;

  return {
    expected: requirement.expected,
    attempted: subAgentExecutions.length,
    completed,
    pending: Math.max(0, requirement.expected - completed),
  };
}

export function canCompleteSubAgentRequirement(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
): boolean {
  const progress = getSubAgentProgress(originalTask, executions);
  return progress ? progress.pending === 0 : true;
}

export function renderSubAgentTaskStatus(
  originalTask: string,
  executions: readonly ToolExecutionRecord[],
): string {
  const progress = getSubAgentProgress(originalTask, executions);
  if (!progress) return '';
  const requirement = extractExplicitSubAgentRequirement(originalTask);
  const modelLabel = requirement?.modelType ? `${requirement.modelType} ` : '';

  return [
    '<task_status>',
    `${modelLabel}子代理要求: ${progress.completed}/${progress.expected} 已成功完成`,
    `已尝试: ${progress.attempted}`,
    `待完成: ${progress.pending}`,
    progress.pending > 0
      ? `完成门禁: 尚未满足。必须继续发出缺少的 ${modelLabel}spawn_subagent 调用，失败的调用不计入完成数。`
      : '完成门禁: 已满足。',
    '</task_status>',
  ].join('\n');
}

function extractExplicitSubAgentRequirement(text: string): SubAgentRequirement | null {
  let requirement: SubAgentRequirement | null = null;
  EXPLICIT_SUBAGENT_COUNT_RE.lastIndex = 0;

  for (const match of text.matchAll(EXPLICIT_SUBAGENT_COUNT_RE)) {
    if (/(?:最多|至多|不超过|up to|at most)/i.test(match[0])) continue;
    const parsed = parseCountToken(match[1] ?? '');
    if (parsed != null && parsed > 0 && parsed <= MAX_EXPLICIT_SUBAGENTS) {
      requirement = {
        expected: parsed,
        modelType: match[2] ? 'vision' : null,
      };
    }
  }

  return requirement;
}

function getExecutionModelType(execution: ToolExecutionRecord): string | null {
  const output = execution.result.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const modelType = (output as Record<string, unknown>).modelType;
  return typeof modelType === 'string' ? modelType : null;
}

function parseCountToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);

  const normalized = token.toLowerCase();
  if (WORD_COUNTS[normalized] != null) return WORD_COUNTS[normalized];

  if (token === '十') return 10;
  if (token.includes('十')) {
    const [tensToken, unitsToken] = token.split('十');
    const tens = tensToken ? CHINESE_DIGITS[tensToken] : 1;
    const units = unitsToken ? CHINESE_DIGITS[unitsToken] : 0;
    if (tens != null && units != null) return (tens * 10) + units;
    return null;
  }

  return CHINESE_DIGITS[token] ?? null;
}

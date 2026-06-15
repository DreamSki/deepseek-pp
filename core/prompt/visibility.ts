export const VISIBLE_USER_PROMPT_START = '<!-- deepseek-pp-visible-user-prompt:start -->';
export const VISIBLE_USER_PROMPT_END = '<!-- deepseek-pp-visible-user-prompt:end -->';

const TOOL_REMINDER_HEADING = 'Tool call format reminder:';
const TOOL_REMINDER_REQUIRED_LINE = 'Available tool tag names:';
const TOOL_REMINDER_FRAGMENT_PREFIXES = [
  TOOL_REMINDER_HEADING,
  TOOL_REMINDER_REQUIRED_LINE,
  'These listed tools are executable by the extension.',
  'To call a tool, use ONLY the direct XML tag',
  'For MCP tools, prefer the short tag name',
  'For local file paths, use forward slashes',
  'Do not use <invoke name="...">',
  'Do not put executable tool XML',
];

const INTERNAL_AGENT_PROMPT_PREFIXES = [
  '以下是工具续跑任务刚刚执行的工具结果。',
  '上一轮回复没有包含任何可执行工具 XML',
  '以下是刚才已经自动执行完成的工具结果。',
  '以下是自动化任务刚刚执行的 MCP 工具结果。',
];

export function markVisibleUserPrompt(prompt: string): string {
  return `${VISIBLE_USER_PROMPT_START}\n${prompt}\n${VISIBLE_USER_PROMPT_END}`;
}

export function extractVisibleUserPrompt(text: string): string | null {
  const start = text.indexOf(VISIBLE_USER_PROMPT_START);
  if (start === -1) return null;

  const contentStart = start + VISIBLE_USER_PROMPT_START.length;
  const end = text.indexOf(VISIBLE_USER_PROMPT_END, contentStart);
  if (end === -1) return null;

  return trimSingleBoundaryNewline(text.slice(contentStart, end));
}

export function sanitizeInternalPromptText(
  text: string,
  fallbackVisiblePrompt?: string,
): string {
  const visiblePrompt = extractVisibleUserPrompt(text);
  if (visiblePrompt !== null) return visiblePrompt;

  if (isInternalAgentPrompt(text)) return '';

  const subAgentTask = extractSubAgentTask(text);
  if (subAgentTask !== null) return subAgentTask;

  if (isToolReminderOnly(text)) return '';

  if (containsToolFormatReminder(text)) {
    return fallbackVisiblePrompt ?? stripToolFormatReminder(text);
  }

  return text;
}

export function containsInternalPromptMarker(text: string): boolean {
  return text.includes(VISIBLE_USER_PROMPT_START) ||
    containsToolFormatReminder(text) ||
    isToolReminderOnly(text) ||
    isInternalAgentPrompt(text) ||
    extractSubAgentTask(text) !== null;
}

function isInternalAgentPrompt(text: string): boolean {
  const normalized = text.trimStart();
  return INTERNAL_AGENT_PROMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    isSubAgentContinuationPrompt(normalized);
}

function isSubAgentContinuationPrompt(text: string): boolean {
  const visionContinuation =
    text.startsWith('You just uploaded ') &&
    text.includes(' via shell_read_image.') &&
    text.includes('\nTask: ');
  const genericContinuation =
    /^Step \d+\/\d+\./.test(text) &&
    text.includes('Output next action. To call a tool:') &&
    text.includes('\nTool results:');
  return visionContinuation || genericContinuation;
}

function extractSubAgentTask(text: string): string | null {
  const normalized = text.trimStart();
  if (!normalized.startsWith('You have tools. To call a tool,')) return null;
  const match = normalized.match(/(?:^|\n)Task: ([\s\S]*?)(?:\n\n---\n|$)/);
  return match?.[1]?.trim() || null;
}

function trimSingleBoundaryNewline(text: string): string {
  let next = text;
  if (next.startsWith('\r\n')) next = next.slice(2);
  else if (next.startsWith('\n')) next = next.slice(1);

  if (next.endsWith('\r\n')) next = next.slice(0, -2);
  else if (next.endsWith('\n')) next = next.slice(0, -1);

  return next;
}

function containsToolFormatReminder(text: string): boolean {
  return text.includes(TOOL_REMINDER_HEADING) && text.includes(TOOL_REMINDER_REQUIRED_LINE);
}

function stripToolFormatReminder(text: string): string {
  const headingIndex = text.indexOf(TOOL_REMINDER_HEADING);
  if (headingIndex === -1) return text;

  const delimiterIndex = text.lastIndexOf('\n---', headingIndex);
  const cutIndex = delimiterIndex === -1 ? headingIndex : delimiterIndex;
  return text.slice(0, cutIndex).trim();
}

function isToolReminderOnly(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) return false;

  return TOOL_REMINDER_FRAGMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

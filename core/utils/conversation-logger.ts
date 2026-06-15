/**
 * Conversation and Thinking Logger
 *
 * This module provides utilities for logging agent conversations and thinking processes
 * to disk for debugging and analysis purposes.
 */

import { buildShellWriteCommand } from './safe-shell-write';

export interface MainAgentConversationLog {
  logType: 'main_agent_conversation';
  timestamp: string;
  loopId: string;
  stepIndex: number;
  chatSessionId: string;
  userPrompt: string;
  systemPrompt: string;
  modelType: string | null;
  refFileIds: string[];
}

export interface ThinkingContentLog {
  logType: 'thinking_content';
  timestamp: string;
  sessionId: string; // Can be chatSessionId for main agent or subAgent
  agentType: 'main' | 'sub';
  stepIndex?: number;
  content: string;
}

export interface MainAgentResponseLog {
  logType: 'main_agent_response';
  timestamp: string;
  loopId: string;
  stepIndex: number;
  chatSessionId: string;
  assistantText: string;
  thinkingText: string;
}

const LOG_DIR = '/tmp';
const MAX_LOG_SIZE = 50_000; // 50KB max per log entry to avoid oversized files

/**
 * Write main agent conversation log to disk
 */
export async function logMainAgentConversation(
  logData: Omit<MainAgentConversationLog, 'logType' | 'timestamp'>,
  executeMcpToolCall: (toolCall: any) => Promise<any>,
  getToolDescriptors: () => Promise<any[]>
): Promise<void> {
  try {
    const descriptors = await getToolDescriptors();
    const shell = descriptors.find((d: any) => d.name === 'shell_exec');
    if (!shell) return;

    const log: MainAgentConversationLog = {
      logType: 'main_agent_conversation',
      timestamp: new Date().toISOString(),
      ...logData,
    };

    const entry = JSON.stringify(log, null, 2);
    const truncatedEntry = entry.length > MAX_LOG_SIZE
      ? entry.slice(0, MAX_LOG_SIZE) + '\n\n...[LOG TRUNCATED]...'
      : entry;

    const filename = `${LOG_DIR}/dpp_main_conversation_${Date.now()}.json`;

    await executeMcpToolCall({
      name: 'shell_exec',
      provider: shell.provider,
      descriptorId: shell.id,
      invocationName: shell.invocationName ?? 'shell_exec',
      payload: { command: buildShellWriteCommand(filename, truncatedEntry) },
      raw: '',
    });
  } catch (err) {
    // Logging should be best-effort; don't throw errors
    console.error('[DPP] Failed to log main agent conversation:', err);
  }
}

/**
 * Write thinking content log to disk
 */
export async function logThinkingContent(
  logData: Omit<ThinkingContentLog, 'logType' | 'timestamp'>,
  executeMcpToolCall: (toolCall: any) => Promise<any>,
  getToolDescriptors: () => Promise<any[]>
): Promise<void> {
  try {
    const descriptors = await getToolDescriptors();
    const shell = descriptors.find((d: any) => d.name === 'shell_exec');
    if (!shell) return;

    const log: ThinkingContentLog = {
      logType: 'thinking_content',
      timestamp: new Date().toISOString(),
      ...logData,
    };

    const entry = JSON.stringify(log, null, 2);
    const truncatedEntry = entry.length > MAX_LOG_SIZE
      ? entry.slice(0, MAX_LOG_SIZE) + '\n\n...[LOG TRUNCATED]...'
      : entry;

    const filename = `${LOG_DIR}/dpp_thinking_${Date.now()}.json`;

    await executeMcpToolCall({
      name: 'shell_exec',
      provider: shell.provider,
      descriptorId: shell.id,
      invocationName: shell.invocationName ?? 'shell_exec',
      payload: { command: buildShellWriteCommand(filename, truncatedEntry) },
      raw: '',
    });
  } catch (err) {
    // Logging should be best-effort; don't throw errors
    console.error('[DPP] Failed to log thinking content:', err);
  }
}

/**
 * Write main agent response log to disk
 */
export async function logMainAgentResponse(
  logData: Omit<MainAgentResponseLog, 'logType' | 'timestamp'>,
  executeMcpToolCall: (toolCall: any) => Promise<any>,
  getToolDescriptors: () => Promise<any[]>
): Promise<void> {
  try {
    const descriptors = await getToolDescriptors();
    const shell = descriptors.find((d: any) => d.name === 'shell_exec');
    if (!shell) return;

    const log: MainAgentResponseLog = {
      logType: 'main_agent_response',
      timestamp: new Date().toISOString(),
      ...logData,
    };

    const entry = JSON.stringify(log, null, 2);
    const truncatedEntry = entry.length > MAX_LOG_SIZE
      ? entry.slice(0, MAX_LOG_SIZE) + '\n\n...[LOG TRUNCATED]...'
      : entry;

    const filename = `${LOG_DIR}/dpp_main_response_${Date.now()}.json`;

    await executeMcpToolCall({
      name: 'shell_exec',
      provider: shell.provider,
      descriptorId: shell.id,
      invocationName: shell.invocationName ?? 'shell_exec',
      payload: { command: buildShellWriteCommand(filename, truncatedEntry) },
      raw: '',
    });
  } catch (err) {
    // Logging should be best-effort; don't throw errors
    console.error('[DPP] Failed to log main agent response:', err);
  }
}

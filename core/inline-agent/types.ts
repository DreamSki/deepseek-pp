import type { ToolCall, ToolDescriptor, ToolExecutionRecord } from '../types';

export interface InlineAgentStartPayload {
  loopId: string;
  chatSessionId: string;
  parentMessageId: number;
  originalPrompt: string;
  agentTaskPrompt: string;
  toolExecutions: ToolExecutionRecord[];
  /** Zero-based step index to continue from when restoring a persisted loop. */
  startingStepIndex?: number;
  /** Result artifacts retained across refresh until the loop completes. */
  subagentResultFiles?: string[];
  promptOptions: InlineAgentPromptOptions;
  toolDescriptors: ToolDescriptor[];
  powWasmUrl?: string;
}

export interface InlineAgentPromptOptions {
  modelType: string | null;
  searchEnabled: boolean;
  thinkingEnabled: boolean;
  refFileIds: string[];
}

export type InlineAgentStepStatus = 'streaming' | 'executing_tools' | 'complete' | 'error';
export type InlineAgentLoopStatus = 'idle' | 'running' | 'stopping' | 'complete' | 'error';

export interface InlineAgentStepState {
  index: number;
  status: InlineAgentStepStatus;
  streamedText: string;
  toolCalls: ToolCall[];
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
}

export interface InlineAgentLoopState {
  loopId: string;
  chatSessionId: string;
  parentMessageId: number | null;
  status: InlineAgentLoopStatus;
  currentStepIndex: number;
  steps: InlineAgentStepState[];
  totalToolExecutions: number;
  startedAt: number;
}

export interface InlineAgentTraceStepRecord {
  index: number;
  status: InlineAgentStepStatus;
  text: string;
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
  collapsed: boolean;
}

export interface InlineAgentTraceRecord {
  id: string;
  loopId: string;
  chatSessionId: string;
  anchorMessageId: number;
  url: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  status: InlineAgentLoopStatus;
  steps: InlineAgentTraceStepRecord[];
  totalSteps: number;
  totalTools: number;
  finalText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** For resume: the last known DeepSeek message ID to continue from. */
  lastParentMessageId?: number | null;
  /** For resume: prompt options (modelType, thinking, search, refFileIds). */
  promptOptions?: InlineAgentPromptOptions;
  /** For resume: accumulated tool executions across all steps. */
  allExecutions?: ToolExecutionRecord[];
  /** For resume: subagent result file paths on disk. */
  subagentResultFiles?: string[];
}

export interface InlineAgentStreamChunkMsg {
  loopId: string;
  stepIndex: number;
  text: string;
  fullText: string;
}

export interface InlineAgentToolDetectedMsg {
  loopId: string;
  stepIndex: number;
  call: ToolCall;
}

export interface InlineAgentStepCompleteMsg {
  loopId: string;
  stepIndex: number;
  responseMessageId: number | null;
  toolExecutions: ToolExecutionRecord[];
  /** For resume: the current parent message ID after this step. */
  parentMessageId?: number | null;
  /** For resume: accumulated tool executions across all steps so far. */
  allExecutions?: ToolExecutionRecord[];
  /** For resume: subagent result file paths collected so far. */
  subagentResultFiles?: string[];
}

export interface InlineAgentLoopCompleteMsg {
  loopId: string;
  totalSteps: number;
  totalTools: number;
  finalText: string;
}

export interface InlineAgentLoopErrorMsg {
  loopId: string;
  stepIndex: number;
  totalTools: number;
  error: string;
}

export const INLINE_AGENT_MAX_STEPS = 25;
export const INLINE_AGENT_MAX_NUDGES = 8;
export const INLINE_AGENT_STEP_TIMEOUT_MS = 120_000;
export const INLINE_AGENT_REQUEST_DELAY_MIN_MS = 2_500;
export const INLINE_AGENT_REQUEST_DELAY_MAX_MS = 6_500;

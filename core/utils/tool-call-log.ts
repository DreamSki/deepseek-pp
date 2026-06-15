import type {
  ToolCall,
  ToolExecutionTrigger,
  ToolResult,
} from '../types';
import { summarizeForLog } from './json-summarize';

export interface ToolCallLogEntry {
  at: string;
  source: ToolExecutionTrigger;
  tool: string;
  descriptorId?: string;
  payload: unknown;
  result: unknown;
}

export function buildToolCallLogEntry(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
  now = new Date(),
): ToolCallLogEntry {
  return {
    at: now.toISOString(),
    source,
    tool: call.name,
    descriptorId: call.descriptorId,
    payload: summarizeForLog(call.payload ?? {}),
    result: summarizeForLog({
      ok: result.ok,
      summary: result.summary,
      detail: result.detail,
      error: result.error,
      durationMs: result.durationMs,
      truncated: result.truncated,
      output: result.output,
    }),
  };
}

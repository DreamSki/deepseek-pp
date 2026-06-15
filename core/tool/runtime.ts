import {
  deleteMemory,
  getMemoryById,
  saveMemory,
  updateMemory,
} from '../memory/store';
import {
  executeMcpToolCall,
  getMcpToolDescriptors,
  refreshMcpServerDiscovery,
} from '../mcp/discovery';
import { getAllMcpServers } from '../mcp/store';
import type { Memory, NewMemory } from '../types';
import { appendToolCallHistory } from './history';
import {
  MEMORY_TOOL_DESCRIPTORS,
  executeMemoryToolCall,
  isMemoryToolName,
  type MemoryToolRuntime,
} from './memory';
import {
  executeSubAgentToolCall,
  type SubAgentProgressEvent,
  type SubAgentToolDeps,
} from './subagent';
import { isSubAgentToolName, SUBAGENT_TOOL_DESCRIPTORS } from './subagent-descriptors';
import {
  WEB_SEARCH_TOOL_DESCRIPTORS,
  executeWebSearchToolCall,
  isWebSearchToolName,
} from './web-search';
import { getWebToolSettings } from './web-settings';
import type { ToolCall, ToolDescriptor, ToolExecutionTrigger, ToolResult } from './types';
import { traceToolDispatch, traceToolResult, type TraceContext } from '../utils/tool-trace';
import { buildShellWriteCommand } from '../utils/safe-shell-write';
import { buildToolCallLogEntry } from '../utils/tool-call-log';

const memoryRuntime: MemoryToolRuntime = {
  async saveMemory(input: NewMemory) {
    const id = await saveMemory(input);
    return { id };
  },
  async getMemoryById(id: number) {
    return (await getMemoryById(id)) ?? null;
  },
  async updateMemory(memory: Memory) {
    await updateMemory(memory);
  },
  async deleteMemory(id: number) {
    await deleteMemory(id);
  },
};

export async function getRuntimeToolDescriptors(): Promise<ToolDescriptor[]> {
  const webSettings = await getWebToolSettings();
  const enabledWebDescriptors = WEB_SEARCH_TOOL_DESCRIPTORS.filter(
    (d) => webSettings[d.name as keyof typeof webSettings] !== false,
  );
  return [
    ...MEMORY_TOOL_DESCRIPTORS,
    ...enabledWebDescriptors,
    ...SUBAGENT_TOOL_DESCRIPTORS,
    ...await getMcpToolDescriptors(),
  ];
}

export async function refreshRuntimeToolDescriptors(): Promise<ToolDescriptor[]> {
  const servers = await getAllMcpServers({ includeSecrets: false });
  await Promise.all(
    servers
      .filter((server) => server.enabled)
      .map((server) => refreshMcpServerDiscovery(server.id)),
  );
  return getRuntimeToolDescriptors();
}

export async function executeRuntimeToolCall(
  call: ToolCall,
  source: ToolExecutionTrigger,
  options?: { signal?: AbortSignal },
): Promise<ToolResult> {
  const result = await executeToolCallWithoutHistory(call, options);
  await appendToolCallHistory(call, result, source);
  // Fire-and-forget trace so main-agent tool calls (esp. fast-mode) are visible
  void logToolCallToFile(call, result, source);
  return result;
}

async function logToolCallToFile(
  call: ToolCall,
  result: ToolResult,
  source: ToolExecutionTrigger,
): Promise<void> {
  try {
    const descriptors = await getRuntimeToolDescriptors();
    const shell = descriptors.find((d) => d.name === 'shell_exec');
    if (!shell) return;

    const entry = JSON.stringify(buildToolCallLogEntry(call, result, source));

    await executeMcpToolCall({
      name: 'shell_exec',
      provider: shell.provider,
      descriptorId: shell.id,
      invocationName: shell.invocationName ?? 'shell_exec',
      payload: { command: buildShellWriteCommand(`/tmp/dpp_main_tool_${Date.now()}.json`, entry) },
      raw: '',
    });
  } catch { /* trace is best-effort */ }
}

async function executeToolCallWithoutHistory(
  call: ToolCall,
  options?: { signal?: AbortSignal },
): Promise<ToolResult> {
  // Only trace manual/sidepanel calls here — agent_run and automation
  // are traced at content.ts and subagent.ts respectively to avoid double-logging.
  const trigger = (call.source as { trigger?: string } | undefined)?.trigger;
  const shouldTrace = trigger === 'manual_chat' || trigger === 'sidepanel_chat' || !trigger;
  const ctx: TraceContext = { source: 'manual', stepIndex: 0 };
  const traceId = shouldTrace ? traceToolDispatch(ctx, call) : -1;

  if (call.parseError) {
    const errResult: ToolResult = {
      ok: false,
      summary: '工具格式错误',
      detail: call.parseError.message,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: call.parseError,
    };
    if (shouldTrace) traceToolResult(traceId, ctx, call.name, errResult);
    return errResult;
  }

  let result: ToolResult;

  if (isMemoryToolName(call.name)) {
    result = await executeMemoryToolCall(memoryRuntime, call);
  } else if (isWebSearchToolName(call.name)) {
    result = await executeWebSearchToolCall(call);
  } else if (isSubAgentToolName(call.name)) {
    result = await executeSubAgentToolCall(call, resolveSubAgentDeps(options?.signal));
  } else if (call.provider?.kind === 'mcp' || call.descriptorId?.startsWith('mcp:')) {
    result = await executeMcpToolCall(call);
  } else {
    result = {
      ok: false,
      summary: '未知工具',
      detail: `Unsupported tool: ${call.name}`,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'tool_unsupported',
        message: `Unsupported tool: ${call.name}`,
        retryable: false,
      },
    };
  }

  if (shouldTrace) traceToolResult(traceId, ctx, call.name, result);
  return result;
}

// ---------------------------------------------------------------------------
// Sub-agent dependency resolver — avoids circular imports between
// subagent.ts ↔ runtime.ts
// ---------------------------------------------------------------------------

const subAgentProgressListeners = new Map<string, Set<(event: SubAgentProgressEvent) => void>>();

/** Register a listener for real-time subagent progress events. Called by the
 *  background script before executing subagent tool calls, so progress
 *  can be forwarded to the content script via chrome.tabs.sendMessage.
 *  Listeners are partitioned by parent run ID so concurrent tabs cannot
 *  receive each other's progress events. */
export function addSubAgentProgressListener(
  runId: string,
  listener: (event: SubAgentProgressEvent) => void,
): void {
  const listeners = subAgentProgressListeners.get(runId) ?? new Set();
  listeners.add(listener);
  subAgentProgressListeners.set(runId, listeners);
}

export function removeSubAgentProgressListener(
  runId: string,
  listener: (event: SubAgentProgressEvent) => void,
): void {
  const listeners = subAgentProgressListeners.get(runId);
  listeners?.delete(listener);
  if (listeners?.size === 0) subAgentProgressListeners.delete(runId);
}

function resolveSubAgentDeps(signal?: AbortSignal): SubAgentToolDeps {
  return {
    executeTool: (call: ToolCall) =>
      executeRuntimeToolCall(call, 'automation', { signal }),
    getToolDescriptors: () => getRuntimeToolDescriptors(),
    onProgress: (event) => {
      if (!event.runId) return;
      for (const listener of subAgentProgressListeners.get(event.runId) ?? []) {
        try { listener(event); } catch { /* don't let one listener break others */ }
      }
    },
    signal,
  };
}

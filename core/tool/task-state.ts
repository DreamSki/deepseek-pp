import type { ToolCall, ToolResult } from '../types';
import { makeSafeFileWriteCall } from '../utils/safe-shell-write';
import { debugLog } from '../utils/debug-log';
import { quoteShellArg } from '../utils/shell-quote';

// ---------------------------------------------------------------------------
// Task state persistence for subagent pipelines.
//
// Optional disk-state helpers for callers that need explicit checkpoints.
// The active inline-agent refresh path persists its trace through browser
// storage and tracks deterministic subagent result artifact paths.
// ---------------------------------------------------------------------------

const TASK_STATE_DIR = '/tmp';
const TASK_STATE_FILE_PREFIX = 'dpp_task_';

export interface SubAgentTaskEntry {
  chatSessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  resultFilePath?: string;
  spawnedAt: string;
  completedAt?: string;
  error?: string;
}

export interface TaskState {
  loopId: string;
  originalTask: string;
  createdAt: string;
  updatedAt: string;
  totalSteps: number;
  totalTools: number;
  subagents: SubAgentTaskEntry[];
  cleanupFiles: string[]; // files to delete on completion
}

export type ExecuteToolForState = (call: ToolCall) => Promise<ToolResult>;

function taskStatePath(loopId: string): string {
  return `${TASK_STATE_DIR}/${TASK_STATE_FILE_PREFIX}${loopId}.json`;
}

function makeShellExecCall(command: string): ToolCall {
  return {
    name: 'shell_exec',
    provider: { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'stdio_bridge' },
    descriptorId: 'mcp:shell:shell_exec',
    invocationName: 'shell_exec',
    payload: { command },
    raw: '',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createTaskState(loopId: string, originalTask: string): TaskState {
  return {
    loopId,
    originalTask,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalSteps: 0,
    totalTools: 0,
    subagents: [],
    cleanupFiles: [],
  };
}

/** Load existing task state from disk. Returns null if not found or unreadable. */
export async function loadTaskState(
  loopId: string,
  executeTool: ExecuteToolForState,
): Promise<TaskState | null> {
  const filePath = taskStatePath(loopId);
  const cmd = `cat ${quoteShellArg(filePath)} 2>/dev/null || echo '__DPP_NOT_FOUND__'`;
  try {
    const result = await executeTool(makeShellExecCall(cmd));
    const text = (result.detail || result.summary || '').trim();
    if (!text || text === '__DPP_NOT_FOUND__') return null;
    return JSON.parse(text) as TaskState;
  } catch {
    return null;
  }
}

/** Persist task state to disk. Best-effort — failures are logged but not thrown. */
export async function saveTaskState(
  state: TaskState,
  executeTool: ExecuteToolForState,
): Promise<void> {
  const filePath = taskStatePath(state.loopId);
  state.updatedAt = new Date().toISOString();

  const json = JSON.stringify(state, null, 2);

  try {
    const result = await executeTool(makeSafeFileWriteCall(filePath, json));
    if (!result.ok) {
      console.warn(`[DPP] task-state: failed to write ${filePath}: ${result.summary}`);
    }
  } catch (err) {
    console.warn(`[DPP] task-state: write error for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Record a subagent spawn in the task state and persist. */
export async function recordSubAgentSpawned(
  state: TaskState,
  chatSessionId: string,
  prompt: string,
  executeTool: ExecuteToolForState,
): Promise<void> {
  state.subagents.push({
    chatSessionId,
    prompt: prompt.slice(0, 500),
    status: 'running',
    spawnedAt: new Date().toISOString(),
  });
  await saveTaskState(state, executeTool);
}

/** Record a subagent completion in the task state and persist. */
export async function recordSubAgentCompleted(
  state: TaskState,
  chatSessionId: string,
  resultFilePath?: string,
  error?: string,
  executeTool?: ExecuteToolForState,
): Promise<void> {
  const entry = state.subagents.find((s) => s.chatSessionId === chatSessionId);
  if (!entry) return;
  entry.status = error ? 'failed' : 'complete';
  entry.completedAt = new Date().toISOString();
  if (resultFilePath) {
    entry.resultFilePath = resultFilePath;
    if (!state.cleanupFiles.includes(resultFilePath)) {
      state.cleanupFiles.push(resultFilePath);
    }
  }
  if (error) entry.error = error;
  if (executeTool) await saveTaskState(state, executeTool);
}

/** Update step counters in the task state. */
export async function updateTaskProgress(
  state: TaskState,
  totalSteps: number,
  totalTools: number,
  executeTool: ExecuteToolForState,
): Promise<void> {
  state.totalSteps = totalSteps;
  state.totalTools = totalTools;
  await saveTaskState(state, executeTool);
}

/** Clean up all temp files listed in the task state. Best-effort. */
export async function cleanupTaskFiles(
  state: TaskState,
  executeTool: ExecuteToolForState,
): Promise<void> {
  const filesToClean = [...state.cleanupFiles, taskStatePath(state.loopId)];
  if (filesToClean.length === 0) return;

  const paths = filesToClean.map(quoteShellArg).join(' ');
  try {
    await executeTool(makeShellExecCall(`rm -f ${paths} 2>/dev/null || true`));
    debugLog('task-state', `cleaned up ${filesToClean.length} temp files`);
  } catch (err) {
    console.warn(`[DPP] task-state: cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

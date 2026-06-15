import {
  buildDeepSeekSessionUrl,
  createChatSession,
  createPowHeaders,
  DeepSeekPayloadError,
  loadClientHeadersFromStorage,
  submitPrompt,
  type ModelTurn,
} from '../deepseek/adapter';
import { uploadImageToDeepSeek, uploadFileToDeepSeek } from '../deepseek/image-upload';
import { extractToolCalls } from '../interceptor/tool-parser';
import { logThinkingContent } from '../utils/conversation-logger';
// NOTE: We deliberately do NOT import addPendingImageFileId / drainPendingImageFileIds
// here. Those are module-level globals shared across ALL parallel subagents, causing
// image file_id cross-contamination (subagent A draining subagent B's uploaded images).
// Instead, each subagent session maintains its own local accRefFileIds / accModelType.
import {
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
} from './invocation';
import {
  clampText,
  createToolExecutionRecord,
  runToolContinuationLoop,
} from '../tool-loop/engine';
import type {
  ToolCall,
  ToolDescriptor,
  ToolExecutionRecord,
  ToolResult,
} from '../types';
import {
  SUBAGENT_TOOL_NAMES,
  type SubAgentToolName,
} from './subagent-descriptors';
import { makeSafeFileWriteCall } from '../utils/safe-shell-write';
import { debugLog } from '../utils/debug-log';
import { traceToolDispatch, traceToolResult, type TraceContext } from '../utils/tool-trace';
import { quoteShellArg } from '../utils/shell-quote';
import { readFileInChunks } from './chunked-read';
import { isInvalidRefFileIdText } from '../utils/ref-file-id';

// Re-export for convenience (descriptors + provider + guard are in subagent-descriptors.ts)
export {
  SUBAGENT_TOOL_DESCRIPTORS,
  SUBAGENT_TOOL_PROVIDER,
  SUBAGENT_TOOL_NAMES,
  isSubAgentToolName,
  type SubAgentToolName,
} from './subagent-descriptors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBAGENT_MAX_STEPS = 16;
const SUBAGENT_SESSION_TIMEOUT_MS = 300_000; // 5 minutes (whole session)
const SUBAGENT_MAX_RETRIES = 2; // retry up to 2 times on transient failures
const SUBAGENT_STEP_TIMEOUT_MS = 120_000;    // 2 minutes (per API call)
const SUBAGENT_MAX_RESULT_CHARS = 20_000;
const SUBAGENT_MAX_TASK_CHARS = 8_000;
const SUBAGENT_MAX_CONTINUATION_CHARS = 4_000;
const IMAGE_REF_RETRY_DELAYS_MS = [900, 2_000, 4_000];

// ---------------------------------------------------------------------------
// Dependencies injected by the runtime layer to avoid circular imports
// ---------------------------------------------------------------------------

/** Progress event emitted by a running subagent at each step. */
export interface SubAgentProgressEvent {
  /** Parent inline-agent run. Used to isolate concurrent tabs and runs. */
  runId?: string;
  /** The subagent's chat session ID (unique per spawn). */
  chatSessionId: string;
  /** Deterministic fallback artifact path, available once the session exists. */
  resultFilePath?: string;
  /** 1-based index among sibling subagents spawned in the same batch (1 = first). */
  subAgentIndex?: number;
  /** Current step index (0-based, 0 = starting, N = after step N complete). */
  step: number;
  /** Total steps executed so far (may increase as subagent runs). */
  stepsSoFar: number;
  /** What the subagent is doing right now. */
  status: 'starting' | 'thinking' | 'calling_tool' | 'step_done' | 'complete';
  /** Human-readable one-liner, e.g. "正在调用 shell_read_image 读取第 3 页". */
  summary: string;
  /** First 120 chars of the subagent's task for context. */
  taskPreview: string;
}

export interface SubAgentToolDeps {
  /** Execute a tool call and return the result. */
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  /** Return the current runtime tool descriptors (excluding spawn_subagent). */
  getToolDescriptors: () => Promise<ToolDescriptor[]>;
  /** Optional callback for real-time progress updates during subagent execution. */
  onProgress?: (event: SubAgentProgressEvent) => void;
  /** Cancels the whole subagent, including retries and continuation calls. */
  signal?: AbortSignal;
}

class SubAgentRunError extends Error {
  constructor(
    readonly code:
      | 'subagent_cancelled'
      | 'subagent_max_steps'
      | 'subagent_step_timeout'
      | 'subagent_failed',
    message: string,
    readonly partialResult?: {
      executions: ToolExecutionRecord[];
      finalText: string;
      resultFilePath?: string;
    },
  ) {
    super(message);
    this.name = 'SubAgentRunError';
  }
}

// ---------------------------------------------------------------------------
// Prompt cleaning — strips Python methodology that DeepSeek reasoner tends to
// inject even when told not to (PyMuPDF, fitz, pip install, etc.)
// ---------------------------------------------------------------------------

const PYTHON_METHODOLOGY_PATTERNS: readonly RegExp[] = [
  /\bpython_exec\b/i,
  /\bPyMuPDF\b/,
  /\bfitz\b/,
  /\bpdfplumber\b/i,
  /\bpip\s+install\b/i,
  /\bpage\.get_images\(/i,
  /\bpage\.get_drawings\(/i,
  /\bdoc\.(load|open)\b.*fitz/i,
  /使用\s*(Python\s*)?(的\s*)?(PyMuPDF|fitz|pdfplumber|库)/i,
  /请使用\s*Python/i,
  /Python\s*(的\s*)?(PyMuPDF|fitz)/i,
];

function stripPythonMethodology(original: string): string {
  let cleaned = original
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false; // will re-add spacing later
      return !PYTHON_METHODOLOGY_PATTERNS.some((pat) => pat.test(trimmed));
    })
    .join('\n');

  // Remove methodology sections often added by reasoner
  cleaned = cleaned.replace(/\n*分析要点[：:][\s\S]*?(?=\n\n|$)/g, '');
  cleaned = cleaned.replace(/\n*分析方法[：:][\s\S]*?(?=\n\n|$)/g, '');
  cleaned = cleaned.replace(/\n*- \s*(遍历每一页|提取所有嵌入|对每张图片记录|描述图片内容|注意区分|分析要点).*$/gm, '');

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Main entry point — called from executeToolCallWithoutHistory in runtime.ts
// ---------------------------------------------------------------------------

export async function executeSubAgentToolCall(
  call: ToolCall,
  deps: SubAgentToolDeps,
): Promise<ToolResult> {
  // [ENTRY PROBE] Write the main-agent's original prompt IMMEDIATELY, before
  // any await that could hang. Skipped in tests. Awaited (not fire-and-forget)
  // so we can observe whether executeMcpToolCall actually succeeds here.
  if ((import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test') {
    const probeData = JSON.stringify({
      at: new Date().toISOString(),
      modelType: call.payload.modelType ?? null,
      prompt: String(call.payload.prompt ?? '').slice(0, 8000),
    });
    try {
      const probeCall = await makeShellWriteToolCall(
        deps.getToolDescriptors,
        `/tmp/dpp_spawn_prompt_${Date.now()}.json`,
        probeData,
      );
      const probeResult = probeCall ? await deps.executeTool(probeCall) : null;
      // eslint-disable-next-line no-console
      console.log(
        '[DPP][probe] spawn_subagent entry write:',
        probeResult?.ok ? 'OK' : 'FAILED',
        '| summary:', probeResult?.summary ?? '',
        '| detail:', probeResult?.detail ?? '',
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[DPP][probe] spawn_subagent entry threw:', e instanceof Error ? e.message : String(e));
    }
  }

  if (deps.signal?.aborted) {
    return createSubAgentFailure(call, 'subagent_cancelled', '子代理已取消', '父任务已停止。', false);
  }

  // -- validate input -------------------------------------------------------
  const rawPrompt = call.payload.prompt;
  const prompt =
    typeof rawPrompt === 'string' ? stripPythonMethodology(rawPrompt.trim()) : '';
  if (!prompt) {
    return {
      ok: false,
      summary: '子代理任务不能为空',
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'subagent_empty_prompt',
        message: 'prompt is required',
        retryable: false,
      },
    };
  }

  if (prompt.length > SUBAGENT_MAX_TASK_CHARS * 2) {
    return {
      ok: false,
      summary: '子代理任务过长',
      detail: `任务描述最多 ${SUBAGENT_MAX_TASK_CHARS * 2} 字符，当前 ${prompt.length} 字符。`,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'subagent_prompt_too_long',
        message: `Prompt exceeds ${SUBAGENT_MAX_TASK_CHARS * 2} chars`,
        retryable: false,
      },
    };
  }

  const modelType =
    typeof call.payload.modelType === 'string'
      ? call.payload.modelType
      : null;

  const imagePaths = Array.isArray(call.payload.imagePaths)
    ? [...new Set(call.payload.imagePaths.filter(
        (path): path is string => typeof path === 'string' && path.trim().length > 0,
      ).map((path) => path.trim()))]
    : [];

  const backupFiles: string[] = Array.isArray(call.payload.backupFiles)
    ? call.payload.backupFiles.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : [];

  const rollbackOnFailure =
    call.payload.rollbackOnFailure === true;

  const stepTimeoutMs =
    typeof call.payload.timeoutMs === 'number' && call.payload.timeoutMs > 0
      ? Math.min(call.payload.timeoutMs, SUBAGENT_SESSION_TIMEOUT_MS)
      : SUBAGENT_STEP_TIMEOUT_MS;

  // Extract subagent index assigned by the caller (content.ts batch numbering)
  const subAgentIndex =
    typeof call.payload._subAgentIndex === 'number' && call.payload._subAgentIndex >= 1
      ? call.payload._subAgentIndex
      : undefined;

  // -- load auth headers ----------------------------------------------------
  let clientHeaders: Record<string, string>;
  try {
    const loaded = await loadClientHeadersFromStorage();
    if (!loaded?.Authorization) {
      return {
        ok: false,
        summary: '无法获取 DeepSeek 认证信息',
        detail:
          '请确保已登录 chat.deepseek.com，扩展需要缓存认证令牌后才能创建子代理会话。',
        name: call.name,
        provider: call.provider,
        descriptorId: call.descriptorId,
        error: {
          code: 'subagent_auth_missing',
          message: 'No cached auth token available',
          retryable: true,
        },
      };
    }
    clientHeaders = loaded;
  } catch (err) {
    return {
      ok: false,
      summary: '读取认证信息失败',
      detail: err instanceof Error ? err.message : String(err),
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: {
        code: 'subagent_auth_read_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
    };
  }

  const backupEntries = await backupFilesForSubAgent(backupFiles, deps.executeTool);
  const sessionTimeoutController = createTimeoutSignal(SUBAGENT_SESSION_TIMEOUT_MS);
  // Merge parent signal with session timeout — abort if either fires.
  const mergedController = new AbortController();
  const onParentAbort = () => mergedController.abort();
  const onTimeoutAbort = () => mergedController.abort();
  deps.signal?.addEventListener('abort', onParentAbort, { once: true });
  sessionTimeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
  if (deps.signal?.aborted || sessionTimeoutController.signal.aborted) {
    mergedController.abort();
  }
  const runSignal = mergedController.signal;
  const cleanupRunSignal = () => {
    deps.signal?.removeEventListener('abort', onParentAbort);
    sessionTimeoutController.signal.removeEventListener('abort', onTimeoutAbort);
    sessionTimeoutController.clear();
  };

  // -- run the sub-agent session (with retry) -------------------------------
  let lastError: unknown;
  try {
  for (let attempt = 0; attempt <= SUBAGENT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.warn(`[DPP] subagent: retry ${attempt}/${SUBAGENT_MAX_RETRIES} for task: ${prompt.slice(0, 100)}`);
      // Exponential backoff: 2s, 4s
      const shouldContinue = await waitWithSignal(2000 * attempt, runSignal);
      if (!shouldContinue) {
        lastError = sessionTimeoutController.signal.aborted && !deps.signal?.aborted
          ? new Error('Subagent session timed out during retry backoff')
          : new SubAgentRunError('subagent_cancelled', 'Subagent cancelled during retry backoff');
        break;
      }
    }

    try {
      const result = await runSubAgentSession(prompt, {
        modelType,
        clientHeaders,
        executeTool: deps.executeTool,
        getToolDescriptors: deps.getToolDescriptors,
        backupEntries,
        rollbackOnFailure,
        stepTimeoutMs,
        imagePaths,
        subAgentIndex,
        onProgress: deps.onProgress,
        signal: runSignal,
        runId: call.source?.runId,
      });

      // -- build a concise, informative summary ---------------------------
      const toolCount = result.executions.length;
      const toolSummary =
        toolCount > 0
          ? `子代理完成（${toolCount} 次工具调用）`
          : '子代理完成';
      const failedTools = result.executions.filter((e) => !e.result.ok);
      const suffix =
        failedTools.length > 0
          ? `，${failedTools.length} 次失败`
          : '';

      const outputData: Record<string, unknown> = {
        modelType: modelType ?? 'default',
        finalText: result.finalText,
        toolExecutions: result.executions.map((e) => ({
          tool: e.name,
          ok: e.result.ok,
          summary: e.result.summary,
        })),
        sessionUrl: result.sessionUrl,
        chatSessionId: result.chatSessionId,
        totalSteps: toolCount,
        ...(attempt > 0 ? { retried: attempt } : {}),
      };
      if (result.diffs.length > 0) outputData.diffs = result.diffs;
      if (result.backupsKept.length > 0) outputData.backupsKept = result.backupsKept;
      if (result.pendingSteps.length > 0) outputData.pendingSteps = result.pendingSteps;
      if (result.resultFilePath) outputData.resultFilePath = result.resultFilePath;

      // Vision results must be backed by the image manifest and read evidence.
      const credibility = assessVisionCredibility(
        modelType,
        result.executions,
        result.imageReads,
        imagePaths,
        result.finalText,
      );
      if (modelType === 'vision') {
        outputData.expectedImagePaths = imagePaths;
        outputData.imageEvidence = result.imageReads;
        outputData.successfulImagePaths = [...new Set(
          result.imageReads.filter((read) => read.uploaded).map((read) => read.path),
        )];
      }
      if (credibility.untrustworthy) {
        outputData.credibilityWarning = credibility.reasons;
        outputData._untrustworthy = true;
      }

      return {
        ok: !credibility.untrustworthy,
        summary: result.pendingSteps.length > 0
          ? `${toolSummary}${suffix} ⚠️ ${result.pendingSteps.length} 步骤待处理`
          : credibility.untrustworthy
            ? `${toolSummary}${suffix} ⚠️ 可信度低：${credibility.reasons.join('；')}`
            : `${toolSummary}${suffix}`,
        detail: result.finalText,
        name: call.name,
        provider: call.provider,
        descriptorId: call.descriptorId,
        ...(credibility.untrustworthy
          ? {
              error: {
                code: 'subagent_untrustworthy',
                message: credibility.reasons.join('；'),
                retryable: true,
              },
            }
          : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output: outputData as any,
      };
    } catch (err) {
      lastError = err;
      const isTimeout = sessionTimeoutController.signal.aborted;
      const isControlledStop = err instanceof SubAgentRunError;

      // A run-wide timeout is a hard deadline; only transient failures may retry.
      if (!deps.signal?.aborted && !isTimeout && !isControlledStop && attempt < SUBAGENT_MAX_RETRIES && isTransientSubAgentError(err)) {
        console.warn(`[DPP] subagent: attempt ${attempt + 1} failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      break;
    }
  }

  // -- all attempts exhausted — handle the last error ---------------------
  {
    const err = lastError;

    // Rollback backed-up files on failure if requested
    const rollbackResult = rollbackOnFailure
      ? await rollbackFilesForSubAgent(backupEntries, deps.executeTool)
      : { restored: [] as string[], failed: [] as string[] };

    const isTimeout = sessionTimeoutController.signal.aborted && !deps.signal?.aborted;
    const controlledCode = err instanceof SubAgentRunError ? err.code : null;
    const message =
      err instanceof Error ? err.message : String(err);

    const rollbackNote = rollbackResult.restored.length > 0
      ? `（已恢复 ${rollbackResult.restored.length} 个文件）`
      : rollbackResult.failed.length > 0
        ? `（${rollbackResult.failed.length} 个文件恢复失败）`
        : '';

    const errorCode = deps.signal?.aborted
      ? 'subagent_cancelled'
      : controlledCode ?? (isTimeout ? 'subagent_timeout' : 'subagent_failed');
    const summary = errorCode === 'subagent_cancelled'
      ? `子代理已取消${rollbackNote}`
      : errorCode === 'subagent_max_steps'
        ? `子代理达到最大步骤仍未完成${rollbackNote}`
        : errorCode === 'subagent_step_timeout' || errorCode === 'subagent_timeout'
          ? `子代理超时未完成${rollbackNote}`
          : `子代理执行失败（已重试 ${SUBAGENT_MAX_RETRIES} 次）${rollbackNote}`;

    // Write an error trace so failures (timeout / max-steps / error) are
    // diagnosable. The success path uses writeSubAgentResultToDisk, but that
    // is only reached on normal completion — the most failure-prone scenarios
    // (overloaded tasks hitting max-steps) skipped it entirely before this.
    // Fire-and-forget: do NOT await, so failure return (incl. cancel) is not
    // blocked by a pending/slow executeTool. The browser process outlives this
    // call, so the trace write still completes in practice.
    const errTrace = JSON.stringify({
      failedAt: new Date().toISOString(),
      modelType,
      errorCode,
      errorMessage: message,
      prompt: prompt.slice(0, 20_000),
      // Include partial execution info if available (from runSubAgentSession)
      partialExecutions: err instanceof SubAgentRunError ? (err as any).executions : undefined,
    });
    const tracePath = `/tmp/dpp_subagent_error_${Date.now()}.json`;
    void (async () => {
      try {
        const writeCall = await makeShellWriteToolCall(deps.getToolDescriptors, tracePath, errTrace);
        if (!writeCall) return;
        await deps.executeTool(writeCall);
        debugLog('subagent', `error trace written to ${tracePath}`);
      } catch (e) {
        debugLog('subagent', `failed to write error trace: ${e instanceof Error ? e.message : String(e)}`);
      }
})();

    return {
      ok: false,
      summary,
      detail: `${message}${rollbackNote}`,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output: rollbackResult.restored.length > 0 || rollbackResult.failed.length > 0
        ? { rolledBackFiles: rollbackResult.restored, rollbackFailedFiles: rollbackResult.failed } as any
        : undefined,
      error: {
        code: errorCode,
        message,
        retryable: errorCode !== 'subagent_cancelled' && errorCode !== 'subagent_max_steps',
      },
    };
  }
  } finally {
    cleanupRunSignal();
  }
}

// ---------------------------------------------------------------------------
// Internal: session lifecycle
// ---------------------------------------------------------------------------

interface SubAgentSessionOptions {
  modelType: string | null;
  clientHeaders: Record<string, string>;
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  getToolDescriptors: () => Promise<ToolDescriptor[]>;
  backupEntries: BackupEntry[];
  rollbackOnFailure: boolean;
  stepTimeoutMs: number;
  imagePaths: string[];
  onProgress?: (event: SubAgentProgressEvent) => void;
  /** 1-based index among sibling subagents spawned in the same batch. */
  subAgentIndex?: number;
  chatSessionId?: string; // pre-created session ID (set by runSubAgentSession)
  signal: AbortSignal;
  runId?: string;
}

interface FileDiffResult {
  file: string;
  summary: string;
  diff: string;
}

interface BackupEntry {
  file: string;
  backupPath: string;
  status: 'backed_up' | 'missing' | 'failed';
}

interface SubAgentSessionResult {
  finalText: string;
  executions: ToolExecutionRecord[];
  sessionUrl: string;
  chatSessionId: string;
  diffs: FileDiffResult[];
  backupsKept: string[];
  pendingSteps: string[];
  imageReads: ImageReadEvidence[];
  /** Path to the result file written to disk (bypasses message channel). */
  resultFilePath?: string;
}

interface ImageReadEvidence {
  path: string;
  toolOk: boolean;
  uploaded: boolean;
  mimeType?: string;
  size?: number;
  failure?: string;
}

async function runSubAgentSession(
  userTask: string,
  opts: SubAgentSessionOptions,
): Promise<SubAgentSessionResult> {
  let chatSessionId: string | undefined = undefined;

  const progress = (status: SubAgentProgressEvent['status'], summary: string, step: number, stepsSoFar: number) => {
    opts.onProgress?.({
      chatSessionId: chatSessionId ?? '',
      resultFilePath: chatSessionId ? subAgentResultPath(chatSessionId) : undefined,
      runId: opts.runId,
      subAgentIndex: opts.subAgentIndex,
      step,
      stepsSoFar,
      status,
      summary,
      taskPreview: userTask.slice(0, 120),
    });
  };

  throwIfAborted(opts.signal);

  // 1. Collect tool descriptors for the sub-agent (exclude spawn_subagent
  //    itself to prevent infinite recursion).
  const allDescriptors = await opts.getToolDescriptors();
  const descriptors = allDescriptors.filter(
    (d) => d.name !== 'spawn_subagent',
  );

  // 2. Create a fresh DeepSeek chat session.
  chatSessionId = await createChatSession(opts.clientHeaders, opts.signal);
  const sessionStartTime = Date.now();

  // Variables to accumulate session state for trace writing
  let finalText = '';
  let executions: ToolExecutionRecord[] = [];
  const pendingSteps: string[] = [];
  const turnTexts: string[] = [];
  const thinkingTexts: string[] = [];
  let imageDiagOk = 0;
  let imageDiagFail = 0;
  const imageDiagFailures: string[] = [];
  const imageReads: ImageReadEvidence[] = [];
  let parseErrorCount = 0;
  const parseErrorDetails: string[] = [];

  try {

  // 3. Build the augmented sub-agent prompt.
  const systemPrompt = buildSubAgentPrompt(userTask, descriptors, opts.modelType, opts.imagePaths);

  // 4. Submit the first prompt (non-streaming, with timeout).
  const sessionStartTime = Date.now();
  const powHeaders = await createPowHeaders(opts.clientHeaders);
  progress('thinking', '正在向子代理发送任务…', 0, 0);

  const turn = await submitPrompt(
    {
      chatSessionId,
      parentMessageId: null,
      modelType: opts.modelType,
      prompt: systemPrompt,
      refFileIds: [],
      thinkingEnabled: true,
      searchEnabled: false,
      clientHeaders: opts.clientHeaders,
      powHeaders,
    },
    opts.signal,
  );

  // 5. If the response contains tool calls, run a continuation loop.
  finalText = turn.assistantText;
  turnTexts.push(turn.assistantText);
  if (turn.thinkingText) {
    thinkingTexts.push(turn.thinkingText);
  }

  const modelToolCalls = extractToolCalls(turn.assistantText, {
    descriptors,
  });
  const toolCalls = selectSubAgentToolBatch(withRequiredVisionImageReads(
    modelToolCalls,
    descriptors,
    opts.modelType,
    opts.imagePaths,
  ));

  if (toolCalls.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    progress('calling_tool', `子代理正在调用 ${toolCalls.map((c) => c.name).join('、')}…`, 1, 0);
  }

  // Track accumulated ref_file_ids and vision mode across continuation steps
  let accRefFileIds: string[] = [];
  let accModelType: string | null = opts.modelType;

  if (toolCalls.length > 0 && turn.responseMessageId !== null) {
    let stepIndex = 0;
    let loop;
    try {
      loop = await runToolContinuationLoop<ModelTurn>({
      initialTurn: turn,
      initialToolCalls: toolCalls,
      maxDepth: SUBAGENT_MAX_STEPS,
      getAssistantText: (t) => t.assistantText,
      getParentMessageId: (t) => t.responseMessageId,
      extractToolCalls: (text) =>
        selectSubAgentToolBatch(extractToolCalls(text, { descriptors })),
      async executeToolCall(c, _parentMessageId) {
        // Guard: prevent recursive subagent spawning. The descriptor list
        // already excludes spawn_subagent, but the legacy DSML parser
        // (<｜DSML｜invoke name="spawn_subagent">) doesn't filter by catalog
        // and can still extract it. Block at execution time to be safe.
        if (c.name === 'spawn_subagent' || c.invocationName === 'spawn_subagent') {
          console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: blocked recursive spawn_subagent call`);
          return {
            name: c.name,
            provider: c.provider,
            descriptorId: c.descriptorId,
            result: {
              ok: false,
              summary: '子代理不能启动子代理',
              detail: 'spawn_subagent 在子代理会话中不可用。请直接使用当前可用的工具（shell_exec、python_exec、shell_upload_file 等）完成任务。',
              error: {
                code: 'subagent_recursion_blocked',
                message: 'spawn_subagent is not available inside a subagent session. Use the tools available to you directly.',
                retryable: false,
              },
            },
          };
        }

        // --- Tool trace: dispatch ---
        const subCtx: TraceContext = {
          source: 'sub',
          stepIndex,
          subIndex: opts.subAgentIndex,
        };
        const subTraceId = traceToolDispatch(subCtx, c);

        // Capture parse errors (AI-generated XML/JSON that couldn't be parsed).
        // These are otherwise invisible — the main agent sees "工具格式错误" but
        // not which invocation or why.
        if (c.parseError) {
          parseErrorCount++;
          const detail = `${c.parseError.details?.invocationName ?? c.invocationName ?? c.name}: ${c.parseError.message}`;
          parseErrorDetails.push(detail);
          console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} step ${stepIndex + 1}: parse error — ${detail}`);
        }

        progress('calling_tool', `子代理正在调用 ${c.name}…`, stepIndex + 1, stepIndex);
        const result = await awaitWithSignal(
          opts.executeTool({
            ...c,
            source: {
              trigger: 'automation',
              chatSessionId,
              runId: opts.runId,
            },
          }),
          opts.signal,
        );

        // Handle shell_read_image: upload the image to the sub-agent's
        // session so it can be seen in vision mode on the next turn.
        // IMPORTANT: push directly to the LOCAL accRefFileIds, not the global
        // pending-image-ids module. Parallel subagents share that global pool,
        // which causes image cross-contamination.
        if (c.name === 'shell_read_image') {
          const imgPath = typeof c.payload.path === 'string' ? c.payload.path : 'unknown';
          const evidence: ImageReadEvidence = {
            path: imgPath,
            toolOk: result.ok,
            uploaded: false,
          };
          imageReads.push(evidence);
          if (!result.ok) {
            evidence.failure = result.error?.message ?? result.detail ?? result.summary;
          }

          if (result.ok) {
          // Three fallback layers, each with retry:
          //   (a) extractBase64FromToolResult — normal output structure
          //   (b) re-read image via shell_exec base64 — last resort
          let imageData = extractBase64FromToolResult(result);
          if (!imageData) {
            // Second layer: check for tempDataUrl from MCP host's HTTP bridge.
            // The MCP host serves the temp file directly on 127.0.0.1, avoiding
            // native-messaging quota limits on large base64 payloads.
            const tempUrl = extractTempDataUrl(result);
            if (tempUrl) {
              // SSRF guard: only fetch from localhost
              if (!isSafeLocalhostUrl(tempUrl)) {
                console.warn('[DPP] subagent: rejecting non-localhost tempDataUrl', tempUrl);
              } else {
              console.log('[DPP] subagent: fetching image data via localhost HTTP bridge');
              try {
                const resp = await fetch(tempUrl);
                if (resp.ok) {
                  const raw = await resp.text();
                  const clean = raw.replace(/\s/g, '').trim();
                  if (clean && /^[A-Za-z0-9+/=]+$/.test(clean)) {
                    const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
                    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
                    imageData = { base64: clean, mimeType: mimeMap[ext] ?? 'image/png', size: base64ByteLength(clean) };
                  }
                }
              } catch (err) {
                console.warn('[DPP] subagent: HTTP bridge fetch failed', err);
              }
              }
            }
          }
          if (!imageData) {
            // Last resort: re-read the image file via chunked shell_exec
            console.warn('[DPP] subagent: no base64 in tool result, retrying with chunked shell_exec fallback');
            if (imgPath !== 'unknown') {
              // Guess MIME from extension (needed before chunked read)
              const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
              const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
              const guessedMime = mimeMap[ext] ?? 'image/png';
              const makeShellCall = (cmd: string) =>
                opts.executeTool({
                  name: 'shell_exec',
                  provider: c.provider,
                  descriptorId: c.descriptorId,
                  invocationName: 'shell_exec',
                  payload: { command: cmd },
                  raw: '',
                  source: { trigger: 'automation' as const, chatSessionId, runId: opts.runId },
                });
              const chunkResult = await awaitWithSignal(
                readFileInChunks(
                  (shellCmd) =>
                    makeShellCall(shellCmd).then((r) => ({
                      ok: r.ok,
                      stdout: extractStdoutFromToolResult(r),
                    })),
                  imgPath,
                  { isBase64Encoded: false },
                ),
                opts.signal,
              );
              if (chunkResult.ok && chunkResult.base64) {
                const base64 = chunkResult.base64.trim();
                imageData = { base64, mimeType: guessedMime, size: base64ByteLength(base64) };
              }
            }
          }
          if (imageData) {
            evidence.mimeType = imageData.mimeType;
            evidence.size = imageData.size;
            // Exponential backoff with jitter for image upload retries.
            // DeepSeek returns biz_code=7 "rate limit reached" when parallel
            // subagents upload simultaneously. Fixed 1.5s delay + only 2
            // attempts caused thundering-herd re-triggers. Jitter spreads
            // retry timing across subagents so they don't collide again.
            const UPLOAD_BACKOFF_MS = [2_000, 5_000, 10_000];
            let fileId: string | null = null;
            for (let uploadAttempt = 0; uploadAttempt <= UPLOAD_BACKOFF_MS.length; uploadAttempt++) {
              if (uploadAttempt > 0) {
                const baseDelay = UPLOAD_BACKOFF_MS[uploadAttempt - 1]!;
                const jitter = Math.random() * baseDelay * 0.5;
                const delay = Math.round(baseDelay + jitter);
                console.warn(`[DPP] subagent: retrying image upload (attempt ${uploadAttempt + 1}/${UPLOAD_BACKOFF_MS.length + 1}, delay ${delay}ms)`);
                await new Promise((r) => setTimeout(r, delay));
              }
              fileId = await uploadImageToDeepSeek({
                base64: imageData.base64,
                mimeType: imageData.mimeType,
                size: imageData.size,
                authHeaders: opts.clientHeaders,
              });
              if (fileId) break;
            }
            if (fileId) {
              accRefFileIds.push(fileId);
              accModelType = 'vision';
              imageDiagOk++;
              evidence.uploaded = true;
              console.log(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: image upload OK — ${imgPath} (${accRefFileIds.length} total, ${imageDiagOk} ok, ${imageDiagFail} failed for this session)`);
            } else {
              imageDiagFail++;
              const reason = `upload failed after retries: ${imgPath}`;
              imageDiagFailures.push(reason);
              evidence.failure = reason;
              console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: ${reason}`);
            }
          } else {
            imageDiagFail++;
            const reason = `no image data after all fallbacks: ${imgPath}`;
            imageDiagFailures.push(reason);
            evidence.failure = reason;
            console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: ${reason}`);
          }
          }
        }

        // Handle shell_upload_file: upload any file to the sub-agent's session.
        // Images use vision mode, documents use default mode.
        if (c.name === 'shell_upload_file') {
          const filePath = typeof c.payload.path === 'string' ? c.payload.path : 'unknown';
          if (result.ok) {
            let fileData = extractBase64FromToolResult(result);
            if (!fileData && filePath !== 'unknown') {
              // Second layer: check for tempDataUrl from MCP host's HTTP bridge.
              const tempUrl = extractTempDataUrl(result);
              if (tempUrl) {
                // SSRF guard: only fetch from localhost
                if (!isSafeLocalhostUrl(tempUrl)) {
                  console.warn('[DPP] subagent: rejecting non-localhost tempDataUrl for file', tempUrl);
                } else {
                console.log('[DPP] subagent: fetching file data via localhost HTTP bridge');
                try {
                  const resp = await fetch(tempUrl);
                  if (resp.ok) {
                    const raw = await resp.text();
                    const clean = raw.replace(/\s/g, '').trim();
                    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
                    const mimeMap: Record<string, string> = {
                      pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                      ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                      txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
                      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
                    };
                    fileData = { base64: clean, mimeType: mimeMap[ext] ?? 'application/octet-stream', size: base64ByteLength(clean) };
                  }
                } catch (err) {
                  console.warn('[DPP] subagent: HTTP bridge fetch failed', err);
                }
                }
              }
            }
            if (!fileData && filePath !== 'unknown') {
              // Fallback: re-read via chunked shell_exec to handle large files
              // Guess MIME from extension (needed before chunked read)
              const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
              const mimeMap: Record<string, string> = {
                pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
              };
              const guessedMime = mimeMap[ext] ?? 'application/octet-stream';
              const makeShellCall = (cmd: string) =>
                opts.executeTool({
                  name: 'shell_exec',
                  provider: c.provider,
                  descriptorId: c.descriptorId,
                  invocationName: 'shell_exec',
                  payload: { command: cmd },
                  raw: '',
                  source: { trigger: 'automation' as const, chatSessionId, runId: opts.runId },
                });
              const chunkResult = await awaitWithSignal(
                readFileInChunks(
                  (shellCmd) =>
                    makeShellCall(shellCmd).then((r) => ({
                      ok: r.ok,
                      stdout: extractStdoutFromToolResult(r),
                    })),
                  filePath,
                  { isBase64Encoded: false },
                ),
                opts.signal,
              );
              if (chunkResult.ok && chunkResult.base64) {
                const base64 = chunkResult.base64.trim();
                fileData = { base64, mimeType: guessedMime, size: base64ByteLength(base64) };
              }
            }
            if (fileData) {
              const isImage = fileData.mimeType.startsWith('image/');
              const UPLOAD_BACKOFF_MS = [2_000, 5_000, 10_000];
              let fileId: string | null = null;
              for (let uploadAttempt = 0; uploadAttempt <= UPLOAD_BACKOFF_MS.length; uploadAttempt++) {
                if (uploadAttempt > 0) {
                  const baseDelay = UPLOAD_BACKOFF_MS[uploadAttempt - 1]!;
                  const jitter = Math.random() * baseDelay * 0.5;
                  const delay = Math.round(baseDelay + jitter);
                  console.warn(`[DPP] subagent: retrying file upload (attempt ${uploadAttempt + 1}/${UPLOAD_BACKOFF_MS.length + 1}, delay ${delay}ms)`);
                  await new Promise((r) => setTimeout(r, delay));
                }
                fileId = await uploadFileToDeepSeek({
                  base64: fileData.base64,
                  mimeType: fileData.mimeType,
                  size: fileData.size,
                  filename: filePath,
                  authHeaders: opts.clientHeaders,
                  isVisionFile: isImage,
                });
                if (fileId) break;
              }
              if (fileId) {
                accRefFileIds.push(fileId);
                if (isImage) accModelType = 'vision';
                result.summary = `文件已成功上传，并作为原生附件挂载到子代理会话：${filePath}`;
                result.detail = '下一轮可直接读取该原生附件。不要解码 Base64，也不要改用 shell 或 Python 库解析文件。';
                result.output = {
                  data: {
                    path: filePath,
                    mimeType: fileData.mimeType,
                    size: fileData.size,
                  },
                  uploadedFileId: fileId,
                  nativeAttachmentReady: true,
                };
                console.log(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: file upload OK — ${filePath} (vision=${isImage}, ${accRefFileIds.length} total refFileIds)`);
              } else {
                console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: file upload failed after retries: ${filePath}`);
              }
            } else {
              console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: no file data after all fallbacks: ${filePath}`);
            }
          }
        }

        stepIndex++;
        // --- Tool trace: result (after all upload processing) ---
        {
          let traceExtras: string | undefined;
          if (c.name === 'shell_read_image') {
            const uploaded = imageReads[imageReads.length - 1]?.uploaded;
            traceExtras = uploaded ? `uploaded file_id=${accRefFileIds[accRefFileIds.length - 1] ?? '?'}` : 'upload failed or skipped';
          } else if (c.name === 'shell_upload_file') {
            traceExtras = result.ok ? `uploaded (${accRefFileIds.length} total refFileIds)` : 'upload failed';
          }
          traceToolResult(subTraceId, subCtx, c.name, result, traceExtras);
        }
        progress('step_done', `子代理已完成 ${c.name}（${result.ok ? '成功' : '失败'}）`, stepIndex, stepIndex);

        return createToolExecutionRecord(c, result, {
          detailMaxLength: SUBAGENT_MAX_CONTINUATION_CHARS,
          outputMaxLength: SUBAGENT_MAX_CONTINUATION_CHARS * 2,
        });
      },
      buildContinuationPrompt: (execs) =>
        buildSubAgentContinuationPrompt(userTask, execs),
      submitContinuation: async (contPrompt, parentMessageId) => {
        // accRefFileIds and accModelType are already maintained locally
        // by executeToolCall (no global pending-image-ids needed).

        throwIfAborted(opts.signal);
        let pHeaders = await createPowHeaders(opts.clientHeaders);
        const stepTimeout = createStepTimeoutSignal(opts.signal, opts.stepTimeoutMs);
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              const t = await submitPrompt(
                {
                  chatSessionId,
                  parentMessageId,
                  modelType: accModelType,
                  prompt: contPrompt,
                  refFileIds: accRefFileIds,
                  thinkingEnabled: true,
                  searchEnabled: false,
                  clientHeaders: opts.clientHeaders,
                  powHeaders: pHeaders,
                },
                stepTimeout.signal,
              );
              turnTexts.push(t.assistantText);
              if (t.thinkingText) {
                thinkingTexts.push(t.thinkingText);
              }
              return t;
            } catch (err) {
              const invalidRefFileId = err instanceof DeepSeekPayloadError &&
                isInvalidRefFileIdText(err.message);
              if (
                !invalidRefFileId ||
                accRefFileIds.length === 0 ||
                attempt >= IMAGE_REF_RETRY_DELAYS_MS.length
              ) {
                throw err;
              }
              const waited = await waitWithSignal(
                IMAGE_REF_RETRY_DELAYS_MS[attempt]!,
                stepTimeout.signal,
              );
              if (!waited) throw err;
              pHeaders = await createPowHeaders(opts.clientHeaders);
            }
          }
        } catch (err) {
          if (stepTimeout.timedOut()) {
            pendingSteps.push(contPrompt.slice(0, 200));
            throw new SubAgentRunError(
              'subagent_step_timeout',
              `Subagent step timed out after ${opts.stepTimeoutMs}ms`,
            );
          }
          if (opts.signal.aborted) {
            throw new SubAgentRunError('subagent_cancelled', 'Subagent cancelled');
          }
          throw err;
        } finally {
          stepTimeout.clear();
        }
      },
    });

    if (loop.exhausted) {
      throw new SubAgentRunError(
        'subagent_max_steps',
        `Subagent still requested tools after ${SUBAGENT_MAX_STEPS} steps`,
      );
    }
    finalText = loop.turn.assistantText;
    executions = loop.executions;
  } catch (err) {
    // If the loop fails partway through, we still want to preserve partial results
    if (err instanceof SubAgentRunError) {
      // Re-throw with context preserved
      throw err;
    }
    // For other errors, wrap with partial execution info if available
    if (executions.length > 0) {
      console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} loop failed after ${executions.length} tool calls, preserving partial state`);
      throw new SubAgentRunError(
        'subagent_failed',
        err instanceof Error ? err.message : String(err),
        { executions, finalText },
      );
    }
    throw err;
  }
  }

  // -- Extract AI's self-diagnostic [诊断] section and log it -----------------
  const aiDiag = extractDiagnosticSection(finalText);
  if (aiDiag) {
    console.log(`[DPP] subagent #${opts.subAgentIndex ?? '?'} self-diagnostic:\n${aiDiag}`);
  } else {
    console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'}: no [诊断] section in response (session ${chatSessionId.slice(0, 8)}…)`);
  }

  // -- Build programmatic diagnostic summary ----------------------------------
  const diagDurationMs = Date.now() - sessionStartTime;
  const diagLine = [
    `[DPP] subagent #${opts.subAgentIndex ?? '?'} session summary:`,
    `${imageDiagOk}/${imageDiagOk + imageDiagFail} images uploaded`,
    `${parseErrorCount} parse errors`,
    `${pendingSteps.length} step timeouts`,
    `${executions.length} tool calls`,
    `${(diagDurationMs / 1000).toFixed(1)}s`,
  ].join(' | ');
  console.log(diagLine);
  if (imageDiagFailures.length > 0) {
    console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} image failures:`, imageDiagFailures);
  }
  if (parseErrorDetails.length > 0) {
    console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} parse errors:`, parseErrorDetails);
  }

  // 6. Write a fallback result artifact FIRST — this ensures that even if
  //    subsequent steps (diffs, URL building, etc.) fail, we still have a
  //    complete trace of what the subagent accomplished.
  let resultFilePath: string | undefined;
  try {
    resultFilePath = await writeSubAgentResultToDisk(
      opts.executeTool,
      opts.getToolDescriptors,
      chatSessionId,
      finalText,
      executions,
      pendingSteps,
      turnTexts,
      thinkingTexts,
      userTask,
      opts.modelType,
    );
    console.log(`[DPP] subagent #${opts.subAgentIndex ?? '?'} trace written to ${resultFilePath}`);
  } catch (err) {
    console.error(`[DPP] subagent #${opts.subAgentIndex ?? '?'} failed to write trace:`, err);
    // Don't let trace write failure fail the entire session — we still have
    // the in-memory results to return to the parent.
  }

  // 7. Compute diffs for backed-up files (non-critical: failure doesn't lose results).
  let diffs: FileDiffResult[] = [];
  let backupsKept: string[] = [];
  try {
    progress('complete', `子代理完成（${executions.length} 次工具调用，${pendingSteps.length} 步待处理）`, executions.length, executions.length);
    diffs = await diffFilesForSubAgent(opts.backupEntries, opts.executeTool);
    backupsKept = opts.backupEntries
      .filter((entry) => entry.status === 'backed_up')
      .map((entry) => entry.backupPath);
  } catch (err) {
    console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} failed to compute diffs:`, err);
    // Continue without diffs — not critical for session result
  }

  // 8. Build the session URL and truncate overly-long output.
  const sessionUrl = buildDeepSeekSessionUrl(chatSessionId);
  const truncatedText =
    finalText.length > SUBAGENT_MAX_RESULT_CHARS
      ? finalText.slice(0, SUBAGENT_MAX_RESULT_CHARS) +
        '\n\n...[子代理输出已截断]'
      : finalText;

  // If any steps timed out, append a pending marker so the main agent
  // knows there is unfinished work.
  const pendingNote = pendingSteps.length > 0
    ? `\n\n⚠️ 待处理：${pendingSteps.length} 个步骤在 ${opts.stepTimeoutMs / 1000}s 内未响应，已标记为待处理。请主代理跟进：\n${pendingSteps.map((s, i) => `  ${i + 1}. ${s}...`).join('\n')}`
    : '';

  // Build programmatic diagnostic note — appended at end so the main agent
  // can see upload/parse issues even if the AI's [诊断] is missing or wrong.
  const diagParts: string[] = [];
  if (imageDiagOk > 0 || imageDiagFail > 0) {
    diagParts.push(`📊 图片上传：${imageDiagOk} 成功 / ${imageDiagFail} 失败`);
    if (imageDiagFailures.length > 0) {
      diagParts.push(`  失败详情：${imageDiagFailures.join('；')}`);
    }
  }
  if (parseErrorCount > 0) {
    diagParts.push(`⚠️ JSON 解析错误：${parseErrorCount} 次`);
    if (parseErrorDetails.length > 0) {
      diagParts.push(`  详情：${parseErrorDetails.join('；')}`);
    }
  }
  if (!aiDiag) {
    diagParts.push('⚠️ 子代理未提供 [诊断] 自检段落');
  }
  const diagNote = diagParts.length > 0
    ? `\n\n---\n## 系统诊断\n${diagParts.join('\n')}\n耗时：${(diagDurationMs / 1000).toFixed(1)}s`
    : '';

  return {
    finalText: truncatedText + pendingNote + diagNote,
    executions,
    sessionUrl,
    chatSessionId,
    diffs,
    backupsKept,
    pendingSteps,
    imageReads,
    resultFilePath,
  };

  } catch (err) {
    // If the subagent session fails after some tool calls have succeeded,
    // we still want to preserve a trace of what was accomplished.
    if (executions.length > 0 && chatSessionId) {
      console.warn(`[DPP] subagent #${opts.subAgentIndex ?? '?'} session failed after ${executions.length} tool calls, writing partial trace`);
      try {
        await writeSubAgentResultToDisk(
          opts.executeTool,
          opts.getToolDescriptors,
          chatSessionId,
          finalText || `子代理会话异常结束: ${err instanceof Error ? err.message : String(err)}`,
          executions,
          pendingSteps,
          turnTexts,
          thinkingTexts,
          userTask,
          opts.modelType,
        );
      } catch (traceErr) {
        console.error(`[DPP] subagent #${opts.subAgentIndex ?? '?'} failed to write partial trace:`, traceErr);
      }
    }
    throw err;
  }
}

function selectSubAgentToolBatch(calls: readonly ToolCall[]): ToolCall[] {
  const uploads = calls.filter((call) => call.name === 'shell_upload_file');
  if (uploads.length === 0) return [...calls];

  const seenPaths = new Set<string>();
  return uploads.filter((call) => {
    const path = typeof call.payload.path === 'string'
      ? call.payload.path
      : JSON.stringify(call.payload);
    if (seenPaths.has(path)) return false;
    seenPaths.add(path);
    return true;
  });
}

function withRequiredVisionImageReads(
  modelCalls: readonly ToolCall[],
  descriptors: readonly ToolDescriptor[],
  modelType: string | null,
  imagePaths: readonly string[],
): ToolCall[] {
  if (modelType !== 'vision' || imagePaths.length === 0) return [...modelCalls];

  const imageDescriptor = descriptors.find((descriptor) => descriptor.name === 'shell_read_image');
  if (!imageDescriptor) return [...modelCalls];

  // Collect all paths the AI attempted to read, even those with parse errors.
  // A call with a parse error may still have the correct path — re-adding it
  // would cause a duplicate read on the next turn.
  const declaredPaths = new Set(
    modelCalls
      .filter((call) => call.name === 'shell_read_image')
      .map((call) => call.payload.path)
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0),
  );
  const requiredCalls = imagePaths
    .filter((path) => !declaredPaths.has(path))
    .map<ToolCall>((path) => ({
      name: imageDescriptor.name,
      invocationName: imageDescriptor.invocationName,
      descriptorId: imageDescriptor.id,
      provider: imageDescriptor.provider,
      payload: { path },
      raw: '',
    }));

  return [...modelCalls, ...requiredCalls];
}

// ---------------------------------------------------------------------------
// Result file persistence (bypasses unreliable message-passing channel)
// ---------------------------------------------------------------------------

const SUBAGENT_RESULT_DIR = '/tmp';
const SUBAGENT_RESULT_FILE_PREFIX = 'dpp_subagent_';

function subAgentResultPath(chatSessionId: string): string {
  return `${SUBAGENT_RESULT_DIR}/${SUBAGENT_RESULT_FILE_PREFIX}${chatSessionId}.json`;
}

/**
 * Build a shell_exec ToolCall that writes content to a file, using the REAL
 * shell_exec descriptor's provider. The shell MCP server id is generated
 * dynamically at storage time (not a fixed literal), so it cannot be hardcoded
 * — hardcoding makes executeMcpToolCall return "MCP server not found".
 */
async function makeShellWriteToolCall(
  getToolDescriptors: () => Promise<ToolDescriptor[]>,
  filePath: string,
  content: string,
): Promise<ToolCall | null> {
  try {
    const descriptors = await getToolDescriptors();
    const shell = descriptors.find((d) => d.name === 'shell_exec');
    if (!shell) return null;
    return makeSafeFileWriteCall(filePath, content, shell.provider, shell.id);
  } catch {
    return null;
  }
}

async function writeSubAgentResultToDisk(
  executeTool: (call: ToolCall) => Promise<ToolResult>,
  getToolDescriptors: () => Promise<ToolDescriptor[]>,
  chatSessionId: string,
  finalText: string,
  executions: ToolExecutionRecord[],
  pendingSteps: string[],
  turnTexts?: string[],
  thinkingTexts?: string[],
  originalPrompt?: string,
  modelType?: string | null,
): Promise<string | undefined> {
  const filePath = subAgentResultPath(chatSessionId);
  const payload = {
    chatSessionId,
    completedAt: new Date().toISOString(),
    modelType: modelType ?? null,
    prompt: (originalPrompt ?? '').slice(0, 20_000),
    totalSteps: executions.length,
    finalText: finalText.slice(0, 20_000),
    toolExecutions: executions.map((e) => ({
      tool: e.name,
      ok: e.result.ok,
      summary: e.result.summary?.slice(0, 500),
    })),
    pendingSteps: pendingSteps.slice(0, 10),
    turns: (turnTexts ?? []).map((text) => text.slice(0, 4000)),
    thinkingTexts: (thinkingTexts ?? []).map((text) => text.slice(0, 8000)),
  };

  const json = JSON.stringify(payload);

  try {
    const writeCall = await makeShellWriteToolCall(getToolDescriptors, filePath, json);
    if (!writeCall) {
      debugLog('subagent', 'result file write skipped: no shell_exec descriptor available');
      return undefined;
    }
    const result = await executeTool(writeCall);
    if (result.ok) {
      debugLog('subagent', `result written to ${filePath} (${json.length} bytes)`);
      return filePath;
    }
    debugLog('subagent', `result file write failed (non-fatal fallback): ${result.summary}`);
    return undefined;
  } catch (err) {
    debugLog('subagent', `result file write error (non-fatal fallback): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSubAgentPrompt(
  userTask: string,
  descriptors: readonly ToolDescriptor[],
  modelType: string | null,
  imagePaths: readonly string[],
): string {
  const compactTools = renderCompactToolList(descriptors);
  const firstTool = descriptors[0];
  const exampleName = firstTool
    ? getPreferredToolInvocationName(firstTool, createToolInvocationCatalog(descriptors))
    : 'shell_exec';

  const isVisionMode = modelType === 'vision';
  const modeGuidance = isVisionMode
    ? [
        '## 当前子代理模式：识图模式',
        '- 这是子代理自己的实际模式，不继承主代理的模式名称。',
      ].join('\n')
    : modelType === 'expert'
      ? [
          '## 当前子代理模式：专家模式',
          '- 这是子代理自己的实际模式，不继承主代理的模式名称。',
          '- 专家模式不能挂载原生文件附件；涉及文档上传时应由快速模式子代理执行。',
        ].join('\n')
      : [
          '## 当前子代理模式：快速模式',
          '- 这是子代理自己的实际模式，不继承主代理的模式名称。不要声称自己处于专家模式。',
          '- 调用 shell_upload_file 是把文件挂载为 DeepSeek 原生附件，不是让你读取或解析 Base64。',
          '- 你的角色：上传文件 → DeepSeek 读原生附件 → 基于附件内容如实回答。',
          '- 你是"上传+阅读"助手，不是 PDF 程序化分析器。上传成功后直接读附件回答，能读到什么就说什么。',
          '- Task 要求的精确数据（如坐标、像素尺寸）如果附件中读不到，诚实说明"原生附件无法获取此信息"即可——不要用 python_exec、shell_exec 等工具去弥补。',
        ].join('\n');
  const imageGuidance = isVisionMode
    ? [
        '**You are in a VISION-CAPABLE session.** You CAN see images.',
        '- Call shell_read_image with the file path. The image will be VISIBLE to you in your NEXT turn — directly describe what you see: colors, objects, text, layout, people, etc.',
        '- Do NOT say you cannot see images. Do NOT try to delegate image analysis to another agent.',
        '- You CAN call multiple shell_read_image in one turn to batch-upload images. Do NOT mix shell_read_image with other tools in the same turn.',
        ...(imagePaths.length > 0
          ? [
              `- REQUIRED IMAGE MANIFEST (${imagePaths.length} files):`,
              ...imagePaths.map((path, index) => `  ${index + 1}. ${path}`),
              '- Read every manifest path exactly once. Identify images only by these full paths, never by inferred page numbers.',
              '- ⚠️ 重要：每张图片只需要读取一次。读取后在下一轮会直接可见，不要重复读取同一张图片。',
            ]
          : []),
        '- Never invent pixel dimensions or bbox coordinates. Before returning any pixel bbox, call shell_analyze_image for the same path and use its measured dimensions.',
      ].join('\n')
    : [
        'You are NOT in a vision-capable session. You cannot directly view images.',
        '- Use shell_exec or python_exec to analyze image files via command-line tools (file, sips, identify, Pillow, etc.).',
      ].join('\n');

  return [
    `You have tools. To call a tool, output an XML block with the tool name as the tag and JSON as the body, exactly like this:`,
    '',
    `<${exampleName}>`,
    `{"command": "ls ~/Downloads"}`,
    `</${exampleName}>`,
    '',
    'The JSON body MUST be valid JSON. Do NOT add any other text inside the tags.',
    'You can place tool calls anywhere in your reply.',
    '',
    modeGuidance,
    '',
    imageGuidance,
    '',
    compactTools,
    '',
    'Task: ' + userTask,
    '',
    '---',
    '## 自诊断（必须执行）',
    '完成任务后，在回复**末尾**附加此段落：',
    '',
    '[诊断]',
    '- 任务要求的文件/图片数：（填数字）',
    '- 实际读到的文件/图片数：（填数字）',
    '- 工具调用失败：有/无（如有，列出失败的工具和原因）',
    '- 遇到格式错误（JSON 解析失败等）：有/无',
    '- 其他异常：（有则描述，无则写"无"）',
    '',
    '必须诚实报告。这是系统自动检测所需的关键信息。',
  ].join('\n');
}

function buildSubAgentContinuationPrompt(
  originalTask: string,
  executions: ToolExecutionRecord[],
): string {
  const results = executions.map((e) => ({
    tool: e.name,
    ok: e.result.ok,
    summary: e.result.summary,
    detail: clampText(e.result.detail, SUBAGENT_MAX_CONTINUATION_CHARS),
  }));
  const hasFailures = executions.some((e) => !e.result.ok);

  // Detect if the last step included shell_read_image — if so, the image
  // is now visible in vision mode and the AI should describe it, not call tools.
  const justReadImage = executions.some((e) => e.name === 'shell_read_image' && e.result.ok);
  const justUploadedFiles = executions.filter((e) => {
    if (e.name !== 'shell_upload_file' || !e.result.ok) return false;
    const output = e.result.output;
    const hasAttachmentMarker = Boolean(output && typeof output === 'object' &&
      (output as Record<string, unknown>).nativeAttachmentReady === true);
    return hasAttachmentMarker || e.result.summary.includes('作为原生附件挂载');
  });

  if (justUploadedFiles.length > 0) {
    return [
      `✅ You just uploaded ${justUploadedFiles.length} file(s). They are NOW attached to this subagent session as native DeepSeek attachments.`,
      '',
      '【最重要：文件已作为原生附件挂载到当前会话，DeepSeek 可以直接读取附件内容。】',
      '直接基于附件内容完成用户任务，报告你从附件中实际看到的信息。',
      '你是"上传+阅读"角色——不需要、也不应该调用 python_exec、shell_exec 等工具重新解析已上传的文件。',
      '如果 Task 要求的内容（如精确坐标）从附件中无法获取，诚实说明即可——不必用其他方式弥补。',
      '只有在明确收到"无法读取附件"或"附件为空"的错误时，才考虑其他方式。',
      '',
      'Task: ' + clampText(originalTask, SUBAGENT_MAX_TASK_CHARS),
      '',
      'When the task is complete, end your response with:',
      '[诊断]',
      '- 任务要求的文件/图片数：（填数字）',
      '- 实际读到的文件/图片数：（填数字）',
      '- 工具调用失败：有/无（如有，列出失败的工具和原因）',
      '- 遇到格式错误（JSON 解析失败等）：有/无',
      '- 其他异常：（有则描述，无则写"无"）',
    ].join('\n');
  }

  if (justReadImage) {
    const imageCount = executions.filter((e) => e.name === 'shell_read_image' && e.result.ok).length;
    return [
      `You just uploaded ${imageCount} image(s) via shell_read_image. ALL of them are NOW VISIBLE to you in vision mode.`,
      '',
      'Look at each image and describe what you see. For each figure:',
      '- Type of figure (chart, diagram, photo, etc.)',
      '- Axes, scales, units, data trends, key values, patterns',
      '- Labels, legends, annotations, conclusion',
      '',
      'If you still have more images to read, you can call shell_read_image again now.',
      'Otherwise, describe all uploaded images in this turn.',
      '',
      'Task: ' + clampText(originalTask, SUBAGENT_MAX_TASK_CHARS),
      '',
      '⚠️ At the end of your final response, include the self-diagnostic section:',
      '[诊断]',
      '- 任务要求的文件/图片数：（填数字）',
      '- 实际读到的文件/图片数：（填数字）',
      '- 工具调用失败：有/无（如有，列出失败的工具和原因）',
      '- 遇到格式错误（JSON 解析失败等）：有/无',
      '- 其他异常：（有则描述，无则写"无"）',
    ].join('\n');
  }

  return [
    `Step ${executions.length}/${SUBAGENT_MAX_STEPS}. ` +
      (hasFailures ? 'Some tools failed. Fix and retry. ' : ''),
    '',
    'Output next action. To call a tool:',
    '<shell_exec>',
    '{"command": "your command here"}',
    '</shell_exec>',
    '',
    'If the task is complete, output the final result instead of a tool call.',
    '',
    'Task: ' + clampText(originalTask, SUBAGENT_MAX_TASK_CHARS),
    '',
    'Tool results:',
    JSON.stringify(results),
    '',
    '⚠️ When the task is complete, end your response with:',
    '[诊断]',
    '- 任务要求的文件/图片数：（填数字）',
    '- 实际读到的文件/图片数：（填数字）',
    '- 工具调用失败：有/无（如有，列出失败的工具和原因）',
    '- 遇到格式错误（JSON 解析失败等）：有/无',
    '- 其他异常：（有则描述，无则写"无"）',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Image data extraction — extracts base64 from shell_read_image ToolResult
// ---------------------------------------------------------------------------

interface ExtractedImageData {
  base64: string;
  mimeType: string;
  size: number;
}

function base64ByteLength(base64: string): number {
  const normalized = base64.replace(/\s/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

/**
 * Extract raw stdout from a shell_exec ToolResult.
 * MCP tool results wrap stdout inside output.data.stdout;
 * the `detail` field is JSON.stringify'd structured content, not raw output.
 */
function extractStdoutFromToolResult(result: { output?: unknown; detail?: string }): string | null {
  const output = result.output;
  if (!output || typeof output !== 'object') return null;
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const stdout = (data as Record<string, unknown>).stdout;
  return typeof stdout === 'string' ? stdout : null;
}

/**
 * Extract tempDataUrl from a shell_read_image / shell_upload_file
 * result whose base64TooLarge path was served via the MCP host's
 * localhost HTTP bridge.
 */
function extractTempDataUrl(result: { output?: unknown }): string | null {
  const output = result.output;
  if (!output || typeof output !== 'object') return null;
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const url = (data as Record<string, unknown>).tempDataUrl;
  return typeof url === 'string' ? url : null;
}

function extractBase64FromToolResult(result: ToolResult): ExtractedImageData | null {
  let base64: string | null = null;
  let mimeType = 'image/png';
  let size = 0;

  if (result.output && typeof result.output === 'object') {
    const out = result.output as Record<string, unknown>;

    if (typeof out.base64 === 'string') {
      base64 = out.base64;
    }
    if (out.data && typeof out.data === 'object') {
      const data = out.data as Record<string, unknown>;
      if (!base64 && typeof data.base64 === 'string') {
        base64 = data.base64;
      }
      if (typeof data.mimeType === 'string') mimeType = data.mimeType;
      if (typeof data.size === 'number') size = data.size;
    }

    if (typeof out.mimeType === 'string') mimeType = out.mimeType;
    if (typeof out.size === 'number') size = out.size;
  }

  if (!base64 && result.detail) {
    const m = result.detail.match(/data:([^;]+);base64,([A-Za-z0-9+/=]+)/);
    if (m) {
      mimeType = m[1]!;
      base64 = m[2]!;
    }
  }

  if (!base64) return null;
  return { base64, mimeType, size };
}

// ---------------------------------------------------------------------------
// Compact tool list — names + params only, ~2KB max (vs ~10KB with hints)
// ---------------------------------------------------------------------------

function renderCompactToolList(descriptors: readonly ToolDescriptor[]): string {
  const catalog = createToolInvocationCatalog(descriptors);
  const lines: string[] = ['Tools:'];

  for (const d of descriptors) {
    const name = getPreferredToolInvocationName(d, catalog);
    const required = d.inputSchema.required ?? [];
    const props = d.inputSchema.properties ?? {};
    const params = required
      .map((k) => {
        const prop = props[k] as Record<string, unknown> | undefined;
        return `"${k}": ${prop?.type ?? 'string'}`;
      })
      .join(', ');

    const description = d.name === 'shell_upload_file'
      ? 'Upload a local file to this session as a native attachment. Read the attached file directly on the next turn.'
      : d.description.slice(0, 100);
    lines.push(`<${name}>${params ? ` {${params}}` : ' {}'}</${name}> — ${description}`);

    if (lines.join('\n').length > 3000) break;
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File backup / diff / rollback helpers
// ---------------------------------------------------------------------------

function shellExecCall(command: string): ToolCall {
  return {
    name: 'shell_exec',
    payload: { command },
    raw: `<shell_exec>{"command":"${command.replace(/"/g, '\\"')}"}</shell_exec>`,
  };
}

async function backupFilesForSubAgent(
  files: string[],
  executeTool: (call: ToolCall) => Promise<ToolResult>,
): Promise<BackupEntry[]> {
  const token = crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '');
  const entries: BackupEntry[] = [];
  for (const [index, file] of files.entries()) {
    const backupPath = `/tmp/dpp_subagent_backup_${token}_${index}`;
    const sourceArg = quoteShellArg(file);
    const backupArg = quoteShellArg(backupPath);
    try {
      const result = await executeTool(shellExecCall(
        `if [ -e ${sourceArg} ]; then /bin/cp -- ${sourceArg} ${backupArg} && printf '__DPP_BACKUP_OK__'; else printf '__DPP_BACKUP_MISSING__'; fi`,
      ));
      const output = `${result.detail ?? ''}\n${result.summary ?? ''}`;
      entries.push({
        file,
        backupPath,
        status: result.ok && output.includes('__DPP_BACKUP_OK__')
          ? 'backed_up'
          : result.ok && output.includes('__DPP_BACKUP_MISSING__')
            ? 'missing'
            : 'failed',
      });
    } catch {
      entries.push({ file, backupPath, status: 'failed' });
    }
  }
  return entries;
}

async function diffFilesForSubAgent(
  entries: BackupEntry[],
  executeTool: (call: ToolCall) => Promise<ToolResult>,
): Promise<FileDiffResult[]> {
  const results: FileDiffResult[] = [];
  for (const entry of entries) {
    const { file, backupPath, status } = entry;
    const fileArg = quoteShellArg(file);
    const backupArg = quoteShellArg(backupPath);
    try {
      if (status === 'missing') {
        const result = await executeTool(shellExecCall(
          `if [ -e ${fileArg} ]; then printf '__DPP_DIFF_NEW__'; else printf '__DPP_DIFF_UNCHANGED__'; fi`,
        ));
        const output = `${result.detail ?? ''}\n${result.summary ?? ''}`;
        results.push(output.includes('__DPP_DIFF_NEW__')
          ? { file, summary: 'new file', diff: '' }
          : { file, summary: 'unchanged', diff: '' });
        continue;
      }
      if (status !== 'backed_up') {
        results.push({ file, summary: 'diff unavailable', diff: '' });
        continue;
      }
      const result = await executeTool(shellExecCall(
        `if [ ! -e ${fileArg} ]; then printf '__DPP_DIFF_DELETED__'; elif diff -q -- ${backupArg} ${fileArg} >/dev/null 2>&1; then printf '__DPP_DIFF_UNCHANGED__'; else diff -u -- ${backupArg} ${fileArg} || true; fi`,
      ));
      const diffText = (result.detail || result.summary || '').trim();
      if (diffText.includes('__DPP_DIFF_UNCHANGED__')) {
        results.push({ file, summary: 'unchanged', diff: '' });
      } else if (diffText.includes('__DPP_DIFF_DELETED__')) {
        results.push({ file, summary: 'deleted', diff: '' });
      } else {
        const lines = diffText ? diffText.split('\n').length : 0;
        results.push({ file, summary: `${lines} lines changed`, diff: diffText.slice(0, 3000) });
      }
    } catch {
      results.push({ file, summary: 'diff unavailable', diff: '' });
    }
  }
  return results;
}

async function rollbackFilesForSubAgent(
  entries: BackupEntry[],
  executeTool: (call: ToolCall) => Promise<ToolResult>,
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const entry of entries) {
    const fileArg = quoteShellArg(entry.file);
    const backupArg = quoteShellArg(entry.backupPath);
    try {
      const command = entry.status === 'backed_up'
        ? `/bin/cp -- ${backupArg} ${fileArg}`
        : entry.status === 'missing'
          ? `/bin/rm -f -- ${fileArg}`
          : 'false';
      const result = await executeTool(shellExecCall(command));
      if (result.ok) restored.push(entry.file);
      else failed.push(entry.file);
    } catch {
      failed.push(entry.file);
    }
  }
  return { restored, failed };
}

function createSubAgentFailure(
  call: ToolCall,
  code: string,
  summary: string,
  detail: string,
  retryable: boolean,
): ToolResult {
  return {
    ok: false,
    summary,
    detail,
    name: call.name,
    provider: call.provider,
    descriptorId: call.descriptorId,
    error: { code, message: detail, retryable },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SubAgentRunError('subagent_cancelled', 'Subagent cancelled');
  }
}

/**
 * Polyfill for AbortSignal.timeout — creates an AbortController that
 * aborts after `ms` milliseconds. AbortSignal.timeout() is only available
 * in Chrome 103+ and may not be available in all Service Worker contexts.
 */
function createTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

/**
 * SSRF guard: only allow fetch() to localhost / 127.0.0.1 URLs.
 * The MCP host serves temp files on a local HTTP bridge — reject any URL
 * that points to an external or internal-non-loopback address.
 */
function isSafeLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1' || host === '::1')
    );
  } catch {
    return false;
  }
}

function waitWithSignal(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(true), delayMs);
    const onAbort = () => finish(false);
    function finish(completed: boolean) {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SubAgentRunError('subagent_cancelled', 'Subagent cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(
      new SubAgentRunError('subagent_cancelled', 'Subagent cancelled'),
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function createStepTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  clear: () => void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  const onParentAbort = () => controller.abort();
  parent.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    clear: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

function isTransientSubAgentError(err: unknown): boolean {
  // Network errors, rate limits, and server errors are transient
  if (err instanceof TypeError && err.message.includes('fetch')) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return /rate.?limit|too many requests|503|502|504|timeout|network|fetch failed|econnrefused|econnreset|etimedout/i.test(message);
}

// ---------------------------------------------------------------------------
// Credibility assessment for vision subagent results
// ---------------------------------------------------------------------------

interface CredibilityAssessment {
  untrustworthy: boolean;
  reasons: string[];
}

// Patterns that ALWAYS indicate an untrustworthy vision response.
// These are hard refusals: the AI says it cannot see or is fabricating.
const HARD_REFUSAL_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /无法(?:看到|查看|识别|读取|访问)|不能(?:看到|查看|识别|看图)|看不(?:到|清|见)/i, reason: '声称无法看到图片' },
  { pattern: /cannot\s(?:see|view|access|read)|unable\s(?:to\s)?(?:see|view)|can['']t\s(?:see|view)/i, reason: 'claims inability to see image' },
  { pattern: /I\s(?:cannot|can['']t|am\s(?:unable|not\sable))\s(?:see|view|analyze|describe)\s(?:the\s)?(?:image|picture|photo|figure)/i, reason: 'explicitly states cannot analyze image' },
  { pattern: /模拟(?:的|了)?/i, reason: '含模拟/虚构语言' },
];

// Patterns that indicate speculative/estimated output.
// These are NORMAL and EXPECTED for coordinate-estimation tasks (bbox,
// pixel positions from PNG images). Skip these when the task involves
// image analysis with coordinates — estimation is inherent to the job.
const ESTIMATION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /假设|假定|推测|猜测|可能(?:是|有)?/i, reason: '含推测性语言' },
  { pattern: /I\s(?:assume|guess|speculate|imagine|suppose)/i, reason: 'speculative language in English' },
];

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * Extract the AI's self-diagnostic `[诊断]` section from its response text.
 * Returns the section content (without the marker), or null if not found.
 */
function extractDiagnosticSection(text: string): string | null {
  // Match [诊断] that starts a diagnostic block: must be at line-start and
  // followed by a newline + bullet point. This avoids matching inline mentions
  // like "[诊断]部分，且必须是诚实的" or the continuation prompt's template.
  // We find the LAST match because the AI may reference "[诊断]" earlier in its
  // response (e.g. "我会在末尾添加[诊断]部分") before the actual block.
  const PATTERN = /(?:^|\n)\[诊断\]\s*\n(\s*-[\s\S]*?)(?=\n\n\n|\n*$)/g;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = PATTERN.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    // Fallback: try the original loose pattern (any [诊断] with bullet points)
    const loose = text.match(/\[诊断\]([\s\S]*?)(?=\n\n\n|\n*$)/);
    if (!loose) return null;
    const body = loose[0].trim();
    if (!body.includes('-')) return null;
    return body;
  }
  const section = `[诊断]\n${lastMatch[1]!.trimEnd()}`;
  return section;
}

// ---------------------------------------------------------------------------
// Credibility assessment for vision subagent results
// ---------------------------------------------------------------------------

function assessVisionCredibility(
  modelType: string | null,
  executions: readonly ToolExecutionRecord[],
  imageReads: readonly ImageReadEvidence[],
  expectedImagePaths: readonly string[],
  finalText: string,
): CredibilityAssessment {
  const reasons: string[] = [];

  // Only vision sessions have a programmatic image-evidence contract.
  if (modelType !== 'vision') {
    return { untrustworthy: false, reasons: [] };
  }

  const successfulPaths = imageReads.filter((read) => read.uploaded).map((read) => read.path);
  const uniqueSuccessfulPaths = [...new Set(successfulPaths)];

  if (expectedImagePaths.length === 0) {
    reasons.push('vision 子代理缺少 imagePaths 图片清单');
  }

  if (imageReads.length === 0) {
    reasons.push('vision 子代理未调用 shell_read_image');
  } else if (successfulPaths.length === 0) {
    reasons.push('vision 子代理没有成功上传任何图片');
  }

  const failedReads = imageReads.filter((read) => !read.uploaded);
  if (failedReads.length > 0) {
    reasons.push(`有 ${failedReads.length} 张图片读取或上传失败`);
  }

  if (expectedImagePaths.length > 0) {
    const successfulSet = new Set(uniqueSuccessfulPaths);
    const expectedSet = new Set(expectedImagePaths);
    const missing = expectedImagePaths.filter((path) => !successfulSet.has(path));
    const unexpected = uniqueSuccessfulPaths.filter((path) => !expectedSet.has(path));
    const duplicates = [...new Set(successfulPaths.filter(
      (path, index) => successfulPaths.indexOf(path) !== index,
    ))];
    if (missing.length > 0) reasons.push(`未读取清单图片：${missing.join('、')}`);
    if (unexpected.length > 0) reasons.push(`读取了清单外图片：${unexpected.join('、')}`);
    if (duplicates.length > 0) reasons.push(`重复读取图片：${duplicates.join('、')}`);
  }

  const reportedReadCount = extractReportedImageCount(finalText);
  if (reportedReadCount !== null && reportedReadCount !== uniqueSuccessfulPaths.length) {
    reasons.push(`自报读取 ${reportedReadCount} 张，但系统确认 ${uniqueSuccessfulPaths.length} 张`);
  }

  // Auto-detect estimation tasks: when imagePaths is non-empty and
  // the response contains bbox/coordinate data, the AI is doing visual
  // estimation from PNG images — speculative language is expected.
  const containsCoordinates =
    /(?:\bbbox\b|边界框|坐标)[\s\S]{0,120}(?:\d+[\s,，]+){2,3}\d+/i.test(finalText) ||
    /(?:\d+[\s,，]+){2,3}\d+[\s\S]{0,80}(?:\bbbox\b|边界框|坐标)/i.test(finalText) ||
    /\b\dx\d\b/i.test(finalText); // e.g. "6×6cm"
  const isEstimationTask = expectedImagePaths.length > 0 && containsCoordinates;

  // Hard refusals: ALWAYS flag these (AI says it can't see, or is fabricating)
  for (const { pattern, reason } of HARD_REFUSAL_PATTERNS) {
    if (pattern.test(finalText)) {
      reasons.push(reason);
    }
  }

  // Estimation language: only flag when the task is NOT inherently estimation-based.
  // Coordinate/chart analysis from PNG images requires visual estimation —
  // penalising "大约" / "approximately" for these tasks causes pointless retries.
  if (!isEstimationTask) {
    for (const { pattern, reason } of ESTIMATION_PATTERNS) {
      if (pattern.test(finalText)) {
        reasons.push(reason);
      }
    }
  }

  // Coordinates require measured dimensions even when the surrounding answer
  // uses estimation language; otherwise the numbers have no pixel basis.
  const hasMeasuredDimensions = executions.some(
    (execution) => execution.name === 'shell_analyze_image' && execution.result.ok,
  );
  if (containsCoordinates && !hasMeasuredDimensions) {
    reasons.push('bbox 坐标缺少真实图片尺寸依据');
  }

  return { untrustworthy: reasons.length > 0, reasons: [...new Set(reasons)] };
}

function extractReportedImageCount(text: string): number | null {
  const match = text.match(/实际读到的文件\/图片数[：:]\s*(\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

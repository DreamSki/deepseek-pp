import {
  createClientHeaders,
  createPowHeaders,
  DeepSeekPayloadError,
  submitPromptStreaming,
  type ModelTurn,
  type SubmitPromptInput,
  type StreamCallbacks,
} from '../deepseek/adapter';
import { extractToolCalls, stripToolCalls } from '../interceptor/tool-parser';
import { executeToolCallsInParallel } from '../tool-loop/engine';
import { consumeVisionMode, drainPendingImageFileIds } from '../tool/pending-image-ids';
import type { ToolCall, ToolDescriptor, ToolExecutionRecord, ToolResult } from '../types';
import type { ToolParsingInput } from '../tool/invocation';
import { isInvalidRefFileIdText } from '../utils/ref-file-id';
import { debugTrace } from '../utils/debug-log';
import { quoteShellArg } from '../utils/shell-quote';
import { logMainAgentConversation, logMainAgentResponse } from '../utils/conversation-logger';
import { executeMcpToolCall } from '../mcp/discovery';
import {
  buildContinuationPrompt,
  buildFinalizationPrompt,
  buildNudgePrompt,
  extractTaskCompleteSignal,
  shouldNudge,
} from './prompt';
import {
  INLINE_AGENT_MAX_NUDGES,
  INLINE_AGENT_MAX_STEPS,
  INLINE_AGENT_REQUEST_DELAY_MAX_MS,
  INLINE_AGENT_REQUEST_DELAY_MIN_MS,
  INLINE_AGENT_STEP_TIMEOUT_MS,
  type InlineAgentLoopCompleteMsg,
  type InlineAgentLoopErrorMsg,
  type InlineAgentStartPayload,
  type InlineAgentStepCompleteMsg,
  type InlineAgentStreamChunkMsg,
  type InlineAgentToolDetectedMsg,
} from './types';
import { canCompleteSubAgentRequirement } from './subagent-progress';

const IMAGE_REF_RETRY_DELAYS_MS = [900, 2_000, 4_000];

type PostFn = (type: string, data: unknown) => void;
type ExecuteToolFn = (call: ToolCall) => Promise<ToolExecutionRecord>;
/** Raw tool executor that returns ToolResult directly, for internal state management. */
type ExecuteToolRawFn = (call: ToolCall) => Promise<ToolResult>;
/** Batch executor: sends multiple spawn_subagent calls to the background
 *  scheduler in one message, preserving its concurrency and dependency rules. */
type ExecuteToolBatchFn = (calls: ToolCall[]) => Promise<ToolExecutionRecord[]>;

export interface InlineAgentLoopDeps {
  post: PostFn;
  executeTool: ExecuteToolFn;
  /** Optional: raw executor for internal shell commands (state files, cleanup). */
  executeToolRaw?: ExecuteToolRawFn;
  /** Optional: batch executor for spawn_subagent parallelism. */
  executeToolBatch?: ExecuteToolBatchFn;
  /** Optional: function to get tool descriptors for logging purposes. */
  getToolDescriptors?: () => Promise<ToolDescriptor[]>;
  signal: AbortSignal;
}

export async function runInlineAgentLoop(
  payload: InlineAgentStartPayload,
  deps: InlineAgentLoopDeps,
): Promise<void> {
  const { post, executeTool, executeToolRaw, executeToolBatch, signal } = deps;
  const { loopId, chatSessionId, toolDescriptors, promptOptions } = payload;
  const { powWasmUrl } = payload;
  const parsingInput: ToolParsingInput = { descriptors: toolDescriptors };

  let parentMessageId: number | null = payload.parentMessageId;
  let allExecutions: ToolExecutionRecord[] = [...payload.toolExecutions];
  let nudgeCount = 0;
  const startingStepIndex = Math.max(
    0,
    Math.min(payload.startingStepIndex ?? 0, INLINE_AGENT_MAX_STEPS),
  );
  let totalSteps = startingStepIndex;
  let totalTools = allExecutions.length;
  let finalText = '';
  let completedWithVisibleAnswer = false;

  // Route all-subagent batches through one background scheduling request.
  const executeToolsSplit = async (
    calls: readonly ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolExecutionRecord[]> => {
    if (
      executeToolBatch &&
      calls.length >= 2 &&
      calls.every((c) => c.name === 'spawn_subagent')
    ) {
      return executeToolBatch([...calls]);
    }
    return executeToolCallsInParallel(calls, executeTool, { signal });
  };

  // Track subagent result artifacts for cleanup after loop completion.
  const subagentResultFiles: string[] = [...new Set(payload.subagentResultFiles ?? [])];
  const trackSubAgentResultFiles = (execs: ToolExecutionRecord[]) => {
    for (const exec of execs) {
      const output = exec.result.output as Record<string, unknown> | undefined;
      const filePath = output?.resultFilePath;
      if (typeof filePath === 'string' && filePath) {
        if (!subagentResultFiles.includes(filePath)) subagentResultFiles.push(filePath);
      }
    }
  };

  // Build AGENT_STEP_COMPLETE message with extra resume data
  const makeStepComplete = (
    stepIndex: number,
    responseMessageId: number | null,
    stepExecutions: ToolExecutionRecord[],
  ): InlineAgentStepCompleteMsg => ({
    loopId,
    stepIndex,
    responseMessageId,
    toolExecutions: stepExecutions,
    parentMessageId,
    allExecutions,
    subagentResultFiles: [...subagentResultFiles],
  });

  try {
    const clientHeaders = createClientHeaders();

    for (let step = startingStepIndex; step < INLINE_AGENT_MAX_STEPS; step++) {
      if (signal.aborted) break;
      if (step > startingStepIndex) {
        await waitBetweenDeepSeekRequests(signal);
        if (signal.aborted) break;
      }

      // Drain any pending image file_ids / vision mode from shell_read_image
      // uploads that happened in the previous step (or before the loop started).
      // Mutating promptOptions ensures subsequent steps (nudge, finalization)
      // also use the correct model type and file IDs.
      const pendingImageIds = drainPendingImageFileIds('inline-agent-loop');
      const visionMode = consumeVisionMode('inline-agent-loop');
      if (pendingImageIds.length > 0 || visionMode) {
        logAgentTrace('consuming pending image state', { ids: pendingImageIds, vision: visionMode });
        if (pendingImageIds.length > 0) {
          promptOptions.refFileIds = [...promptOptions.refFileIds, ...pendingImageIds];
        }
        if (visionMode) {
          promptOptions.modelType = 'vision';
        }
      }

      const prompt = buildContinuationPrompt(payload.originalPrompt, allExecutions, totalTools);

      // Log main agent conversation for debugging
      if (deps.getToolDescriptors) {
        void logMainAgentConversation({
          loopId,
          stepIndex: step,
          chatSessionId,
          userPrompt: payload.originalPrompt,
          systemPrompt: prompt,
          modelType: promptOptions.modelType,
          refFileIds: promptOptions.refFileIds,
        }, (toolCall: ToolCall) => executeMcpToolCall(toolCall), deps.getToolDescriptors);
      }

      const powHeaders = await createPowHeaders(clientHeaders, powWasmUrl);

      post('AGENT_STEP_STARTED', { loopId, stepIndex: step });

      const input: SubmitPromptInput = {
        chatSessionId,
        parentMessageId,
        modelType: promptOptions.modelType,
        prompt,
        refFileIds: promptOptions.refFileIds,
        thinkingEnabled: promptOptions.thinkingEnabled,
        searchEnabled: promptOptions.searchEnabled,
        clientHeaders,
        powHeaders,
      };

      if (promptOptions.refFileIds.length > 0) {
        logAgentTrace('sending completion request', {
          chatSessionId,
          parentMessageId,
          modelType: promptOptions.modelType,
          refFileIds: promptOptions.refFileIds,
        });
      }

      let notifiedToolCount = 0;
      const stepTimeout = createStepSignal(signal);
      const turn: ModelTurn = await submitPromptStreamingWithImageRefRetry(input, {
        onTextChunk(text, fullText) {
          const stripped = stripToolCalls(fullText, parsingInput);
          post('AGENT_STREAM_CHUNK', {
            loopId,
            stepIndex: step,
            text,
            fullText: stripped,
          } satisfies InlineAgentStreamChunkMsg);

          const calls = extractToolCalls(fullText, parsingInput);
          for (let i = notifiedToolCount; i < calls.length; i++) {
            post('AGENT_TOOL_DETECTED', {
              loopId,
              stepIndex: step,
              call: calls[i],
            } satisfies InlineAgentToolDetectedMsg);
          }
          notifiedToolCount = calls.length;
        },
      }, stepTimeout.signal, () => createPowHeaders(clientHeaders, powWasmUrl));
      stepTimeout.clear();

      // Log main agent response for debugging
      if (deps.getToolDescriptors) {
        void logMainAgentResponse({
          loopId,
          stepIndex: step,
          chatSessionId,
          assistantText: turn.assistantText,
          thinkingText: '', // Thinking is captured separately in fetch-hook
        }, (toolCall: ToolCall) => executeMcpToolCall(toolCall), deps.getToolDescriptors);
      }

      if (signal.aborted) break;

      parentMessageId = turn.responseMessageId;
      if (parentMessageId == null) {
        totalSteps = step + 1;
        break;
      }
      const toolCalls = extractToolCalls(turn.assistantText, parsingInput);
      const visibleText = stripToolCalls(turn.assistantText, parsingInput);

      if (
        extractTaskCompleteSignal(turn.assistantText) &&
        canCompleteSubAgentRequirement(payload.originalPrompt, allExecutions)
      ) {
        const stepExecutions: ToolExecutionRecord[] = [];
        post('AGENT_STEP_COMPLETE', makeStepComplete(step, turn.responseMessageId, stepExecutions));
        totalSteps = step + 1;
        break;
      }

      if (toolCalls.length === 0) {
        if (!shouldNudge(payload.originalPrompt, allExecutions, visibleText, nudgeCount)) {
          finalText = visibleText.trim();
          completedWithVisibleAnswer = finalText.length > 0;
          post('AGENT_STEP_COMPLETE', makeStepComplete(step, turn.responseMessageId, []));
          totalSteps = step + 1;
          break;
        }

        nudgeCount++;
        if (nudgeCount > INLINE_AGENT_MAX_NUDGES) {
          post('AGENT_STEP_COMPLETE', makeStepComplete(step, turn.responseMessageId, []));
          totalSteps = step + 1;
          break;
        }

        const nudgePrompt = buildNudgePrompt(payload.originalPrompt, visibleText, allExecutions, nudgeCount, totalTools);
        const nudgeInput: SubmitPromptInput = {
          ...input,
          prompt: nudgePrompt,
          parentMessageId: turn.responseMessageId,
        };

        await waitBetweenDeepSeekRequests(signal);
        if (signal.aborted) break;

        const nudgePowHeaders = await createPowHeaders(clientHeaders, powWasmUrl);
        nudgeInput.powHeaders = nudgePowHeaders;

        const nudgeTimeout = createStepSignal(signal);
        const nudgeTurn = await submitPromptStreamingWithImageRefRetry(nudgeInput, {
          onTextChunk(text, fullText) {
            const stripped = stripToolCalls(fullText, parsingInput);
            post('AGENT_STREAM_CHUNK', {
              loopId,
              stepIndex: step,
              text,
              fullText: stripped || visibleText,
            } satisfies InlineAgentStreamChunkMsg);
          },
        }, nudgeTimeout.signal, () => createPowHeaders(clientHeaders, powWasmUrl));
        nudgeTimeout.clear();

        if (signal.aborted) break;

        parentMessageId = nudgeTurn.responseMessageId;
        const nudgeToolCalls = extractToolCalls(nudgeTurn.assistantText, parsingInput);
        const nudgeVisibleText = stripToolCalls(nudgeTurn.assistantText, parsingInput);

        if (nudgeToolCalls.length === 0) {
          if (!visibleText.trim() && !nudgeVisibleText.trim()) {
            // Both the original and nudge responses are empty — likely a
            // token limit or the model declined. End gracefully instead of
            // throwing so the user at least sees partial results.
            logAgentTrace('empty nudge response — ending loop gracefully', { step, executions: allExecutions.length });
            post('AGENT_STEP_COMPLETE', makeStepComplete(step, nudgeTurn.responseMessageId, []));
            totalSteps = step + 1;
            break;
          }

          post('AGENT_STEP_COMPLETE', makeStepComplete(step, nudgeTurn.responseMessageId, []));
          totalSteps = step + 1;
          if (!canCompleteSubAgentRequirement(payload.originalPrompt, allExecutions)) {
            continue;
          }
          if (!extractTaskCompleteSignal(nudgeTurn.assistantText)) {
            finalText = nudgeVisibleText.trim();
            completedWithVisibleAnswer = finalText.length > 0;
          }
          break;
        }

        const nudgeExecs = await executeToolsSplit(nudgeToolCalls, signal);
        allExecutions = [...allExecutions, ...nudgeExecs];
        totalTools += nudgeExecs.length;
        trackSubAgentResultFiles(nudgeExecs);

        post('AGENT_STEP_COMPLETE', makeStepComplete(step, nudgeTurn.responseMessageId, nudgeExecs));
        totalSteps = step + 1;
        nudgeCount = 0;

        continue;
      }

      nudgeCount = 0;
      const stepExecs = await executeToolsSplit(toolCalls, signal);
      allExecutions = [...allExecutions, ...stepExecs];
      totalTools += stepExecs.length;
      trackSubAgentResultFiles(stepExecs);

      post('AGENT_STEP_COMPLETE', makeStepComplete(step, turn.responseMessageId, stepExecs));
      totalSteps = step + 1;

      if (signal.aborted) break;
    }

    if (!signal.aborted && !completedWithVisibleAnswer && totalTools > 0 && totalSteps > 0) {
      try {
        await waitBetweenDeepSeekRequests(signal);
        if (signal.aborted) {
          post('AGENT_LOOP_COMPLETE', {
            loopId,
            totalSteps,
            totalTools,
            finalText,
          } satisfies InlineAgentLoopCompleteMsg);
          return;
        }

        const powHeaders = await createPowHeaders(clientHeaders, powWasmUrl);
        const finalizationPrompt = buildFinalizationPrompt(payload.originalPrompt, allExecutions);
        const finalInput: SubmitPromptInput = {
          chatSessionId,
          parentMessageId,
          modelType: promptOptions.modelType,
          prompt: finalizationPrompt,
          refFileIds: promptOptions.refFileIds,
          thinkingEnabled: promptOptions.thinkingEnabled,
          searchEnabled: promptOptions.searchEnabled,
          clientHeaders,
          powHeaders,
        };

        let finalStepStarted = false;
        // Finalization must respect a step timeout too — previously it used the
        // raw parent signal with no deadline, so a hung DeepSeek stream here
        // left the main agent waiting forever (looked like "no response").
        const finalTimeout = createStepSignal(signal);
        try {
          const finalTurn = await submitPromptStreamingWithImageRefRetry(finalInput, {
            onTextChunk(_text, fullText) {
              if (!fullText.trim()) return;
              if (!finalStepStarted) {
                post('AGENT_STEP_STARTED', { loopId, stepIndex: totalSteps });
                finalStepStarted = true;
              }
              post('AGENT_STREAM_CHUNK', {
                loopId,
                stepIndex: totalSteps,
                text: _text,
                fullText,
              } satisfies InlineAgentStreamChunkMsg);
            },
          }, finalTimeout.signal, () => createPowHeaders(clientHeaders, powWasmUrl));

          finalText = finalTurn.assistantText;
          if (finalText.trim()) {
            if (!finalStepStarted) {
              post('AGENT_STEP_STARTED', { loopId, stepIndex: totalSteps });
              post('AGENT_STREAM_CHUNK', {
                loopId,
                stepIndex: totalSteps,
                text: finalText,
                fullText: finalText,
              } satisfies InlineAgentStreamChunkMsg);
            }
            post('AGENT_STEP_COMPLETE', makeStepComplete(totalSteps, finalTurn.responseMessageId, []));
            totalSteps++;
          }
        } finally {
          finalTimeout.clear();
        }
      } catch {
        // Finalization is best-effort; loop still completes
      }
    }

    // Clean up subagent result temp files
    if (executeToolRaw && subagentResultFiles.length > 0) {
      await cleanupSubAgentResultFiles(subagentResultFiles, executeToolRaw);
    }

    post('AGENT_LOOP_COMPLETE', {
      loopId,
      totalSteps,
      totalTools,
      finalText,
    } satisfies InlineAgentLoopCompleteMsg);
  } catch (err) {
    if (signal.aborted) {
      post('AGENT_LOOP_COMPLETE', {
        loopId,
        totalSteps,
        totalTools,
        finalText: '',
      } satisfies InlineAgentLoopCompleteMsg);
      return;
    }

    // On error, keep the temp files for debugging/resume
    if (subagentResultFiles.length > 0) {
      logAgentTrace('loop error — subagent result files preserved for resume', {
        files: subagentResultFiles,
      });
    }

    post('AGENT_LOOP_ERROR', {
      loopId,
      stepIndex: totalSteps,
      totalTools,
      error: err instanceof Error ? err.message : String(err),
    } satisfies InlineAgentLoopErrorMsg);
  }
}

function waitBetweenDeepSeekRequests(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const delay = randomInt(INLINE_AGENT_REQUEST_DELAY_MIN_MS, INLINE_AGENT_REQUEST_DELAY_MAX_MS);
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, delay);
    const onAbort = () => cleanup();

    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function submitPromptStreamingWithImageRefRetry(
  input: SubmitPromptInput,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
  refreshPowHeaders: () => Promise<Record<string, string>>,
): Promise<ModelTurn> {
  let currentInput = input;
  for (let attempt = 0; ; attempt++) {
    try {
      return await submitPromptStreaming(currentInput, callbacks, signal);
    } catch (err) {
      const invalidRefFileId = err instanceof DeepSeekPayloadError && isInvalidRefFileIdText(err.message);
      if (currentInput.refFileIds.length > 0) {
        logAgentTrace('completion failed with image refs', {
          attempt: attempt + 1,
          invalidRefFileId,
          refFileIds: currentInput.refFileIds,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (
        signal.aborted ||
        currentInput.refFileIds.length === 0 ||
        !invalidRefFileId ||
        attempt >= IMAGE_REF_RETRY_DELAYS_MS.length
      ) {
        throw err;
      }

      const delayMs = IMAGE_REF_RETRY_DELAYS_MS[attempt];
      logAgentTrace('completion rejected image ref; retrying after file processing wait', {
        attempt: attempt + 1,
        delayMs,
        refFileIds: currentInput.refFileIds,
        error: err instanceof Error ? err.message : String(err),
      });
      await waitFixedDelay(delayMs, signal);
      if (signal.aborted) throw err;
      currentInput = {
        ...currentInput,
        powHeaders: await refreshPowHeaders(),
      };
    }
  }
}

function waitFixedDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, delayMs);
    const onAbort = () => cleanup();

    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function logAgentTrace(message: string, data: Record<string, unknown>): void {
  debugTrace(`agent-loop: ${message}`, data);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function cleanupSubAgentResultFiles(
  filePaths: string[],
  executeToolRaw: (call: ToolCall) => Promise<ToolResult>,
): Promise<void> {
  const paths = filePaths.map((f) => quoteShellArg(f)).join(' ');
  try {
    await executeToolRaw({
      name: 'shell_exec',
      provider: { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'stdio_bridge' },
      descriptorId: 'mcp:shell:shell_exec',
      invocationName: 'shell_exec',
      payload: { command: `rm -f ${paths} 2>/dev/null || true` },
      raw: '',
    });
    logAgentTrace('cleaned up subagent result files', { count: filePaths.length });
  } catch (err) {
    logAgentTrace('failed to clean up subagent result files', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function createStepSignal(parentSignal: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INLINE_AGENT_STEP_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onParentAbort, { once: true });
  const clear = () => {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, clear };
}

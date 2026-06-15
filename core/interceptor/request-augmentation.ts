import { PRESET_REINJECTION_INTERVAL } from '../constants';
import { buildPromptAugmentation } from '../prompt';
import { parseSkillCommand } from '../skill/parser';
import type { Memory, ModelType, Skill, SystemPromptPreset, ToolDescriptor } from '../types';
// pending-image-ids is consumed exclusively by inline-agent/loop.ts for agent steps

export interface RequestAugmentationState {
  memories: Memory[];
  skills: Array<Pick<Skill, 'name' | 'instructions' | 'memoryEnabled'>>;
  activePreset: SystemPromptPreset | null;
  modelType: ModelType;
  toolDescriptors: readonly ToolDescriptor[];
  messageCount: number;
}

export interface RequestBodyAugmentationResult {
  body: string;
  agentTaskPrompt: string;
  usedMemoryIds: number[];
  messageCount: number;
}

interface ResolvedSkills {
  combinedPrompt: string;
  memoryEnabled: boolean;
}

export function resolveRequestModelType(value: unknown): ModelType {
  if (value === 'expert' || value === 'reasoner' || value === 'deepseek_reasoner') {
    return 'expert';
  }
  return null;
}

export function augmentRequestBody(
  bodyStr: string,
  state: RequestAugmentationState,
): RequestBodyAugmentationResult | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    return null;
  }

  // Pending image file_ids are drained by the inline agent loop directly
  // (it controls its own request params, including modelType and refFileIds).
  // shell_read_image and shell_upload_file now always upload to DeepSeek,
  // so the inline-agent-loop consumer drains them at each step.

  const originalPrompt = (body.prompt as string) || '';
  if (!originalPrompt) return null;

  const thinkingEnabled = body.thinking_enabled === true;
  const isFirstMessage = body.parent_message_id === null || body.parent_message_id === undefined;
  const messageCount = isFirstMessage ? 1 : state.messageCount + 1;
  const shouldInjectPreset =
    state.activePreset &&
    (isFirstMessage || messageCount % PRESET_REINJECTION_INTERVAL === 0);
  const presetContent = shouldInjectPreset ? state.activePreset!.content : null;

  // Only apply the extension's model type preference when the DeepSeek web UI
  // hasn't already set one. This preserves the user's explicit mode selection on
  // the web page (e.g. vision mode, reasoning mode) while still defaulting to
  // Expert when no model type is specified.
  if (state.modelType && !body.model_type) {
    body.model_type = state.modelType;
  }
  const mainAgentMode = body.model_type === 'vision'
    ? 'vision'
    : resolveRequestModelType(body.model_type) === 'expert'
      ? 'expert'
      : 'fast';

  // Debug logging for mode detection
  console.log('[DPP] Mode detection:', {
    bodyModelType: body.model_type,
    stateModelType: state.modelType,
    mainAgentMode,
    isVisionMode: mainAgentMode === 'vision',
  });
  const isVisionMode = mainAgentMode === 'vision';

  const invocation = parseSkillCommand(originalPrompt);
  if (invocation) {
    const resolved = resolveSkills(state.skills, invocation.skillName, invocation.args);
    if (resolved) {
      const { augmented, usedMemoryIds } = buildPromptAugmentation(resolved.combinedPrompt, {
        memories: state.memories,
        thinkingEnabled,
        identityOnly: !resolved.memoryEnabled,
        presetContent,
        toolDescriptors: state.toolDescriptors,
        isVisionMode,
        mainAgentMode,
      });

      body.prompt = augmented;
      return {
        body: JSON.stringify(body),
        agentTaskPrompt: resolved.combinedPrompt,
        usedMemoryIds,
        messageCount,
      };
    }
  }

  const { augmented, usedMemoryIds } = buildPromptAugmentation(originalPrompt, {
    memories: state.memories,
    thinkingEnabled,
    presetContent,
    toolDescriptors: state.toolDescriptors,
    isVisionMode,
    mainAgentMode,
  });
  body.prompt = augmented;

  return {
    body: JSON.stringify(body),
    agentTaskPrompt: originalPrompt,
    usedMemoryIds,
    messageCount,
  };
}

function resolveSkills(
  skills: RequestAugmentationState['skills'],
  skillName: string,
  args: string,
): ResolvedSkills | null {
  const primarySkill = skills.find((s) => s.name === skillName);
  if (!primarySkill) return null;

  const secondInvocation = parseSkillCommand('/' + args);
  if (secondInvocation) {
    const secondSkill = skills.find((s) => s.name === secondInvocation.skillName);
    if (secondSkill) {
      const userArgs = secondInvocation.args;
      const combinedInstructions = primarySkill.instructions + '\n\n---\n\n' + secondSkill.instructions;
      return {
        combinedPrompt: userArgs
          ? wrapUserInput(combinedInstructions, userArgs)
          : combinedInstructions,
        memoryEnabled: primarySkill.memoryEnabled || secondSkill.memoryEnabled,
      };
    }
  }

  return {
    combinedPrompt: args
      ? wrapUserInput(primarySkill.instructions, args)
      : primarySkill.instructions,
    memoryEnabled: primarySkill.memoryEnabled,
  };
}

function wrapUserInput(instructions: string, userInput: string): string {
  return `${instructions}\n\n---\n\n以下是用户本次的输入，请根据上述指令处理：\n\n${userInput}`;
}

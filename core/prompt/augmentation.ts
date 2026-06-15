import { SYSTEM_TEMPLATE_CHAT, SYSTEM_TEMPLATE_THINKING } from '../constants';
import type { Memory, ToolDescriptor } from '../types';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createToolInvocationCatalog,
  getPreferredToolInvocationName,
  getToolInvocationNames,
  type ToolInvocationCatalog,
} from '../tool';
import { estimateTokens, formatMemoriesBlock, getMemoryBudget, selectMemories } from '../memory/selector';
import { markVisibleUserPrompt } from './visibility';

export type MainAgentMode = 'fast' | 'expert' | 'vision';

export interface PromptAugmentationOptions {
  memories?: readonly Memory[];
  thinkingEnabled?: boolean;
  identityOnly?: boolean;
  presetContent?: string | null;
  toolDescriptors?: readonly ToolDescriptor[];
  isVisionMode?: boolean;
  mainAgentMode?: MainAgentMode;
}

export interface PromptAugmentationResult {
  augmented: string;
  usedMemoryIds: number[];
  renderedToolCount: number;
}

export function buildPromptAugmentation(
  originalPrompt: string,
  options?: PromptAugmentationOptions,
): PromptAugmentationResult {
  const {
    memories = [],
    thinkingEnabled = false,
    identityOnly = false,
    presetContent = null,
    toolDescriptors = DEFAULT_TOOL_DESCRIPTORS,
    isVisionMode = false,
    mainAgentMode = 'fast',
  } = options ?? {};

  const promptTokens = estimateTokens(originalPrompt);
  const budget = getMemoryBudget(promptTokens);
  const selected = selectMemories(originalPrompt, [...memories], { budget, identityOnly });
  const memBlock = formatMemoriesBlock(selected);
  // Hide vision-only tools (shell_read_image, shell_analyze_image) from non-vision sessions
  const callableDescriptors = filterCallableTools(toolDescriptors, isVisionMode, mainAgentMode);
  const toolsBlock = renderToolSchemas(callableDescriptors);
  const template = thinkingEnabled ? SYSTEM_TEMPLATE_THINKING : SYSTEM_TEMPLATE_CHAT;
  const baseSystem = template
    .replace('{{memories}}', memBlock)
    .replace('{{tools}}', toolsBlock);
  const system = [
    baseSystem,
    renderMainAgentModeGuidance(mainAgentMode),
    renderWebSearchGuidance(callableDescriptors),
    renderToolCallabilityGuidance(toolDescriptors, isVisionMode, mainAgentMode),
    renderFileUploadGuidance(toolDescriptors, mainAgentMode),
  ].filter(Boolean).join('\n\n');
  const presetPrefix = presetContent ? `${presetContent}\n\n---\n\n` : '';
  const toolReminder = renderToolFormatReminder(callableDescriptors);

  return {
    augmented: presetPrefix + system + markVisibleUserPrompt(originalPrompt) + toolReminder,
    usedMemoryIds: selected.map((memory) => memory.id!).filter(Boolean),
    renderedToolCount: toolDescriptors.length,
  };
}

export function renderToolSchemas(descriptors: readonly ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS): string {
  const catalog = createToolInvocationCatalog(descriptors);
  const shellHint = renderShellMcpHint(descriptors, catalog);
  const pythonHint = renderPythonMcpHint(descriptors, catalog);
  const schemas = descriptors
    .map((descriptor) => renderToolSchema(descriptor, catalog))
    .join('\n\n');
  return [shellHint, pythonHint, schemas].filter(Boolean).join('\n\n');
}

function renderWebSearchGuidance(descriptors: readonly ToolDescriptor[]): string {
  const hasWebSearch = descriptors.some((descriptor) => descriptor.name === 'web_search');
  if (!hasWebSearch) return '';

  return [
    '## 网络搜索规则',
    '',
    '当对话中出现以下情况时，你应当使用 web_search 工具搜索互联网：',
    '- 用户询问实时信息、新闻、事件、汇率、天气等',
    '- 用户询问你不确定的知识，需要查阅最新资料',
    '- 用户明确要求你搜索或查询某些信息',
    '- 你需要验证事实、数据或引用来源',
    '',
    '### 搜索流程',
    '1. 先输出 web_search 工具调用进行搜索',
    '2. 搜索会自动执行，结果会展示在页面上并回传给你',
    '3. 阅读搜索结果后，基于结果给出回答',
    '',
    '### 示例',
    '',
    '用户：2024年诺贝尔奖得主是谁？',
    '助手回复：',
    '',
    '我帮你搜索一下最新的信息。',
    '',
    '<web_search>',
    '{"query": "2024 诺贝尔奖得主"}',
    '</web_search>',
    '',
    '### 规则',
    '- 搜索时使用中文关键词可获得更好的中文结果',
    '- 如果一次搜索不够，可以继续调用 web_search 搜索不同关键词',
    '- 不要在没有搜索的情况下编造实时信息',
  ].join('\n');
}

function renderPythonMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
): string {
  const pythonExec = descriptors.find((descriptor) => descriptor.name === 'python_exec');
  const pythonStatus = descriptors.find((descriptor) => descriptor.name === 'python_status');
  if (!pythonExec && !pythonStatus) return '';

  const execName = pythonExec ? getPreferredToolInvocationName(pythonExec, catalog) : null;
  const statusName = pythonStatus ? getPreferredToolInvocationName(pythonStatus, catalog) : null;

  return [
    '### Python Quick Validation Capability',
    execName
      ? `Use <${execName}> for short Python snippets that verify an idea, perform complex calculations, or transform small data. Treat it as a scratchpad, not as a general local execution environment.`
      : '',
    statusName
      ? `Use <${statusName}>{}</${statusName}> when you need to know the Python version or whether numpy, pandas, or sympy are available.`
      : '',
    'Assume the Python standard library is available. Only use numpy, pandas, or sympy after python_status reports them as available.',
    'Do not install packages, access sensitive local files, run long jobs, or use network access through Python. Keep code short and return concise text or JSON.',
  ].filter(Boolean).join('\n');
}

function renderToolSchema(descriptor: ToolDescriptor, catalog: ToolInvocationCatalog): string {
  const examplePayload = createExamplePayload(descriptor);
  const preferredName = getPreferredToolInvocationName(descriptor, catalog);
  const acceptedNames = getToolInvocationNames(descriptor, catalog);
  const lines = [
    `### Tool ${preferredName}`,
    `Title: ${descriptor.title}`,
    `Description: ${descriptor.description}`,
    acceptedNames.length > 1 ? `Accepted tag names: ${acceptedNames.join(', ')}` : '',
    `Valid call format for ${preferredName}:`,
    `<${preferredName}>`,
    JSON.stringify(examplePayload, null, 2),
    `</${preferredName}>`,
    `Invalid formats: <invoke name="${preferredName}">...</invoke>, <tool_call>...</tool_call>`,
    `Parameters JSON Schema: ${JSON.stringify(descriptor.inputSchema)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function renderShellMcpHint(
  descriptors: readonly ToolDescriptor[],
  catalog: ToolInvocationCatalog,
): string {
  const shellExec = descriptors.find((descriptor) => descriptor.name === 'shell_exec');
  if (!shellExec) return '';

  const shellStatus = descriptors.find((descriptor) => descriptor.name === 'shell_status');
  const execName = getPreferredToolInvocationName(shellExec, catalog);
  const statusName = shellStatus ? getPreferredToolInvocationName(shellStatus, catalog) : null;

  return [
    '### Shell MCP Capability',
    'Shell MCP is connected through the extension. You can execute local CLI commands by emitting the executable XML tool tag; do not say you cannot run commands when this tool is listed.',
    `Use <${execName}> with a JSON body such as {"command":"officecli --version","timeout_ms":60000} to run OfficeCLI or other local CLI tools.`,
    statusName
      ? `Use <${statusName}>{}</${statusName}> first when you need host status, shell, PATH, or working-directory context.`
      : '',
    'Match command syntax to shell_status.shell. On Windows the Shell Local host uses PowerShell by default, so list files with commands such as Get-ChildItem -LiteralPath "D:\\\\Documents\\\\Downloads\\\\CN" -File | Select-Object -ExpandProperty FullName, and quote paths once inside the command string. Use cmd.exe /c explicitly only when you need CMD syntax such as dir /b.',
    `Recognized shell tool names: ${catalog.invocationNames.filter(n => descriptors.some(d => d.name === n || d.invocationName === n)).join(', ')}`,
  ].filter(Boolean).join('\n');
}

export function renderToolFormatReminder(descriptors: readonly ToolDescriptor[]): string {
  const catalog = createToolInvocationCatalog(descriptors);
  const names = catalog.invocationNames;
  if (names.length === 0) return '';
  return [
    '',
    '',
    '---',
    'Tool call format reminder:',
    `Available tool tag names: ${names.join(', ')}`,
    'These listed tools are executable by the extension. Do not claim you cannot call a listed MCP tool.',
    'To call a tool, use ONLY the direct XML tag whose name is the tool name, with valid JSON as the body.',
    'For MCP tools, prefer the short tag name when it appears in the available names list.',
    'For local file paths, use forward slashes or escaped backslashes so the JSON body remains valid.',
    'Do not use <invoke name="...">, <tool_call>, Markdown code fences, {"tool":"...","arguments":{...}}, or any wrapper format.',
    'Do not put executable tool XML in a thinking/reasoning section; put it in the final assistant answer content.',
  ].join('\n');
}

function createExamplePayload(descriptor: ToolDescriptor): Record<string, unknown> {
  const properties = descriptor.inputSchema.properties ?? {};
  const required = descriptor.inputSchema.required ?? Object.keys(properties);
  const payload: Record<string, unknown> = {};

  for (const key of required) {
    payload[key] = exampleValue(properties[key]);
  }

  return payload;
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'value';
  const value = schema as Record<string, unknown>;
  const type = value.type;
  if (Array.isArray(type)) return exampleValue({ ...value, type: type[0] });
  if (value.enum && Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default: {
      const desc = typeof value.description === 'string' ? value.description.toLowerCase() : '';
      if (type === 'string' && (desc.includes('file path') || desc.includes('file_path') || desc.includes('filepath'))) {
        if (desc.includes('.pptx')) return './example.pptx';
        if (desc.includes('.docx')) return './example.docx';
        if (desc.includes('.xlsx')) return './example.xlsx';
        return './example.txt';
      }
      return 'value';
    }
  }
}

function renderMainAgentModeGuidance(mode: MainAgentMode): string {
  if (mode === 'expert') {
    return [
      '## 当前主代理模式：专家模式',
      '当前请求使用 expert 推理模型。该模式不能读取 ref_file_ids 文件附件。',
      '- 不要声称自己处于快速模式。',
      '- 遇到本地文档上传、阅读或分析任务，调用 spawn_subagent，并明确设置 modelType:"default"，由快速模式子代理上传和阅读文件。',
      '- spawn_subagent 的 prompt 只需描述任务目标，不要写实现步骤或分析方法（如 Python/PyMuPDF 方案）。子代理会自行用原生附件读取文件。',
    ].join('\n');
  }
  if (mode === 'vision') {
    return [
      '## 当前主代理模式：识图模式',
      '当前请求使用 vision 模型。不要声称自己处于专家模式或快速模式。',
      '- 识图模式专为图片分析设计，可直接使用 shell_read_image 获取图片内容并分析。',
      '- 对于需要立即分析的图片，使用 shell_read_image 直接读取并分析图片内容。',
      '- shell_upload_file 适用于文档类文件（PDF、DOCX等），图片会在下一轮对话中可见。',
    ].join('\n');
  }
  return [
    '## 当前主代理模式：快速模式',
    '当前请求使用 default 快速模型，可以通过 shell_upload_file 把文档作为原生附件挂载到下一轮。',
    '- 不要声称自己处于专家模式，也不要仅因为文件上传而创建子代理。',
  ].join('\n');
}

function renderToolCallabilityGuidance(
  descriptors: readonly ToolDescriptor[],
  isVisionMode: boolean,
  mainAgentMode: MainAgentMode,
): string {
  // Use the FULL descriptor list (before filtering) to detect what's available
  const hasShellReadImage = descriptors.some((d) => d.name === 'shell_read_image');
  const hasSpawnSubagent = descriptors.some((d) => d.name === 'spawn_subagent');
  const lines: string[] = [];

  if (hasShellReadImage && !isVisionMode) {
    lines.push(
      '## 识图工具调用规则',
      '- shell_read_image 当前不可由主代理直接调用。如果用户要求看图、分析图片、识别图片内容，使用 spawn_subagent 并指定 modelType:"vision"。',
    );
  }

  if (hasSpawnSubagent && mainAgentMode === 'expert') {
    lines.push(
      '- 专家模式不能直接上传或读取文件附件。遇到本地文档上传或阅读任务时，由快速模式子代理调用 shell_upload_file 完成上传。',
    );
  }

  return lines.join('\n');
}

const VISION_ONLY_TOOLS = new Set(['shell_read_image', 'shell_analyze_image']);
const EXPERT_HIDDEN_TOOLS = new Set(['shell_upload_file']);

/**
 * Filter tool descriptors based on the main agent's mode:
 * - Non-vision mode: hide shell_read_image and shell_analyze_image
 * - Expert mode: also hide shell_upload_file (delegated to fast sub-agents)
 */
function filterCallableTools(
  descriptors: readonly ToolDescriptor[],
  isVisionMode: boolean,
  mainAgentMode?: MainAgentMode,
): ToolDescriptor[] {
  return descriptors.filter((d) => {
    if (!isVisionMode && VISION_ONLY_TOOLS.has(d.name)) return false;
    if (mainAgentMode === 'expert' && EXPERT_HIDDEN_TOOLS.has(d.name)) return false;
    return true;
  });
}

function renderFileUploadGuidance(
  descriptors: readonly ToolDescriptor[],
  mainAgentMode: MainAgentMode,
): string {
  const hasShellUploadFile = descriptors.some((d) => d.name === 'shell_upload_file');
  if (!hasShellUploadFile) return '';

  const hasSpawnSubagent = descriptors.some((d) => d.name === 'spawn_subagent');

  if (hasSpawnSubagent && mainAgentMode === 'expert') {
    return [
      '## 本地文件上传规则',
      '- 专家模式下，委派边界优先于本地文件直接上传规则：文件应交给快速模式子代理处理。',
      '- 主代理只调用 spawn_subagent（modelType:"default"），由子代理调用 shell_upload_file 完成上传。',
      '- 不要在同一轮由主代理先调用 shell_upload_file 再调用 spawn_subagent；上传必须完全委派给子代理。',
    ].join('\n');
  }

  return [
    '## 本地文件上传规则',
    '- shell_upload_file 用于文档类文件（PDF、DOCX、XLSX、PPTX等），图片会在下一轮对话中通过 ref_file_ids 可见。',
    '- 对于需要立即分析的图片，使用 shell_read_image 直接读取并分析，不要使用 shell_upload_file。',
    '- 仅当用户明确说”使用 shell_upload_file”或明确提到工具名称时，才调用此工具。',
    '- 用户只说”上传文件”、”阅读文档”、”分析PDF”等间接需求时，不应使用此工具。',
    '- 仅对用户明确指定的文件使用，不要自动扩展到其他文件。',
    '- 使用 shell_upload_file 后，文件内容会在下一轮对话中自动可见，无需额外操作。',
    '- shell_status 只在调用 shell_exec 前需要；shell_upload_file 不需要先查 shell_status。',
  ].join('\n');
}

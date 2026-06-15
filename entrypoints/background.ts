import {
  getAllMemories,
  getMemoryById,
  saveMemory,
  updateMemory,
  deleteMemory,
  touchMemories,
  replaceAllMemories,
  archiveStaleMemories,
} from '../core/memory/store';
import {
  deleteGitHubSkillSource,
  getAllSkillSources,
  getAllSkills,
  getSkillLibrary,
  getUserSkills,
  replaceAllCustomSkills,
  replaceAllSkillSources,
  saveSkill,
  setSkillEnabled,
  deleteSkill,
} from '../core/skill/registry';
import {
  checkGitHubSkillSourceUpdates,
  importGitHubSkillSource,
  previewGitHubSkillSource,
  updateGitHubSkillSource,
} from '../core/skill/github-importer';
import {
  getAllPresets,
  savePreset,
  deletePreset,
  getActivePreset,
  setActivePresetId,
  replaceAllPresets,
} from '../core/preset/store';
import { getModelType, setModelType } from '../core/model/store';
import { getDeepSeekTheme, saveDeepSeekTheme } from '../core/theme/store';
import { getBackgroundConfig, saveBackgroundConfig, clearBackgroundConfig } from '../core/background/store';
import { getPetConfig, savePetConfig, clearPetConfig } from '../core/pet/store';
import { getExtensionVersion } from '../core/version';
import { getSyncConfig, saveSyncConfig } from '../core/sync/config';
import { webdavTest, webdavMkcol, webdavGet, webdavPut } from '../core/sync/webdav-client';
import {
  parseValidatedArray,
  validateGitHubSkillSource,
  validatePreset,
  validateSkill,
  validateStoredMemory,
} from '../core/sync/schema';
import { clearToolCallHistory, getToolCallHistory } from '../core/tool/history';
import {
  executeRuntimeToolCall,
  getRuntimeToolDescriptors,
  refreshRuntimeToolDescriptors,
  addSubAgentProgressListener,
  removeSubAgentProgressListener,
} from '../core/tool/runtime';
import {
  createMcpServer,
  deleteMcpServer,
  getAllMcpServers,
  getMcpToolCache,
  getMcpServerById,
  updateMcpServer,
} from '../core/mcp/store';
import { refreshMcpServerDiscovery } from '../core/mcp/discovery';
import { getMcpOriginPattern, requestMcpServerOriginPermission } from '../core/mcp/transports';
import { SHELL_MCP_NATIVE_HOST, SHELL_MCP_SERVER_NAME, createShellMcpPresetInput } from '../core/shell';
import { getWebToolSettings, setWebToolEnabled } from '../core/tool/web-settings';
import { getAllScenarios, applyScenarioTemplate } from '../core/scenario/store';
import { getChatEnabled } from '../core/chat/store';
import {
  clearDeepSeekApiKey,
  DEEPSEEK_API_KEY_STORAGE_KEY,
  getDeepSeekApiKey,
  hasDeepSeekApiKey,
  saveDeepSeekApiKey,
} from '../core/chat/api-key';
import {
  createAutomation,
  deleteAutomation,
  getAllAutomations,
  getAutomationById,
  getAutomationRuns,
  setAutomationStatus,
  updateAutomation,
} from '../core/automation/store';
import { runDeepSeekAutomation } from '../core/automation/runner';
import {
  AUTOMATION_WAKE_ALARM_NAME,
  AUTOMATION_WAKE_INTERVAL_MINUTES,
  refreshAutomationNextRunAt,
  runAutomation,
  scanDueAutomations,
} from '../core/automation/scheduler';
import { validateAutomationSchedule } from '../core/automation/schedule';
import {
  createChatSession,
  createPowHeaders,
  submitPromptStreaming,
  loadClientHeadersFromStorage,
} from '../core/deepseek/adapter';
import {
  submitOfficialDeepSeekStreaming,
  type OfficialDeepSeekMessage,
} from '../core/deepseek/official-api';
import { createDeepSeekConversationExportTransport } from '../core/deepseek/conversation-export';
import {
  buildConversationExportArtifactsCancellable,
  runConversationExport,
} from '../core/export/service';
import { normalizeConversationExportRequest } from '../core/export/schema';
import { buildPromptAugmentation } from '../core/prompt';
import { extractToolCalls } from '../core/interceptor/tool-parser';
import { executeToolCallsInParallel } from '../core/tool-loop/engine';
import type { WebSearchToolName } from '../core/tool/web-search';
import type { BackgroundConfig, DeepSeekTheme, GitHubSkillImportRequest, GitHubSkillSource, Memory, ModelType, NewMemory, PetConfig, Skill, SyncConfig, SyncCounts, SystemPromptPreset, ToolCall, ToolDescriptor, ToolExecutionRecord, ToolResult } from '../core/types';
import type { McpServerCreateInput, McpServerUpdateInput } from '../core/mcp/types';
import type { AutomationCreateInput, AutomationRunnerRequest, AutomationRunnerResult, AutomationStatus, AutomationUpdateInput } from '../core/automation/types';
import type { ConversationExportProgress, ConversationExportResult } from '../core/export/types';

const DEEPSEEK_HOME_URL = 'https://chat.deepseek.com/';
const DEEPSEEK_TAB_URL_PATTERN = '*://chat.deepseek.com/*';
const REFRESH_AUTH_MESSAGE = { type: 'REFRESH_DEEPSEEK_AUTH' } as const;
const MISSING_DEEPSEEK_AUTH_MESSAGE = '请先在 chat.deepseek.com 登录，或刷新 DeepSeek 页面后重试。';
let chatSessionId: string | null = null;
let chatParentMessageId: number | null = null;
let officialApiChatMessages: OfficialDeepSeekMessage[] = [];
const conversationExportControllers = new Map<string, AbortController>();
const activeToolRunControllers = new Map<string, AbortController>();
function replaceActiveToolRunController(runId: string, controller: AbortController): void {
  const previous = activeToolRunControllers.get(runId);
  if (previous && previous !== controller) previous.abort();
  activeToolRunControllers.set(runId, controller);
}
type SidePanelApi = {
  setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
};

type SyncDataSnapshot = {
  memories: Omit<Memory, 'id'>[];
  skills: Skill[];
  skillSources: GitHubSkillSource[];
  presets: SystemPromptPreset[];
};

export default defineBackground(() => {
  enableSidePanelActionClick();
  registerAutomationAlarmListener();

  archiveStaleMemories().catch((error) => reportBackgroundStartupError('archive_stale_memories_failed', error));
  ensureShellMcpPreset().catch((error) => reportBackgroundStartupError('shell_mcp_preset_failed', error));
  createContextMenus().catch((error) => reportBackgroundStartupError('context_menus_failed', error));
  ensureAutomationWakeAlarm().catch((error) => reportBackgroundStartupError('automation_alarm_create_failed', error));
  scanDueAutomationsFromWake().catch((error) => reportBackgroundStartupError('automation_startup_scan_failed', error));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(createBackgroundErrorResponse(message, error)));
    return true;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ('deepseek_pp_chat_enabled' in changes || DEEPSEEK_API_KEY_STORAGE_KEY in changes) {
      createContextMenus().catch(() => {});
      broadcastChatAuthStatus().catch(() => {});
    }
  });
});

function registerAutomationAlarmListener() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTOMATION_WAKE_ALARM_NAME) return;
    scanDueAutomationsFromWake().catch((error) => reportBackgroundStartupError('automation_alarm_scan_failed', error));
  });
}

async function ensureAutomationWakeAlarm() {
  await chrome.alarms.create(AUTOMATION_WAKE_ALARM_NAME, {
    periodInMinutes: AUTOMATION_WAKE_INTERVAL_MINUTES,
  });
}

function enableSidePanelActionClick() {
  if (import.meta.env.FIREFOX) return;

  const sidePanel = (chrome as typeof chrome & { sidePanel?: SidePanelApi }).sidePanel;
  sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((error) => reportBackgroundStartupError('sidepanel_behavior_failed', error));
}

async function createContextMenus() {
  const chatEnabled = await getChatEnabled();
  if (!chatEnabled) {
    try { await chrome.contextMenus.removeAll(); } catch {}
    return;
  }
  try {
    await chrome.contextMenus.removeAll();
  } catch {}
  const apiKeyConfigured = await hasDeepSeekApiKey();
  const menuScope = apiKeyConfigured
    ? {}
    : { documentUrlPatterns: [DEEPSEEK_TAB_URL_PATTERN] };
  const scenarios = await getAllScenarios();
  const enabledScenarios = scenarios.filter((s) => s.enabled);

  chrome.contextMenus.create({
    id: 'send-to-chat',
    title: '发送到对话',
    contexts: ['selection'],
    ...menuScope,
  });

  if (enabledScenarios.length > 0) {
    chrome.contextMenus.create({
      id: 'separator-1',
      type: 'separator',
      contexts: ['selection'],
      ...menuScope,
    });

    for (const scenario of enabledScenarios) {
      chrome.contextMenus.create({
        id: `scenario-${scenario.id}`,
        title: scenario.label,
        contexts: ['selection'],
        ...menuScope,
      });
    }
  }
}

try {
  chrome.contextMenus.onClicked.addListener(async (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
    if (!info.selectionText) return;
    const selectedText = info.selectionText.trim();
    if (!selectedText) return;

    // 在 async 边界之前打开侧边栏，保留用户手势
    const tabId = tab?.id;
    if (tabId && chrome.sidePanel?.open) {
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }

    const chatEnabled = await getChatEnabled();
    if (!chatEnabled) return;

    if (info.menuItemId === 'send-to-chat') {
      openSidePanelAndSendText(selectedText, tab).catch(() => {});
      return;
    }

    if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('scenario-')) {
      const scenarioId = info.menuItemId.slice('scenario-'.length);
      getAllScenarios()
        .then((scenarios) => {
          const scenario = scenarios.find((s) => s.id === scenarioId);
          if (!scenario) return;
          const processed = applyScenarioTemplate(scenario.template, selectedText);
          openSidePanelAndSendText(processed, tab);
        })
        .catch(() => {});
      return;
    }
  });
} catch {}

async function openSidePanelAndSendText(text: string, tab?: chrome.tabs.Tab) {
  // 写入 storage 作为容灾：message 可能因侧边栏未就绪而丢失
  try {
    await chrome.storage.local.set({ pendingChatText: text });
  } catch {}

  chrome.runtime.sendMessage({ type: 'OPEN_CHAT_WITH_TEXT', text }).catch(() => {});
}

async function ensureShellMcpPreset() {
  const servers = await getAllMcpServers();
  const exists = servers.some((s) =>
    s.displayName === SHELL_MCP_SERVER_NAME || s.transport.nativeHost === SHELL_MCP_NATIVE_HOST
  );
  if (!exists) {
    await createMcpServer(createShellMcpPresetInput({ enabled: true }));
  }
}

function reportBackgroundStartupError(code: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[DeepSeek++] ${code}: ${detail}`, error);
}

function createBackgroundErrorResponse(
  message: { type?: string } | unknown,
  error: unknown,
): ToolResult | { ok: false; error: string } | null {
  const detail = error instanceof Error ? error.message : String(error);

  if (!message || typeof message !== 'object') {
    return null;
  }

  const type = (message as { type?: string }).type;

  if (type === 'EXECUTE_TOOL_CALL') {
    return {
      ok: false,
      summary: '后台工具执行失败',
      detail,
      error: {
        code: 'background_tool_execution_failed',
        message: detail,
        retryable: true,
      },
    };
  }

  // Sidepanel sync handlers check result?.ok; content scripts use sendRuntimeMessage
  // which guards against error responses. Return structured error for both.
  return { ok: false, error: detail };
}

async function handleMessage(
  message: { type: string; payload?: unknown },
  sender: chrome.runtime.MessageSender,
) {
  switch (message.type) {
    case 'GET_MEMORIES':
      return getAllMemories();

    case 'GET_MEMORY_BY_ID': {
      const { id: memId } = message.payload as { id: number };
      return getMemoryById(memId) ?? null;
    }

    case 'SAVE_MEMORY': {
      const id = await saveMemory(message.payload as NewMemory);
      await broadcastStateUpdate(sender.tab?.id);
      return { id };
    }

    case 'UPDATE_MEMORY': {
      await updateMemory(message.payload as Memory);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_MEMORY': {
      const { id } = message.payload as { id: number };
      await deleteMemory(id);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'TOUCH_MEMORIES': {
      const { ids } = message.payload as { ids: number[] };
      await touchMemories(ids);
      return { ok: true };
    }

    case 'GET_SKILLS':
      return getAllSkills();

    case 'GET_SKILL_LIBRARY':
      return getSkillLibrary();

    case 'GET_GITHUB_SKILL_SOURCES':
      return getAllSkillSources();

    case 'SAVE_SKILL': {
      const payload = message.payload as Skill | { skill: Skill; previousName?: string };
      const { skill, previousName } = 'skill' in payload ? payload : { skill: payload, previousName: undefined };
      await saveSkill(skill, previousName);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_SKILL': {
      const { name } = message.payload as { name: string };
      await deleteSkill(name);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'SET_SKILL_ENABLED': {
      const { name, enabled } = message.payload as { name: string; enabled: boolean };
      await setSkillEnabled(name, enabled);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'PREVIEW_GITHUB_SKILL_SOURCE': {
      const { url } = message.payload as { url: string };
      return previewGitHubSkillSource(url);
    }

    case 'IMPORT_GITHUB_SKILL_SOURCE': {
      const result = await importGitHubSkillSource(message.payload as GitHubSkillImportRequest);
      await broadcastStateUpdate(sender.tab?.id);
      return result;
    }

    case 'CHECK_GITHUB_SKILL_SOURCE_UPDATES': {
      const { sourceId } = message.payload as { sourceId: string };
      return checkGitHubSkillSourceUpdates(sourceId);
    }

    case 'UPDATE_GITHUB_SKILL_SOURCE': {
      const { sourceId } = message.payload as { sourceId: string };
      const result = await updateGitHubSkillSource(sourceId);
      await broadcastStateUpdate(sender.tab?.id);
      return result;
    }

    case 'DELETE_GITHUB_SKILL_SOURCE': {
      const { sourceId } = message.payload as { sourceId: string };
      await deleteGitHubSkillSource(sourceId);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_PRESETS':
      return getAllPresets();

    case 'SAVE_PRESET': {
      await savePreset(message.payload as SystemPromptPreset);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_PRESET': {
      const { id: presetId } = message.payload as { id: string };
      await deletePreset(presetId);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'SET_ACTIVE_PRESET': {
      const { id: activeId } = message.payload as { id: string | null };
      await setActivePresetId(activeId);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_ACTIVE_PRESET':
      return getActivePreset();

    case 'GET_MCP_SERVERS':
      return getAllMcpServers();

    case 'GET_MCP_SERVER': {
      const { id } = message.payload as { id: string };
      return getMcpServerById(id);
    }

    case 'CREATE_MCP_SERVER': {
      const server = await createMcpServer(message.payload as McpServerCreateInput);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return server;
    }

    case 'UPDATE_MCP_SERVER': {
      const { id, patch } = message.payload as { id: string; patch: McpServerUpdateInput };
      const server = await updateMcpServer(id, patch);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return server;
    }

    case 'DELETE_MCP_SERVER': {
      const { id } = message.payload as { id: string };
      await deleteMcpServer(id);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_MCP_TOOL_CACHE': {
      const { serverId } = message.payload as { serverId: string };
      return getMcpToolCache(serverId);
    }

    case 'REFRESH_MCP_SERVER_TOOLS': {
      const { serverId } = message.payload as { serverId: string };
      const cache = await refreshMcpServerDiscovery(serverId);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return cache;
    }

    case 'REQUEST_MCP_SERVER_PERMISSION': {
      const { serverId } = message.payload as { serverId: string };
      const server = await getMcpServerById(serverId);
      if (!server) return { ok: false, error: 'mcp_server_not_found' };
      if (server.transport.kind === 'native_messaging') return { ok: true, origin: null };
      try {
        const origin = getMcpOriginPattern(server);
        const ok = await requestMcpServerOriginPermission(server);
        return { ok, origin };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'TEST_MCP_SERVER_CONNECTION': {
      const { serverId } = message.payload as { serverId: string };
      const cache = await refreshMcpServerDiscovery(serverId);
      await broadcastMcpServersUpdate(sender.tab?.id);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return {
        ok: cache.health.status === 'ready',
        cache,
        health: cache.health,
      };
    }

    case 'GET_WEB_TOOL_SETTINGS':
      return getWebToolSettings();

    case 'SET_WEB_TOOL_SETTING': {
      const { name, enabled } = message.payload as { name: WebSearchToolName; enabled: boolean };
      await setWebToolEnabled(name, enabled);
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DIAGNOSE_WEB_SEARCH': {
      const q = typeof (message.payload as { query?: string })?.query === 'string'
        ? (message.payload as { query: string }).query : 'test';
      const diags: Record<string, { status: number; length: number; error?: string; preview?: string }> = {};
      for (const domain of ['cn.bing.com', 'www.bing.com']) {
        const url = `https://${domain}/search?q=${encodeURIComponent(q)}`;
        try {
          const resp = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            signal: AbortSignal.timeout(10_000),
          });
          const text = await resp.text();
          diags[domain] = {
            status: resp.status,
            length: text.length,
            preview: text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200),
          };
        } catch (e) {
          diags[domain] = {
            status: 0,
            length: 0,
            error: e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150),
          };
        }
      }
      return diags;
    }

    case 'REQUEST_HOST_PERMISSION': {
      const { origins } = message.payload as { origins: string[] };
      if (!origins?.length) return { ok: false, error: 'no_origins' };
      try {
        const granted = await chrome.permissions.request({ origins }).catch(() => false);
        return { ok: granted, origins };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'GET_TOOL_DESCRIPTORS':
      return getRuntimeToolDescriptors();

    case 'REFRESH_TOOL_DESCRIPTORS': {
      const tools = await refreshRuntimeToolDescriptors();
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      await broadcastMcpServersUpdate(sender.tab?.id);
      return tools;
    }

    case 'EXECUTE_TOOL_CALL': {
      const originalCall = message.payload as ToolCall;
      const tabId = sender.tab?.id;
      const runId = originalCall.source?.runId ?? crypto.randomUUID();
      const call: ToolCall = {
        ...originalCall,
        source: { ...(originalCall.source ?? { trigger: 'manual_chat' }), runId },
      };
      const controller = call.name === 'spawn_subagent' ? new AbortController() : null;
      if (controller) replaceActiveToolRunController(runId, controller);
      let progressListener: ((event: import('../core/tool/subagent').SubAgentProgressEvent) => void) | null = null;
      if (call.name === 'spawn_subagent' && tabId != null) {
        progressListener = (event) => {
          chrome.tabs.sendMessage(tabId, { type: 'SUBAGENT_PROGRESS', payload: event }).catch(() => {});
        };
        addSubAgentProgressListener(runId, progressListener);
      }
      try {
        const result = await executeRuntimeToolCall(
          call,
          call.source?.trigger ?? 'manual_chat',
          { signal: controller?.signal },
        );
        await broadcastToolCallHistoryUpdate(sender.tab?.id);
        return result;
      } finally {
        if (controller && activeToolRunControllers.get(runId) === controller) {
          activeToolRunControllers.delete(runId);
        }
        if (progressListener) {
          removeSubAgentProgressListener(runId, progressListener);
        }
      }
    }

    case 'EXECUTE_TOOL_CALLS_BATCH': {
      const originalCalls = message.payload as ToolCall[];
      const tabId = sender.tab?.id;
      const runId = originalCalls.find((call) => call.source?.runId)?.source?.runId ?? crypto.randomUUID();
      const calls: ToolCall[] = originalCalls.map((call) => ({
        ...call,
        source: { ...(call.source ?? { trigger: 'manual_chat' as const }), runId },
      }));
      const hasSubAgents = calls.some((c) => c.name === 'spawn_subagent');
      const controller = new AbortController();
      replaceActiveToolRunController(runId, controller);
      let progressListener: ((event: import('../core/tool/subagent').SubAgentProgressEvent) => void) | null = null;
      if (hasSubAgents && tabId != null) {
        progressListener = (event) => {
          chrome.tabs.sendMessage(tabId, { type: 'SUBAGENT_PROGRESS', payload: event }).catch(() => {});
        };
        addSubAgentProgressListener(runId, progressListener);
      }
      try {
        const records = await executeToolCallsInParallel(
          calls,
          async (call) => ({
            name: call.name,
            provider: call.provider,
            descriptorId: call.descriptorId,
            result: await executeRuntimeToolCall(
              call,
              call.source?.trigger ?? 'manual_chat',
              { signal: controller.signal },
            ),
          }),
          { signal: controller.signal },
        );
        await broadcastToolCallHistoryUpdate(sender.tab?.id);
        return { results: records.map((record) => record.result) };
      } finally {
        if (activeToolRunControllers.get(runId) === controller) {
          activeToolRunControllers.delete(runId);
        }
        if (progressListener) {
          removeSubAgentProgressListener(runId, progressListener);
        }
      }
    }

    case 'CANCEL_TOOL_RUN': {
      const { runId } = message.payload as { runId: string };
      activeToolRunControllers.get(runId)?.abort();
      return { ok: true };
    }

    case 'GET_TOOL_CALL_HISTORY': {
      const { limit } = (message.payload as { limit?: number } | undefined) ?? {};
      return getToolCallHistory(limit);
    }

    case 'CLEAR_TOOL_CALL_HISTORY': {
      await clearToolCallHistory();
      await broadcastToolCallHistoryUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_CONFIG':
      return { version: getExtensionVersion() };

    case 'GET_DEEPSEEK_API_KEY_STATUS':
      return { ok: true, configured: await hasDeepSeekApiKey() };

    case 'SAVE_DEEPSEEK_API_KEY': {
      const { apiKey } = message.payload as { apiKey?: string };
      await saveDeepSeekApiKey(apiKey ?? '');
      officialApiChatMessages = [];
      await createContextMenus();
      await broadcastChatAuthStatus(sender.tab?.id);
      return { ok: true, configured: true };
    }

    case 'CLEAR_DEEPSEEK_API_KEY':
      await clearDeepSeekApiKey();
      officialApiChatMessages = [];
      await createContextMenus();
      await broadcastChatAuthStatus(sender.tab?.id);
      return { ok: true, configured: false };

    case 'GET_DEEPSEEK_THEME':
      return getDeepSeekTheme();

    case 'SET_DEEPSEEK_THEME': {
      const { theme } = message.payload as { theme?: DeepSeekTheme };
      if (theme !== 'light' && theme !== 'dark') return { ok: false, error: 'invalid_theme' };
      const current = await getDeepSeekTheme();
      if (current === theme) return { ok: true };
      await saveDeepSeekTheme(theme);
      await broadcastThemeUpdate(theme, sender.tab?.id);
      return { ok: true };
    }

    case 'GET_MODEL_TYPE':
      return getModelType();

    case 'SET_MODEL_TYPE': {
      const newModelType = message.payload as ModelType;
      const current = await getModelType();
      if (newModelType === current) return { ok: true };
      await setModelType(newModelType);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_BACKGROUND':
      return getBackgroundConfig();

    case 'SAVE_BACKGROUND': {
      const bgConfig = message.payload as BackgroundConfig;
      await saveBackgroundConfig(bgConfig);
      await broadcastBackgroundUpdate(bgConfig);
      return { ok: true };
    }

    case 'CLEAR_BACKGROUND': {
      await clearBackgroundConfig();
      await broadcastBackgroundUpdate(null);
      return { ok: true };
    }

    case 'GET_PET':
      return getPetConfig();

    case 'SAVE_PET': {
      const petConfig = message.payload as PetConfig;
      await savePetConfig(petConfig);
      await broadcastPetUpdate(petConfig);
      return { ok: true };
    }

    case 'CLEAR_PET': {
      await clearPetConfig();
      await broadcastPetUpdate(await getPetConfig());
      return { ok: true };
    }

    case 'GET_SYNC_CONFIG':
      return getSyncConfig();

    case 'SAVE_SYNC_CONFIG': {
      await saveSyncConfig(message.payload as SyncConfig);
      return { ok: true };
    }

    case 'WEBDAV_TEST': {
      await webdavTest(message.payload as SyncConfig);
      return { ok: true };
    }

    case 'WEBDAV_UPLOAD_LOCAL': {
      const config = await getSyncConfig();
      if (!config) throw new Error('未配置 WebDAV');

      const [, snapshot] = await Promise.all([
        webdavMkcol(config),
        getLocalSyncDataSnapshot(),
      ]);

      await uploadSyncDataSnapshot(config, snapshot);

      const now = Date.now();
      await saveSyncConfig({ ...config, lastSyncAt: now });
      return { ok: true, lastSyncAt: now, counts: getSyncCounts(snapshot) };
    }

    case 'WEBDAV_DOWNLOAD_REMOTE': {
      const config = await getSyncConfig();
      if (!config) throw new Error('未配置 WebDAV');

      const snapshot = await getRemoteSyncDataSnapshot(config);

      await Promise.all([
        replaceAllMemories(snapshot.memories),
        replaceAllCustomSkills(snapshot.skills),
        replaceAllSkillSources(snapshot.skillSources),
        replaceAllPresets(snapshot.presets),
      ]);

      const now = Date.now();
      await saveSyncConfig({ ...config, lastSyncAt: now });
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true, lastSyncAt: now, counts: getSyncCounts(snapshot) };
    }

    case 'CHAT_SUBMIT_PROMPT': {
      const { text } = message.payload as { text: string };
      if (!(await getChatEnabled())) {
        return { ok: false, error: 'chat_disabled' };
      }
      if (!text?.trim()) return { ok: false, error: 'empty_prompt' };
      // Fire and forget — the streaming response is broadcast
      handleChatSubmitPrompt(text, sender.tab?.id).catch(() => {});
      return { ok: true };
    }

    case 'CHAT_NEW_SESSION':
      chatSessionId = null;
      chatParentMessageId = null;
      officialApiChatMessages = [];
      return { ok: true };

    case 'GET_AUTH_STATUS': {
      return getChatAuthStatus(sender.tab?.id);
    }

    case 'EXPORT_DEEPSEEK_CONVERSATIONS':
      return handleConversationExport(message.payload, sender.tab?.id);

    case 'CANCEL_DEEPSEEK_EXPORT': {
      const { exportId } = message.payload as { exportId?: string };
      if (!exportId) return { ok: false, error: 'missing_export_id' };
      const controller = conversationExportControllers.get(exportId);
      if (!controller) return { ok: false, error: 'export_not_running' };
      controller.abort();
      conversationExportControllers.delete(exportId);
      await broadcastConversationExportProgress({
        exportId,
        phase: 'cancelled',
        status: 'cancelled',
        current: 0,
        total: 0,
        message: '导出已取消',
      }, sender.tab?.id);
      return { ok: true };
    }

    case 'AUTH_STATUS_CHANGED': {
      await broadcastChatAuthStatus(sender.tab?.id);
      return { ok: true };
    }

    case 'GET_AUTOMATIONS':
      return getAllAutomations();

    case 'GET_AUTOMATION_RUNS': {
      const { automationId, limit } = message.payload as { automationId: string; limit?: number };
      return getAutomationRuns({ automationId, limit });
    }

    case 'CREATE_AUTOMATION': {
      const input = message.payload as AutomationCreateInput;
      validateAutomationInput(input);
      const automation = await createAutomation(input);
      const refreshed = await refreshAutomationNextRunAt(automation.id);
      await broadcastAutomationUpdate(sender.tab?.id);
      return refreshed ?? automation;
    }

    case 'UPDATE_AUTOMATION': {
      const { id, patch } = message.payload as { id: string; patch: AutomationUpdateInput };
      validateAutomationPatch(patch);
      const automation = await updateAutomation(id, patch);
      if (!automation) return { ok: false, error: 'automation_not_found' };
      const refreshed = await refreshAutomationNextRunAt(id);
      await broadcastAutomationUpdate(sender.tab?.id);
      return refreshed ?? automation;
    }

    case 'SET_AUTOMATION_STATUS': {
      const { id, status } = message.payload as { id: string; status: AutomationStatus };
      if (!isAutomationStatus(status)) return { ok: false, error: 'invalid_automation_status' };
      const automation = await setAutomationStatus(id, status);
      if (!automation) return { ok: false, error: 'automation_not_found' };
      const refreshed = await refreshAutomationNextRunAt(id);
      await broadcastAutomationUpdate(sender.tab?.id);
      return refreshed ?? automation;
    }

    case 'DELETE_AUTOMATION': {
      const { id } = message.payload as { id: string };
      await deleteAutomation(id);
      await broadcastAutomationUpdate(sender.tab?.id);
      await broadcastAutomationRunsUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'RUN_AUTOMATION_NOW': {
      const { id } = message.payload as { id: string };
      return runAutomationNow(id, sender.tab?.id);
    }

    case 'SCENARIOS_UPDATED':
      await createContextMenus();
      return { ok: true };

    default:
      return null;
  }
}

async function broadcastToTabs(payload: Record<string, unknown>, excludeTabId?: number) {
  chrome.runtime.sendMessage(payload).catch(() => {});

  const tabs = await chrome.tabs.query({ url: DEEPSEEK_TAB_URL_PATTERN });
  for (const tab of tabs) {
    if (tab.id && tab.id !== excludeTabId) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  }
  if (excludeTabId) {
    chrome.tabs.sendMessage(excludeTabId, payload).catch(() => {});
  }
}

async function loadOrRefreshClientHeaders(preferredTabId?: number): Promise<Record<string, string> | null> {
  const cached = await loadClientHeadersFromStorage();
  if (cached) return cached;

  await refreshClientHeadersFromDeepSeekTabs(preferredTabId);
  return loadClientHeadersFromStorage();
}

async function refreshClientHeadersFromDeepSeekTabs(preferredTabId?: number): Promise<boolean> {
  const tabs = await getDeepSeekTabsForAuthRefresh(preferredTabId);
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, REFRESH_AUTH_MESSAGE);
      if (response?.hasToken === true) return true;
    } catch {
      // Content scripts may be absent on stale or restricted tabs; try the next live DeepSeek tab.
    }
  }
  return false;
}

async function getDeepSeekTabsForAuthRefresh(preferredTabId?: number): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ url: DEEPSEEK_TAB_URL_PATTERN });
  if (!preferredTabId) {
    return tabs.sort((a, b) => Number(b.active) - Number(a.active));
  }

  const preferred = tabs.find((tab) => tab.id === preferredTabId);
  if (!preferred) return tabs;
  return [preferred, ...tabs.filter((tab) => tab.id !== preferredTabId)];
}

async function broadcastStateUpdate(excludeTabId?: number) {
  const [memories, skills, activePreset, modelType] = await Promise.all([
    getAllMemories(),
    getAllSkills(),
    getActivePreset(),
    getModelType(),
  ]);
  await broadcastToTabs({ type: 'STATE_UPDATED', memories, skills, activePreset, modelType }, excludeTabId);
}

async function broadcastBackgroundUpdate(config: BackgroundConfig | null) {
  await broadcastToTabs({ type: 'BACKGROUND_UPDATED', config });
}

async function broadcastPetUpdate(config: PetConfig) {
  await broadcastToTabs({ type: 'PET_UPDATED', config });
}

async function broadcastThemeUpdate(theme: DeepSeekTheme, excludeTabId?: number) {
  await broadcastToTabs({ type: 'THEME_UPDATED', theme }, excludeTabId);
}

async function broadcastMcpServersUpdate(excludeTabId?: number) {
  const servers = await getAllMcpServers();
  await broadcastToTabs({ type: 'MCP_SERVERS_UPDATED', servers }, excludeTabId);
}

async function broadcastToolDescriptorsUpdate(excludeTabId?: number) {
  const toolDescriptors = await getRuntimeToolDescriptors();
  await broadcastToTabs({ type: 'TOOL_DESCRIPTORS_UPDATED', toolDescriptors }, excludeTabId);
}

async function broadcastToolCallHistoryUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'TOOL_CALL_HISTORY_UPDATED' }, excludeTabId);
}

async function broadcastAutomationUpdate(excludeTabId?: number) {
  const automations = await getAllAutomations();
  await broadcastToTabs({ type: 'AUTOMATIONS_UPDATED', automations }, excludeTabId);
}

async function broadcastAutomationRunsUpdate(excludeTabId?: number) {
  await broadcastToTabs({ type: 'AUTOMATION_RUNS_UPDATED' }, excludeTabId);
}

async function getChatAuthStatus(preferredTabId?: number) {
  const hasApiKey = await hasDeepSeekApiKey();
  if (hasApiKey) {
    return {
      ok: true,
      available: true,
      provider: 'official-api',
      hasApiKey: true,
      hasToken: false,
    };
  }

  const headers = await loadOrRefreshClientHeaders(preferredTabId);
  return {
    ok: true,
    available: !!headers,
    provider: headers ? 'deepseek-web' : null,
    hasApiKey: false,
    hasToken: !!headers,
  };
}

async function broadcastChatAuthStatus(preferredTabId?: number) {
  const status = await getChatAuthStatus(preferredTabId);
  chrome.runtime.sendMessage({ type: 'AUTH_STATUS_CHANGED', ...status }).catch(() => {});
}

async function broadcastConversationExportProgress(
  progress: ConversationExportProgress,
  excludeTabId?: number,
) {
  await broadcastToTabs({ type: 'DEEPSEEK_EXPORT_PROGRESS', progress }, excludeTabId);
}

async function handleConversationExport(
  payload: unknown,
  excludeTabId?: number,
): Promise<ConversationExportResult | { ok: false; exportId?: string; error: string }> {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const exportId = typeof value.exportId === 'string' && value.exportId.trim()
    ? value.exportId.trim()
    : crypto.randomUUID();
  const request = normalizeConversationExportRequest(value.request);
  const headers = await loadOrRefreshClientHeaders(excludeTabId);
  if (!headers) {
    return {
      ok: false,
      exportId,
      error: MISSING_DEEPSEEK_AUTH_MESSAGE,
    };
  }

  const controller = new AbortController();
  conversationExportControllers.set(exportId, controller);

  try {
    const baseUrl = new URL(DEEPSEEK_HOME_URL).origin;
    const exportData = await runConversationExport({
      exportId,
      request,
      baseUrl,
      extensionVersion: getExtensionVersion(),
      signal: controller.signal,
      transport: createDeepSeekConversationExportTransport({
        baseUrl,
        clientHeaders: headers,
        fetchImpl: fetch,
      }),
      onProgress: (progress) => broadcastConversationExportProgress(progress, excludeTabId),
    });

    await broadcastConversationExportProgress({
      exportId,
      phase: 'formatting',
      status: 'running',
      current: 0,
      total: request.formats.length,
      message: '生成导出文件',
    }, excludeTabId);

    assertConversationExportNotCancelled(controller.signal);
    const artifacts = await buildConversationExportArtifactsCancellable(exportData, controller.signal);
    assertConversationExportNotCancelled(controller.signal);
    return {
      ok: true,
      exportId,
      summary: exportData.stats,
      artifacts,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    await broadcastConversationExportProgress({
      exportId,
      phase: aborted ? 'cancelled' : 'failed',
      status: aborted ? 'cancelled' : 'failed',
      current: 0,
      total: 0,
      message: aborted ? '导出已取消' : error instanceof Error ? error.message : String(error),
    }, excludeTabId);
    return {
      ok: false,
      exportId,
      error: aborted ? '导出已取消' : error instanceof Error ? error.message : String(error),
    };
  } finally {
    conversationExportControllers.delete(exportId);
  }
}

function assertConversationExportNotCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Conversation export was cancelled.', 'AbortError');
}

async function scanDueAutomationsFromWake() {
  const result = await scanDueAutomations(executeAutomationWithContext);
  if (result.initialized > 0 || result.started > 0 || result.failed > 0) {
    await broadcastAutomationUpdate();
  }
  if (result.started > 0 || result.failed > 0) {
    await broadcastAutomationRunsUpdate();
    await broadcastToolCallHistoryUpdate();
  }
  return result;
}

async function runAutomationNow(id: string, excludeTabId?: number) {
  const automation = await getAutomationById(id);
  if (!automation) return { ok: false, error: 'automation_not_found' };

  const run = await runAutomation({
    automationId: id,
    trigger: 'manual',
    scheduledFor: null,
    executor: executeAutomationWithContext,
  });

  await broadcastAutomationUpdate(excludeTabId);
  await broadcastAutomationRunsUpdate(excludeTabId);
  await broadcastToolCallHistoryUpdate(excludeTabId);

  return run ?? { ok: false, error: 'automation_already_running' };
}

async function executeAutomationWithContext(
  request: AutomationRunnerRequest,
): Promise<AutomationRunnerResult> {
  const [memories, activePreset, toolDescriptors] = await Promise.all([
    getAllMemories(),
    getActivePreset(),
    getRuntimeToolDescriptors(),
  ]);
  const enabledDescriptors = toolDescriptors.filter((descriptor) => descriptor.execution.enabled);

  return runDeepSeekAutomation({
    ...request,
    promptContext: {
      memories,
      presetContent: activePreset?.content ?? null,
      toolDescriptors: enabledDescriptors,
    },
  }, {
    executeToolCall: (call) => executeRuntimeToolCall(call, 'automation'),
  });
}

function validateAutomationInput(input: AutomationCreateInput) {
  if (!input || typeof input !== 'object') throw new Error('Invalid automation input');
  validateNonEmptyString(input.name, 'Automation name');
  validateNonEmptyString(input.prompt, 'Automation prompt');
  validateAutomationScheduleInput(input.schedule);
}

function validateAutomationPatch(patch: AutomationUpdateInput) {
  if (!patch || typeof patch !== 'object') throw new Error('Invalid automation patch');
  if (patch.name !== undefined) validateNonEmptyString(patch.name, 'Automation name');
  if (patch.prompt !== undefined) validateNonEmptyString(patch.prompt, 'Automation prompt');
  if (patch.status !== undefined && !isAutomationStatus(patch.status)) {
    throw new Error('Invalid automation status');
  }
  if (patch.schedule !== undefined) validateAutomationScheduleInput(patch.schedule);
}

function validateAutomationScheduleInput(schedule: AutomationCreateInput['schedule']) {
  if (!schedule || typeof schedule !== 'object') throw new Error('Invalid automation schedule');
  const result = validateAutomationSchedule(schedule);
  if (!result.ok) throw new Error(result.error.message);
}

function validateNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

function isAutomationStatus(status: unknown): status is AutomationStatus {
  return status === 'active' || status === 'paused' || status === 'archived';
}

async function getLocalSyncDataSnapshot(): Promise<SyncDataSnapshot> {
  const [memories, userSkills, skillSources, presets] = await Promise.all([
    getAllMemories(),
    getUserSkills(),
    getAllSkillSources(),
    getAllPresets(),
  ]);

  return {
    memories: memories.map(({ id, ...memory }) => memory),
    skills: userSkills,
    skillSources,
    presets,
  };
}

async function uploadSyncDataSnapshot(config: SyncConfig, snapshot: SyncDataSnapshot): Promise<void> {
  await Promise.all([
    webdavPut(config, 'memories.json', JSON.stringify(snapshot.memories)),
    webdavPut(config, 'skills.json', JSON.stringify(snapshot.skills)),
    webdavPut(config, 'skill-sources.json', JSON.stringify(snapshot.skillSources)),
    webdavPut(config, 'presets.json', JSON.stringify(snapshot.presets)),
  ]);
}

async function getRemoteSyncDataSnapshot(config: SyncConfig): Promise<SyncDataSnapshot> {
  const [remoteMemJson, remoteSkillJson, remotePresetJson, remoteSkillSourceJson] = await Promise.all([
    webdavGetRequired(config, 'memories.json'),
    webdavGetRequired(config, 'skills.json'),
    webdavGetRequired(config, 'presets.json'),
    webdavGet(config, 'skill-sources.json'),
  ]);

  const memories = parseValidatedArray('memories.json', remoteMemJson, (item, path) => {
    if (!item || typeof item !== 'object') throw new Error(`${path} must be an object`);
    const { id: _id, ...memory } = item as Memory;
    return validateStoredMemory(memory, path);
  });

  return {
    memories,
    skills: parseValidatedArray('skills.json', remoteSkillJson, validateSkill),
    skillSources: remoteSkillSourceJson === null
      ? []
      : parseValidatedArray('skill-sources.json', remoteSkillSourceJson, validateGitHubSkillSource),
    presets: parseValidatedArray('presets.json', remotePresetJson, validatePreset),
  };
}

async function webdavGetRequired(config: SyncConfig, file: string): Promise<string> {
  const content = await webdavGet(config, file);
  if (content === null) {
    throw new Error(`云端缺少 ${file}，已停止下载以避免覆盖本地数据`);
  }
  return content;
}

function getSyncCounts(snapshot: SyncDataSnapshot): SyncCounts {
  return {
    memories: snapshot.memories.length,
    skills: snapshot.skills.length,
    presets: snapshot.presets.length,
  };
}

async function handleChatSubmitPrompt(prompt: string, excludeTabId?: number) {
  const apiKey = await getDeepSeekApiKey();
  if (apiKey) {
    await handleOfficialApiChatSubmitPrompt(prompt, apiKey, excludeTabId);
    return;
  }

  await handleWebChatSubmitPrompt(prompt, excludeTabId);
}

async function handleWebChatSubmitPrompt(prompt: string, excludeTabId?: number) {
  const headers = await loadOrRefreshClientHeaders(excludeTabId);
  if (!headers) {
    broadcastChatChunk({ text: '', done: true, error: MISSING_DEEPSEEK_AUTH_MESSAGE }, excludeTabId);
    return;
  }

  try {
    if (!chatSessionId) {
      chatSessionId = await createChatSession(headers);
      chatParentMessageId = null;
    }

    const { augmented, enabledDescriptors } = await buildSidepanelPrompt(prompt);

    const powHeaders = await createPowHeaders(headers);

    const initialInput = {
      chatSessionId,
      parentMessageId: chatParentMessageId,
      modelType: null,
      prompt: augmented,
      refFileIds: [],
      thinkingEnabled: false,
      searchEnabled: false,
      clientHeaders: headers,
      powHeaders,
    };

    await runSidepanelToolLoop(initialInput, enabledDescriptors, excludeTabId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcastChatChunk({ text: '', done: true, error: msg }, excludeTabId);
    if (msg.includes('auth') || msg.includes('token') || msg.includes('401')) {
      chatSessionId = null;
    }
  }
}

async function handleOfficialApiChatSubmitPrompt(prompt: string, apiKey: string, excludeTabId?: number) {
  try {
    const [modelType, promptContext] = await Promise.all([
      getModelType(),
      buildSidepanelPrompt(prompt),
    ]);

    const initialMessages: OfficialDeepSeekMessage[] = [
      ...officialApiChatMessages,
      { role: 'user', content: promptContext.augmented },
    ];

    officialApiChatMessages = await runOfficialApiToolLoop(
      {
        apiKey,
        modelType,
        messages: initialMessages,
      },
      promptContext.enabledDescriptors,
      excludeTabId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcastChatChunk({ text: '', done: true, error: msg }, excludeTabId);
  }
}

async function buildSidepanelPrompt(prompt: string): Promise<{
  augmented: string;
  enabledDescriptors: ToolDescriptor[];
}> {
  const [memories, activePreset, toolDescriptors] = await Promise.all([
    getAllMemories(),
    getActivePreset(),
    getRuntimeToolDescriptors(),
  ]);

  const enabledDescriptors = toolDescriptors.filter((t) => t.execution.enabled);
  const { augmented } = buildPromptAugmentation(prompt, {
    memories,
    presetContent: activePreset?.content ?? null,
    toolDescriptors: enabledDescriptors,
    thinkingEnabled: false,
  });

  return { augmented, enabledDescriptors };
}

async function runOfficialApiToolLoop(
  input: {
    apiKey: string;
    modelType: ModelType;
    messages: OfficialDeepSeekMessage[];
  },
  toolDescriptors: ToolDescriptor[],
  excludeTabId?: number,
): Promise<OfficialDeepSeekMessage[]> {
  const MAX_STEPS = 20;
  let currentMessages = [...input.messages];

  for (let step = 0; step < MAX_STEPS; step++) {
    let accumulated = '';
    const turn = await submitOfficialDeepSeekStreaming({
      apiKey: input.apiKey,
      modelType: input.modelType,
      messages: currentMessages,
    }, {
      onTextChunk(newText: string, fullText: string) {
        accumulated = fullText;
        broadcastChatChunk({ text: newText, done: false }, excludeTabId);
      },
    });

    const fullText = accumulated || turn.assistantText;

    if (!fullText) {
      broadcastChatChunk({ text: '', done: true }, excludeTabId);
      return currentMessages;
    }

    currentMessages = [...currentMessages, { role: 'assistant', content: fullText }];
    const toolCalls = extractToolCalls(fullText, { descriptors: toolDescriptors });

    if (toolCalls.length === 0) {
      broadcastChatChunk({ text: '', done: true }, excludeTabId);
      return currentMessages;
    }

    const execs: ToolExecutionRecord[] = [];
    for (const call of toolCalls) {
      const result = await executeRuntimeToolCall(call, 'sidepanel_chat');
      execs.push({
        name: call.name,
        result: {
          ok: result.ok,
          summary: result.summary,
          detail: result.detail,
          output: result.output,
          truncated: result.truncated,
          error: result.error,
        },
      });
    }

    const toolResultsText = execs.map((e) =>
      `<${e.name}_result>\n${JSON.stringify(e.result)}\n</${e.name}_result>`
    ).join('\n');

    currentMessages = [
      ...currentMessages,
      {
        role: 'user',
        content: `[TOOL_RESULTS]\n${toolResultsText}\n[/TOOL_RESULTS]\n\n请根据上述工具执行结果继续回答。`,
      },
    ];
  }

  broadcastChatChunk({ text: '(达到最大工具调用步数，对话结束)', done: true }, excludeTabId);
  return currentMessages;
}

async function runSidepanelToolLoop(
  input: {
    chatSessionId: string;
    parentMessageId: number | null;
    modelType: string | null;
    prompt: string;
    refFileIds: string[];
    thinkingEnabled: boolean;
    searchEnabled: boolean;
    clientHeaders: Record<string, string>;
    powHeaders: Record<string, string>;
  },
  toolDescriptors: ToolDescriptor[],
  excludeTabId?: number,
) {
  const MAX_STEPS = 20;
  const allExecutions: ToolExecutionRecord[] = [];
  let currentInput = input;

  for (let step = 0; step < MAX_STEPS; step++) {
    let accumulated = '';
    const turn = await submitPromptStreaming(currentInput, {
      onTextChunk(newText: string, fullText: string) {
        accumulated = fullText;
        broadcastChatChunk({ text: newText, done: false }, excludeTabId);
      },
    });

    chatParentMessageId = turn.responseMessageId;
    const fullText = accumulated || turn.assistantText;

    if (!fullText) {
      broadcastChatChunk({ text: '', done: true }, excludeTabId);
      return;
    }

    const toolCalls = extractToolCalls(fullText, { descriptors: toolDescriptors });

    if (toolCalls.length === 0) {
      broadcastChatChunk({ text: fullText, done: true }, excludeTabId);
      return;
    }

    const execs: ToolExecutionRecord[] = [];
    for (const call of toolCalls) {
      const result = await executeRuntimeToolCall(call, 'sidepanel_chat');
      execs.push({
        name: call.name,
        result: {
          ok: result.ok,
          summary: result.summary,
          detail: result.detail,
          output: result.output,
          truncated: result.truncated,
          error: result.error,
        },
      });
    }
    allExecutions.push(...execs);

    const toolResultsText = execs.map((e) =>
      `<${e.name}_result>\n${JSON.stringify(e.result)}\n</${e.name}_result>`
    ).join('\n');

    const continuationPrompt = `[TOOL_RESULTS]\n${toolResultsText}\n[/TOOL_RESULTS]\n\n请根据上述工具执行结果继续回答。`;

    currentInput = {
      ...currentInput,
      prompt: continuationPrompt,
      parentMessageId: chatParentMessageId,
    };
  }

  broadcastChatChunk({ text: '(达到最大工具调用步数，对话结束)', done: true }, excludeTabId);
}

function broadcastChatChunk(
  chunk: { text: string; done: boolean; error?: string },
  excludeTabId?: number,
) {
  chrome.runtime.sendMessage({ type: 'CHAT_STREAM_CHUNK', ...chunk }).catch(() => {});
}

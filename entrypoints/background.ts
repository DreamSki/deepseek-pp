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
import { getAllSkills, saveSkill, deleteSkill, replaceAllCustomSkills } from '../core/skill/registry';
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
import { mergeMemories, mergeSkills, mergePresets } from '../core/sync/merge';
import { clearToolCallHistory, getToolCallHistory } from '../core/tool/history';
import {
  executeRuntimeToolCall,
  getRuntimeToolDescriptors,
  refreshRuntimeToolDescriptors,
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
import type { BackgroundConfig, DeepSeekTheme, Memory, ModelType, NewMemory, PetConfig, Skill, SyncConfig, SystemPromptPreset, ToolCall, ToolResult } from '../core/types';
import type { McpServerCreateInput, McpServerUpdateInput } from '../core/mcp/types';

const DEEPSEEK_HOME_URL = 'https://chat.deepseek.com/';
type SidePanelApi = {
  setPanelBehavior?: (options: { openPanelOnActionClick: boolean }) => Promise<void>;
};

export default defineBackground(() => {
  enableSidePanelActionClick();

  archiveStaleMemories().catch((error) => reportBackgroundStartupError('archive_stale_memories_failed', error));
  ensureShellMcpPreset().catch((error) => reportBackgroundStartupError('shell_mcp_preset_failed', error));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(createBackgroundErrorResponse(message, error)));
    return true;
  });
});

function enableSidePanelActionClick() {
  if (import.meta.env.FIREFOX) return;

  const sidePanel = (chrome as typeof chrome & { sidePanel?: SidePanelApi }).sidePanel;
  sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch((error) => reportBackgroundStartupError('sidepanel_behavior_failed', error));
}

async function ensureShellMcpPreset() {
  const servers = await getAllMcpServers();
  const exists = servers.some((s) =>
    s.displayName === SHELL_MCP_SERVER_NAME || s.transport.nativeHost === SHELL_MCP_NATIVE_HOST
  );
  if (!exists) {
    await createMcpServer(createShellMcpPresetInput({ enabled: false }));
  }
}

function reportBackgroundStartupError(code: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[DeepSeek++] ${code}: ${detail}`, error);
}

function createBackgroundErrorResponse(
  message: { type?: string } | unknown,
  error: unknown,
): ToolResult | null {
  if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'EXECUTE_TOOL_CALL') {
    return null;
  }

  const detail = error instanceof Error ? error.message : String(error);
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

    case 'SAVE_SKILL': {
      await saveSkill(message.payload as Skill);
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true };
    }

    case 'DELETE_SKILL': {
      const { name } = message.payload as { name: string };
      await deleteSkill(name);
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

    case 'GET_TOOL_DESCRIPTORS':
      return getRuntimeToolDescriptors();

    case 'REFRESH_TOOL_DESCRIPTORS': {
      const tools = await refreshRuntimeToolDescriptors();
      await broadcastToolDescriptorsUpdate(sender.tab?.id);
      await broadcastMcpServersUpdate(sender.tab?.id);
      return tools;
    }

    case 'EXECUTE_TOOL_CALL': {
      const call = message.payload as ToolCall;
      const result = await executeRuntimeToolCall(call, call.source?.trigger ?? 'manual_chat');
      await broadcastToolCallHistoryUpdate(sender.tab?.id);
      return result;
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

    case 'WEBDAV_SYNC': {
      const config = await getSyncConfig();
      if (!config) throw new Error('未配置 WebDAV');

      await webdavMkcol(config);

      const [localMemories, allSkills, localPresets] = await Promise.all([
        getAllMemories(),
        getAllSkills(),
        getAllPresets(),
      ]);
      const localSkills = allSkills.filter((s) => s.source === 'custom');

      const [remoteMemJson, remoteSkillJson, remotePresetJson] = await Promise.all([
        webdavGet(config, 'memories.json'),
        webdavGet(config, 'skills.json'),
        webdavGet(config, 'presets.json'),
      ]);

      const remoteMemories: Memory[] = remoteMemJson ? JSON.parse(remoteMemJson) : [];
      const remoteSkills: Skill[] = remoteSkillJson ? JSON.parse(remoteSkillJson) : [];
      const remotePresets: SystemPromptPreset[] = remotePresetJson ? JSON.parse(remotePresetJson) : [];

      const mergedMemories = mergeMemories(localMemories, remoteMemories);
      const mergedSkills = mergeSkills(localSkills, remoteSkills);
      const mergedPresets = mergePresets(localPresets, remotePresets);

      await Promise.all([
        replaceAllMemories(mergedMemories),
        replaceAllCustomSkills(mergedSkills),
        replaceAllPresets(mergedPresets),
      ]);

      await Promise.all([
        webdavPut(config, 'memories.json', JSON.stringify(mergedMemories)),
        webdavPut(config, 'skills.json', JSON.stringify(mergedSkills)),
        webdavPut(config, 'presets.json', JSON.stringify(mergedPresets)),
      ]);

      const now = Date.now();
      await saveSyncConfig({ ...config, lastSyncAt: now });
      await broadcastStateUpdate(sender.tab?.id);
      return { ok: true, lastSyncAt: now };
    }

    default:
      return null;
  }
}

async function broadcastToTabs(payload: Record<string, unknown>, excludeTabId?: number) {
  chrome.runtime.sendMessage(payload).catch(() => {});

  const tabs = await chrome.tabs.query({ url: '*://chat.deepseek.com/*' });
  for (const tab of tabs) {
    if (tab.id && tab.id !== excludeTabId) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  }
  if (excludeTabId) {
    chrome.tabs.sendMessage(excludeTabId, payload).catch(() => {});
  }
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

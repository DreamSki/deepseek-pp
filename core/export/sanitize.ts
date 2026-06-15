import { stripToolCalls } from '../interceptor/tool-parser';
import { sanitizeInternalPromptText } from '../prompt';
import { SHELL_TOOL_NAMES } from '../shell/contracts';
import type {
  ConversationExport,
  ExportedContentFragment,
  ExportedMessage,
  ExportedSession,
} from './types';

export function sanitizeConversationExport(exportData: ConversationExport): ConversationExport {
  const sessions = exportData.sessions.map(sanitizeSession);
  return {
    ...exportData,
    request: { ...exportData.request, mode: 'sanitized' },
    stats: {
      ...exportData.stats,
      messageCount: sessions.reduce((total, session) => total + session.messages.length, 0),
    },
    sessions,
    attachments: exportData.attachments.map((attachment) => {
      const { raw: _raw, signedPath: _signedPath, ...safeAttachment } = attachment;
      return safeAttachment;
    }),
  };
}

export function sanitizeExportText(text: string): string {
  const visibleText = sanitizeInternalPromptText(text);
  return stripKnownShellToolCalls(stripToolCalls(visibleText)).trim();
}

function sanitizeSession(session: ExportedSession): ExportedSession {
  const { raw: _raw, ...safeSession } = session;
  const messages = safeSession.messages
    .map(sanitizeMessage)
    .filter((message) => message.content.length > 0 || message.contentFragments.length > 0 || message.attachmentRefs.length > 0);
  return {
    ...safeSession,
    messages,
  };
}

function sanitizeMessage(message: ExportedMessage): ExportedMessage {
  const { raw: _raw, ...safeMessage } = message;
  const contentFragments = safeMessage.contentFragments
    .map(sanitizeFragment)
    .filter((fragment) => fragment.text.length > 0);

  return {
    ...safeMessage,
    content: sanitizeExportText(safeMessage.content),
    contentFragments,
  };
}

function sanitizeFragment(fragment: ExportedContentFragment): ExportedContentFragment {
  return {
    ...fragment,
    text: sanitizeExportText(fragment.text),
  };
}

const SHELL_TOOL_CALL_RE = new RegExp(
  `<(${SHELL_TOOL_NAMES.join('|')})>\\s*[\\s\\S]*?\\s*<\\/\\1>`,
  'g',
);

function stripKnownShellToolCalls(text: string): string {
  return text.replace(SHELL_TOOL_CALL_RE, '');
}

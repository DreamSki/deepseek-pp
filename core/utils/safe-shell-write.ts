import type { ToolCall, ToolProviderIdentity } from '../types';

/**
 * Build the shell command that writes `content` to `filePath` safely.
 *
 * Encodes the content as base64 and decodes in-shell via `base64 -d`. This
 * avoids ALL shell-escaping pitfalls (quotes, $, backticks, newlines, heredoc
 * quirks across shells) and works in both zsh and bash.
 */
export function buildShellWriteCommand(filePath: string, content: string): string {
  // btoa requires a binary-safe encoding step for UTF-8 text
  const b64 = btoa(unescape(encodeURIComponent(content)));
  return `printf %s ${b64} | base64 -d > "${filePath}"`;
}

/**
 * Build a shell_exec ToolCall that writes content to a file.
 *
 * IMPORTANT: `provider` and `descriptorId` MUST come from the real shell_exec
 * descriptor (via getToolDescriptors). The shell MCP server's id is generated
 * dynamically at storage time (not a fixed 'shell' literal), so hardcoding an
 * id here makes executeMcpToolCall return "MCP server not found".
 */
export function makeSafeFileWriteCall(
  filePath: string,
  content: string,
  provider?: ToolProviderIdentity,
  descriptorId?: string,
): ToolCall {
  return {
    name: 'shell_exec',
    provider: provider ?? { kind: 'mcp', id: 'shell', displayName: 'Shell', transport: 'stdio_bridge' },
    descriptorId: descriptorId ?? 'mcp:shell:shell_exec',
    invocationName: 'shell_exec',
    payload: { command: buildShellWriteCommand(filePath, content) },
    raw: '',
  };
}

import type { ToolCall } from '../types';

const DELEGATED_UPLOAD_MARKER = '由你调用 shell_upload_file';

/**
 * Check whether `needle` appears as an exact, standalone path in `haystack`.
 * Uses word-boundary-aware matching so that "/tmp/a" does NOT match
 * "/tmp/abc" or "/tmp/a.bak".
 */
function promptContainsExactPath(haystack: string, needle: string): boolean {
  // Escape regex special characters in the needle path
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the path when it is preceded by whitespace, line-start, or a quote,
  // and followed by whitespace, line-end, a quote, or common delimiters.
  const re = new RegExp(`(?<=^|[\\s"'\\[\\](),;，；（）、])${escaped}(?=$|[\\s"'\\[\\](),;，；（）、])`, 'm');
  return re.test(haystack);
}

export function routeUploadIntoQueuedSubAgent(
  call: ToolCall,
  queuedSubAgents: readonly ToolCall[],
): boolean {
  // 自动路由已禁用。shell_upload_file 只在用户明确说"使用 shell_upload_file"
  // 或明确提到工具名称时才调用，不会自动插入上传指令到子代理。
  return false;
}

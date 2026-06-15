import type { ToolCall, ToolError } from '../types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  createXmlToolCallRegex,
  getToolInvocationLabel,
  type ToolInvocationCatalog,
  type ToolParsingInput,
} from '../tool';
import { debugLog } from '../utils/debug-log';

const LEGACY_TOOL_CALLS_BLOCK_REGEX = /<｜DSML｜tool_calls>\s*[\s\S]*?\s*<\/｜DSML｜tool_calls>/g;
const LEGACY_INVOKE_REGEX = /<｜DSML｜invoke name="([^"]+)">\s*([\s\S]*?)\s*<\/｜DSML｜invoke>/g;
const LEGACY_PARAMETER_REGEX = /<｜DSML｜parameter name="([^"]+)" string="(true|false)">([\s\S]*?)<\/｜DSML｜parameter>/g;

export function extractToolCalls(text: string, input?: ToolParsingInput): ToolCall[] {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  const executableText = maskMarkdownCode(text);
  return [
    ...extractXmlToolCalls(executableText, catalog),
    ...extractLegacyToolCalls(executableText, catalog),
  ];
}

function maskMarkdownCode(text: string): string {
  // RegExp indices use UTF-16 code units, so split the string the same way.
  const chars = text.split('');
  const fenceStart = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  let opening: RegExpExecArray | null;

  while ((opening = fenceStart.exec(text)) !== null) {
    const marker = opening[1]!;
    const closing = new RegExp(
      `^[ \\t]{0,3}${escapeRegex(marker[0]!)}{${marker.length},}[ \\t]*(?:\\n|$)`,
      'gm',
    );
    closing.lastIndex = fenceStart.lastIndex;
    const closingMatch = closing.exec(text);
    const end = closingMatch ? closing.lastIndex : text.length;
    maskRange(chars, opening.index, end);
    fenceStart.lastIndex = end;
  }

  const withoutFences = chars.join('');
  const inlineCode = /(`+)([^\n]*?)\1/g;
  let inline: RegExpExecArray | null;
  while ((inline = inlineCode.exec(withoutFences)) !== null) {
    maskRange(chars, inline.index, inline.index + inline[0].length);
  }

  return chars.join('');
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractXmlToolCalls(text: string, catalog: ToolInvocationCatalog): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = createXmlToolCallRegex(catalog);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const invocationName = match[1];
    const body = match[2].trim();
    const raw = match[0];
    let payload: Record<string, unknown>;
    try {
      const parsed = body.length === 0 ? {} : parseJsonLenient(body);
      if (!isToolPayload(parsed)) {
        // Auto-salvage: try to extract key field from non-object body
        const salvaged = salvageToolPayload(body, invocationName);
        if (salvaged !== null) {
          payload = salvaged;
        } else {
          debugLog('tool-parser', `payload not an object for <${invocationName}>`, { body: body.slice(0, 200) });
          calls.push(createToolCallFromInvocation(invocationName, {}, raw, catalog, {
            parseError: createToolParseError(
              'tool_call_payload_invalid',
              invocationName,
              'Tool call body must be a JSON object.',
            ),
          }));
          continue;
        }
      } else {
        payload = parsed;
      }
    } catch (err) {
      // Auto-salvage: when a tool call has broken JSON, extract the key
      // fields directly from the body text instead of rejecting the call.
      const salvaged = salvageToolPayload(body, invocationName);
      if (salvaged !== null) {
        debugLog('tool-parser', `salvaged broken JSON for <${invocationName}>`, { body: body.slice(0, 200) });
        payload = salvaged;
      } else {
        debugLog('tool-parser', `unparseable JSON for <${invocationName}>`, { body: body.slice(0, 200), error: err instanceof Error ? err.message : String(err) });
        calls.push(createToolCallFromInvocation(invocationName, {}, raw, catalog, {
          parseError: createToolParseError(
            'tool_call_json_invalid',
            invocationName,
            [
              'Tool call body is not valid JSON.',
              'Use double quotes for strings and forward slashes in file paths, for example "/Users/username/Documents/file.txt" or "~/Downloads/file.txt".',
              err instanceof Error ? err.message : String(err),
            ].join(' '),
          ),
        }));
        continue;
      }
    }
    calls.push(createToolCallFromInvocation(invocationName, payload, raw, catalog));
  }

  return calls;
}

function extractLegacyToolCalls(text: string, catalog: ToolInvocationCatalog): ToolCall[] {
  const calls: ToolCall[] = [];
  const blockRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[0];
    const invokeRegex = new RegExp(LEGACY_INVOKE_REGEX.source, 'g');
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokeRegex.exec(blockContent)) !== null) {
      const invocationName = invokeMatch[1];
      const invokeContent = invokeMatch[2];
      const payload: Record<string, unknown> = {};
      const paramRegex = new RegExp(LEGACY_PARAMETER_REGEX.source, 'g');
      let paramMatch: RegExpExecArray | null;

      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const isString = paramMatch[2] === 'true';
        const value = paramMatch[3];
        if (isString) {
          payload[paramName] = value;
          continue;
        }
        try {
          payload[paramName] = JSON.parse(value);
        } catch {
          payload[paramName] = value;
        }
      }

      calls.push(createToolCallFromInvocation(invocationName, payload, invokeMatch[0], catalog));
    }
  }

  return calls;
}

export function stripToolCalls(text: string, input?: ToolParsingInput): string {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  const regex = createXmlToolCallRegex(catalog);
  const legacyRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  return text.replace(regex, '').replace(legacyRegex, '').trim();
}

export function replaceToolCallsWithSummary(text: string, input?: ToolParsingInput): string {
  const catalog = createToolInvocationCatalog(input?.descriptors);
  const regex = createXmlToolCallRegex(catalog);
  const legacyRegex = new RegExp(LEGACY_TOOL_CALLS_BLOCK_REGEX.source, 'g');
  return text
    .replace(regex, (match) => replaceMatchWithSummary(match, catalog))
    .replace(legacyRegex, (match) => replaceMatchWithSummary(match, catalog));
}

function replaceMatchWithSummary(match: string, catalog: ToolInvocationCatalog): string {
  const calls = extractToolCalls(match, { descriptors: catalog.descriptors });
  if (calls.length === 0) return '';
  const lines = calls.map(call => {
    const name = call.name;
    if (call.parseError) return `• ${getToolInvocationLabel(name, catalog)}：格式错误`;
    const detail = (call.payload as any).name || (call.payload as any).content || (call.payload as any).id || '';
    return `• ${getToolInvocationLabel(name, catalog)}${detail ? '：' + detail : ''}`;
  });
  const executedCount = calls.filter(call => !call.parseError).length;
  const header = executedCount === calls.length
    ? `🔧 已执行工具（${calls.length}次）`
    : `🔧 已执行工具（${executedCount}次，${calls.length - executedCount}次格式错误）`;
  return '\n\n---\n' + header + '\n' + lines.join('\n') + '\n---';
}

function isToolPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function createToolParseError(code: string, invocationName: string, message: string): ToolError {
  return {
    code,
    message,
    retryable: false,
    details: { invocationName },
  };
}

// ---------------------------------------------------------------------------
// Lenient JSON parser — handles common AI-generated JSON mistakes:
// unescaped newlines/tabs inside string values, etc.
// ---------------------------------------------------------------------------

export function parseJsonLenient(body: string): unknown {
  // Fast path: already valid JSON
  try { return JSON.parse(body); } catch { /* fall through */ }

  // Valid JSON escape sequences after backslash
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

  // State machine: track whether we're inside a JSON string value,
  // fix unescaped control characters, and repair invalid backslash sequences.
  let fixed = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;

    if (escaped) {
      // If the character after \ is not a valid JSON escape (e.g. \[, \!),
      // double the backslash so JSON.parse treats it as a literal backslash.
      if (!VALID_ESCAPES.has(ch)) {
        fixed += '\\' + ch;
      } else {
        fixed += ch;
      }
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      fixed += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      fixed += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') fixed += '\\n';
      else if (ch === '\r') fixed += '\\r';
      else if (ch === '\t') fixed += '\\t';
      else fixed += ch;
    } else {
      fixed += ch;
    }
  }

  // If we ended mid-escape, close the dangling backslash
  if (escaped) fixed += '\\';

  return JSON.parse(fixed);
}

// ---------------------------------------------------------------------------
// Salvage shell_exec commands from broken JSON
// ---------------------------------------------------------------------------

const SHELL_TOOL_NAMES_FOR_SALVAGE = new Set(['shell_exec', 'shell_execute']);
const PATH_BASED_TOOLS = new Set(['shell_read_image', 'shell_upload_file']);

/**
 * Unified salvage: extracts key fields from broken/non-object tool call bodies.
 *
 * For shell_exec / shell_execute → extracts "command"
 * For shell_read_image            → extracts "path"
 * For shell_upload_file           → extracts "path"
 * For other tools                 → returns null (no salvage possible)
 */
function salvageToolPayload(body: string, invocationName: string): Record<string, unknown> | null {
  const trimmed = body.trim();

  // --- shell_read_image / shell_upload_file: extract "path" field ------------
  if (PATH_BASED_TOOLS.has(invocationName)) {
    return salvagePathBasedTool(trimmed);
  }

  // --- shell_exec / shell_execute: extract "command" field -------------------
  if (SHELL_TOOL_NAMES_FOR_SALVAGE.has(invocationName)) {
    const cmd = salvageShellExecCommand(trimmed, invocationName);
    return cmd !== null ? { command: cmd } : null;
  }

  return null;
}

/**
 * Salvage a "path" field from a tool call with broken JSON.
 * Used by both shell_read_image and shell_upload_file.
 */
function salvagePathBasedTool(trimmed: string): Record<string, unknown> | null {
  // If the body doesn't look like JSON, look for a file path directly
  if (!trimmed.startsWith('{')) {
    if (/^[~\/]/.test(trimmed)) {
      return { path: trimmed };
    }
    const pathMatch = trimmed.match(/([~\/][^\s"'{}\]]+)/);
    if (pathMatch) {
      return { path: pathMatch[1] };
    }
    return null;
  }

  // Try to extract "path" field value from broken JSON
  const pathMatch = trimmed.match(/"path"\s*:\s*"([^"]*?)"/);
  if (pathMatch) {
    return { path: pathMatch[1].replace(/\\"/g, '"') };
  }

  // Maybe the key is unquoted
  const fallback = trimmed.match(/^\s*\{?\s*(?:"?path"?|'path')\s*:\s*(?:"|')?([\s\S]+?)(?:"|')?\s*\}?\s*$/);
  if (fallback) {
    return { path: fallback[1].replace(/\\"/g, '"') };
  }

  return null;
}
function salvageShellExecCommand(body: string, invocationName: string): string | null {
  // Only apply to shell_exec (not python_exec, memory_save, etc.)
  if (!SHELL_TOOL_NAMES_FOR_SALVAGE.has(invocationName)) return null;

  // If the body doesn't even look like JSON, treat the whole thing as
  // the command (the AI may have omitted the {"command": ...} wrapper).
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) {
    return trimmed;
  }

  // Try to extract "command" field value. The regex matches:
  //   "command" : " ... "
  // handling escaped quotes inside the value.
  const cmdMatch = trimmed.match(/"command"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (cmdMatch) {
    return cmdMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\');
  }

  // Maybe the key is unquoted or uses single quotes — extract anything
  // between the first : and the last closing brace/bracket.
  const fallback = trimmed.match(/^\s*\{?\s*(?:"?command"?|'command')\s*:\s*(?:"|')?([\s\S]+?)(?:"|')?\s*\}?\s*$/);
  if (fallback) {
    return fallback[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }

  return null;
}

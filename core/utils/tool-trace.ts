/**
 * Structured tool execution tracing — always-on console logging for
 * the complete lifecycle of every tool call in both main-agent and
 * sub-agent contexts.
 *
 * Output format (filter with `[DPP][trace]` in DevTools Console):
 *
 *   [DPP][trace][main:3] ▶ shell_exec (cmd: "ls -la ~/Downloads")
 *   [DPP][trace][main:3] ✓ shell_exec 245ms ok (1.2KB)
 *   [DPP][trace][sub:2:5] ▶ shell_read_image (path: "/tmp/img.png")
 *   [DPP][trace][sub:2:5] ✓ shell_read_image 320ms ok → uploaded file_id=abc123
 *
 * ## Partitioning
 *
 * Three instrumentation sites ensure each tool call produces exactly
 * one dispatch + one result line:
 *
 *   trigger='agent_run'      → content.ts  (main agent)
 *   trigger='automation'     → subagent.ts (sub-agent)
 *   trigger='manual_chat'    → runtime.ts  (direct calls)
 *   trigger='sidepanel_chat' → runtime.ts  (direct calls)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceContext {
  /** Who is executing this tool. */
  source: 'main' | 'sub' | 'manual';
  /** 0-based step index within the current loop. */
  stepIndex: number;
  /** 1-based sub-agent index (only for source='sub'). */
  subIndex?: number;
}

// ---------------------------------------------------------------------------
// Timing — ring buffer
// ---------------------------------------------------------------------------

const TIMING_SLOTS = 128;
const startTimes = new Float64Array(TIMING_SLOTS);
let nextId = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log the dispatch of a tool call and return a trace ID for the
 * corresponding `traceToolResult` call.
 */
export function traceToolDispatch(
  ctx: TraceContext,
  call: {
    name: string;
    payload?: Record<string, unknown>;
    parseError?: { message: string };
  },
): number {
  const id = nextId++;
  startTimes[id % TIMING_SLOTS] = Date.now();
  const tag = formatTag(ctx);

  if (call.parseError) {
    console.log(
      `[DPP][trace][${tag}] ✗ ${call.name} 0ms fail: parse error — ${truncate(call.parseError.message, 80)}`,
    );
    return id;
  }

  const summary = summarizePayload(call.name, call.payload);
  console.log(`[DPP][trace][${tag}] ▶ ${call.name}${summary ? ' ' + summary : ''}`);
  return id;
}

/**
 * Log the result of a tool call, including duration computed from
 * the matching `traceToolDispatch` call.
 */
export function traceToolResult(
  traceId: number,
  ctx: TraceContext,
  callName: string,
  result: {
    ok: boolean;
    summary?: string;
    detail?: string;
    error?: { message: string };
    output?: unknown;
    truncated?: boolean;
  },
  extras?: string,
): void {
  const duration = Date.now() - startTimes[traceId % TIMING_SLOTS];
  const tag = formatTag(ctx);
  const status = result.ok ? '✓' : '✗';
  const suffix = summarizeResult(callName, result, extras);
  console.log(`[DPP][trace][${tag}] ${status} ${callName} ${duration}ms ${suffix}`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatTag(ctx: TraceContext): string {
  if (ctx.source === 'sub' && ctx.subIndex != null) {
    return `sub:${ctx.subIndex}:${ctx.stepIndex}`;
  }
  if (ctx.source === 'manual') return 'manual';
  return `${ctx.source}:${ctx.stepIndex}`;
}

/**
 * Extract the single most informative field from a tool payload
 * for a compact one-line summary.
 */
function summarizePayload(
  name: string,
  payload?: Record<string, unknown>,
): string {
  if (!payload) return '';

  // Tool-specific key fields
  const keyMap: Record<string, string> = {
    shell_exec: 'command',
    shell_execute: 'command',
    python_exec: 'code',
    shell_read_image: 'path',
    shell_upload_file: 'path',
    spawn_subagent: 'prompt',
    web_search: 'query',
    web_fetch: 'url',
    memory_save: 'content',
    memory_delete: 'id',
  };

  const key = keyMap[name];
  if (key && payload[key] != null) {
    const val = String(payload[key]);
    const truncated = truncate(val, 60);
    const suffix = val.length > 60 ? '…' : '';
    // Format: (key: "truncated value…")
    if (name === 'shell_exec' || name === 'shell_execute') {
      return `(cmd: "${truncated}${suffix}")`;
    }
    if (name === 'python_exec') {
      return `(code: "${truncated}${suffix}")`;
    }
    return `(${key}: "${truncated}${suffix}")`;
  }

  // Fallback: first non-trivial string value
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > 0) {
      return `(${k}: "${truncate(v, 50)}")`;
    }
  }

  return '';
}

/**
 * Produce a compact result summary string.
 */
function summarizeResult(
  name: string,
  result: {
    ok: boolean;
    summary?: string;
    detail?: string;
    error?: { message: string };
    output?: unknown;
    truncated?: boolean;
  },
  extras?: string,
): string {
  const parts: string[] = [];

  if (result.ok) {
    parts.push('ok');
  } else {
    const errMsg = result.error?.message ?? result.summary ?? 'unknown error';
    parts.push(`fail: ${truncate(errMsg, 60)}`);
  }

  // Output size hint
  const output = result.output;
  if (output != null && typeof output === 'object') {
    try {
      const json = JSON.stringify(output);
      if (json.length > 0) {
        parts.push(formatBytes(json.length));
      }
    } catch { /* skip */ }
  }

  // Truncation flag
  if (result.truncated) {
    parts.push('truncated');
  }

  // Upload-specific extras
  if (extras) {
    parts.push(extras);
  }

  return parts.join(' | ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

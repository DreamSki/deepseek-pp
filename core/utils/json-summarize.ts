/**
 * Shared JSON/object summarization for diagnostic logging.
 *
 * Features:
 * - Depth control (max 3) to prevent unbounded recursion
 * - Array truncation (first 8 items)
 * - String truncation (> 240 chars)
 * - Sensitive key redaction (token, authorization, cookie)
 */

export function summarizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[Object]';
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => summarizeForLog(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }

  const summarized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|authorization|cookie/i.test(key)) {
      summarized[key] = '[redacted]';
    } else {
      summarized[key] = summarizeForLog(item, depth + 1);
    }
  }
  return summarized;
}

/**
 * Summarize a raw JSON string: parse it, then summarize the resulting value.
 * Falls back to a text preview if parsing fails.
 */
export function summarizeJsonText(text: string): unknown {
  try {
    return summarizeForLog(JSON.parse(text));
  } catch {
    return { type: 'text', length: text.length, preview: text.replace(/\s+/g, ' ').trim().slice(0, 500) };
  }
}

/**
 * Shared check for DeepSeek "invalid ref file id" error messages.
 * Used by both the stream consumer (adapter.ts) and the retry loop (loop.ts).
 */

export function isInvalidRefFileIdText(text: string): boolean {
  const normalized = text.replace(/[_-]+/g, ' ');
  return /invalid.*ref.*file.*ids?/i.test(normalized) ||
    /ref\s+file\s+ids?.*invalid/i.test(normalized);
}

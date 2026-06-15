/**
 * Debug-gated logging for DeepSeek++ diagnostics.
 *
 * Production: silent (no console output).
 * Development: set `window.__DPP_DEBUG__ = true` in browser console to enable.
 *
 * Rules:
 * - Use `debugLog` / `debugTrace` for informational diagnostics (what's happening)
 * - Keep all `console.warn` and `console.error` as-is (error-path, always visible)
 */

const DPP_DEBUG = typeof globalThis !== 'undefined' &&
  (globalThis as Record<string, unknown>).__DPP_DEBUG__ === true;

export function debugLog(prefix: string, ...args: unknown[]): void {
  if (DPP_DEBUG) console.log(`[DPP] ${prefix}:`, ...args);
}

export function debugTrace(label: string, data: Record<string, unknown>): void {
  if (DPP_DEBUG) console.log(`[DPP] ${label}`, JSON.stringify(data));
}

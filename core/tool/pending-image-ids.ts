/**
 * Pending image file IDs and vision mode flag for shell_read_image uploads.
 *
 * When shell_read_image reads a local image and uploads it to DeepSeek,
 * the resulting file_id is stored here. The next chat request then drains
 * these IDs into ref_file_ids AND forces model_type to 'vision' so the
 * model actually processes the image visually.
 *
 * ## Consumer exclusivity
 *
 * Exactly ONE consumer drains the pending state per request cycle:
 *   - `request-augmentation` — normal chat completion requests
 *   - `inline-agent-loop` — agent continuation steps
 *   - `subagent-continuation` — sub-agent's internal loop
 *
 * These consumers are mutually exclusive per request. If two consumers
 * drain in the same cycle it indicates a bug — the second drain will
 * get an empty array and a warning is logged.
 *
 * ## Navigation safety
 *
 * Call `clearPendingImageState()` when the page URL changes. This
 * prevents stale file_ids from a previous conversation from being
 * injected into a new one.
 */

import { debugLog } from '../utils/debug-log';

export type PendingImageConsumer =
  | 'request-augmentation'
  | 'inline-agent-loop'
  | 'subagent-continuation'
  | 'test';

let pendingIds: string[] = [];
let forceVisionMode = false;
/** URL snapshot at the time the last file_id was added — used to detect navigation. */
let captureUrl: string | null = null;
/** The last consumer to drain — used to detect double-drain bugs. */
let lastDrainConsumer: PendingImageConsumer | null = null;
/** Monotonic generation counter bumped on each clearPendingImageState call. */
let generation = 0;

export function addPendingImageFileId(id: string, sessionUrl?: string, options?: { skipVisionMode?: boolean }): void {
  if (pendingIds.includes(id)) return;
  pendingIds.push(id);
  if (!options?.skipVisionMode) {
    forceVisionMode = true; // uploaded an image → next request must be vision mode
  }
  captureUrl = sessionUrl ?? (typeof location !== 'undefined' ? location.href : null);

  console.log(
    `[DPP] pending-image-ids: added file_id=${id} (total=${pendingIds.length}, vision=${forceVisionMode}, skipVision=${!!options?.skipVisionMode}, url=${captureUrl?.slice(0, 80) ?? 'N/A'})`,
  );
}

export function drainPendingImageFileIds(consumer: PendingImageConsumer): string[] {
  if (lastDrainConsumer !== null && pendingIds.length === 0) {
    // Already drained by another consumer in this cycle — that's expected
    // (the first consumer got everything). Only log in dev.
    console.debug(
      `[DPP] pending-image-ids: drain by "${consumer}" after "${lastDrainConsumer}" already emptied the queue`,
    );
    return [];
  }

  if (pendingIds.length > 0 && lastDrainConsumer !== null && lastDrainConsumer !== consumer) {
    // Two different consumers both got non-empty drains — this is a bug.
    console.warn(
      `[DPP] pending-image-ids: RACE DETECTED — "${consumer}" drained ${pendingIds.length} IDs after "${lastDrainConsumer}" already drained. ` +
      `This means two consumers are competing for the same pending image state.`,
    );
  }

  lastDrainConsumer = consumer;
  const ids = pendingIds;
  pendingIds = [];
  if (ids.length > 0) {
    console.log(
      `[DPP] pending-image-ids: drained ${ids.length} file_id(s) by "${consumer}": [${ids.join(', ')}]`,
    );
  }
  return ids;
}

export function consumeVisionMode(consumer: PendingImageConsumer): boolean {
  const v = forceVisionMode;
  if (v) {
    debugLog('pending-image-ids', `vision mode consumed by "${consumer}"`);
  }
  forceVisionMode = false;

  // If vision was on but another consumer already drained, the vision flag
  // may have been left stale. Log a warning so we can trace this.
  if (v && lastDrainConsumer !== null && lastDrainConsumer !== consumer) {
    console.warn(
      `[DPP] pending-image-ids: vision mode consumed by "${consumer}" but last drain was by "${lastDrainConsumer}". ` +
      `Vision mode may have been applied to the wrong request.`,
    );
  }

  return v;
}

export function hasPendingImageFileIds(): boolean {
  return pendingIds.length > 0;
}

/**
 * Clear all pending image state. Call this on page navigation to prevent
 * stale file_ids from a previous conversation from being injected into
 * a new completion request.
 */
export function clearPendingImageState(): void {
  if (pendingIds.length > 0 || forceVisionMode) {
    console.log(
      `[DPP] pending-image-ids: clearing state (${pendingIds.length} IDs, vision=${forceVisionMode}) due to navigation`,
    );
    pendingIds = [];
    forceVisionMode = false;
  }
  lastDrainConsumer = null;
  generation++;
}

/**
 * Returns the capture URL at the time the last file_id was added.
 * Returns null if no file_ids are pending or if captureUrl wasn't recorded.
 */
export function getPendingImageCaptureUrl(): string | null {
  return captureUrl;
}

/**
 * Returns the current generation counter. Bumps on each clearPendingImageState.
 * Useful for detecting whether state was cleared between add and drain.
 */
export function getPendingImageGeneration(): number {
  return generation;
}

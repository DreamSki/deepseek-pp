/**
 * Shared DeepSeek image file upload and readiness polling.
 *
 * Used by both:
 * - `entrypoints/content.ts` — agent-run shell_read_image uploads
 * - `core/tool/subagent.ts` — sub-agent vision session uploads
 *
 * This module handles the full lifecycle:
 * 1. Upload base64 image data to DeepSeek's file API
 * 2. Extract file_id from the response
 * 3. Poll for file readiness (SUCCESS + audit pass)
 */

import { createPowHeaders } from './adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageUploadInput {
  /** Base64-encoded image data (no data-url prefix). */
  base64: string;
  /** MIME type, e.g. 'image/png'. */
  mimeType: string;
  /** Original file size in bytes. */
  size: number;
  /** Original filename or path. Only the basename is sent to DeepSeek. */
  filename?: string;
  /** Pre-built auth headers (from createClientHeaders or loadClientHeadersFromStorage). */
  authHeaders: Record<string, string>;
  /** Optional: URL to the PoW WASM module. Required for content script path. */
  powWasmUrl?: string;
}

export interface FileUploadInput extends ImageUploadInput {
  /**
   * Whether this file requires vision mode.
   * - true (images) → x-model-type: 'vision', forces vision mode
   * - false (PDF, DOCX, etc.) → x-model-type: 'default', no vision mode
   * Defaults to true for backward compatibility.
   */
  isVisionFile?: boolean;
}

export interface FileUploadStatus {
  ready: boolean;
  failed: boolean;
  status: string | null;
  auditResult: string | null;
  tokenUsage: number | null;
  width: number | null;
  height: number | null;
  errorCode: string | number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_PATH = '/api/v0/file/upload_file';
const FILE_FETCH_PATH = '/api/v0/file/fetch_files';
const FILE_READY_DELAYS_MS = [700, 1_200, 2_000, 3_000, 4_000];
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a file to DeepSeek and wait for it to be processed.
 * Supports both images (vision mode) and documents (default mode).
 * Returns the file_id on success, or null on failure.
 */
export async function uploadFileToDeepSeek(input: FileUploadInput): Promise<string | null> {
  const { base64, mimeType, size, authHeaders, powWasmUrl } = input;
  const isVision = input.isVisionFile !== false; // default true

  // Decode locally. Fetching a data: URL can be rejected in extension/page
  // contexts and also makes large files depend on URL handling limits.
  let blob: Blob;
  try {
    const binary = atob(base64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    blob = new Blob([bytes], { type: mimeType });
  } catch (err) {
    const preview = base64.length > 80 ? `${base64.slice(0, 80)}…` : base64;
    console.warn(`[DPP] file-upload: base64→Blob conversion failed (len=${base64.length}, start="${preview}")`, err);
    return null;
  }

  const filename = getUploadFilename(input.filename, mimeType, isVision);
  const formData = new FormData();
  formData.append('file', blob, filename);

  // PoW is required for file upload (same mechanism as chat completion)
  let powHeaders: Record<string, string> = {};
  try {
    powHeaders = await createPowHeaders(authHeaders, powWasmUrl, UPLOAD_PATH);
  } catch (err) {
    console.warn('[DPP] file-upload: PoW challenge failed, proceeding without it', err);
  }

  try {
    const response = await fetch(`${DEEPSEEK_ORIGIN}${UPLOAD_PATH}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...authHeaders,
        ...powHeaders,
        'x-file-size': String(size || blob.size),
        'x-model-type': isVision ? 'vision' : 'default',
        'x-thinking-enabled': '1',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (response.status === 429) {
        console.warn('[DPP] file-upload: DeepSeek API rate limit exceeded (429). Please wait a few minutes before trying again.');
      } else {
        console.warn('[DPP] file-upload: HTTP error', response.status, errorText.slice(0, 500));
      }
      return null;
    }

    const rawText = await response.text().catch(() => '');
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      console.warn('[DPP] file-upload: response is not valid JSON');
      return null;
    }

    const fileId = extractFileIdFromResponse(json);
    if (fileId) {
      const readiness = await waitForImageFileReady(fileId, authHeaders);
      return readiness === 'ready' ? fileId : null;
    }
    const responsePreview = JSON.stringify(json).slice(0, 300);
    console.warn(`[DPP] file-upload: could not extract file_id from response: ${responsePreview}`);
  } catch (err) {
    console.warn('[DPP] file-upload: fetch threw', err);
  }

  return null;
}

/**
 * Upload an image to DeepSeek and wait for it to be processed.
 * Backward-compatible wrapper around uploadFileToDeepSeek with vision mode.
 * Returns the file_id on success, or null on failure.
 */
export async function uploadImageToDeepSeek(input: ImageUploadInput): Promise<string | null> {
  return uploadFileToDeepSeek({ ...input, isVisionFile: true });
}

function getUploadFilename(original: string | undefined, mimeType: string, isVision: boolean): string {
  const basename = original?.split(/[\\/]/).pop()?.trim();
  if (basename && basename !== '.' && basename !== '..') return basename;

  const ext = mimeType.split('/')[1]?.split(/[;+]/)[0] || 'bin';
  return `${isVision ? 'image' : 'file'}.${ext}`;
}

/**
 * Wait for an uploaded image file to be fully processed by DeepSeek's backend.
 * Returns 'ready', 'failed', or 'timeout'.
 */
export async function waitForImageFileReady(
  fileId: string,
  authHeaders: Record<string, string>,
): Promise<'ready' | 'failed' | 'timeout'> {
  for (let attempt = 0; attempt < FILE_READY_DELAYS_MS.length; attempt++) {
    await delay(FILE_READY_DELAYS_MS[attempt]!);
    const status = await fetchImageFileStatus(fileId, authHeaders);

    if (status.ready) return 'ready';
    if (status.failed) return 'failed';
  }

  console.warn('[DPP] image-upload: file did not become ready before timeout', fileId);
  return 'timeout';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchImageFileStatus(
  fileId: string,
  authHeaders: Record<string, string>,
): Promise<FileUploadStatus> {
  const url = new URL(FILE_FETCH_PATH, DEEPSEEK_ORIGIN);
  url.searchParams.set('file_ids', fileId);

  try {
    const response = await fetch(url.href, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...authHeaders,
      },
    });

    // Handle rate limiting specifically
    if (response.status === 429) {
      console.warn('[DPP] image-upload: DeepSeek API rate limit exceeded (429). Please wait a few minutes before trying again.');
      return createUnknownFileStatus();
    }

    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return createUnknownFileStatus();
    }

    const file = extractFileStatusRecord(json, fileId);
    if (!file) return createUnknownFileStatus();

    const status = firstStringValue(file, 'status');
    const auditResult = firstStringValue(file, 'audit_result');
    const tokenUsage = firstNumberValue(file, 'token_usage');
    const width = firstNumberValue(file, 'width');
    const height = firstNumberValue(file, 'height');
    const errorCode = firstStringOrNumberValue(file, 'error_code');
    const ready = status === 'SUCCESS' && (auditResult === null || auditResult === 'pass');
    const failed = /fail|error|reject/i.test(status ?? '') ||
      (auditResult !== null && auditResult !== 'unknown' && auditResult !== 'pass');

    return { ready, failed, status, auditResult, tokenUsage, width, height, errorCode };
  } catch (err) {
    console.warn('[DPP] image-upload: fetch_files failed', err);
    return createUnknownFileStatus();
  }
}

function extractFileStatusRecord(json: unknown, fileId: string): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const data = root.data;
  const bizData = data && typeof data === 'object' ? (data as Record<string, unknown>).biz_data : null;
  const files = bizData && typeof bizData === 'object' ? (bizData as Record<string, unknown>).files : null;
  if (Array.isArray(files)) {
    return files.find((item): item is Record<string, unknown> => {
      return !!item && typeof item === 'object' && (item as Record<string, unknown>).id === fileId;
    }) ?? null;
  }
  return null;
}

function createUnknownFileStatus(): FileUploadStatus {
  return {
    ready: false,
    failed: false,
    status: null,
    auditResult: null,
    tokenUsage: null,
    width: null,
    height: null,
    errorCode: null,
  };
}

function extractFileIdFromResponse(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;

  // Try known DeepSeek response shapes
  const data = root.data;
  if (data && typeof data === 'object') {
    const bizData = (data as Record<string, unknown>).biz_data;
    if (bizData && typeof bizData === 'object') {
      const directId = firstStringValue(bizData as Record<string, unknown>, 'file_id', 'id');
      if (directId) return directId;
      // Some responses nest under a "file" key
      const file = (bizData as Record<string, unknown>).file;
      if (file && typeof file === 'object') {
        const id = firstStringValue(file as Record<string, unknown>, 'file_id', 'id');
        if (id) return id;
      }
    }
    const id = firstStringValue(data as Record<string, unknown>, 'file_id', 'id');
    if (id) return id;
  }

  return firstStringValue(root, 'file_id', 'id');
}

function firstStringValue(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstNumberValue(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function firstStringOrNumberValue(obj: Record<string, unknown>, ...keys: string[]): string | number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunked base64 file reading via shell_exec.
 *
 * When a file's base64 exceeds MAX_MCP_BASE64_BYTES (650KB), the MCP host
 * writes it to a temp file instead of embedding it in the JSON response.
 * The extension then reads the file via shell_exec, but shell_exec enforces
 * a per-invocation stdout limit (128KB).
 *
 * This utility reads the file in multiple shell_exec calls (chunks),
 * concatenating the output so the full base64 can be reconstructed
 * regardless of file size. Each chunk stays well within the limit.
 *
 * Two modes:
 * - `isBase64Encoded: true` — file already contains base64 text (MCP temp file).
 *   Chunk size: 90KB raw base64.
 * - `isBase64Encoded: false` — file is binary (original file read as fallback).
 *   Chunk size: 60KB binary → ~80KB base64 after encoding.
 */

import { quoteShellArg } from '../utils/shell-quote';

/** Chunk size for already-base64-encoded temp files (120KB, safely under 128KB limit). */
const CHUNK_BASE64 = 120_000;
/** Chunk size for raw binary files — after base64 encoding: ~120KB < 128KB limit. */
const CHUNK_BINARY = 90_000;

/**
 * Minimal contract the chunked reader needs from a shell_exec call.
 * Both content.ts (ToolCardResult) and subagent.ts (ToolResult) can be
 * adapted to this shape.
 */
export interface ChunkedShellResult {
  ok: boolean;
  stdout: string | null;
}

/**
 * Read a file in chunks via shell_exec, returning the concatenated base64.
 *
 * @param execShellCmd — called with a shell command string for each chunk.
 * @param filePath — absolute path to the file to read.
 * @param options.isBase64Encoded — true if file is already base64 (MCP temp
 *   file), false if the file is raw binary and needs on-the-fly encoding.
 */
export async function readFileInChunks(
  execShellCmd: (cmd: string) => Promise<ChunkedShellResult>,
  filePath: string,
  options: { isBase64Encoded: boolean },
): Promise<{ ok: boolean; base64: string | null; truncated: boolean }> {
  const chunkSize = options.isBase64Encoded ? CHUNK_BASE64 : CHUNK_BINARY;

  // Step 1: get total file size
  const sizeCmd = `wc -c < ${quoteShellArg(filePath)}`;
  const sizeResult = await execShellCmd(sizeCmd);
  if (!sizeResult.ok || !sizeResult.stdout) {
    console.warn('[DPP] chunked-read: failed to get file size for', filePath);
    return { ok: false, base64: null, truncated: false };
  }
  const fileSize = parseInt(sizeResult.stdout.trim(), 10);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    console.warn('[DPP] chunked-read: invalid file size', sizeResult.stdout);
    return { ok: false, base64: null, truncated: false };
  }

  const totalChunks = Math.ceil(fileSize / chunkSize);
  const truncated =
    !options.isBase64Encoded &&
    totalChunks > 1 &&
    totalChunks * chunkSize > 10 * 1024 * 1024;

  if (totalChunks > 1) {
    console.log(
      `[DPP] chunked-read: ${filePath.slice(-40)} (${(fileSize / 1024).toFixed(1)}KB) → ${totalChunks} chunk(s) of ${chunkSize}B`,
    );
  }

  // Step 2: read each chunk via Python for reliability — no shell
  // pipeline edge cases (dd block-size quirks, head/tail pipe races).
  // Path, offset, and size are passed as separate argv so shell quoting
  // can't break the Python string literal.
  // Whitespace (base64 line-wrapping) is stripped in JS below.
  const chunks: string[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const offset = i * chunkSize;
    const cmd = options.isBase64Encoded
      ? `python3 -c "import sys;f=open(sys.argv[1]);f.seek(int(sys.argv[2]));sys.stdout.write(f.read(int(sys.argv[3])))" ${quoteShellArg(filePath)} ${offset} ${chunkSize}`
      : `python3 -c "import sys;f=open(sys.argv[1],'rb');f.seek(int(sys.argv[2]));sys.stdout.buffer.write(f.read(int(sys.argv[3])))" ${quoteShellArg(filePath)} ${offset} ${chunkSize} | base64`;

    const result = await execShellCmd(cmd);
    if (!result.ok || result.stdout === null) {
      console.warn(
        `[DPP] chunked-read: chunk ${i + 1}/${totalChunks} failed ` +
        `(ok=${result.ok}, stdoutLen=${result.stdout?.length ?? 'null'})`,
      );
      return { ok: false, base64: null, truncated: false };
    }
    chunks.push(result.stdout.replace(/\s/g, ''));
  }

  const base64 = chunks.join('');
  return { ok: true, base64, truncated };
}

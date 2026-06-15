import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/deepseek/adapter', () => ({
  createPowHeaders: vi.fn().mockResolvedValue({}),
}));

import { uploadFileToDeepSeek, uploadImageToDeepSeek } from '../core/deepseek/image-upload';

describe('uploadImageToDeepSeek', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects a file that never becomes ready', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { biz_data: { id: 'file-1' } } }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({
        data: { biz_data: { files: [{ id: 'file-1', status: 'PROCESSING' }] } },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = uploadImageToDeepSeek({
      base64: 'aW1hZ2U=',
      mimeType: 'image/png',
      size: 5,
      authHeaders: { Authorization: 'Bearer test' },
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBeNull();
  });

  it('preserves the original document filename', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { biz_data: {} } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await uploadFileToDeepSeek({
      base64: 'ZG9jdW1lbnQ=',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 8,
      filename: '/tmp/quarterly-report.docx',
      authHeaders: { Authorization: 'Bearer test' },
      isVisionFile: false,
    });

    const uploadOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const uploadedFile = (uploadOptions.body as FormData).get('file') as File;
    expect(uploadedFile.name).toBe('quarterly-report.docx');
  });

  it('decodes base64 locally without fetching a data URL', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('data:')) throw new TypeError('Failed to fetch');
      if (url.includes('/upload_file')) {
        return new Response(JSON.stringify({ data: { biz_data: { id: 'file-local-decode' } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { biz_data: { files: [{ id: 'file-local-decode', status: 'SUCCESS', audit_result: 'pass' }] } },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = uploadFileToDeepSeek({
      base64: 'aGVsbG8=',
      mimeType: 'text/plain',
      size: 5,
      filename: '/tmp/hello.txt',
      authHeaders: { Authorization: 'Bearer test' },
      isVisionFile: false,
    });
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('file-local-decode');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v0/file/upload_file');
    const uploadOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const uploadedFile = (uploadOptions.body as FormData).get('file') as File;
    expect(uploadedFile.size).toBe(5);
    expect(uploadedFile.type).toBe('text/plain');
  });
});

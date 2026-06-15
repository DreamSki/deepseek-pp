/**
 * Background fetch handler for API requests that need elevated permissions.
 *
 * Some browsers (like ChatGPT Atlas) impose additional restrictions on content script
 * network requests, even for same-origin requests. This module routes sensitive
 * API requests through the background script which has fewer restrictions.
 */

export interface BackgroundFetchRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | FormData;
  credentials?: RequestCredentials;
}

export interface BackgroundFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  error?: string;
}

export async function backgroundFetch(request: BackgroundFetchRequest): Promise<BackgroundFetchResponse> {
  const { url, method, headers = {}, body, credentials = 'include' } = request;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials,
    });

    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Text response, keep as is
    }

    // Convert Headers object to plain object
    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersObj,
      text,
      json,
    };
  } catch (err) {
    throw new Error(`Background fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

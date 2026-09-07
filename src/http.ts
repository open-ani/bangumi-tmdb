import { setTimeout as delay } from 'node:timers/promises';

export class HttpError extends Error {
  constructor(public status: number, path: string) { super(`HTTP ${status}: ${path}`); }
}
export async function request(url: string, init: RequestInit = {}, fetcher = fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) });
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(1000 * 2 ** attempt); continue;
    }
    if (response.ok) return response;
    const transient = response.status === 429 || response.status >= 500;
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    if (!transient || attempt >= 3) throw new HttpError(response.status, new URL(url).pathname);
    const retrySeconds = Number(retryAfter);
    await delay(Number.isFinite(retrySeconds) && retrySeconds > 0
      ? Math.min(60000, retrySeconds * 1000) : 1000 * 2 ** attempt);
  }
}

/** Small fetch wrapper shared by all adapters. Injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${service} API error ${status}: ${body.slice(0, 500)}`);
  }
}

export async function requestJson<T = unknown>(
  service: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(service, res.status, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(service, res.status, `non-JSON response: ${text}`);
  }
}

/** Strip keys/secrets from a URL before it appears in an error or log. */
export function redactUrl(url: string): string {
  return url.replace(/(accessKey|secretKey|api_key|token)=([^&]+)/gi, "$1=***");
}

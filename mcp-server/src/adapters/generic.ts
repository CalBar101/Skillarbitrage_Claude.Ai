/**
 * Generic bearer/API-key REST adapter used for Zipteams and Salesa until their
 * API shapes are confirmed. Once docs and credentials arrive, typed methods are
 * added on top of `request()` the same way LeadSquaredClient does.
 */
import { requestJson, type FetchLike } from "../http.js";

export interface GenericConfig {
  service: string;
  baseUrl: string;
  apiKey?: string;
  /** How the key is sent. Default: Authorization: Bearer <key>. */
  authStyle?: "bearer" | "x-api-key" | "query:api_key" | { header: string };
  fetch?: FetchLike;
}

export class GenericRestClient {
  private readonly fetchImpl: FetchLike;
  constructor(private readonly cfg: GenericConfig) {
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  get configured(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.apiKey);
  }

  get service(): string {
    return this.cfg.service;
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    if (!this.configured) {
      throw new Error(`${this.cfg.service} is not configured: set its BASE_URL and API_KEY secrets.`);
    }
    const u = new URL(path.replace(/^\//, ""), this.cfg.baseUrl.replace(/\/?$/, "/"));
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = {};
    const style = this.cfg.authStyle ?? "bearer";
    const key = this.cfg.apiKey!;
    if (style === "bearer") headers.authorization = `Bearer ${key}`;
    else if (style === "x-api-key") headers["x-api-key"] = key;
    else if (style === "query:api_key") u.searchParams.set("api_key", key);
    else headers[style.header] = key;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return requestJson<T>(this.cfg.service, this.fetchImpl, u.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }
}

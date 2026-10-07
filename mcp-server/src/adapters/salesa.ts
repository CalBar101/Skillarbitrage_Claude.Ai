/**
 * Salesa (Centrana centralized transcript API) client.
 * Base: https://centralized-transcript-api.altlapps.com/api/v1
 * Auth: x-api-key header.
 */
import { GenericRestClient } from "./generic.js";
import type { FetchLike } from "../http.js";

export const SALESA_DEFAULT_BASE_URL = "https://centralized-transcript-api.altlapps.com/api/v1";

/** Normalise an Indian phone to the 12-digit form Salesa expects (91XXXXXXXXXX). Other countries pass through digits-only. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

export class SalesaClient {
  readonly rest: GenericRestClient;
  constructor(cfg: { baseUrl?: string; apiKey?: string; fetch?: FetchLike }) {
    this.rest = new GenericRestClient({
      service: "Salesa",
      baseUrl: cfg.baseUrl || SALESA_DEFAULT_BASE_URL,
      apiKey: cfg.apiKey,
      authStyle: "x-api-key",
      fetch: cfg.fetch,
    });
  }

  get configured() {
    return this.rest.configured;
  }

  /** API 1: transcripts for one or more phone numbers. */
  searchByNumbers(numbers: string[], callStatus?: string) {
    return this.rest.request<unknown>("GET", "/webhook/search-by-numbers-v1", {
      query: { numbers: numbers.map(normalisePhone).join(","), call_status: callStatus },
    });
  }

  /** API 2: ask Salesa to transcribe pending calls for these phones. */
  generateTranscripts(phones: string[]) {
    return this.rest.request<unknown>("POST", "/webhook/generate-transcripts-by-phone", {
      body: phones.map((p) => ({ student_phone: normalisePhone(p) })),
    });
  }
}

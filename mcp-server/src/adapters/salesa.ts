/**
 * Salesa (Centrana centralized transcript API) client.
 * Base: https://centralized-transcript-api.altlapps.com/api/v1
 * Auth: x-api-key header.
 */
import { GenericRestClient } from "./generic.js";
import type { FetchLike } from "../http.js";
import { normalisePhone } from "../phone.js";
export { normalisePhone };

export const SALESA_DEFAULT_BASE_URL = "https://centralized-transcript-api.altlapps.com/api/v1";


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

  /** API 1: transcripts for one or more phone numbers, raw. Shape: { "<91phone>": { sales_call: SalesaCall[] } } */
  searchByNumbersRaw(numbers: string[], callStatus?: string) {
    return this.rest.request<SalesaRaw>("GET", "/webhook/search-by-numbers-v1", {
      query: { numbers: numbers.map(normalisePhone).join(","), call_status: callStatus },
    });
  }

  /** API 1, compacted: newest calls first, transcript text truncated. */
  async searchByNumbers(numbers: string[], callStatus?: string, opts: { maxCalls?: number; maxChars?: number } = {}) {
    const raw = await this.searchByNumbersRaw(numbers, callStatus);
    return compactSalesa(raw, opts);
  }

  /** Calls on one calendar day (Salesa start_time is IST labelled as Z), all statuses, newest first. */
  async callsOnDay(numbers: string[], day: string, opts: { maxChars?: number; minSeconds?: number } = {}) {
    const raw = await this.searchByNumbersRaw(numbers);
    const all = compactSalesa(raw, { maxCalls: 10_000, maxChars: opts.maxChars ?? 6000 });
    const calls = all.calls.filter((c) => (c.startTime ?? "").startsWith(day) && (c.durationSec ?? 0) >= (opts.minSeconds ?? 0));
    return { phones: all.phones, calls };
  }

  /** API 2: ask Salesa to transcribe pending calls for these phones. */
  generateTranscripts(phones: string[]) {
    return this.rest.request<unknown>("POST", "/webhook/generate-transcripts-by-phone", {
      body: phones.map((p) => ({ student_phone: normalisePhone(p) })),
    });
  }
}

export interface SalesaCall {
  caller_id?: string;
  start_time?: string;
  end_time?: string;
  call_duration?: number;
  agent_name?: string;
  s3_transcript_url?: string | null;
  s3_audio_file_url?: string | null;
  createdAt?: string;
  transcript?: { text?: string } | string | null;
  [k: string]: unknown;
}
export type SalesaRaw = Record<string, { sales_call?: SalesaCall[]; [k: string]: unknown } | SalesaCall[] | unknown>;

export interface CompactCall {
  phone: string;
  startTime?: string;
  durationSec?: number;
  agent?: string;
  audioUrl?: string | null;
  transcriptUrl?: string | null;
  transcriptChars: number;
  transcript: string;
}

/** Flatten Salesa's per-phone map into a list of calls, newest first, with transcript text bounded. */
export function compactSalesa(raw: SalesaRaw | unknown, opts: { maxCalls?: number; maxChars?: number } = {}): { phones: Record<string, number>; calls: CompactCall[] } {
  const maxCalls = opts.maxCalls ?? 10;
  const maxChars = opts.maxChars ?? 4000;
  const calls: CompactCall[] = [];
  const phones: Record<string, number> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [phone, v] of Object.entries(raw as Record<string, unknown>)) {
      const list: SalesaCall[] = Array.isArray(v) ? (v as SalesaCall[]) : Array.isArray((v as { sales_call?: unknown })?.sales_call) ? ((v as { sales_call: SalesaCall[] }).sales_call) : [];
      phones[phone] = list.length;
      for (const c of list) {
        const t = typeof c.transcript === "string" ? c.transcript : c.transcript?.text ?? "";
        calls.push({
          phone,
          startTime: c.start_time,
          durationSec: typeof c.call_duration === "number" ? c.call_duration : undefined,
          agent: c.agent_name,
          audioUrl: c.s3_audio_file_url ?? null,
          transcriptUrl: c.s3_transcript_url ?? null,
          transcriptChars: t.length,
          transcript: t.length > maxChars ? t.slice(0, maxChars) + ` …[truncated ${t.length - maxChars} chars]` : t,
        });
      }
    }
  }
  calls.sort((a, b) => (a.startTime ?? "") < (b.startTime ?? "") ? 1 : -1);
  return { phones, calls: calls.slice(0, maxCalls) };
}

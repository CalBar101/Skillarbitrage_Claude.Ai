/**
 * Zipteams Customer API client (push side).
 * Docs: https://zipteams.github.io/customer-api/introduction
 * - Call sync + disposition update: POST to the ingestion endpoint, x-zip-api-key header.
 * - Create/upsert customer: POST https://api.zipteams.com/api/v1/client/conversation/webhook/customer-sync
 * Analysis comes back via callbacks handled in src/index.ts and stored in src/store.ts.
 */
import { requestJson, type FetchLike } from "../http.js";
import { toE164 } from "../phone.js";

export const ZIPTEAMS_INGEST_URL = "https://mixu6sd8i0.execute-api.ap-south-1.amazonaws.com/calls-webhook-ingestion-handler";
export const ZIPTEAMS_CUSTOMER_SYNC_URL = "https://api.zipteams.com/api/v1/client/conversation/webhook/customer-sync";

export interface ZipteamsCallRecord {
  call: { id: string; recording_url: string; start_time: string; phone_number?: string; access_type?: "whitelisted_ip" };
  agent: { id: string; email: string };
  customer?: { id?: string; name?: string; email?: string; disposition_status?: string };
  custom_fields?: { internal_name: string; value: string }[];
  callback_url?: string;
  metadata?: Record<string, string>;
}

export interface ZipteamsDispositionRecord {
  agent: { id: string; email: string };
  customer: { id?: string; name?: string; email?: string; phone_number?: string; disposition_status?: string };
  custom_fields?: { internal_name: string; value: string }[];
}

export interface ZipteamsCustomerUpsert {
  agent_email: string;
  name?: string;
  email?: string;
  phone_number?: string;
  disposition_status?: string;
  custom_fields?: { field_name: string; value: string }[];
}

export class ZipteamsClient {
  private readonly fetchImpl: FetchLike;
  constructor(
    private readonly cfg: { apiKey?: string; ingestUrl?: string; customerSyncUrl?: string; fetch?: FetchLike },
  ) {
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  get configured(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  private post<T>(url: string, body: unknown) {
    if (!this.cfg.apiKey) throw new Error("Zipteams is not configured: set the ZIPTEAMS_API_KEY secret.");
    return requestJson<T>("Zipteams", this.fetchImpl, url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zip-api-key": this.cfg.apiKey },
      body: JSON.stringify(body),
    });
  }

  /** Section 1. Phone numbers are coerced to E.164. Empty optional strings are dropped (Zipteams rejects ""). */
  syncCalls(records: ZipteamsCallRecord[]) {
    const data = records.map((r) => clean({ ...r, call: { ...r.call, phone_number: r.call.phone_number ? toE164(r.call.phone_number) : undefined } }));
    return this.post<{ message: string }>(this.cfg.ingestUrl ?? ZIPTEAMS_INGEST_URL, { data });
  }

  /** Section 2. */
  updateDisposition(records: ZipteamsDispositionRecord[]) {
    const data = records.map((r) =>
      clean({ ...r, customer: { ...r.customer, phone_number: r.customer.phone_number ? toE164(r.customer.phone_number) : undefined } }),
    );
    return this.post<{ message: string }>(this.cfg.ingestUrl ?? ZIPTEAMS_INGEST_URL, { type: "disposition-status", data });
  }

  /** Section 3. One customer per request. */
  upsertCustomer(c: ZipteamsCustomerUpsert) {
    return this.post<unknown>(
      this.cfg.customerSyncUrl ?? ZIPTEAMS_CUSTOMER_SYNC_URL,
      clean({ ...c, phone_number: c.phone_number ? toE164(c.phone_number) : undefined }),
    );
  }
}

/** Recursively drop undefined and empty-string values. */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined || val === "") continue;
      out[k] = clean(val);
    }
    return out as T;
  }
  return v;
}

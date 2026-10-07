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
export const ZIPTEAMS_PARTNER_BASE = "https://api.zipteams.com/api/v1/partner";

/**
 * Two credential styles exist:
 * - "customer": one x-zip-api-key, Customer API endpoints.
 * - "partner": x-api-key + x-api-secret + x-tenant-id + x-sub-tenant-id, Partner API endpoints
 *   (POST /partner/ingest/batch-call, PUT /partner/ingest/disposition-status). 120 req/min.
 */
export interface ZipteamsConfig {
  apiKey?: string;
  apiSecret?: string;
  tenantId?: string;
  subTenantId?: string;
  ingestUrl?: string;
  customerSyncUrl?: string;
  partnerBase?: string;
  fetch?: FetchLike;
}

export interface ZipteamsCallRecord {
  call: { id: string; recording_url: string; start_time: string; end_time?: string; phone_number?: string; access_type?: "whitelisted_ip" };
  agent: { id: string; email: string; name?: string };
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
  constructor(private readonly cfg: ZipteamsConfig) {
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
  }

  get mode(): "partner" | "customer" | "unconfigured" {
    if (this.cfg.apiKey && this.cfg.apiSecret && this.cfg.tenantId && this.cfg.subTenantId) return "partner";
    if (this.cfg.apiKey) return "customer";
    return "unconfigured";
  }

  get configured(): boolean {
    return this.mode !== "unconfigured";
  }

  private headers(): Record<string, string> {
    const m = this.mode;
    if (m === "unconfigured") throw new Error("Zipteams is not configured: set ZIPTEAMS_API_KEY (and for the Partner API also ZIPTEAMS_API_SECRET, ZIPTEAMS_TENANT_ID, ZIPTEAMS_SUB_TENANT_ID).");
    if (m === "partner") {
      return {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey!,
        "x-api-secret": this.cfg.apiSecret!,
        "x-tenant-id": this.cfg.tenantId!,
        "x-sub-tenant-id": this.cfg.subTenantId!,
      };
    }
    return { "content-type": "application/json", "x-zip-api-key": this.cfg.apiKey! };
  }

  private send<T>(method: "POST" | "PUT", url: string, body: unknown) {
    return requestJson<T>("Zipteams", this.fetchImpl, url, { method, headers: this.headers(), body: JSON.stringify(body) });
  }

  /** Send calls for analysis. Phones are coerced to E.164; empty optional strings are dropped (Zipteams rejects ""). */
  syncCalls(records: ZipteamsCallRecord[]) {
    if (this.mode === "partner") {
      const data = records.map((r) => {
        if (!r.call.end_time) throw new Error(`Partner API needs call.end_time for call ${r.call.id}.`);
        if (!r.customer?.id) throw new Error(`Partner API needs customer.id for call ${r.call.id}.`);
        if (!r.call.phone_number) throw new Error(`Partner API needs the customer phone (contact_number) for call ${r.call.id}.`);
        return clean({
          call: {
            id: r.call.id,
            recording_url: r.call.recording_url,
            start_time: toUtcZ(r.call.start_time),
            end_time: toUtcZ(r.call.end_time),
            contact_number: toE164(r.call.phone_number),
          },
          agent: r.agent,
          customer: r.customer,
          callback_url: r.callback_url,
          metadata: r.metadata,
          custom_fields: r.custom_fields,
        });
      });
      return this.send<{ success: boolean }>("POST", `${this.cfg.partnerBase ?? ZIPTEAMS_PARTNER_BASE}/ingest/batch-call`, { data });
    }
    const data = records.map((r) => clean({ ...r, call: { ...r.call, end_time: undefined, phone_number: r.call.phone_number ? toE164(r.call.phone_number) : undefined } }));
    return this.send<{ message: string }>("POST", this.cfg.ingestUrl ?? ZIPTEAMS_INGEST_URL, { data });
  }

  /** Update a customer's disposition. Partner API keys on customer_id only; Customer API matches by phone/email. */
  updateDisposition(records: ZipteamsDispositionRecord[]) {
    if (this.mode === "partner") {
      return Promise.all(
        records.map((r) => {
          if (!r.customer.id) throw new Error("Partner API disposition update needs customer.id (the id used at ingestion).");
          return this.send<{ success: boolean }>("PUT", `${this.cfg.partnerBase ?? ZIPTEAMS_PARTNER_BASE}/ingest/disposition-status`, {
            customer_id: r.customer.id,
            disposition_status: r.customer.disposition_status,
          });
        }),
      );
    }
    const data = records.map((r) =>
      clean({ ...r, customer: { ...r.customer, phone_number: r.customer.phone_number ? toE164(r.customer.phone_number) : undefined } }),
    );
    return this.send<{ message: string }>("POST", this.cfg.ingestUrl ?? ZIPTEAMS_INGEST_URL, { type: "disposition-status", data });
  }

  /** Customer API only: create-or-update a customer without a call. */
  upsertCustomer(c: ZipteamsCustomerUpsert) {
    if (this.mode === "partner") throw new Error("Customer upsert is a Customer API endpoint; with Partner credentials, ingest a call instead (customers are created on ingestion).");
    return this.send<unknown>(
      "POST",
      this.cfg.customerSyncUrl ?? ZIPTEAMS_CUSTOMER_SYNC_URL,
      clean({ ...c, phone_number: c.phone_number ? toE164(c.phone_number) : undefined }),
    );
  }
}

/** Partner API wants UTC with a trailing Z. Accepts any ISO 8601 with offset. */
function toUtcZ(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
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

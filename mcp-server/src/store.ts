/**
 * Storage for Zipteams callbacks. Zipteams has no read API: it POSTs its AI
 * analysis to a webhook we own, so we persist those payloads and let MCP
 * tools read them back. Backed by Workers KV in production, memory in tests.
 */
import { normalisePhone } from "./phone.js";

export interface CallSummary {
  call_id: string;
  customer_id?: string;
  agent_id?: string;
  type: "CALL_SUMMARY";
  intent?: string;
  intent_score?: number;
  quality_score?: number;
  [k: string]: unknown;
}

export interface CustomerSummary {
  type: "CUSTOMER_SUMMARY";
  customer_id?: string;
  phone?: string;
  phone_number?: string;
  email?: string;
  contact_email?: string;
  owner?: string;
  intent?: string;
  intent_score?: number;
  [k: string]: unknown;
}

export interface StoredRecord<T> {
  receivedAt: string;
  payload: T;
}

export interface CallIndexEntry {
  key: string;
  receivedAt: string;
  call_id: string;
  customer_id?: string;
  agent_id?: string;
  intent?: string;
  intent_score?: number;
  quality_score?: number;
}

export interface CustomerIndexEntry {
  key: string;
  receivedAt: string;
  customer_id?: string;
  phone?: string;
  email?: string;
  owner?: string;
  intent?: string;
  intent_score?: number;
}

export interface InsightsStore {
  saveCallSummary(p: CallSummary): Promise<void>;
  saveCustomerSummary(p: CustomerSummary): Promise<void>;
  getCallSummary(callId: string): Promise<StoredRecord<CallSummary> | null>;
  getCustomerSummary(q: { phone?: string; email?: string; customerId?: string }): Promise<StoredRecord<CustomerSummary> | null>;
  listRecentCalls(opts: { sinceIso: string; limit?: number }): Promise<CallIndexEntry[]>;
  listRecentCustomers(opts: { sinceIso: string; limit?: number }): Promise<CustomerIndexEntry[]>;
}

const CALL_PREFIX = "call:";
const CALLID_PREFIX = "callid:";
const CUST_PHONE_PREFIX = "customer:phone:";
const CUST_EMAIL_PREFIX = "customer:email:";
const CUST_ID_PREFIX = "customer:id:";
const CUSTLOG_PREFIX = "custlog:";

function customerPhone(p: CustomerSummary): string | undefined {
  const raw = p.phone ?? p.phone_number;
  return raw ? normalisePhone(String(raw)) : undefined;
}
function customerEmail(p: CustomerSummary): string | undefined {
  const raw = p.email ?? p.contact_email;
  return raw ? String(raw).trim().toLowerCase() : undefined;
}

/** Minimal subset of the KVNamespace API we use, so tests can fake it. */
export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void>;
  list(opts: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export class KVInsightsStore implements InsightsStore {
  constructor(private readonly kv: KVLike, private readonly now: () => Date = () => new Date()) {}

  async saveCallSummary(p: CallSummary): Promise<void> {
    const receivedAt = this.now().toISOString();
    const key = `${CALL_PREFIX}${receivedAt}:${p.call_id}`;
    const meta: Omit<CallIndexEntry, "key"> = {
      receivedAt,
      call_id: p.call_id,
      customer_id: p.customer_id,
      agent_id: p.agent_id,
      intent: p.intent,
      intent_score: p.intent_score,
      quality_score: p.quality_score,
    };
    const record: StoredRecord<CallSummary> = { receivedAt, payload: p };
    await this.kv.put(key, JSON.stringify(record), { metadata: meta });
    await this.kv.put(`${CALLID_PREFIX}${p.call_id}`, key);
  }

  async saveCustomerSummary(p: CustomerSummary): Promise<void> {
    const receivedAt = this.now().toISOString();
    const record = JSON.stringify({ receivedAt, payload: p } satisfies StoredRecord<CustomerSummary>);
    const phone = customerPhone(p);
    const email = customerEmail(p);
    const meta: Omit<CustomerIndexEntry, "key"> = {
      receivedAt,
      customer_id: p.customer_id,
      phone,
      email,
      owner: p.owner,
      intent: p.intent,
      intent_score: p.intent_score,
    };
    const writes: Promise<void>[] = [];
    if (phone) writes.push(this.kv.put(`${CUST_PHONE_PREFIX}${phone}`, record));
    if (email) writes.push(this.kv.put(`${CUST_EMAIL_PREFIX}${email}`, record));
    if (p.customer_id) writes.push(this.kv.put(`${CUST_ID_PREFIX}${p.customer_id}`, record));
    writes.push(this.kv.put(`${CUSTLOG_PREFIX}${receivedAt}:${p.customer_id ?? phone ?? email ?? "unknown"}`, record, { metadata: meta }));
    await Promise.all(writes);
  }

  async getCallSummary(callId: string): Promise<StoredRecord<CallSummary> | null> {
    const key = await this.kv.get(`${CALLID_PREFIX}${callId}`, "text");
    if (!key) return null;
    const raw = await this.kv.get(key, "text");
    return raw ? (JSON.parse(raw) as StoredRecord<CallSummary>) : null;
  }

  async getCustomerSummary(q: { phone?: string; email?: string; customerId?: string }): Promise<StoredRecord<CustomerSummary> | null> {
    const keys = [
      q.customerId ? `${CUST_ID_PREFIX}${q.customerId}` : null,
      q.phone ? `${CUST_PHONE_PREFIX}${normalisePhone(q.phone)}` : null,
      q.email ? `${CUST_EMAIL_PREFIX}${q.email.trim().toLowerCase()}` : null,
    ].filter((k): k is string => Boolean(k));
    for (const key of keys) {
      const raw = await this.kv.get(key, "text");
      if (raw) return JSON.parse(raw) as StoredRecord<CustomerSummary>;
    }
    return null;
  }

  private async listSince<T extends { receivedAt: string }>(prefix: string, sinceIso: string, limit: number): Promise<(T & { key: string })[]> {
    // Keys embed the ISO timestamp right after the prefix, so lexical order is chronological.
    // Walk day prefixes from `since` to today to avoid scanning the whole namespace.
    const out: (T & { key: string })[] = [];
    const since = new Date(sinceIso);
    const today = this.now();
    for (let d = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      let cursor: string | undefined;
      do {
        const page = await this.kv.list({ prefix: `${prefix}${d.toISOString().slice(0, 10)}`, cursor, limit: 1000 });
        for (const k of page.keys) {
          const m = k.metadata as T | undefined;
          if (m && m.receivedAt >= sinceIso) out.push({ ...m, key: k.name });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
    return out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, limit);
  }

  listRecentCalls(opts: { sinceIso: string; limit?: number }) {
    return this.listSince<Omit<CallIndexEntry, "key">>(CALL_PREFIX, opts.sinceIso, opts.limit ?? 50);
  }

  listRecentCustomers(opts: { sinceIso: string; limit?: number }) {
    return this.listSince<Omit<CustomerIndexEntry, "key">>(CUSTLOG_PREFIX, opts.sinceIso, opts.limit ?? 50);
  }
}

/** In-memory KV for tests and local dev without a namespace. */
export class MemoryKV implements KVLike {
  readonly data = new Map<string, { value: string; metadata?: unknown }>();
  async get(key: string) {
    return this.data.get(key)?.value ?? null;
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    this.data.set(key, { value, metadata: opts?.metadata });
  }
  async list(opts: { prefix?: string }) {
    const keys = [...this.data.entries()]
      .filter(([k]) => !opts.prefix || k.startsWith(opts.prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, v]) => ({ name, metadata: v.metadata }));
    return { keys, list_complete: true as const };
  }
}

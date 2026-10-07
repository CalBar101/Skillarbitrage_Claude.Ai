/**
 * Read-only end-to-end check of every connection. Used by the `connections_selftest`
 * tool and by the scheduled handler (so results can be read back from KV when the
 * MCP endpoint is not reachable from where the operator sits).
 */
import type { Clients } from "./server.js";
import { ApiError, redactUrl } from "./http.js";
import { ZIPTEAMS_INGEST_URL } from "./adapters/zipteams.js";

export interface CheckResult {
  ok: boolean;
  ms: number;
  detail: unknown;
}

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  const t = Date.now();
  try {
    return { ok: true, ms: Date.now() - t, detail: await fn() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, ms: Date.now() - t, detail: redactUrl(msg).slice(0, 600) };
  }
}

const first = (v: unknown, n = 2) => (Array.isArray(v) ? v.slice(0, n) : v);
const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "object" && v !== null ? Object.keys(v).length : 0);

export async function runSelfTest(clients: Clients, opts: { samplePhone?: string; zipteamsApiKey?: string } = {}) {
  const lsq = clients.leadsquared;
  const results: Record<string, CheckResult | string> = {};

  if (!lsq) results.leadsquared = "not configured";
  else {
    results.leadsquared_users = await check(async () => {
      const u = (await lsq.listUsers()) as Record<string, unknown>[];
      return { count: u.length, sample: u.slice(0, 3).map((x) => ({ ID: x.ID, Name: `${x.FirstName ?? ""} ${x.LastName ?? ""}`.trim(), Email: x.EmailAddress })) };
    });
    results.leadsquared_activity_types = await check(async () => {
      const t = (await lsq.getActivityTypes()) as Record<string, unknown>[];
      return { count: t.length, sample: t.slice(0, 8).map((x) => ({ ActivityEvent: x.ActivityEvent, Name: x.ActivityEventName ?? x.Name })) };
    });
    results.leadsquared_recent_leads = await check(async () => {
      const rows = (await lsq.searchLeads({
        Columns: { Include_CSV: "ProspectID,FirstName,EmailAddress,Phone,Mobile,ProspectStage,ModifiedOn" },
        Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
        Paging: { PageIndex: 1, PageSize: 3 },
      })) as Record<string, unknown>[];
      return { count: rows.length, fields: rows[0] ? Object.keys(rows[0]) : [], sample: rows.map((r) => ({ ProspectID: r.ProspectID, ProspectStage: r.ProspectStage, ModifiedOn: r.ModifiedOn })) };
    });
    results.leadsquared_tasks = await check(async () => {
      const t = await lsq.listTasks({ Paging: { PageIndex: 1, PageSize: 3 } });
      return { count: count(t), sample: first(t, 1) };
    });
    if (opts.samplePhone) {
      results.leadsquared_lead_by_phone = await check(async () => {
        const l = (await lsq.getLeadByPhone(opts.samplePhone!)) as Record<string, unknown>[];
        return { count: l.length, sample: l.slice(0, 1).map((r) => ({ ProspectID: r.ProspectID, ProspectStage: r.ProspectStage, Phone: r.Phone, Mobile: r.Mobile })) };
      });
    }
  }

  if (!clients.salesa.configured) results.salesa = "not configured";
  else if (opts.samplePhone) {
    results.salesa_transcripts = await check(async () => {
      const r = await clients.salesa.searchByNumbers([opts.samplePhone!], "answered");
      const s = JSON.stringify(r);
      return { bytes: s.length, topLevelKeys: typeof r === "object" && r ? Object.keys(r as object) : typeof r, preview: s.slice(0, 1500) };
    });
  } else results.salesa = "configured; pass samplePhone to exercise";

  // Zipteams has no read endpoint. An empty batch is accepted (200) or rejected by validation (4xx),
  // but a bad key fails with 401/403 first, so this proves the key without creating anything.
  if (!clients.zipteams.configured) results.zipteams = "not configured";
  else if (clients.zipteams.mode === "customer" && opts.zipteamsApiKey) {
    results.zipteams_key = await check(async () => {
      const res = await fetch(ZIPTEAMS_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zip-api-key": opts.zipteamsApiKey! },
        body: JSON.stringify({ data: [] }),
      });
      const body = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new ApiError("Zipteams", res.status, body);
      return { status: res.status, body, verdict: "key accepted" };
    });
  } else results.zipteams = `configured (${clients.zipteams.mode} mode); key check only implemented for customer mode`;

  results.zipteams_callback_url = clients.zipteamsCallbackUrl ?? "not set";
  const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
  results.zipteams_stored_insights = await check(async () => ({
    callsLast30d: (await clients.store.listRecentCalls({ sinceIso, limit: 5 })).length,
    customersLast30d: (await clients.store.listRecentCustomers({ sinceIso, limit: 5 })).length,
  }));

  const summary = Object.entries(results).map(([k, v]) => `${k}: ${typeof v === "string" ? v : v.ok ? "OK" : "FAIL"}`);
  return { ranAt: new Date().toISOString(), summary, results };
}

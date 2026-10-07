/**
 * Rank leads by a transparent conversion-likelihood heuristic built from the three systems.
 * Every component is returned with the score so the caller (Claude) can explain or re-weight it.
 */
import type { Clients } from "./server.js";
import { normalisePhone } from "./phone.js";

export interface RankOptions {
  days: number;
  /** Restrict to these LeadSquared owner emails (case-insensitive) and/or ids. */
  ownerEmails?: string[];
  ownerIds?: string[];
  /** Or restrict by any lead field value, e.g. { field: "mx_Team", value: "Elite" }. */
  teamField?: { field: string; value: string };
  /** Stage weights, 0-30. Unlisted stages get 5; stages listed in `excludeStages` are dropped. */
  stageWeights?: Record<string, number>;
  excludeStages?: string[];
  /** How many leads to enrich with activity, Salesa and Zipteams signals. */
  candidates: number;
  /** Max leads scanned from LeadSquared, newest-modified first. */
  scanLimit: number;
  /** Timezone offset for LeadSquared timestamps. */
  tzOffsetMinutes: number;
}

export interface RankedLead {
  ProspectID: string;
  name: string;
  email?: string;
  phone?: string;
  stage?: string;
  owner?: string;
  ownerEmail?: string;
  leadScore?: number;
  modifiedOn?: string;
  score: number;
  signals: Record<string, number | string>;
}

const DEFAULT_STAGE_WEIGHTS: Record<string, number> = {
  lead: 5,
  prospect: 10,
  "qualified lead": 15,
  qualified: 15,
  opportunity: 25,
  "hot lead": 25,
  hot: 25,
  negotiation: 30,
  "proposal sent": 25,
  "demo done": 20,
  "payment pending": 30,
  customer: 0,
  converted: 0,
  "not interested": 0,
  junk: 0,
  "do not call": 0,
};
const DEFAULT_EXCLUDE = ["customer", "converted", "not interested", "junk", "do not call", "invalid", "lost"];

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

export async function rankLeads(clients: Clients, o: RankOptions) {
  const lsq = clients.leadsquared;
  if (!lsq) throw new Error("LeadSquared is not configured.");
  const now = Date.now();
  const cutoffLocal = new Date(now - o.days * 86_400_000 + o.tzOffsetMinutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const stageWeights = { ...DEFAULT_STAGE_WEIGHTS, ...Object.fromEntries(Object.entries(o.stageWeights ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const exclude = new Set((o.excludeStages ?? DEFAULT_EXCLUDE).map((s) => s.toLowerCase()));
  const ownerEmails = new Set((o.ownerEmails ?? []).map((e) => e.toLowerCase()));
  const ownerIds = new Set(o.ownerIds ?? []);

  // 1. Scan leads modified in the window, newest first. One filter max per LeadSquared query, so team filter is server-side when given, owners client-side.
  const columns = "ProspectID,FirstName,LastName,EmailAddress,Phone,Mobile,ProspectStage,Score,OwnerId,OwnerIdName,OwnerIdEmailAddress,ModifiedOn,CreatedOn,Source,LastActivity,LastActivityDate" + (o.teamField ? `,${o.teamField.field}` : "");
  const scanned: Record<string, unknown>[] = [];
  const pageSize = 100;
  for (let page = 1; scanned.length < o.scanLimit; page++) {
    const rows = (await lsq.searchLeads({
      Parameter: o.teamField ? { LookupName: o.teamField.field, LookupValue: o.teamField.value, SqlOperator: "=" } : undefined,
      Columns: { Include_CSV: columns },
      Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
      Paging: { PageIndex: page, PageSize: pageSize },
    })) as Record<string, unknown>[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    let stop = false;
    for (const r of rows) {
      if (typeof r.ModifiedOn === "string" && r.ModifiedOn < cutoffLocal) {
        stop = true;
        break;
      }
      scanned.push(r);
    }
    if (stop || rows.length < pageSize) break;
  }

  // 2. Team / owner / stage filter and the cheap part of the score.
  const prelim = scanned
    .filter((r) => {
      if (ownerEmails.size || ownerIds.size) {
        const em = lower(r.OwnerIdEmailAddress);
        const id = typeof r.OwnerId === "string" ? r.OwnerId : "";
        if (!(ownerEmails.has(em) || ownerIds.has(id))) return false;
      }
      return !exclude.has(lower(r.ProspectStage));
    })
    .map((r) => {
      const stage = lower(r.ProspectStage);
      const stageW = stageWeights[stage] ?? 5;
      const leadScore = num(r.Score);
      const leadScoreW = leadScore === undefined ? 0 : Math.min(15, Math.round(leadScore / 10));
      const lastAct = typeof r.LastActivityDate === "string" ? r.LastActivityDate : typeof r.ModifiedOn === "string" ? r.ModifiedOn : undefined;
      const daysSince = lastAct ? (now - (new Date(lastAct.replace(" ", "T") + "Z").getTime() - o.tzOffsetMinutes * 60_000)) / 86_400_000 : 99;
      const recencyW = daysSince <= 1 ? 10 : daysSince <= 3 ? 6 : daysSince <= 7 ? 3 : 0;
      const lead: RankedLead = {
        ProspectID: String(r.ProspectID),
        name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(),
        email: typeof r.EmailAddress === "string" ? r.EmailAddress : undefined,
        phone: typeof r.Phone === "string" && r.Phone ? r.Phone : typeof r.Mobile === "string" ? r.Mobile : undefined,
        stage: typeof r.ProspectStage === "string" ? r.ProspectStage : undefined,
        owner: typeof r.OwnerIdName === "string" ? r.OwnerIdName : undefined,
        ownerEmail: typeof r.OwnerIdEmailAddress === "string" ? r.OwnerIdEmailAddress : undefined,
        leadScore,
        modifiedOn: typeof r.ModifiedOn === "string" ? r.ModifiedOn : undefined,
        score: stageW + leadScoreW + recencyW,
        signals: { stage: stageW, leadScore: leadScoreW, recency: recencyW, daysSinceActivity: Math.round(daysSince * 10) / 10 },
      };
      return lead;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, o.candidates);

  // 3. Enrich candidates: Zipteams intent (stored callbacks), Salesa answered calls (one batched request), activity count.
  const phones = [...new Set(prelim.map((l) => l.phone).filter((p): p is string => Boolean(p)).map(normalisePhone))];
  let salesaByPhone: Record<string, number> = {};
  let salesaNote = "not configured";
  if (clients.salesa.configured && phones.length) {
    try {
      const raw = await clients.salesa.searchByNumbers(phones, "answered");
      salesaByPhone = countByPhone(raw, phones);
      salesaNote = `queried ${phones.length} numbers`;
    } catch (e) {
      salesaNote = `error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  }

  await Promise.all(
    prelim.map(async (l) => {
      const zt = await clients.store.getCustomerSummary({ phone: l.phone, email: l.email, customerId: l.ProspectID }).catch(() => null);
      if (zt) {
        const intent = lower(zt.payload.intent);
        const intentW = intent.includes("interested") && !intent.includes("not") ? 20 : intent.includes("hot") ? 25 : intent === "" ? 0 : -10;
        const is = num(zt.payload.intent_score);
        const intentScoreW = is === undefined ? 0 : Math.round((is / 100) * 20);
        l.signals.zipteamsIntent = zt.payload.intent ?? "";
        l.signals.zipteamsIntentW = intentW;
        l.signals.zipteamsIntentScoreW = intentScoreW;
        l.score += intentW + intentScoreW;
      }
      const calls = l.phone ? (salesaByPhone[normalisePhone(l.phone)] ?? 0) : 0;
      const callsW = Math.min(15, calls * 5);
      l.signals.salesaAnsweredCalls = calls;
      l.signals.salesaCallsW = callsW;
      l.score += callsW;
      try {
        const acts = await lsq.getLeadActivities(l.ProspectID, { pageSize: 25 });
        const n = Array.isArray(acts?.ProspectActivities) ? acts.ProspectActivities.length : num(acts?.RecordCount) ?? 0;
        const actW = Math.min(10, Math.round(n / 2));
        l.signals.activitiesRecent = n;
        l.signals.activitiesW = actW;
        l.score += actW;
      } catch (e) {
        l.signals.activitiesError = e instanceof Error ? e.message.slice(0, 120) : String(e);
      }
    }),
  );

  prelim.sort((a, b) => b.score - a.score);
  return {
    window: { days: o.days, modifiedOnOrAfter: cutoffLocal },
    scanned: scanned.length,
    afterFilters: prelim.length,
    filters: { ownerEmails: [...ownerEmails], ownerIds: [...ownerIds], teamField: o.teamField ?? null, excludedStages: [...exclude] },
    salesa: salesaNote,
    scoring: "stage(0-30) + leadScore(0-15) + recency(0-10) + activities(0-10) + salesaCalls(0-15) + zipteamsIntent(-10..25) + zipteamsIntentScore(0-20)",
    leads: prelim,
  };
}

/** Count Salesa transcript records per normalised phone. Shape-agnostic: any object whose JSON mentions the number counts once. */
function countByPhone(raw: unknown, phones: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (Object.values(raw as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  for (const it of items) {
    const s = JSON.stringify(it).replace(/\D/g, " ");
    for (const p of phones) {
      if (s.includes(p) || s.includes(p.replace(/^91/, ""))) out[p] = (out[p] ?? 0) + 1;
    }
  }
  return out;
}

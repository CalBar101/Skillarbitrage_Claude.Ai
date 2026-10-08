/**
 * One calendar day of calling for a batch of owners: per-owner outcome counts from LeadSquared
 * (including the Zipteams fields the connector syncs) plus the candidate leads to pull Salesa
 * transcripts for. Day is an IST calendar day; LeadSquared API timestamps are UTC.
 */
import type { Clients } from "./server.js";
import { scanTeamLeads, lowerText as lower, TEAM_LEAD_COLUMNS } from "./ranking.js";
import { normalisePhone } from "./phone.js";

const IST_MIN = 330;
export function istDayToUtcWindow(day: string): { fromUtc: string; toUtc: string } {
  const start = new Date(`${day}T00:00:00Z`).getTime() - IST_MIN * 60_000;
  const end = start + 86_400_000;
  const f = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  return { fromUtc: f(start), toUtc: f(end) };
}

const CLOSE = ["course enrolled", "booking fees received", "collections done", "loan pending"];
const PIPE = ["follow up for closure", "counselled lead", "roadmap done", "discovery call done", "opportunity created"];
const DEAD = ["not interested", "invalid", "irrelevant lead"];

export interface OwnerDay {
  ownerId: string;
  owner: string;
  touched: number;
  newLeads: number;
  callDone: number;
  notConnected: number;
  pipeline: number;
  closure: number;
  enrolled: number;
  dead: number;
  zipHigh: number;
  zipModerate: number;
  zipLow: number;
  zipScored: number;
  zipScoreSum: number;
  qualityScored: number;
  qualitySum: number;
  objections: Record<string, number>;
  stages: Record<string, number>;
}

export interface CandidateLead {
  ownerId: string;
  owner: string;
  ProspectID: string;
  name: string;
  phone?: string;
  stage: string;
  zipIntent: string;
  zipScore: number | null;
  zipQuality: number | null;
  zipDisposition: string;
  objection: string;
  justification: string;
  talkingPoints: string;
  course: string;
  modifiedOn: string;
  score: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function analyzeCallingDay(
  clients: Clients,
  o: { day: string; ownerIds: string[]; candidatesPerOwner: number; scanLimit: number },
) {
  const { fromUtc, toUtc } = istDayToUtcWindow(o.day);
  const { scanned, ownerNames } = await scanTeamLeads(clients, { ownerIds: o.ownerIds, cutoffLocal: fromUtc, scanLimit: o.scanLimit });
  const rows = scanned.filter((r) => typeof r.ModifiedOn === "string" && r.ModifiedOn < toUtc);
  const owners = new Map<string, OwnerDay>();
  const candidates: CandidateLead[] = [];
  for (const r of rows) {
    const id = String(r.OwnerId ?? "");
    const name = typeof r.OwnerIdName === "string" ? r.OwnerIdName : ownerNames[id] ?? id;
    let s = owners.get(id);
    if (!s) {
      s = { ownerId: id, owner: name, touched: 0, newLeads: 0, callDone: 0, notConnected: 0, pipeline: 0, closure: 0, enrolled: 0, dead: 0, zipHigh: 0, zipModerate: 0, zipLow: 0, zipScored: 0, zipScoreSum: 0, qualityScored: 0, qualitySum: 0, objections: {}, stages: {} };
      owners.set(id, s);
    }
    const stage = lower(r.ProspectStage);
    s.touched++;
    s.stages[stage || "(blank)"] = (s.stages[stage || "(blank)"] ?? 0) + 1;
    if (typeof r.CreatedOn === "string" && r.CreatedOn >= fromUtc && r.CreatedOn < toUtc) s.newLeads++;
    if (lower(r.mx_Call_Connected_Status) === "call done") s.callDone++;
    if (stage === "call not picking up" || stage === "call not connected") s.notConnected++;
    if (PIPE.includes(stage)) s.pipeline++;
    if (stage === "follow up for closure") s.closure++;
    if (CLOSE.includes(stage)) s.enrolled++;
    if (DEAD.includes(stage)) s.dead++;
    const zt = `${lower(r.mx_Zip_Intent_Type)} ${lower(r.mx_Zip_Intent)}`;
    if (zt.includes("high")) s.zipHigh++;
    else if (zt.includes("moderate")) s.zipModerate++;
    else if (zt.includes("low") || zt.includes("not")) s.zipLow++;
    const zs = num(r.mx_Zip_Intent_Score);
    if (zs !== null) { s.zipScored++; s.zipScoreSum += zs; }
    const zq = num(r.mx_Zip_Quality_Score);
    if (zq !== null) { s.qualityScored++; s.qualitySum += zq; }
    const obj = typeof r.mx_Zip_Objection_Category === "string" ? r.mx_Zip_Objection_Category : "";
    if (obj && obj !== "NA") for (const x of obj.split(",")) { const k = x.trim(); if (k) s.objections[k] = (s.objections[k] ?? 0) + 1; }

    // Candidate for transcript review: connected, in pipeline/closed, or scored by Zipteams on this day.
    const interesting = CLOSE.includes(stage) || PIPE.includes(stage) || zs !== null;
    if (interesting) {
      const stageW = CLOSE.includes(stage) ? 30 : stage === "follow up for closure" ? 25 : PIPE.includes(stage) ? 15 : 5;
      const score = stageW + (zt.includes("high") ? 20 : zt.includes("moderate") ? 10 : 0) + (zs ?? 0) / 5 + (zq ?? 0) / 10;
      const phone = typeof r.Phone === "string" && r.Phone ? r.Phone : typeof r.Mobile === "string" ? r.Mobile : undefined;
      candidates.push({
        ownerId: id,
        owner: name,
        ProspectID: String(r.ProspectID),
        name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(),
        phone: phone ? normalisePhone(phone) : undefined,
        stage: String(r.ProspectStage ?? ""),
        zipIntent: String(r.mx_Zip_Intent_Type || r.mx_Zip_Intent || ""),
        zipScore: zs,
        zipQuality: zq,
        zipDisposition: String(r.mx_Zip_AI_Disposition ?? ""),
        objection: obj,
        justification: String(r.mx_Zip_Intent_Justification ?? "").slice(0, 400),
        talkingPoints: String(r.mx_Zip_Talking_Points ?? "").slice(0, 300),
        course: String(r.mx_Enquired_Course ?? ""),
        modifiedOn: String(r.ModifiedOn ?? ""),
        score: Math.round(score),
      });
    }
  }
  // Keep the strongest N candidates per owner.
  const perOwner = new Map<string, CandidateLead[]>();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    const list = perOwner.get(c.ownerId) ?? [];
    if (list.length < o.candidatesPerOwner) { list.push(c); perOwner.set(c.ownerId, list); }
  }
  return {
    day: o.day,
    windowUtc: { from: fromUtc, to: toUtc },
    scanned: scanned.length,
    inWindow: rows.length,
    owners: [...owners.values()].sort((a, b) => b.touched - a.touched),
    candidates: [...perOwner.values()].flat(),
    unresolved: ownerNames["_unresolvedEmails"] ?? null,
  };
}

/** Normalise Leads.RecentlyModified rows (either flat objects or LeadPropertyList arrays) to flat objects. */
function flattenLeads(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  const leads = (res as { Leads?: unknown[] })?.Leads;
  if (!Array.isArray(leads)) return [];
  return leads.map((l) => {
    const props = (l as { LeadPropertyList?: { Attribute: string; Value: unknown }[] }).LeadPropertyList;
    if (!Array.isArray(props)) return l as Record<string, unknown>;
    return Object.fromEntries(props.map((p) => [p.Attribute, p.Value]));
  });
}

/**
 * Whole-account calling day via Leads.RecentlyModified: pages through every lead modified in the IST day,
 * aggregates per owner, keeps the top candidates per owner. Stops at `budgetMs` and reports nextPage.
 */
export async function analyzeCallingDayAll(
  clients: Clients,
  o: { day: string; startPage: number; maxPages: number; pageSize: number; candidatesPerOwner: number; budgetMs: number; ownerFilter?: Set<string> },
) {
  const lsq = clients.leadsquared;
  if (!lsq) throw new Error("LeadSquared is not configured.");
  const { fromUtc, toUtc } = istDayToUtcWindow(o.day);
  const t0 = Date.now();
  const owners = new Map<string, OwnerDay>();
  const candidates: CandidateLead[] = [];
  let page = o.startPage;
  let fetched = 0;
  let nextPage: number | null = null;
  let recordCount: number | undefined;
  for (; page < o.startPage + o.maxPages; page++) {
    if (Date.now() - t0 > o.budgetMs) { nextPage = page; break; }
    const res = await lsq.leadsRecentlyModified({ FromDate: fromUtc, ToDate: toUtc, Columns: { Include_CSV: TEAM_LEAD_COLUMNS }, Paging: { PageIndex: page, PageSize: o.pageSize } });
    recordCount = (res as { RecordCount?: number })?.RecordCount ?? recordCount;
    const rows = flattenLeads(res);
    if (rows.length === 0) break;
    fetched += rows.length;
    for (const r of rows) {
      const id = String(r.OwnerId ?? "");
      if (o.ownerFilter && !o.ownerFilter.has(id)) continue;
      tally(owners, candidates, r, id, fromUtc, toUtc);
    }
    if (rows.length < o.pageSize) break;
  }
  if (nextPage === null && page >= o.startPage + o.maxPages) nextPage = page;
  const perOwner = new Map<string, CandidateLead[]>();
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    const list = perOwner.get(c.ownerId) ?? [];
    if (list.length < o.candidatesPerOwner) { list.push(c); perOwner.set(c.ownerId, list); }
  }
  return { day: o.day, windowUtc: { from: fromUtc, to: toUtc }, pagesFrom: o.startPage, pagesDone: page - o.startPage, fetched, recordCount, nextPage, elapsedMs: Date.now() - t0, owners: [...owners.values()].sort((a, b) => b.touched - a.touched), candidates: [...perOwner.values()].flat() };
}

function tally(owners: Map<string, OwnerDay>, candidates: CandidateLead[], r: Record<string, unknown>, id: string, fromUtc: string, toUtc: string) {
  const name = typeof r.OwnerIdName === "string" ? r.OwnerIdName : id;
  let s = owners.get(id);
  if (!s) {
    s = { ownerId: id, owner: name, touched: 0, newLeads: 0, callDone: 0, notConnected: 0, pipeline: 0, closure: 0, enrolled: 0, dead: 0, zipHigh: 0, zipModerate: 0, zipLow: 0, zipScored: 0, zipScoreSum: 0, qualityScored: 0, qualitySum: 0, objections: {}, stages: {} };
    owners.set(id, s);
  }
  const stage = lower(r.ProspectStage);
  s.touched++;
  s.stages[stage || "(blank)"] = (s.stages[stage || "(blank)"] ?? 0) + 1;
  if (typeof r.CreatedOn === "string" && r.CreatedOn >= fromUtc && r.CreatedOn < toUtc) s.newLeads++;
  if (lower(r.mx_Call_Connected_Status) === "call done") s.callDone++;
  if (stage === "call not picking up" || stage === "call not connected") s.notConnected++;
  if (PIPE.includes(stage)) s.pipeline++;
  if (stage === "follow up for closure") s.closure++;
  if (CLOSE.includes(stage)) s.enrolled++;
  if (DEAD.includes(stage)) s.dead++;
  const zt = `${lower(r.mx_Zip_Intent_Type)} ${lower(r.mx_Zip_Intent)}`;
  if (zt.includes("high")) s.zipHigh++;
  else if (zt.includes("moderate")) s.zipModerate++;
  else if (zt.includes("low") || zt.includes("not")) s.zipLow++;
  const zs = num(r.mx_Zip_Intent_Score);
  if (zs !== null) { s.zipScored++; s.zipScoreSum += zs; }
  const zq = num(r.mx_Zip_Quality_Score);
  if (zq !== null) { s.qualityScored++; s.qualitySum += zq; }
  const obj = typeof r.mx_Zip_Objection_Category === "string" ? r.mx_Zip_Objection_Category : "";
  if (obj && obj !== "NA") for (const x of obj.split(",")) { const k = x.trim(); if (k) s.objections[k] = (s.objections[k] ?? 0) + 1; }
  if (CLOSE.includes(stage) || PIPE.includes(stage) || zs !== null) {
    const stageW = CLOSE.includes(stage) ? 30 : stage === "follow up for closure" ? 25 : PIPE.includes(stage) ? 15 : 5;
    const score = stageW + (zt.includes("high") ? 20 : zt.includes("moderate") ? 10 : 0) + (zs ?? 0) / 5 + (zq ?? 0) / 10;
    const phone = typeof r.Phone === "string" && r.Phone ? r.Phone : typeof r.Mobile === "string" ? r.Mobile : undefined;
    candidates.push({ ownerId: id, owner: name, ProspectID: String(r.ProspectID), name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(), phone: phone ? normalisePhone(phone) : undefined, stage: String(r.ProspectStage ?? ""), zipIntent: String(r.mx_Zip_Intent_Type || r.mx_Zip_Intent || ""), zipScore: zs, zipQuality: zq, zipDisposition: String(r.mx_Zip_AI_Disposition ?? ""), objection: obj, justification: String(r.mx_Zip_Intent_Justification ?? "").slice(0, 400), talkingPoints: String(r.mx_Zip_Talking_Points ?? "").slice(0, 300), course: String(r.mx_Enquired_Course ?? ""), modifiedOn: String(r.ModifiedOn ?? ""), score: Math.round(score) });
  }
}

/** Activities in a UTC window, aggregated by creator and activity type, with a raw sample for shape discovery. */
export async function activitiesOnDay(
  clients: Clients,
  o: { day: string; activityEvent?: number; startPage: number; maxPages: number; pageSize: number; budgetMs: number; sample: number },
) {
  const lsq = clients.leadsquared;
  if (!lsq) throw new Error("LeadSquared is not configured.");
  const { fromUtc, toUtc } = istDayToUtcWindow(o.day);
  const t0 = Date.now();
  const byCreator = new Map<string, { name: string; total: number; byType: Record<string, number>; durationSec: number; durationCount: number }>();
  const byType: Record<string, number> = {};
  const sample: unknown[] = [];
  let page = o.startPage;
  let fetched = 0;
  let nextPage: number | null = null;
  let raw: unknown = null;
  let keys: string[] = [];
  for (; page < o.startPage + o.maxPages; page++) {
    if (Date.now() - t0 > o.budgetMs) { nextPage = page; break; }
    const res = await lsq.activitiesRecentlyModified({ FromDate: fromUtc, ToDate: toUtc, ActivityEvent: o.activityEvent, Paging: { PageIndex: page, PageSize: o.pageSize } });
    if (page === o.startPage && !Array.isArray(res)) raw = JSON.stringify(res).slice(0, 1500);
    const list: Record<string, unknown>[] = Array.isArray(res) ? (res as Record<string, unknown>[]) : (Object.values(res as Record<string, unknown>).find(Array.isArray) as Record<string, unknown>[] | undefined) ?? [];
    if (list.length === 0) break;
    if (!keys.length && list[0]) keys = Object.keys(list[0]);
    fetched += list.length;
    for (const a of list) {
      if (sample.length < o.sample) sample.push(a);
      const type = String(a.ActivityEventName ?? a.ActivityType ?? a.EventName ?? a.ActivityEvent ?? "?");
      byType[type] = (byType[type] ?? 0) + 1;
      const cid = String(a.CreatedBy ?? a.OwnerId ?? a.Owner ?? a.CreatedByEmail ?? "?");
      const cname = String(a.CreatedByName ?? a.OwnerName ?? a.CreatedByEmail ?? cid);
      let c = byCreator.get(cid);
      if (!c) { c = { name: cname, total: 0, byType: {}, durationSec: 0, durationCount: 0 }; byCreator.set(cid, c); }
      c.total++;
      c.byType[type] = (c.byType[type] ?? 0) + 1;
      const dur = num(a.CallDuration ?? a.Duration ?? a.mx_Custom_1 ?? a.ActivityDuration);
      if (dur !== null) { c.durationSec += dur; c.durationCount++; }
    }
    if (list.length < o.pageSize) break;
  }
  if (nextPage === null && page >= o.startPage + o.maxPages) nextPage = page;
  return { day: o.day, windowUtc: { from: fromUtc, to: toUtc }, pagesFrom: o.startPage, pagesDone: page - o.startPage, fetched, nextPage, elapsedMs: Date.now() - t0, responseShape: raw, keys, byType, byCreator: Object.fromEntries([...byCreator.entries()].sort((a, b) => b[1].total - a[1].total)), sample };
}

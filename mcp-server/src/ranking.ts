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

/** Weights for this account's ProspectStage values (0-30 = closer to paying). */
const DEFAULT_STAGE_WEIGHTS: Record<string, number> = {
  "booking fees received": 30,
  "loan pending": 28,
  "follow up for closure": 25,
  "counselled lead": 20,
  "roadmap done": 20,
  "discovery call done": 15,
  "opportunity created": 15,
  "re-enquired lead": 10,
  "may buy later": 10,
  "call back later": 8,
  "new lead": 5,
  "roadmap dnp": 3,
  "call not picking up": 2,
  "call not connected": 2,
};
/** Salesa rejects large number lists; keep batches small. */
const SALESA_BATCH = 5;
const DEFAULT_EXCLUDE = ["course enrolled", "collections done", "not interested", "invalid", "irrelevant lead", "support query"];
const LEAD_CATEGORY_W: Record<string, number> = { hot: 10, warm: 5, cold: -5 };

const lower = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\u00a0/g, " ").trim().toLowerCase() : "";
/** Either field may carry HIGH/MODERATE/LOW/NEUTRAL/NOT_QUALIFIED or INTERESTED/NOT_INTERESTED wording. */
const zipTypeWeight = (type: string, intent: string): number => {
  const t = `${type} ${intent}`;
  if (t.includes("not_qualified") || t.includes("not qualified")) return -15;
  if (t.includes("not interested") || t.includes("not_interested")) return -10;
  if (t.includes("high") || t.includes("hot")) return 20;
  if (t.includes("moderate") || t.includes("interested")) return 10;
  if (t.includes("low")) return -5;
  return 0;
};
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

  const { scanned, resolvedOwnerIds, ownerNames } = await scanTeamLeads(clients, {
    ownerEmails: [...ownerEmails],
    ownerIds: [...ownerIds],
    teamField: o.teamField,
    cutoffLocal,
    scanLimit: o.scanLimit,
  });
  // 2. Team / owner / stage filter and the cheap part of the score.
  const prelim = scanned
    .filter((r) => {
      if (resolvedOwnerIds.size) {
        const em = lower(r.OwnerIdEmailAddress);
        const id = typeof r.OwnerId === "string" ? r.OwnerId : "";
        if (!(ownerEmails.has(em) || resolvedOwnerIds.has(id))) return false;
      }
      if (o.teamField && lower(r[o.teamField.field]) !== lower(o.teamField.value)) return false;
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
      // Zipteams results already synced into LeadSquared by the existing connector.
      // mx_Zip_Intent_Type (HIGH/MODERATE/...) when set, else mx_Zip_Intent (INTERESTED/NOT_INTERESTED/...).
      const zipType = lower(r.mx_Zip_Intent_Type);
      const zipIntent = lower(r.mx_Zip_Intent);
      const zipTypeW = zipTypeWeight(zipType, zipIntent);
      const zipScore = num(r.mx_Zip_Intent_Score);
      const zipScoreW = zipScore === undefined ? 0 : Math.round((Math.max(0, Math.min(100, zipScore)) / 100) * 15);
      const catW = LEAD_CATEGORY_W[lower(r.mx_Lead_category)] ?? 0;
      const callDoneW = lower(r.mx_Call_Connected_Status) === "call done" ? 5 : 0;
      const lead: RankedLead = {
        ProspectID: String(r.ProspectID),
        name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(),
        email: typeof r.EmailAddress === "string" ? r.EmailAddress : undefined,
        phone: typeof r.Phone === "string" && r.Phone ? r.Phone : typeof r.Mobile === "string" ? r.Mobile : undefined,
        stage: typeof r.ProspectStage === "string" ? r.ProspectStage : undefined,
        owner: typeof r.OwnerIdName === "string" ? r.OwnerIdName : ownerNames[String(r.OwnerId)],
        ownerEmail: typeof r.OwnerIdEmailAddress === "string" ? r.OwnerIdEmailAddress : undefined,
        leadScore,
        modifiedOn: typeof r.ModifiedOn === "string" ? r.ModifiedOn : undefined,
        score: stageW + leadScoreW + recencyW + zipTypeW + zipScoreW + catW + callDoneW,
        signals: {
          stage: stageW,
          leadScore: leadScoreW,
          recency: recencyW,
          daysSinceActivity: Math.round(daysSince * 10) / 10,
          zipIntentType: typeof r.mx_Zip_Intent_Type === "string" && r.mx_Zip_Intent_Type ? r.mx_Zip_Intent_Type : typeof r.mx_Zip_Intent === "string" ? r.mx_Zip_Intent : "",
          zipIntentTypeW: zipTypeW,
          zipIntentScore: zipScore ?? "",
          zipIntentScoreW: zipScoreW,
          zipAiDisposition: typeof r.mx_Zip_AI_Disposition === "string" ? r.mx_Zip_AI_Disposition : "",
          zipObjection: typeof r.mx_Zip_Objection_Category === "string" ? r.mx_Zip_Objection_Category : "",
          leadCategory: typeof r.mx_Lead_category === "string" ? r.mx_Lead_category : "",
          leadCategoryW: catW,
          callConnected: typeof r.mx_Call_Connected_Status === "string" ? r.mx_Call_Connected_Status : "",
          callDoneW,
          course: typeof r.mx_Enquired_Course === "string" ? r.mx_Enquired_Course : "",
        },
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
      for (let i = 0; i < phones.length; i += SALESA_BATCH) {
        const chunk = phones.slice(i, i + SALESA_BATCH);
        const { phones: counts } = await clients.salesa.searchByNumbers(chunk, "answered", { maxCalls: 0 });
        for (const [p, n] of Object.entries(counts)) salesaByPhone[normalisePhone(p)] = n;
      }
      salesaNote = `queried ${phones.length} numbers`;
    } catch (e) {
      salesaNote = `error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  }

  const enrich = async (l: RankedLead) => {
      const zt = await clients.store.getCustomerSummary({ phone: l.phone, email: l.email, customerId: l.ProspectID }).catch(() => null);
      if (zt && !l.signals.zipIntentType) {
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
  };
  for (let i = 0; i < prelim.length; i += 4) await Promise.all(prelim.slice(i, i + 4).map(enrich));

  prelim.sort((a, b) => b.score - a.score);
  return {
    window: { days: o.days, modifiedOnOrAfter: cutoffLocal },
    scanned: scanned.length,
    afterFilters: prelim.length,
    filters: { ownerEmails: [...ownerEmails], ownerIds: [...ownerIds], teamField: o.teamField ?? null, excludedStages: [...exclude] },
    salesa: salesaNote,
    owners: ownerNames,
    scoring:
      "stage(0-30) + leadScore(0-15) + recency(0-10) + zipIntentType(-15..20, from LeadSquared mx_Zip_Intent_Type) + zipIntentScore(0-15) + leadCategory(-5..10) + callDone(0-5) + activities(0-10) + salesaAnsweredCalls(0-15); Zipteams webhook intent only used when LeadSquared has no Zip fields",
    leads: prelim,
  };
}

export const TEAM_LEAD_COLUMNS =
  "ProspectID,FirstName,LastName,EmailAddress,Phone,Mobile,ProspectStage,Score,OwnerId,OwnerIdName,OwnerIdEmailAddress,ModifiedOn,CreatedOn,Source,LastActivity,LastActivityDate,mx_Zip_Intent,mx_Zip_Intent_Type,mx_Zip_Intent_Score,mx_Zip_AI_Disposition,mx_Zip_Objection_Category,mx_Zip_Quality_Score,mx_Zip_Intent_Justification,mx_Zip_Talking_Points,mx_Lead_category,mx_Call_Connected_Status,mx_Enquired_Course";

/**
 * Leads modified at/after `cutoffLocal` for a set of owners (one LeadSquared query per owner,
 * newest first, stopping at the cutoff) or for a team field value. Shared by ranking and summaries.
 */
export async function scanTeamLeads(
  clients: Clients,
  o: { ownerEmails?: string[]; ownerIds?: string[]; teamField?: { field: string; value: string }; cutoffLocal: string; scanLimit: number },
) {
  const lsq = clients.leadsquared;
  if (!lsq) throw new Error("LeadSquared is not configured.");
  const ownerEmails = new Set((o.ownerEmails ?? []).map((e) => e.toLowerCase()));
  const columns = TEAM_LEAD_COLUMNS + (o.teamField ? `,${o.teamField.field}` : "");
  const resolvedOwnerIds = new Set(o.ownerIds ?? []);
  const ownerNames: Record<string, string> = {};
  if (ownerEmails.size) {
    const users = (await lsq.listUsers()) as Record<string, unknown>[];
    const found = new Set<string>();
    for (const u of users) {
      const em = lower(u.EmailAddress);
      if (ownerEmails.has(em) && typeof u.ID === "string") {
        resolvedOwnerIds.add(u.ID);
        ownerNames[u.ID] = `${u.FirstName ?? ""} ${u.LastName ?? ""}`.trim();
        found.add(em);
      }
    }
    const missing = [...ownerEmails].filter((e) => !found.has(e));
    if (missing.length) ownerNames["_unresolvedEmails"] = missing.join(", ");
  }
  const scanned: Record<string, unknown>[] = [];
  const pageSize = 100;
  const scanOne = async (param?: { LookupName: string; LookupValue: string; SqlOperator: string }) => {
    for (let page = 1; scanned.length < o.scanLimit; page++) {
      const rows = (await lsq.searchLeads({
        Parameter: param,
        Columns: { Include_CSV: columns },
        Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
        Paging: { PageIndex: page, PageSize: pageSize },
      })) as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      let stop = false;
      for (const r of rows) {
        if (typeof r.ModifiedOn === "string" && r.ModifiedOn < o.cutoffLocal) {
          stop = true;
          break;
        }
        scanned.push(r);
      }
      if (stop || rows.length < pageSize) break;
    }
  };
  if (resolvedOwnerIds.size) {
    for (const id of resolvedOwnerIds) await scanOne({ LookupName: "OwnerId", LookupValue: id, SqlOperator: "=" });
  } else {
    await scanOne(o.teamField ? { LookupName: o.teamField.field, LookupValue: o.teamField.value, SqlOperator: "=" } : undefined);
  }
  return { scanned, resolvedOwnerIds, ownerNames };
}

export const lowerText = lower;
export const zipWeight = zipTypeWeight;

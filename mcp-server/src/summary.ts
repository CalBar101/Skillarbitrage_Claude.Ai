/**
 * Team daily summary: what a sales group's book did in a window, from LeadSquared fields
 * (including the Zipteams intent the existing connector writes back) plus a stage-change
 * check on the closed/paid leads so "enrolled today" is not confused with "edited today".
 */
import type { Clients } from "./server.js";
import { scanTeamLeads, lowerText as lower, zipWeight } from "./ranking.js";

const CLOSE_STAGES = ["course enrolled", "booking fees received", "collections done", "loan pending"];
const PIPELINE_STAGES = ["follow up for closure", "counselled lead", "roadmap done", "discovery call done", "opportunity created"];
const DEAD_STAGES = ["not interested", "invalid", "irrelevant lead"];

interface OwnerStats {
  owner: string;
  touched: number;
  newLeads: number;
  stages: Record<string, number>;
  closed: number;
  pipeline: number;
  dead: number;
  zipHigh: number;
  zipLow: number;
  callDone: number;
}

const blank = (owner: string): OwnerStats => ({ owner, touched: 0, newLeads: 0, stages: {}, closed: 0, pipeline: 0, dead: 0, zipHigh: 0, zipLow: 0, callDone: 0 });

export async function teamDailySummary(
  clients: Clients,
  o: { ownerEmails?: string[]; ownerIds?: string[]; teamField?: { field: string; value: string }; hours: number; scanLimit: number; tzOffsetMinutes: number; asOf?: Date },
) {
  const lsq = clients.leadsquared;
  if (!lsq) throw new Error("LeadSquared is not configured.");
  const asOf = o.asOf ?? new Date();
  const local = (d: Date) => new Date(d.getTime() + o.tzOffsetMinutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const cutoffLocal = local(new Date(asOf.getTime() - o.hours * 3600_000));
  const asOfLocal = local(asOf);
  const { scanned, ownerNames } = await scanTeamLeads(clients, { ownerEmails: o.ownerEmails, ownerIds: o.ownerIds, teamField: o.teamField, cutoffLocal, scanLimit: o.scanLimit });
  const rows = scanned.filter((r) => typeof r.ModifiedOn !== "string" || r.ModifiedOn <= asOfLocal);

  const perOwner = new Map<string, OwnerStats>();
  const team = blank("TEAM");
  const closedLeads: Record<string, unknown>[] = [];
  const hot: { name: string; owner: string; stage: string; zipIntent: string; zipScore: unknown; objection: string; course: string; score: number; modifiedOn: string }[] = [];
  for (const r of rows) {
    const ownerKey = typeof r.OwnerIdName === "string" ? r.OwnerIdName : ownerNames[String(r.OwnerId)] ?? String(r.OwnerId);
    const st = perOwner.get(ownerKey) ?? blank(ownerKey);
    perOwner.set(ownerKey, st);
    const stage = lower(r.ProspectStage);
    for (const s of [st, team]) {
      s.touched++;
      s.stages[stage || "(blank)"] = (s.stages[stage || "(blank)"] ?? 0) + 1;
      if (typeof r.CreatedOn === "string" && r.CreatedOn >= cutoffLocal) s.newLeads++;
      if (CLOSE_STAGES.includes(stage)) s.closed++;
      if (PIPELINE_STAGES.includes(stage)) s.pipeline++;
      if (DEAD_STAGES.includes(stage)) s.dead++;
      const zt = `${lower(r.mx_Zip_Intent_Type)} ${lower(r.mx_Zip_Intent)}`;
      if (zt.includes("high")) s.zipHigh++;
      if (zt.includes("low") || zt.includes("not")) s.zipLow++;
      if (lower(r.mx_Call_Connected_Status) === "call done") s.callDone++;
    }
    if (CLOSE_STAGES.includes(stage)) closedLeads.push(r);
    if (PIPELINE_STAGES.includes(stage)) {
      const zipScore = Number(r.mx_Zip_Intent_Score);
      const score = (stage === "follow up for closure" ? 25 : 15) + zipWeight(lower(r.mx_Zip_Intent_Type), lower(r.mx_Zip_Intent)) + (Number.isFinite(zipScore) ? Math.round(zipScore / 100 * 15) : 0) + (lower(r.mx_Lead_category) === "hot" ? 10 : 0);
      hot.push({
        name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(),
        owner: ownerKey,
        stage: String(r.ProspectStage ?? ""),
        zipIntent: String(r.mx_Zip_Intent_Type || r.mx_Zip_Intent || ""),
        zipScore: r.mx_Zip_Intent_Score ?? "",
        objection: String(r.mx_Zip_Objection_Category ?? ""),
        course: String(r.mx_Enquired_Course ?? ""),
        score,
        modifiedOn: String(r.ModifiedOn ?? ""),
      });
    }
  }

  // Which of the closed-stage leads actually changed stage inside the window? (capped to respect the rate limit)
  const closedChecked: { name: string; owner: string; stage: string; course: string; stageChangedInWindow: boolean | "unknown"; changedAt?: string }[] = [];
  for (const r of closedLeads.slice(0, 20)) {
    let changed: boolean | "unknown" = "unknown";
    let changedAt: string | undefined;
    try {
      const acts = await lsq.getLeadActivities(String(r.ProspectID), { pageSize: 25 });
      const list = (acts?.ProspectActivities ?? []) as Record<string, unknown>[];
      for (const a of list) {
        const text = JSON.stringify(a).toLowerCase();
        const when = typeof a.ActivityDateTime === "string" ? a.ActivityDateTime : typeof a.CreatedOn === "string" ? a.CreatedOn : "";
        if (text.includes("stage") && text.includes(lower(r.ProspectStage)) && when >= cutoffLocal && when <= asOfLocal) {
          changed = true;
          changedAt = when;
          break;
        }
      }
      if (changed === "unknown") changed = false;
    } catch {
      changed = "unknown";
    }
    closedChecked.push({
      name: `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim(),
      owner: typeof r.OwnerIdName === "string" ? r.OwnerIdName : String(r.OwnerId),
      stage: String(r.ProspectStage ?? ""),
      course: String(r.mx_Enquired_Course ?? ""),
      stageChangedInWindow: changed,
      changedAt,
    });
  }

  hot.sort((a, b) => b.score - a.score);
  return {
    window: { from: cutoffLocal, to: asOfLocal, hours: o.hours, timezoneOffsetMinutes: o.tzOffsetMinutes },
    owners: ownerNames,
    team: { ...team, stages: sortStages(team.stages) },
    perOwner: [...perOwner.values()].sort((a, b) => b.touched - a.touched).map((s) => ({ ...s, stages: sortStages(s.stages) })),
    closedStageLeads: closedChecked,
    closedStageLeadsNotChecked: Math.max(0, closedLeads.length - 20),
    hottestPipeline: hot.slice(0, 10),
    notes: [
      "touched = leads modified in the window by anyone or any automation, not only by the owner",
      "closed/pipeline/dead count the lead's CURRENT stage; see closedStageLeads.stageChangedInWindow for real conversions in the window",
      "zipHigh/zipLow come from Zipteams intent fields synced into LeadSquared",
    ],
  };
}

function sortStages(s: Record<string, number>) {
  return Object.fromEntries(Object.entries(s).sort((a, b) => b[1] - a[1]));
}

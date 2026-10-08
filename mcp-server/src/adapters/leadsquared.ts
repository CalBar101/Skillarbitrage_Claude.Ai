/**
 * LeadSquared v2 REST API client.
 * Auth: accessKey + secretKey as query params on every call.
 * Docs: https://apidocs.leadsquared.com/
 * Hosts differ by region: api.leadsquared.com, api-in21.leadsquared.com, api-us11.leadsquared.com.
 */
import { requestJson, type FetchLike } from "../http.js";

export interface LeadSquaredConfig {
  host: string;
  accessKey: string;
  secretKey: string;
  fetch?: FetchLike;
}

/** LeadSquared represents a lead as an array of { Attribute, Value } pairs. */
export type LsqAttribute = { Attribute: string; Value: string | number | boolean | null };
export type LsqLead = Record<string, unknown>;

/** LeadSquared allows 30 calls per 5 s per account. Space calls ~220 ms apart and retry once on 429. */
class Throttle {
  private next = 0;
  constructor(private readonly gapMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export class LeadSquaredClient {
  private readonly fetchImpl: FetchLike;
  private readonly throttle = new Throttle(220);
  constructor(private readonly cfg: LeadSquaredConfig) {
    const base = cfg.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
    this.fetchImpl = async (u, i) => {
      await this.throttle.wait();
      let res = await base(u, i);
      // The 30-per-5s quota is shared with every other integration on the account, so back off generously.
      for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 5500 + attempt * 2000));
        await this.throttle.wait();
        res = await base(u, i);
      }
      return res;
    };
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`https://${this.cfg.host}/v2/${path}`);
    u.searchParams.set("accessKey", this.cfg.accessKey);
    u.searchParams.set("secretKey", this.cfg.secretKey);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return requestJson<T>("LeadSquared", this.fetchImpl, this.url(path, params));
  }

  private post<T>(path: string, body: unknown, params?: Record<string, string | number | undefined>) {
    return requestJson<T>("LeadSquared", this.fetchImpl, this.url(path, params), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ---- Leads ----
  getLeadById(leadId: string) {
    return this.get<LsqLead[]>("LeadManagement.svc/Leads.GetById", { id: leadId });
  }
  getLeadByEmail(email: string) {
    return this.get<LsqLead[]>("LeadManagement.svc/Leads.GetByEmailaddress", { emailaddress: email });
  }
  getLeadByPhone(phone: string) {
    return this.get<LsqLead[]>("LeadManagement.svc/RetrieveLeadByPhoneNumber", { phone });
  }
  quickSearch(key: string) {
    return this.get<LsqLead[]>("LeadManagement.svc/Leads.GetByQuickSearch", { key });
  }
  /** Advanced search. `criteria` uses LeadSquared's SearchParameters syntax, e.g. { LookupName: "ProspectStage", LookupValue: "Prospect" } or a raw `Parameter`. */
  searchLeads(body: {
    Parameter?: { LookupName?: string; LookupValue?: string; SqlOperator?: string; FromDate?: string; ToDate?: string };
    Columns?: { Include_CSV?: string };
    Sorting?: { ColumnName: string; Direction: "0" | "1" };
    Paging?: { PageIndex: number; PageSize: number };
  }) {
    return this.post<LsqLead[]>("LeadManagement.svc/Leads.Get", body);
  }
  createLead(attributes: LsqAttribute[]) {
    return this.post<{ Status: string; Message: { Id: string } }>("LeadManagement.svc/Lead.Create", attributes);
  }
  updateLead(leadId: string, attributes: LsqAttribute[]) {
    return this.post<{ Status: string; Message: { AffectedRows: number } }>(
      "LeadManagement.svc/Lead.Update",
      attributes,
      { leadId },
    );
  }
  /** Upsert keyed on the chosen attribute (email by default). */
  createOrUpdateLead(attributes: LsqAttribute[], searchBy: "EmailAddress" | "Phone" | "ProspectID" = "EmailAddress") {
    return this.post<{ Status: string; Message: { Id: string; IsCreated: boolean } }>(
      "LeadManagement.svc/Lead.CreateOrUpdate",
      attributes,
      { postUpdatedLead: "true", searchBy },
    );
  }
  /** Leads modified in a UTC window ("yyyy-MM-dd HH:mm:ss"), up to 5000 per page. */
  leadsRecentlyModified(body: { FromDate: string; ToDate: string; Columns?: { Include_CSV?: string }; Paging?: { PageIndex: number; PageSize: number } }) {
    return this.post<{ RecordCount?: number; Leads?: { LeadPropertyList: { Attribute: string; Value: unknown }[] }[] } | LsqLead[]>(
      "LeadManagement.svc/Leads.RecentlyModified",
      { Parameter: { FromDate: body.FromDate, ToDate: body.ToDate }, Columns: body.Columns, Paging: body.Paging },
    );
  }
  /** Activities created/modified in a UTC window. */
  activitiesRecentlyModified(body: { FromDate: string; ToDate: string; ActivityEvent?: number; Paging?: { PageIndex: number; PageSize: number } }) {
    return this.post<unknown>("ProspectActivity.svc/RetrieveRecentlyModified", {
      Parameter: { FromDate: body.FromDate, ToDate: body.ToDate, ActivityEvent: body.ActivityEvent },
      Paging: body.Paging,
    });
  }
  getLeadFields() {
    return this.get<unknown[]>("LeadManagement.svc/LeadsMetaData.Get");
  }

  // ---- Activities ----
  getActivityTypes() {
    return this.get<unknown[]>("ProspectActivity.svc/ActivityTypes.Get");
  }
  getLeadActivities(leadId: string, opts: { activityEvent?: number; pageIndex?: number; pageSize?: number } = {}) {
    return this.post<{ RecordCount: number; ProspectActivities: unknown[] }>(
      "ProspectActivity.svc/Retrieve",
      {
        Parameter: opts.activityEvent !== undefined ? { ActivityEvent: opts.activityEvent } : {},
        Paging: { Offset: opts.pageIndex ?? 0, RowCount: opts.pageSize ?? 25 },
      },
      { leadId },
    );
  }
  createActivity(input: {
    leadId: string;
    activityEvent: number;
    note?: string;
    dateTime?: string; // "yyyy-MM-dd HH:mm:ss" in account timezone
    fields?: { SchemaName: string; Value: string }[];
  }) {
    return this.post<{ Status: string; Message: { Id: string } }>("ProspectActivity.svc/Create", {
      RelatedProspectId: input.leadId,
      ActivityEvent: input.activityEvent,
      ActivityNote: input.note,
      ActivityDateTime: input.dateTime,
      Fields: input.fields,
    });
  }

  // ---- Tasks ----
  listTasks(body: {
    Parameter?: { LookupName?: string; LookupValue?: string; SqlOperator?: string; FromDate?: string; ToDate?: string };
    Paging?: { PageIndex: number; PageSize: number };
  }) {
    return this.post<unknown[]>("Task.svc/Retrieve", body);
  }
  createTask(input: {
    name: string;
    description?: string;
    ownerUserId?: string;
    leadId: string;
    dueDate: string; // "yyyy-MM-dd HH:mm:ss"
    taskTypeName?: string;
  }) {
    return this.post<{ Status: string; Message: { Id: string } }>("Task.svc/Create", {
      Name: input.name,
      Description: input.description,
      OwnerUserId: input.ownerUserId,
      RelatedEntity: 1, // 1 = Lead
      RelatedEntityId: input.leadId,
      DueDate: input.dueDate,
      TaskType: input.taskTypeName ? { Name: input.taskTypeName } : undefined,
    });
  }
  completeTask(taskId: string) {
    return this.post<{ Status: string }>("Task.svc/MarkAsComplete", {}, { taskId });
  }

  // ---- Users ----
  listUsers() {
    return this.get<unknown[]>("UserManagement.svc/Users.Get");
  }
}

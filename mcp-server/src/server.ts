import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LeadSquaredClient, type LsqAttribute } from "./adapters/leadsquared.js";
import { SalesaClient } from "./adapters/salesa.js";
import { ZipteamsClient } from "./adapters/zipteams.js";
import { KVInsightsStore, MemoryKV, type InsightsStore, type KVLike } from "./store.js";
import { runSelfTest } from "./selftest.js";
import { rankLeads } from "./ranking.js";
import { ApiError, redactUrl } from "./http.js";
import type { FetchLike } from "./http.js";

export interface Env {
  MCP_AUTH_TOKEN: string;
  LEADSQUARED_HOST: string;
  LEADSQUARED_ACCESS_KEY?: string;
  LEADSQUARED_SECRET_KEY?: string;
  ZIPTEAMS_API_KEY?: string;
  /** Partner API only. When all three are set with the key, Partner endpoints are used. */
  ZIPTEAMS_API_SECRET?: string;
  ZIPTEAMS_TENANT_ID?: string;
  ZIPTEAMS_SUB_TENANT_ID?: string;
  /** Secret path segment Zipteams must use when calling our webhook. */
  ZIPTEAMS_WEBHOOK_SECRET?: string;
  /** Public URL of this Worker, used to build callback URLs. */
  PUBLIC_BASE_URL?: string;
  SALESA_BASE_URL?: string;
  SALESA_API_KEY?: string;
  /** Offset for "today" in rundowns, minutes east of UTC. Default 330 (IST). */
  RUNDOWN_TZ_OFFSET_MINUTES?: string;
  /** Phone the scheduled self-test looks up. */
  SELFTEST_SAMPLE_PHONE?: string;
  INSIGHTS?: KVLike;
}

export interface Clients {
  leadsquared?: LeadSquaredClient;
  zipteams: ZipteamsClient;
  salesa: SalesaClient;
  store: InsightsStore;
  zipteamsCallbackUrl?: string;
  tzOffsetMinutes: number;
  /** Only used by the self-test key probe. */
  zipteamsApiKey?: string;
}

export function buildClients(env: Env, fetchImpl?: FetchLike): Clients {
  return {
    leadsquared:
      env.LEADSQUARED_ACCESS_KEY && env.LEADSQUARED_SECRET_KEY
        ? new LeadSquaredClient({
            host: env.LEADSQUARED_HOST || "api.leadsquared.com",
            accessKey: env.LEADSQUARED_ACCESS_KEY,
            secretKey: env.LEADSQUARED_SECRET_KEY,
            fetch: fetchImpl,
          })
        : undefined,
    zipteams: new ZipteamsClient({
      apiKey: env.ZIPTEAMS_API_KEY,
      apiSecret: env.ZIPTEAMS_API_SECRET,
      tenantId: env.ZIPTEAMS_TENANT_ID,
      subTenantId: env.ZIPTEAMS_SUB_TENANT_ID,
      fetch: fetchImpl,
    }),
    salesa: new SalesaClient({ baseUrl: env.SALESA_BASE_URL, apiKey: env.SALESA_API_KEY, fetch: fetchImpl }),
    store: new KVInsightsStore(env.INSIGHTS ?? new MemoryKV()),
    zipteamsCallbackUrl:
      env.PUBLIC_BASE_URL && env.ZIPTEAMS_WEBHOOK_SECRET
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/zipteams/${env.ZIPTEAMS_WEBHOOK_SECRET}`
        : undefined,
    tzOffsetMinutes: Number(env.RUNDOWN_TZ_OFFSET_MINUTES ?? 330),
    zipteamsApiKey: env.ZIPTEAMS_API_KEY,
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: redactUrl(msg) }], isError: true };
}

/** Wrap a tool body so API failures become readable tool errors instead of protocol errors. */
const guard =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

const attributeSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe('Lead fields keyed by LeadSquared schema name, e.g. {"FirstName":"Asha","EmailAddress":"a@x.com","Phone":"+91..."}');

function toAttributes(fields: Record<string, string | number | boolean | null>): LsqAttribute[] {
  return Object.entries(fields).map(([Attribute, Value]) => ({ Attribute, Value }));
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createServer(clients: Clients): McpServer {
  const server = new McpServer({ name: "skillarbitrage-sales", version: "0.1.0" });

  // ---------------- Status ----------------
  server.registerTool(
    "connections_status",
    {
      title: "Connection status",
      description: "Report which of LeadSquared, Zipteams and Salesa are configured on this server.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => ({
      leadsquared: clients.leadsquared ? "configured" : "missing LEADSQUARED_ACCESS_KEY / LEADSQUARED_SECRET_KEY",
      zipteams: clients.zipteams.configured ? `configured (${clients.zipteams.mode} API)` : "missing ZIPTEAMS_API_KEY",
      zipteamsCallbackUrl: clients.zipteamsCallbackUrl ?? "not set (PUBLIC_BASE_URL / ZIPTEAMS_WEBHOOK_SECRET)",
      salesa: clients.salesa.configured ? "configured" : "missing SALESA_API_KEY",
    })),
  );

  server.registerTool(
    "connections_selftest",
    {
      title: "End-to-end connection self-test",
      description: "Read-only checks against LeadSquared (users, activity types, recent leads, tasks), Salesa (transcripts for a sample phone) and the Zipteams key. Creates nothing.",
      inputSchema: { samplePhone: z.string().optional().describe("A phone number known to LeadSquared and Salesa") },
      annotations: READ,
    },
    guard(async ({ samplePhone }) => runSelfTest(clients, { samplePhone, zipteamsApiKey: clients.zipteamsApiKey })),
  );

  // ---------------- LeadSquared ----------------
  const lsq = () => {
    if (!clients.leadsquared) throw new Error("LeadSquared is not configured on this server.");
    return clients.leadsquared;
  };

  server.registerTool(
    "leadsquared_find_lead",
    {
      title: "Find LeadSquared lead",
      description:
        "Look up a lead by id, email, phone, or free-text quick search (name, email, phone, company). Returns matching leads with all fields.",
      inputSchema: {
        leadId: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        query: z.string().optional().describe("Free-text quick search"),
      },
      annotations: READ,
    },
    guard(async ({ leadId, email, phone, query }) => {
      const c = lsq();
      if (leadId) return c.getLeadById(leadId);
      if (email) return c.getLeadByEmail(email);
      if (phone) return c.getLeadByPhone(phone);
      if (query) return c.quickSearch(query);
      throw new Error("Provide one of leadId, email, phone or query.");
    }),
  );

  server.registerTool(
    "leadsquared_search_leads",
    {
      title: "Search LeadSquared leads",
      description:
        "Filter leads by one field (e.g. ProspectStage = 'Prospect', OwnerId, Source) with paging and sorting. Use leadsquared_lead_fields to discover field schema names.",
      inputSchema: {
        field: z.string().optional().describe("Schema name to filter on, e.g. ProspectStage"),
        value: z.string().optional(),
        operator: z.string().optional().describe("SQL operator, e.g. '=' or 'like'. Default '='"),
        columns: z.array(z.string()).optional().describe("Schema names to return; default all"),
        sortBy: z.string().optional().describe("Schema name to sort on, e.g. ModifiedOn"),
        sortDesc: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    guard(async (a) =>
      lsq().searchLeads({
        Parameter: a.field ? { LookupName: a.field, LookupValue: a.value, SqlOperator: a.operator ?? "=" } : undefined,
        Columns: a.columns ? { Include_CSV: a.columns.join(",") } : undefined,
        Sorting: a.sortBy ? { ColumnName: a.sortBy, Direction: a.sortDesc ? "1" : "0" } : undefined,
        Paging: { PageIndex: a.page ?? 1, PageSize: a.pageSize ?? 25 },
      }),
    ),
  );

  server.registerTool(
    "leadsquared_lead_fields",
    {
      title: "LeadSquared lead field metadata",
      description: "List lead field schema names, display names, data types and dropdown options.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => lsq().getLeadFields()),
  );

  server.registerTool(
    "leadsquared_create_lead",
    {
      title: "Create LeadSquared lead",
      description: "Create a new lead. Requires at least EmailAddress or Phone. Ask the user to confirm before creating.",
      inputSchema: { fields: attributeSchema },
      annotations: WRITE,
    },
    guard(async ({ fields }) => lsq().createLead(toAttributes(fields))),
  );

  server.registerTool(
    "leadsquared_update_lead",
    {
      title: "Update LeadSquared lead",
      description: "Update fields on an existing lead by LeadId (e.g. ProspectStage, OwnerId, custom mx_ fields). Confirm with the user first.",
      inputSchema: { leadId: z.string(), fields: attributeSchema },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async ({ leadId, fields }) => lsq().updateLead(leadId, toAttributes(fields))),
  );

  server.registerTool(
    "leadsquared_upsert_lead",
    {
      title: "Create or update LeadSquared lead",
      description: "Upsert a lead matched on EmailAddress (default), Phone or ProspectID. Safe for syncing from other systems.",
      inputSchema: {
        fields: attributeSchema,
        matchOn: z.enum(["EmailAddress", "Phone", "ProspectID"]).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async ({ fields, matchOn }) => lsq().createOrUpdateLead(toAttributes(fields), matchOn)),
  );

  server.registerTool(
    "leadsquared_activity_types",
    {
      title: "LeadSquared activity types",
      description: "List activity types and their numeric ActivityEvent codes, needed to post or filter activities.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => lsq().getActivityTypes()),
  );

  server.registerTool(
    "leadsquared_lead_activities",
    {
      title: "LeadSquared lead activity history",
      description: "Activity timeline for a lead (calls, emails, notes, custom activities). 25 per page.",
      inputSchema: {
        leadId: z.string(),
        activityEvent: z.number().int().optional().describe("Filter to one ActivityEvent code"),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    guard(async (a) => lsq().getLeadActivities(a.leadId, { activityEvent: a.activityEvent, pageIndex: a.page, pageSize: a.pageSize })),
  );

  server.registerTool(
    "leadsquared_log_activity",
    {
      title: "Log LeadSquared activity",
      description:
        "Post an activity (call note, meeting summary, custom activity) on a lead. Get the ActivityEvent code from leadsquared_activity_types. Confirm with the user first.",
      inputSchema: {
        leadId: z.string(),
        activityEvent: z.number().int(),
        note: z.string().optional(),
        dateTime: z.string().optional().describe("yyyy-MM-dd HH:mm:ss in the account timezone; default now"),
        fields: z.array(z.object({ SchemaName: z.string(), Value: z.string() })).optional(),
      },
      annotations: WRITE,
    },
    guard(async (a) => lsq().createActivity(a)),
  );

  server.registerTool(
    "leadsquared_list_tasks",
    {
      title: "List LeadSquared tasks",
      description: "Tasks (follow-ups, calls, meetings) optionally filtered by owner, lead, status or due-date window.",
      inputSchema: {
        field: z.string().optional().describe("e.g. OwnerId, RelatedEntityId, StatusCode"),
        value: z.string().optional(),
        fromDate: z.string().optional().describe("yyyy-MM-dd HH:mm:ss"),
        toDate: z.string().optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    guard(async (a) =>
      lsq().listTasks({
        Parameter: { LookupName: a.field, LookupValue: a.value, FromDate: a.fromDate, ToDate: a.toDate },
        Paging: { PageIndex: a.page ?? 1, PageSize: a.pageSize ?? 25 },
      }),
    ),
  );

  server.registerTool(
    "leadsquared_create_task",
    {
      title: "Create LeadSquared task",
      description: "Create a follow-up task on a lead. Confirm with the user first.",
      inputSchema: {
        leadId: z.string(),
        name: z.string(),
        dueDate: z.string().describe("yyyy-MM-dd HH:mm:ss"),
        description: z.string().optional(),
        ownerUserId: z.string().optional(),
        taskTypeName: z.string().optional(),
      },
      annotations: WRITE,
    },
    guard(async (a) => lsq().createTask(a)),
  );

  server.registerTool(
    "leadsquared_complete_task",
    {
      title: "Complete LeadSquared task",
      description: "Mark a task as completed.",
      inputSchema: { taskId: z.string() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async ({ taskId }) => lsq().completeTask(taskId)),
  );

  server.registerTool(
    "leadsquared_users",
    {
      title: "LeadSquared users",
      description: "List users (owners) with their ids, for assigning leads and tasks.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => lsq().listUsers()),
  );

  // ---------------- Zipteams (push in, read stored callbacks) ----------------
  const agentSchema = z.object({ id: z.string().describe("Your internal agent id"), email: z.string().describe("Agent email exactly as they exist and are Active on Zipteams") });

  server.registerTool(
    "zipteams_sync_call",
    {
      title: "Send a call recording to Zipteams for AI analysis",
      description:
        "Push one or more completed calls (public recording URL + agent + customer) to Zipteams. Zipteams transcribes and analyses asynchronously and posts the result to this server's webhook; read it later with zipteams_call_insights. call.id must be unique per call. Confirm with the user first.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              callId: z.string(),
              recordingUrl: z.string().url().describe("Publicly reachable MP3/WAV/AAC/M4A/MP4 URL"),
              startTime: z.string().describe("ISO 8601 with timezone, e.g. 2026-07-28T14:45:00+05:30"),
              endTime: z.string().optional().describe("ISO 8601 with timezone. Required with Partner API credentials; ignored otherwise"),
              phone: z.string().optional().describe("Customer phone; required with Partner credentials, else required unless customerEmail given"),
              agent: agentSchema.extend({ name: z.string().optional() }),
              customerId: z.string().optional().describe("Your CRM id, e.g. the LeadSquared ProspectID. Required with Partner credentials. Echoed back in callbacks."),
              customerName: z.string().optional(),
              customerEmail: z.string().optional(),
              dispositionStatus: z.string().optional(),
              customFields: z.array(z.object({ internal_name: z.string(), value: z.string() })).optional(),
              metadata: z.record(z.string(), z.string()).optional(),
              accessType: z.enum(["whitelisted_ip"]).optional(),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: WRITE,
    },
    guard(async ({ calls }) =>
      clients.zipteams.syncCalls(
        calls.map((c) => ({
          call: { id: c.callId, recording_url: c.recordingUrl, start_time: c.startTime, end_time: c.endTime, phone_number: c.phone, access_type: c.accessType },
          agent: c.agent,
          customer: { id: c.customerId, name: c.customerName, email: c.customerEmail, disposition_status: c.dispositionStatus },
          custom_fields: c.customFields,
          metadata: c.metadata,
          callback_url: clients.zipteamsCallbackUrl,
        })),
      ),
    ),
  );

  server.registerTool(
    "zipteams_upsert_customer",
    {
      title: "Create or update a Zipteams customer",
      description: "Create the customer in Zipteams if missing (matched by email/phone), otherwise update status and customer-level custom fields. No call needed. Confirm with the user first.",
      inputSchema: {
        agentEmail: z.string(),
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        dispositionStatus: z.string().optional(),
        customFields: z.array(z.object({ field_name: z.string(), value: z.string() })).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async (a) =>
      clients.zipteams.upsertCustomer({
        agent_email: a.agentEmail,
        name: a.name,
        email: a.email,
        phone_number: a.phone,
        disposition_status: a.dispositionStatus,
        custom_fields: a.customFields,
      }),
    ),
  );

  server.registerTool(
    "zipteams_update_disposition",
    {
      title: "Update a Zipteams customer's disposition status",
      description: "Update status / custom fields on a customer that already exists in Zipteams, without sending a call. With Partner credentials only customerId and dispositionStatus are used. Confirm with the user first.",
      inputSchema: {
        agent: agentSchema,
        phone: z.string().optional(),
        email: z.string().optional(),
        customerId: z.string().optional(),
        name: z.string().optional(),
        dispositionStatus: z.string().optional(),
        customFields: z.array(z.object({ internal_name: z.string(), value: z.string() })).optional(),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async (a) =>
      clients.zipteams.updateDisposition([
        {
          agent: a.agent,
          customer: { id: a.customerId, name: a.name, email: a.email, phone_number: a.phone, disposition_status: a.dispositionStatus },
          custom_fields: a.customFields,
        },
      ]),
    ),
  );

  server.registerTool(
    "zipteams_call_insights",
    {
      title: "Zipteams AI analysis for a call",
      description: "Read the stored Call Summary callback for a call id: intent, scores, chapter summaries, BANT, quality parameters. Returns null if Zipteams has not posted it yet.",
      inputSchema: { callId: z.string() },
      annotations: READ,
    },
    guard(async ({ callId }) => clients.store.getCallSummary(callId)),
  );

  server.registerTool(
    "zipteams_customer_insights",
    {
      title: "Zipteams customer-level insights",
      description: "Latest stored Customer Summary for a contact by phone, email or customer id: intent, BANT, objections, competitors, timeline, talking points.",
      inputSchema: { phone: z.string().optional(), email: z.string().optional(), customerId: z.string().optional() },
      annotations: READ,
    },
    guard(async (q) => {
      if (!q.phone && !q.email && !q.customerId) throw new Error("Provide phone, email or customerId.");
      return clients.store.getCustomerSummary(q);
    }),
  );

  server.registerTool(
    "zipteams_recent_insights",
    {
      title: "Recent Zipteams insights",
      description: "Call and customer summaries received from Zipteams in the last N hours, newest first.",
      inputSchema: { hours: z.number().min(1).max(720).optional().describe("Default 24"), limit: z.number().int().min(1).max(200).optional() },
      annotations: READ,
    },
    guard(async ({ hours, limit }) => {
      const sinceIso = new Date(Date.now() - (hours ?? 24) * 3600_000).toISOString();
      const [calls, customers] = await Promise.all([
        clients.store.listRecentCalls({ sinceIso, limit }),
        clients.store.listRecentCustomers({ sinceIso, limit }),
      ]);
      return { since: sinceIso, calls, customers };
    }),
  );

  // ---------------- Salesa (call transcripts) ----------------
  const phoneList = z.array(z.string()).min(1).describe("Phone numbers in any format; 10-digit Indian numbers get the 91 prefix");

  server.registerTool(
    "salesa_get_transcripts",
    {
      title: "Salesa call transcripts by phone",
      description: "Fetch call transcripts for one or more phone numbers. Defaults to answered calls only.",
      inputSchema: {
        numbers: phoneList,
        callStatus: z.string().optional().describe("Filter, e.g. 'answered'. Omit for all statuses."),
      },
      annotations: READ,
    },
    guard(async ({ numbers, callStatus }) => clients.salesa.searchByNumbers(numbers, callStatus ?? "answered")),
  );

  server.registerTool(
    "salesa_generate_transcripts",
    {
      title: "Salesa: transcribe pending calls",
      description: "Ask Salesa to generate transcripts for calls on these phone numbers that have not been transcribed yet. Then re-run salesa_get_transcripts.",
      inputSchema: { numbers: phoneList },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(async ({ numbers }) => clients.salesa.generateTranscripts(numbers)),
  );

  server.registerTool(
    "lead_call_transcripts",
    {
      title: "Call transcripts for a LeadSquared lead",
      description:
        "Join LeadSquared and Salesa: find the lead by id, email or phone, take its Phone and Mobile numbers, and return its Salesa call transcripts alongside the lead summary. Use this before summarising a lead's calls or logging a call activity.",
      inputSchema: {
        leadId: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        callStatus: z.string().optional(),
      },
      annotations: READ,
    },
    guard(async ({ leadId, email, phone, callStatus }) => {
      const c = lsq();
      const leads = leadId ? await c.getLeadById(leadId) : email ? await c.getLeadByEmail(email) : phone ? await c.getLeadByPhone(phone) : null;
      if (!leads) throw new Error("Provide one of leadId, email or phone.");
      const lead = (leads as Record<string, unknown>[])[0];
      if (!lead) throw new Error("No matching lead in LeadSquared.");
      const numbers = [...new Set([lead.Phone, lead.Mobile, phone].filter((v): v is string => typeof v === "string" && v.trim() !== ""))];
      if (numbers.length === 0) throw new Error("Lead has no Phone or Mobile to look up transcripts with.");
      const transcripts = await clients.salesa.searchByNumbers(numbers, callStatus ?? "answered");
      return {
        lead: {
          ProspectID: lead.ProspectID,
          FirstName: lead.FirstName,
          LastName: lead.LastName,
          EmailAddress: lead.EmailAddress,
          Phone: lead.Phone,
          Mobile: lead.Mobile,
          ProspectStage: lead.ProspectStage,
          OwnerIdName: lead.OwnerIdName,
        },
        numbersQueried: numbers,
        transcripts,
      };
    }),
  );

  // ---------------- Ranking ----------------
  server.registerTool(
    "rank_leads_by_conversion",
    {
      title: "Rank leads by conversion likelihood",
      description:
        "Leads modified in the last N days, filtered to a team (owner emails/ids or a lead field value), scored on stage, LeadSquared lead score, activity recency and count, Salesa answered calls, and Zipteams intent where stored. Returns the ranked list with each signal so the result can be explained. Use leadsquared_users to find owner emails and leadsquared_lead_fields to find a team field.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe("Default 7"),
        ownerEmails: z.array(z.string()).optional(),
        ownerIds: z.array(z.string()).optional(),
        teamField: z.object({ field: z.string(), value: z.string() }).optional(),
        stageWeights: z.record(z.string(), z.number()).optional(),
        excludeStages: z.array(z.string()).optional(),
        candidates: z.number().int().min(1).max(100).optional().describe("Leads to enrich with call and intent signals. Default 30"),
        scanLimit: z.number().int().min(100).max(2000).optional().describe("Max leads scanned. Default 500"),
      },
      annotations: READ,
    },
    guard(async (a) =>
      rankLeads(clients, {
        days: a.days ?? 7,
        ownerEmails: a.ownerEmails,
        ownerIds: a.ownerIds,
        teamField: a.teamField,
        stageWeights: a.stageWeights,
        excludeStages: a.excludeStages,
        candidates: a.candidates ?? 30,
        scanLimit: a.scanLimit ?? 500,
        tzOffsetMinutes: clients.tzOffsetMinutes,
      }),
    ),
  );

  // ---------------- Rundown ----------------
  server.registerTool(
    "daily_rundown",
    {
      title: "Daily rundown across LeadSquared, Zipteams and Salesa",
      description:
        "One call for the morning check: LeadSquared tasks due today and overdue, leads modified in the last 24h, and Zipteams call/customer insights received in the last 24h. Salesa transcripts are per-lead; use lead_call_transcripts for a specific lead. Each section reports its own error instead of failing the whole rundown.",
      inputSchema: {
        ownerUserId: z.string().optional().describe("Restrict tasks to this LeadSquared user id"),
        hours: z.number().min(1).max(168).optional().describe("Look-back window for leads and insights. Default 24"),
      },
      annotations: READ,
    },
    guard(async ({ ownerUserId, hours }) => {
      const windowMs = (hours ?? 24) * 3600_000;
      const now = new Date();
      const sinceIso = new Date(now.getTime() - windowMs).toISOString();
      // LeadSquared date strings are in the account timezone, "yyyy-MM-dd HH:mm:ss".
      const local = (d: Date) => new Date(d.getTime() + clients.tzOffsetMinutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
      const endOfToday = local(now).slice(0, 10) + " 23:59:59";
      const weekAgo = local(new Date(now.getTime() - 7 * 86_400_000)).slice(0, 10) + " 00:00:00";

      const section = async <T,>(fn: () => Promise<T>): Promise<T | { error: string }> => {
        try {
          return await fn();
        } catch (e) {
          return { error: redactUrl(e instanceof Error ? e.message : String(e)) };
        }
      };

      const [tasks, leads, insightsCalls, insightsCustomers] = await Promise.all([
        section(() =>
          lsq().listTasks({
            Parameter: { LookupName: ownerUserId ? "OwnerId" : undefined, LookupValue: ownerUserId, FromDate: weekAgo, ToDate: endOfToday },
            Paging: { PageIndex: 1, PageSize: 100 },
          }),
        ),
        section(async () => {
          const rows = (await lsq().searchLeads({
            Columns: { Include_CSV: "ProspectID,FirstName,LastName,EmailAddress,Phone,Mobile,ProspectStage,OwnerIdName,Source,ModifiedOn,CreatedOn" },
            Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
            Paging: { PageIndex: 1, PageSize: 50 },
          })) as Record<string, unknown>[];
          const cutoff = local(new Date(now.getTime() - windowMs));
          return rows.filter((r) => typeof r.ModifiedOn === "string" && r.ModifiedOn >= cutoff);
        }),
        section(() => clients.store.listRecentCalls({ sinceIso, limit: 100 })),
        section(() => clients.store.listRecentCustomers({ sinceIso, limit: 100 })),
      ]);

      return {
        generatedAt: now.toISOString(),
        window: { since: sinceIso, tasksFrom: weekAgo, tasksTo: endOfToday, timezoneOffsetMinutes: clients.tzOffsetMinutes },
        leadsquared: { tasksDueOrOverdue: tasks, leadsModified: leads },
        zipteams: { calls: insightsCalls, customers: insightsCustomers },
        salesa: "per-lead only: call lead_call_transcripts with a lead id, email or phone",
      };
    }),
  );

  return server;
}

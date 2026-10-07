import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LeadSquaredClient, type LsqAttribute } from "./adapters/leadsquared.js";
import { GenericRestClient } from "./adapters/generic.js";
import { SalesaClient } from "./adapters/salesa.js";
import { ApiError, redactUrl } from "./http.js";
import type { FetchLike } from "./http.js";

export interface Env {
  MCP_AUTH_TOKEN: string;
  LEADSQUARED_HOST: string;
  LEADSQUARED_ACCESS_KEY?: string;
  LEADSQUARED_SECRET_KEY?: string;
  ZIPTEAMS_BASE_URL?: string;
  ZIPTEAMS_API_KEY?: string;
  SALESA_BASE_URL?: string;
  SALESA_API_KEY?: string;
}

export interface Clients {
  leadsquared?: LeadSquaredClient;
  zipteams: GenericRestClient;
  salesa: SalesaClient;
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
    zipteams: new GenericRestClient({
      service: "Zipteams",
      baseUrl: env.ZIPTEAMS_BASE_URL ?? "",
      apiKey: env.ZIPTEAMS_API_KEY,
      fetch: fetchImpl,
    }),
    salesa: new SalesaClient({ baseUrl: env.SALESA_BASE_URL, apiKey: env.SALESA_API_KEY, fetch: fetchImpl }),
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
      zipteams: clients.zipteams.configured ? "configured" : "missing ZIPTEAMS_BASE_URL / ZIPTEAMS_API_KEY",
      salesa: clients.salesa.configured ? "configured" : "missing SALESA_API_KEY",
    })),
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

  // ---------------- Zipteams (generic until API docs arrive) ----------------
  server.registerTool(
    "zipteams_api_request",
    {
      title: "Zipteams raw API request",
      description:
        "Call any Zipteams REST endpoint relative to its configured base URL. Use GET for reads; only use write methods after confirming with the user.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().describe("Path relative to the base URL, e.g. /meetings"),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
      },
      annotations: WRITE,
    },
    guard(async ({ method, path, query, body }) => clients.zipteams.request(method, path, { query, body })),
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

  return server;
}

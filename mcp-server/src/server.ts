import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LeadSquaredClient, type LsqAttribute } from "./adapters/leadsquared.js";
import { GenericRestClient } from "./adapters/generic.js";
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
  salesa: GenericRestClient;
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
    salesa: new GenericRestClient({
      service: "Salesa",
      baseUrl: env.SALESA_BASE_URL ?? "",
      apiKey: env.SALESA_API_KEY,
      fetch: fetchImpl,
    }),
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
      salesa: clients.salesa.configured ? "configured" : "missing SALESA_BASE_URL / SALESA_API_KEY",
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

  // ---------------- Zipteams / Salesa (generic until API docs arrive) ----------------
  for (const [name, client] of [
    ["zipteams", clients.zipteams],
    ["salesa", clients.salesa],
  ] as const) {
    server.registerTool(
      `${name}_api_request`,
      {
        title: `${client.service} raw API request`,
        description:
          `Call any ${client.service} REST endpoint relative to its configured base URL. ` +
          "Use GET for reads; only use write methods after confirming with the user. Typed tools replace this once the API is mapped.",
        inputSchema: {
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().describe("Path relative to the base URL, e.g. /meetings"),
          query: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
        },
        annotations: { ...WRITE, readOnlyHint: false },
      },
      guard(async ({ method, path, query, body }) => client.request(method, path, { query, body })),
    );
  }

  return server;
}

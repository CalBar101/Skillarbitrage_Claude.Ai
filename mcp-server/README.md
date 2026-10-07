# Skillarbitrage sales MCP server

One Model Context Protocol (MCP) server that exposes LeadSquared, Zipteams and Salesa
to Claude as tools. Runs on Cloudflare Workers; add it once as a custom connector in
claude.ai, Claude Desktop, or Claude Code.

## Tools

| Tool | What it does |
| --- | --- |
| `connections_status` | Which services are configured |
| `leadsquared_find_lead` | Lookup by id, email, phone, or quick search |
| `leadsquared_search_leads` | Filter by any field with paging and sorting |
| `leadsquared_lead_fields` | Field schema names and dropdown options |
| `leadsquared_create_lead` / `_update_lead` / `_upsert_lead` | Writes, confirmed with the user first |
| `leadsquared_activity_types` / `_lead_activities` / `_log_activity` | Activity timeline and posting notes or meeting summaries |
| `leadsquared_list_tasks` / `_create_task` / `_complete_task` | Follow-up tasks |
| `leadsquared_users` | Owners for assignment |
| `salesa_get_transcripts` | Call transcripts for one or more phone numbers (answered calls by default) |
| `salesa_generate_transcripts` | Ask Salesa to transcribe pending calls for given phones |
| `lead_call_transcripts` | Join: LeadSquared lead (by id, email or phone) plus its Salesa transcripts |
| `zipteams_sync_call` | Push a call recording + agent + customer to Zipteams for AI analysis (callback lands on this server) |
| `zipteams_upsert_customer` / `zipteams_update_disposition` | Create or update customers and statuses in Zipteams |
| `zipteams_call_insights` / `zipteams_customer_insights` / `zipteams_recent_insights` | Read the AI analysis Zipteams posted back (stored in KV) |
| `daily_rundown` | LeadSquared tasks due/overdue, leads modified in 24h, Zipteams insights in 24h |

## Zipteams credentials

Two styles exist. A single `x-zip-api-key` uses the Customer API. A key + secret + tenant id +
sub-tenant id uses the Partner API (batch call ingestion with required `end_time` and
`customer.id`, disposition update by `customer_id`). Both are issued by Zipteams at onboarding;
they are not in the public docs.

## Zipteams callbacks

Zipteams has no read API. It POSTs `CALL_SUMMARY` and `CUSTOMER_SUMMARY` payloads to
`https://<worker>.workers.dev/webhooks/zipteams/<ZIPTEAMS_WEBHOOK_SECRET>`. Call summaries
arrive automatically for calls sent with `zipteams_sync_call`. Customer summaries must be
enabled by Zipteams support for the same URL. Payloads are stored in the `INSIGHTS` KV namespace.

## Deploy

```bash
cd mcp-server
npm install
npm run typecheck && npm test

# Secrets (never committed). Generate the auth token with: openssl rand -hex 32
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put LEADSQUARED_ACCESS_KEY
npx wrangler secret put LEADSQUARED_SECRET_KEY
npx wrangler secret put ZIPTEAMS_API_KEY
# Partner API credentials only (all three switch the client to Partner endpoints):
npx wrangler secret put ZIPTEAMS_API_SECRET
npx wrangler secret put ZIPTEAMS_TENANT_ID
npx wrangler secret put ZIPTEAMS_SUB_TENANT_ID
npx wrangler secret put ZIPTEAMS_WEBHOOK_SECRET   # openssl rand -hex 24
npx wrangler secret put SALESA_API_KEY

# Region host and base URLs live in wrangler.jsonc "vars".
npx wrangler deploy
```

## Connect Claude

The endpoint is `https://<worker>.workers.dev/mcp`. Authenticate either way:

- **Claude Code**: `claude mcp add --transport http sales https://<worker>.workers.dev/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`
- **claude.ai / Claude Desktop custom connector** (no header support): use the URL
  `https://<worker>.workers.dev/mcp/<MCP_AUTH_TOKEN>`. Treat that URL as a password.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                       # http://localhost:8787/mcp
```

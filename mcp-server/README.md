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
| `zipteams_api_request` / `salesa_api_request` | Raw REST calls until those APIs are mapped to typed tools |

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

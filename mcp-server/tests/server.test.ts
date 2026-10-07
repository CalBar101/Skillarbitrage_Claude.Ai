import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { buildClients, createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryKV } from "../src/store.js";

const env = {
  MCP_AUTH_TOKEN: "test-token",
  LEADSQUARED_HOST: "api.leadsquared.com",
  LEADSQUARED_ACCESS_KEY: "ak",
  LEADSQUARED_SECRET_KEY: "sk",
  SALESA_API_KEY: "salesa-key",
  ZIPTEAMS_API_KEY: "zip-key",
  ZIPTEAMS_WEBHOOK_SECRET: "hook-secret",
  PUBLIC_BASE_URL: "http://worker.test",
  INSIGHTS: new MemoryKV(),
};

// Route fetch() from the MCP client into the worker; everything else is a stubbed LeadSquared.
const calls: { url: string; init?: RequestInit }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("http://worker.test")) return worker.fetch(new Request(input, init), env as never);
  calls.push({ url, init });
  if (url.includes("Leads.GetByEmailaddress"))
    return new Response(JSON.stringify([{ ProspectID: "123", FirstName: "Asha" }]), { headers: { "content-type": "application/json" } });
  if (url.includes("Leads.Get?") || url.includes("Leads.Get&")) {
    const body = JSON.parse(String(init?.body));
    if (body.Paging?.PageIndex > 1) return new Response("[]");
    const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 330 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const all = [
      { ProspectID: "A", FirstName: "Hot", Phone: "+91-7805955245", ProspectStage: "Follow Up For Closure", Score: "60", OwnerId: "U1", OwnerIdEmailAddress: "elite1@x.com", ModifiedOn: day(0.5), mx_Zip_Intent_Type: "HIGH", mx_Zip_Intent_Score: "80", mx_Lead_category: "Hot" },
      { ProspectID: "B", FirstName: "Warm", Phone: "9213579137", ProspectStage: "Call Back Later", Score: "20", OwnerId: "U1", OwnerIdEmailAddress: "elite1@x.com", ModifiedOn: day(2) },
      { ProspectID: "C", FirstName: "Other", Phone: "9000000000", ProspectStage: "Follow Up For Closure", Score: "90", OwnerId: "U2", OwnerIdEmailAddress: "someone@x.com", ModifiedOn: day(1) },
      { ProspectID: "D", FirstName: "Won", Phone: "9111111111", ProspectStage: "Course Enrolled", Score: "99", OwnerId: "U1", OwnerIdEmailAddress: "elite1@x.com", ModifiedOn: day(1) },
      { ProspectID: "E", FirstName: "Old", Phone: "9222222222", ProspectStage: "Follow Up For Closure", Score: "99", OwnerId: "U1", OwnerIdEmailAddress: "elite1@x.com", ModifiedOn: day(9) },
    ];
    const owner = body.Parameter?.LookupName === "OwnerId" ? body.Parameter.LookupValue : null;
    return new Response(JSON.stringify(owner ? all.filter((l) => l.OwnerId === owner) : all));
  }
  if (url.includes("ProspectActivity.svc/Retrieve"))
    return new Response(JSON.stringify({ RecordCount: url.includes("leadId=A") ? 6 : 1, ProspectActivities: url.includes("leadId=A") ? [1, 2, 3, 4, 5, 6] : [1] }));
  if (url.includes("Users.Get"))
    return new Response(JSON.stringify([{ ID: "U1", FirstName: "Elite", LastName: "One", EmailAddress: "elite1@x.com" }, { ID: "U2", FirstName: "Some", LastName: "One", EmailAddress: "someone@x.com" }]));
  if (url.includes("RetrieveLeadByPhoneNumber"))
    return new Response(JSON.stringify([{ ProspectID: "77", FirstName: "Ravi", Phone: "+91-7805955245", Mobile: "9213579137" }]));
  if (url.includes("search-by-numbers-v1"))
    return new Response(JSON.stringify({
      "917805955245": { sales_call: [
        { caller_id: "91917805955245", start_time: "2026-10-01T10:00:00.000Z", call_duration: 41, agent_name: "A", s3_audio_file_url: "https://x/1.mp3", transcript: { text: "hello" } },
        { caller_id: "91917805955245", start_time: "2026-10-03T10:00:00.000Z", call_duration: 474, agent_name: "B", s3_audio_file_url: "https://x/2.mp3", transcript: { text: "again " + "x".repeat(5000) } },
      ] },
      "919213579137": { sales_call: [{ start_time: "2026-10-02T10:00:00.000Z", transcript: { text: "hi" } }] },
    }));
  if (url.includes("calls-webhook-ingestion-handler")) return new Response(JSON.stringify({ message: "Data Received Successfully" }));
  if (url.includes("/partner/ingest/")) return new Response(JSON.stringify({ success: true }));
  if (url.includes("Lead.Update")) return new Response(JSON.stringify({ Status: "Success", Message: { AffectedRows: 1 } }));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

test("rejects a bad token", async () => {
  const res = await worker.fetch(new Request("http://worker.test/mcp/wrong", { method: "POST" }), env as never);
  assert.equal(res.status, 401);
});

test("lists tools and calls LeadSquared through the MCP transport", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "leadsquared_find_lead"));
  assert.ok(tools.some((t) => t.name === "zipteams_sync_call"));
  assert.ok(tools.some((t) => t.name === "daily_rundown"));

  const found = await client.callTool({ name: "leadsquared_find_lead", arguments: { email: "a@x.com" } });
  const text = (found.content as { text: string }[])[0].text;
  assert.match(text, /Asha/);
  const lsqCall = calls.find((c) => c.url.includes("GetByEmailaddress"))!;
  assert.match(lsqCall.url, /accessKey=ak&secretKey=sk/);

  const upd = await client.callTool({ name: "leadsquared_update_lead", arguments: { leadId: "123", fields: { ProspectStage: "Customer" } } });
  assert.equal(upd.isError, undefined);
  const body = JSON.parse(String(calls.find((c) => c.url.includes("Lead.Update"))!.init!.body));
  assert.deepEqual(body, [{ Attribute: "ProspectStage", Value: "Customer" }]);
  await client.close();
});

test("salesa transcripts normalise phones and send the api key header", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({ name: "salesa_get_transcripts", arguments: { numbers: ["+91 78059 55245", "9213579137"] } });
  assert.equal(r.isError, undefined);
  const call = calls.find((c) => c.url.includes("search-by-numbers-v1"))!;
  assert.match(call.url, /numbers=917805955245%2C919213579137&call_status=answered/);
  assert.equal((call.init!.headers as Record<string, string>)["x-api-key"], "salesa-key");
  await client.close();
});

test("lead_call_transcripts joins LeadSquared phone fields to Salesa", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({ name: "lead_call_transcripts", arguments: { phone: "7805955245" } });
  assert.equal(r.isError, undefined, (r.content as { text: string }[])[0].text);
  const out = JSON.parse((r.content as { text: string }[])[0].text);
  assert.equal(out.lead.ProspectID, "77");
  assert.deepEqual(out.numbersQueried, ["+91-7805955245", "9213579137", "7805955245"]);
  assert.equal(out.transcripts.phones["917805955245"], 2);
  assert.equal(out.transcripts.calls[0].agent, "B", "newest first");
  assert.match(out.transcripts.calls[0].transcript, /truncated 1006 chars/);
  await client.close();
});

test("zipteams_sync_call sends E.164 phones, the api key and our callback url", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({
    name: "zipteams_sync_call",
    arguments: {
      calls: [{ callId: "c1", recordingUrl: "https://rec.example/1.mp3", startTime: "2026-10-07T10:00:00+05:30", phone: "7805955245", agent: { id: "A1", email: "rep@x.com" }, customerId: "77", customerEmail: "" }],
    },
  });
  assert.equal(r.isError, undefined, (r.content as { text: string }[])[0].text);
  const call = calls.find((c) => c.url.includes("calls-webhook-ingestion-handler"))!;
  assert.equal((call.init!.headers as Record<string, string>)["x-zip-api-key"], "zip-key");
  const body = JSON.parse(String(call.init!.body));
  assert.equal(body.type, undefined);
  assert.equal(body.data[0].call.phone_number, "+917805955245");
  assert.equal(body.data[0].callback_url, "http://worker.test/webhooks/zipteams/hook-secret");
  assert.equal("email" in body.data[0].customer, false, "empty strings must be dropped");
  await client.close();
});

test("zipteams webhook stores callbacks that tools can read back", async () => {
  const bad = await worker.fetch(new Request("http://worker.test/webhooks/zipteams/nope", { method: "POST", body: "{}" }), env as never);
  assert.equal(bad.status, 401);
  const post = (p: unknown) =>
    worker.fetch(new Request("http://worker.test/webhooks/zipteams/hook-secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }), env as never);
  assert.equal((await post({ type: "CALL_SUMMARY", call_id: "c1", customer_id: "77", intent: "INTERESTED", intent_score: 74, summary: [] })).status, 200);
  assert.equal((await post({ type: "CUSTOMER_SUMMARY", customer_id: "77", phone: "+919213579137", email: "Ravi@X.com", intent: "INTERESTED" })).status, 200);

  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0].text;
  const call = JSON.parse(text(await client.callTool({ name: "zipteams_call_insights", arguments: { callId: "c1" } })));
  assert.equal(call.payload.intent, "INTERESTED");
  const byPhone = JSON.parse(text(await client.callTool({ name: "zipteams_customer_insights", arguments: { phone: "9213579137" } })));
  assert.equal(byPhone.payload.customer_id, "77");
  const byEmail = JSON.parse(text(await client.callTool({ name: "zipteams_customer_insights", arguments: { email: "ravi@x.com" } })));
  assert.equal(byEmail.payload.customer_id, "77");
  const recent = JSON.parse(text(await client.callTool({ name: "zipteams_recent_insights", arguments: { hours: 1 } })));
  assert.equal(recent.calls.length, 1);
  assert.equal(recent.customers.length, 1);
  const rundown = await client.callTool({ name: "daily_rundown", arguments: {} });
  const rd = JSON.parse(text(rundown));
  assert.equal(rd.zipteams.calls.length, 1);
  assert.ok(rd.leadsquared.tasksDueOrOverdue.error, "stubbed LSQ returns 404 for tasks; section must report, not throw");
  await client.close();
});

test("partner credentials switch to the Partner API with UTC times and contact_number", async () => {
  const partnerEnv = { ...env, ZIPTEAMS_API_SECRET: "sec", ZIPTEAMS_TENANT_ID: "t1", ZIPTEAMS_SUB_TENANT_ID: "st1", MCP_AUTH_TOKEN: "partner-token" };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://partner.test")) return worker.fetch(new Request(input, init), partnerEnv as never);
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://partner.test/mcp/partner-token")));
    const status = JSON.parse((await client.callTool({ name: "connections_status", arguments: {} })).content[0].text);
    assert.match(status.zipteams, /partner API/);
    const missing = await client.callTool({
      name: "zipteams_sync_call",
      arguments: { calls: [{ callId: "p1", recordingUrl: "https://rec.example/1.mp3", startTime: "2026-10-07T10:00:00+05:30", phone: "7805955245", agent: { id: "A1", email: "rep@x.com" } }] },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /end_time/);
    const ok = await client.callTool({
      name: "zipteams_sync_call",
      arguments: { calls: [{ callId: "p1", recordingUrl: "https://rec.example/1.mp3", startTime: "2026-10-07T10:00:00+05:30", endTime: "2026-10-07T10:12:00+05:30", phone: "7805955245", customerId: "77", agent: { id: "A1", email: "rep@x.com" } }] },
    });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    const call = calls.find((c) => c.url.includes("/partner/ingest/batch-call"))!;
    const h = call.init!.headers as Record<string, string>;
    assert.deepEqual([h["x-api-key"], h["x-api-secret"], h["x-tenant-id"], h["x-sub-tenant-id"]], ["zip-key", "sec", "t1", "st1"]);
    const body = JSON.parse(String(call.init!.body));
    assert.equal(body.data[0].call.start_time, "2026-10-07T04:30:00Z");
    assert.equal(body.data[0].call.contact_number, "+917805955245");
    assert.equal(body.data[0].callback_url, "http://worker.test/webhooks/zipteams/hook-secret");
    const disp = await client.callTool({ name: "zipteams_update_disposition", arguments: { agent: { id: "A1", email: "rep@x.com" }, customerId: "77", dispositionStatus: "interested" } });
    assert.equal(disp.isError, undefined, disp.content[0].text);
    const put = calls.find((c) => c.url.includes("/partner/ingest/disposition-status"))!;
    assert.equal(put.init!.method, "PUT");
    assert.deepEqual(JSON.parse(String(put.init!.body)), { customer_id: "77", disposition_status: "interested" });
    // Partner callbacks have no `type`; the webhook must still store them as call summaries.
    const cb = await worker.fetch(new Request("http://worker.test/webhooks/zipteams/hook-secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ call_id: "p1", intent: "INTERESTED" }) }), partnerEnv as never);
    assert.equal(cb.status, 200);
    const stored = JSON.parse((await client.callTool({ name: "zipteams_call_insights", arguments: { callId: "p1" } })).content[0].text);
    assert.equal(stored.payload.intent, "INTERESTED");
    await client.close();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("rank_leads_by_conversion filters by owner, window and stage, and enriches with calls, activities and intent", async () => {
  await worker.fetch(new Request("http://worker.test/webhooks/zipteams/hook-secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "CUSTOMER_SUMMARY", customer_id: "B", phone: "+919213579137", intent: "INTERESTED", intent_score: 80 }) }), env as never);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({ name: "rank_leads_by_conversion", arguments: { days: 7, ownerEmails: ["Elite1@x.com"] } });
  assert.equal(r.isError, undefined, (r.content as { text: string }[])[0].text);
  const out = JSON.parse((r.content as { text: string }[])[0].text);
  const ids = out.leads.map((l: { ProspectID: string }) => l.ProspectID);
  assert.deepEqual(ids.sort(), ["A", "B"], "C is another owner, D is a Customer, E is outside the window");
  const A = out.leads.find((l: { ProspectID: string }) => l.ProspectID === "A");
  const B = out.leads.find((l: { ProspectID: string }) => l.ProspectID === "B");
  assert.equal(A.signals.salesaAnsweredCalls, 2);
  assert.equal(A.signals.activitiesRecent, 6);
  assert.equal(A.signals.zipIntentTypeW, 20, "HIGH from LeadSquared field");
  assert.equal(A.signals.zipIntentScoreW, 12);
  assert.equal(A.signals.leadCategoryW, 10);
  assert.equal(B.signals.zipteamsIntent, "INTERESTED", "webhook intent used only when LeadSquared has none");
  assert.ok(B.signals.zipteamsIntentScoreW === 16);
  assert.ok(A.score > B.score);
  assert.equal(out.owners.U1, "Elite One");
  assert.ok(typeof out.scoring === "string");
  await client.close();
});

test("unconfigured services report cleanly instead of throwing", async () => {
  const server = createServer(buildClients({ MCP_AUTH_TOKEN: "x", LEADSQUARED_HOST: "" }));
  assert.ok(server);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({ name: "salesa_generate_transcripts", arguments: { numbers: ["1"] } });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0].text, /Salesa API error 404/);
  await client.close();
});

test.after(() => { globalThis.fetch = realFetch; });

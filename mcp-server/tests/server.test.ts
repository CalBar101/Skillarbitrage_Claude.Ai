import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { buildClients, createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = {
  MCP_AUTH_TOKEN: "test-token",
  LEADSQUARED_HOST: "api.leadsquared.com",
  LEADSQUARED_ACCESS_KEY: "ak",
  LEADSQUARED_SECRET_KEY: "sk",
  SALESA_API_KEY: "salesa-key",
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
  if (url.includes("RetrieveLeadByPhoneNumber"))
    return new Response(JSON.stringify([{ ProspectID: "77", FirstName: "Ravi", Phone: "+91-7805955245", Mobile: "9213579137" }]));
  if (url.includes("search-by-numbers-v1"))
    return new Response(JSON.stringify({ data: [{ phone: "917805955245", transcript: "hello" }] }));
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
  assert.ok(tools.some((t) => t.name === "zipteams_api_request"));

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
  assert.equal(out.transcripts.data[0].transcript, "hello");
  await client.close();
});

test("unconfigured services report cleanly instead of throwing", async () => {
  const server = createServer(buildClients({ MCP_AUTH_TOKEN: "x", LEADSQUARED_HOST: "" }));
  assert.ok(server);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp/test-token")));
  const r = await client.callTool({ name: "zipteams_api_request", arguments: { method: "GET", path: "/meetings" } });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0].text, /not configured/);
  await client.close();
});

test.after(() => { globalThis.fetch = realFetch; });

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildClients, createServer, type Env } from "./server.js";
import type { CallSummary, CustomerSummary } from "./store.js";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  // crypto.subtle.timingSafeEqual exists on Workers; fall back to constant-time loop elsewhere.
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(ab.buffer as ArrayBuffer, bb.buffer as ArrayBuffer);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Token may come as `Authorization: Bearer <t>` (Claude Code, Desktop) or as the URL path `/mcp/<t>` (claude.ai custom connector). */
function extractToken(req: Request): { token: string | null; pathOk: boolean } {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp") return { token: null, pathOk: false };
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return { token: auth.slice(7).trim(), pathOk: true };
  return { token: parts[1] ?? null, pathOk: true };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "skillarbitrage-mcp", endpoint: "/mcp" });
    }
    // Zipteams callbacks: POST /webhooks/zipteams/<ZIPTEAMS_WEBHOOK_SECRET>
    const hook = url.pathname.match(/^\/webhooks\/zipteams\/([^/]+)$/);
    if (hook) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.ZIPTEAMS_WEBHOOK_SECRET || !timingSafeEqual(decodeURIComponent(hook[1]), env.ZIPTEAMS_WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      let payload: Record<string, unknown>;
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const { store } = buildClients(env);
      // Customer API callbacks carry type=CALL_SUMMARY; Partner API callbacks carry call_id with no type.
      if ((payload.type === "CALL_SUMMARY" || payload.type === undefined) && typeof payload.call_id === "string") {
        payload.type = "CALL_SUMMARY";
        await store.saveCallSummary(payload as unknown as CallSummary);
      } else if (payload.type === "CUSTOMER_SUMMARY") {
        await store.saveCustomerSummary(payload as unknown as CustomerSummary);
      } else {
        return Response.json({ ok: false, ignored: true, reason: "unknown type" });
      }
      return Response.json({ ok: true });
    }

    const { token, pathOk } = extractToken(req);
    if (!pathOk) return new Response("Not found", { status: 404 });
    if (!env.MCP_AUTH_TOKEN) return new Response("Server misconfigured: MCP_AUTH_TOKEN not set", { status: 500 });
    if (!token || !timingSafeEqual(token, env.MCP_AUTH_TOKEN)) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }

    // Stateless: a fresh server + transport per request, no session ids. Works on Workers without Durable Objects.
    const server = createServer(buildClients(env));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  },
} satisfies ExportedHandler<Env>;

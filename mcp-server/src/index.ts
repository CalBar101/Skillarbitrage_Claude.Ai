import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildClients, createServer, type Env } from "./server.js";

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

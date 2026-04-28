import 'dotenv/config';
import serverlessHttp from "serverless-http";
import express from "express";
import jwt from "jsonwebtoken";
import { getStore } from "@netlify/blobs";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNiftyClient } from "../../src/services/niftyClient.js";
import { registerProjectTools } from "../../src/tools/projects.js";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { registerMilestoneTools } from "../../src/tools/milestones.js";
import { registerTimelogTools } from "../../src/tools/timelogs.js";

const BASE_URL = process.env.URL || "https://niftypm-mcp.netlify.app";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

const NIFTY_CLIENT_ID = "eBbgVL4fc1KASs9Do5SdZho5iNKRP1wJ";
const NIFTY_SCOPES = "file,doc,message,project,task,member,label,milestone,task_group,subtask,subteam,time_tracking";
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

function getSessionStore() {
  return getStore({
    name: "oauth-sessions",
    siteID: process.env.NETLIFY_SITE_ID!,
    token: process.env.NETLIFY_TOKEN!,
  });
}

function buildMcpServer(niftyToken: string): McpServer {
  const server = new McpServer({ name: "nifty-mcp-server", version: "1.0.0" });
  const getClient = () => createNiftyClient(niftyToken);
  registerProjectTools(server, getClient);
  registerTaskTools(server, getClient);
  registerMilestoneTools(server, getClient);
  registerTimelogTools(server, getClient);
  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Protected Resource Metadata (RFC9728) ────────────────────────────────────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [`${BASE_URL}`],
  });
});

// ── OAuth discovery (RFC8414) ─────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ── Dynamic Client Registration (RFC7591) ────────────────────────────────────
app.post("/register", (req, res) => {
  console.log("register body:", JSON.stringify(req.body));
  res.status(201).json({
    client_id: "mcp-client",
    client_secret_expires_at: 0,
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// ── Step 1: Save claude's redirect_uri+state in Netlify Blobs, redirect to Nifty ─
// Nifty's registered redirect_uri is fixed — we can't embed data in the path.
// Nifty also truncates the state param so we can't use it either.
// Solution: store {redirect_uri, state} server-side keyed by a random ID,
// pass the ID as Nifty's state param (short, survives round-trip).
app.get("/authorize", async (req, res) => {
  let { redirect_uri, state } = req.query as Record<string, string>;
  console.log("authorize query:", JSON.stringify(req.query));

  // Claude sometimes omits redirect_uri — fall back to the registered callback
  if (!redirect_uri) {
    redirect_uri = "https://claude.ai/api/mcp/auth_callback";
  }

  const sessionId = randomBytes(8).toString("hex"); // 16 chars — short enough for Nifty

  try {
    const store = getSessionStore();
    await store.set(sessionId, JSON.stringify({ redirect_uri: redirect_uri || "", state: state || "" }));
  } catch (err: any) {
    console.error("Blobs write error:", err?.message);
    res.status(500).send(`Failed to create session: ${err?.message}`);
    return;
  }

  const niftyAuthUrl = new URL("https://vgts.nifty.pm/authorize");
  niftyAuthUrl.searchParams.set("response_type", "code");
  niftyAuthUrl.searchParams.set("client_id", NIFTY_CLIENT_ID);
  niftyAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  niftyAuthUrl.searchParams.set("scope", NIFTY_SCOPES);
  niftyAuthUrl.searchParams.set("state", sessionId);

  res.redirect(niftyAuthUrl.toString());
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok" });
});

// ── Step 2: Nifty redirects here with ?code=&state=<sessionId> ───────────────
// Look up claude's redirect_uri + state from Netlify Blobs, wrap the Nifty
// code in a short-lived JWT, redirect back to Claude.
app.get("/oauth/callback", async (req, res) => {
  const { code: niftyCode, state: sessionId, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`Nifty OAuth error: ${error}${error_description ? " — " + error_description : ""}`);
    return;
  }

  if (!sessionId) {
    res.status(400).send("Authorization failed: missing state/session ID.");
    return;
  }

  if (!niftyCode) {
    res.status(400).send("Authorization failed: missing code from Nifty.");
    return;
  }

  let session: { redirect_uri: string; state: string } | null = null;
  try {
    const store = getSessionStore();
    const raw = await store.get(sessionId, { type: "text" });
    session = raw ? JSON.parse(raw) : null;
    if (session) await store.delete(sessionId); // one-time use
  } catch (err: any) {
    res.status(500).send(`Session lookup error: ${err?.message}`);
    return;
  }

  if (!session?.redirect_uri) {
    res.status(400).send(`Authorization failed: session not found or expired (id: ${sessionId})`);
    return;
  }

  console.log("session:", JSON.stringify(session));

  // Nifty's code IS the access token — wrap it in a short-lived JWT for Claude
  const code = jwt.sign({ niftyToken: niftyCode }, JWT_SECRET, { expiresIn: "5m" });
  const url = new URL(session.redirect_uri);
  url.searchParams.set("code", code);
  // state is required by Claude — always include it
  url.searchParams.set("state", session.state || "");
  res.redirect(url.toString());
});

// ── Step 3: Claude exchanges our code for a long-lived access token ──────────
app.post("/token", (req, res) => {
  const body = typeof req.body === "string"
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body;
  const { code, grant_type } = body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  let niftyToken: string;
  try {
    const payload = jwt.verify(code, JWT_SECRET) as { niftyToken: string };
    niftyToken = payload.niftyToken;
  } catch {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code is invalid or expired" });
  }

  const accessToken = jwt.sign({ niftyToken }, JWT_SECRET, { expiresIn: "30d" });
  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 30 * 24 * 60 * 60,
  });
});

// ── MCP GET: discovery/auth challenge ────────────────────────────────────────
app.get("/mcp", (_req, res) => {
  res
    .set("WWW-Authenticate", `Bearer realm="${BASE_URL}", resource_metadata_url="${BASE_URL}/.well-known/oauth-protected-resource"`)
    .status(401)
    .json({ error: "unauthorized" });
});

const expressHandler = serverlessHttp(app);

// ── Main handler: MCP POST bypasses serverless-http to avoid buffering issues ─
export const handler = async (event: any, context: any) => {
  const path = event.path || event.rawPath || "";
  const method = event.httpMethod || event.requestContext?.http?.method || "";

  if (path === "/mcp" && method === "POST") {
    const wwwAuth = `Bearer realm="${BASE_URL}", resource_metadata_url="${BASE_URL}/.well-known/oauth-protected-resource"`;
    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return { statusCode: 401, headers: { "WWW-Authenticate": wwwAuth, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Missing bearer token" }) };
    }

    let niftyToken: string;
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { niftyToken: string };
      niftyToken = payload.niftyToken;
    } catch {
      return { statusCode: 401, headers: { "WWW-Authenticate": wwwAuth, "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid or expired token" }) };
    }

    try {
      const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : "{}";
      const parsedBody = JSON.parse(body);

      const mcpServer = buildMcpServer(niftyToken);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);

      const responseBody = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const mockRes: any = {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(k: string, v: string) { this.headers[k] = v; },
          getHeader(k: string) { return this.headers[k]; },
          write(chunk: any) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
          end(chunk?: any) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            resolve(Buffer.concat(chunks).toString());
          },
          on() { return this; },
          once() { return this; },
          emit() { return this; },
        };
        transport.handleRequest({ headers: event.headers || {}, method: "POST", body: parsedBody } as any, mockRes, parsedBody)
          .catch(reject);
      });

      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: responseBody };
    } catch (err: any) {
      console.error("MCP handler error:", err?.message, err?.stack);
      return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "internal_error", message: err?.message }) };
    }
  }

  return expressHandler(event, context);
};

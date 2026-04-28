import 'dotenv/config';
import serverlessHttp from "serverless-http";
import express from "express";
import jwt from "jsonwebtoken";
import { createHmac } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNiftyClient } from "../../src/services/niftyClient.js";
import { registerProjectTools } from "../../src/tools/projects.js";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { registerMilestoneTools } from "../../src/tools/milestones.js";
import { registerTimelogTools } from "../../src/tools/timelogs.js";

const BASE_URL = process.env.URL || "https://niftypm-mcp.netlify.app";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";

const NIFTY_CLIENT_ID = "rfXF4Z8Y51U0RF6BBTrU0cTTM4DCX9un";
const NIFTY_SCOPES = "file,doc,message,project,task,member,label,milestone,task_group,subtask,subteam,time_tracking";
const REDIRECT_URI = `${BASE_URL}/oauth/callback`;

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
app.post("/register", (_req, res) => {
  res.status(201).json({
    client_id: "mcp-client",
    client_secret_expires_at: 0,
    redirect_uris: [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// ── Step 1: Store claude's redirect_uri+state in Netlify Blobs, send to Nifty ─
// Nifty does not round-trip the state param reliably, and only accepts the
// pre-registered redirect_uri. We store the payload server-side and pass a
// random short ID as state — Nifty will echo it back unchanged.
// Pack claude's redirect_uri + state into a compact signed token for Nifty's state param.
// Format: base64url(payload).<hmac-signature>
function packState(redirect_uri: string, state: string): string {
  const payload = Buffer.from(JSON.stringify({ r: redirect_uri, s: state })).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(payload).digest("base64url").slice(0, 16);
  return `${payload}.${sig}`;
}

function unpackState(packed: string): { redirect_uri: string; state: string } | null {
  try {
    const dot = packed.lastIndexOf(".");
    const payload = packed.slice(0, dot);
    const sig = packed.slice(dot + 1);
    const expectedSig = createHmac("sha256", JWT_SECRET).update(payload).digest("base64url").slice(0, 16);
    if (sig !== expectedSig) return null;
    const { r, s } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return { redirect_uri: r, state: s };
  } catch {
    return null;
  }
}

app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;

  const niftyState = packState(redirect_uri || "", state || "");

  const niftyAuthUrl = new URL("https://nifty.pm/authorize");
  niftyAuthUrl.searchParams.set("response_type", "code");
  niftyAuthUrl.searchParams.set("client_id", NIFTY_CLIENT_ID);
  niftyAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  niftyAuthUrl.searchParams.set("scope", NIFTY_SCOPES);
  niftyAuthUrl.searchParams.set("state", niftyState);

  res.redirect(niftyAuthUrl.toString());
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok" });
});

// ── Step 2: Nifty redirects here with ?code=&state=<sessionId> ───────────────
// Look up claude's redirect_uri + state from Netlify Blobs using the session ID,
// wrap the Nifty token in a short-lived code JWT, redirect back to Claude.
app.get("/oauth/callback", (req, res) => {
  const { code: niftyToken, state: packedState, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`Nifty OAuth error: ${error}${error_description ? " — " + error_description : ""}`);
    return;
  }

  if (!packedState) {
    res.status(400).send("Authorization failed: missing state.");
    return;
  }

  const session = unpackState(packedState);
  if (!session?.redirect_uri) {
    res.status(400).send("Authorization failed: invalid or tampered state.");
    return;
  }

  if (!niftyToken) {
    res.status(400).send("Authorization failed: missing code from Nifty.");
    return;
  }

  const code = jwt.sign({ niftyToken }, JWT_SECRET, { expiresIn: "5m" });
  const url = new URL(session.redirect_uri);
  url.searchParams.set("code", code);
  if (session.state) url.searchParams.set("state", session.state);
  res.redirect(url.toString());
});

// ── Step 3: Claude exchanges our code for a long-lived JWT ───────────────────
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

// ── MCP endpoint ──────────────────────────────────────────────────────────────
app.use("/mcp", (req, _res, next) => {
  req.headers["accept"] = "application/json, text/event-stream";
  next();
});

app.get("/mcp", (_req, res) => {
  res
    .set("WWW-Authenticate", `Bearer realm="${BASE_URL}", resource_metadata_url="${BASE_URL}/.well-known/oauth-protected-resource"`)
    .status(401)
    .json({ error: "unauthorized" });
});

app.post("/mcp", async (req, res) => {
  const authHeader = req.headers["authorization"];
  const wwwAuth = `Bearer realm="${BASE_URL}", resource_metadata_url="${BASE_URL}/.well-known/oauth-protected-resource"`;

  if (!authHeader?.startsWith("Bearer ")) {
    res.set("WWW-Authenticate", wwwAuth).status(401).json({ error: "Missing bearer token" });
    return;
  }

  let niftyToken: string;
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { niftyToken: string };
    niftyToken = payload.niftyToken;
  } catch {
    res.set("WWW-Authenticate", wwwAuth).status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const mcpServer = buildMcpServer(niftyToken);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

export const handler = serverlessHttp(app);

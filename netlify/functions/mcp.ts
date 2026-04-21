import 'dotenv/config';
import serverlessHttp from "serverless-http";
import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
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
const NIFTY_CLIENT_SECRET = process.env.NIFTY_CLIENT_SECRET!;
const NIFTY_TOKEN_URL = "https://openapi.niftypm.com/oauth/token";
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

// ── Protected Resource Metadata (RFC9728) — Claude.ai checks this first ───────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [`${BASE_URL}`],
  });
});

// ── OAuth discovery (RFC8414) ─────────────────────────────────────────────────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
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

// ── Dynamic Client Registration (RFC7591) — auto-approve all clients ─────────
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

// ── Step 1: Redirect to Nifty's real OAuth authorize page ────────────────────
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;

  const stateToken = jwt.sign(
    { claudeRedirectUri: redirect_uri, claudeState: state },
    JWT_SECRET,
    { expiresIn: "10m" }
  );

  const niftyAuthUrl = new URL("https://nifty.pm/authorize");
  niftyAuthUrl.searchParams.set("response_type", "code");
  niftyAuthUrl.searchParams.set("client_id", NIFTY_CLIENT_ID);
  niftyAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  niftyAuthUrl.searchParams.set("scope", NIFTY_SCOPES);
  niftyAuthUrl.searchParams.set("state", stateToken);

  res.redirect(niftyAuthUrl.toString());
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok" });
});

// ── Step 2: Nifty redirects here after user approves ─────────────────────────
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.status(400).send(`Authorization failed: ${error || "missing code or state"}`);
  }

  // Decode Claude's original redirect_uri + state from our signed JWT
  let claudeRedirectUri: string;
  let claudeState: string;
  try {
    const payload = jwt.verify(state, JWT_SECRET) as { claudeRedirectUri: string; claudeState: string };
    claudeRedirectUri = payload.claudeRedirectUri;
    claudeState = payload.claudeState;
  } catch (err) {
    return res.status(400).send("Invalid or expired state token");
  }

  // Exchange Nifty's code for a Nifty access token
  let niftyAccessToken: string;
  try {
    const response = await axios.post(NIFTY_TOKEN_URL, new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: NIFTY_CLIENT_ID,
      client_secret: NIFTY_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

    niftyAccessToken = response.data.access_token;
  } catch (err: any) {
    console.error("Nifty token exchange failed:", err?.response?.data || err.message);
    return res.status(500).send(`Failed to exchange token with Nifty: ${JSON.stringify(err?.response?.data)}`);
  }

  // Issue a short-lived code JWT containing the Nifty token — Claude.ai will exchange this next
  const ourCode = jwt.sign({ niftyToken: niftyAccessToken }, JWT_SECRET, { expiresIn: "5m" });

  const callbackUrl = new URL(claudeRedirectUri);
  callbackUrl.searchParams.set("code", ourCode);
  if (claudeState) callbackUrl.searchParams.set("state", claudeState);

  res.redirect(callbackUrl.toString());
});

// ── Step 3: Claude.ai exchanges our code for a long-lived JWT ────────────────
app.post("/token", (req, res) => {
  const { code, grant_type } = req.body;

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

  // Issue a long-lived access token wrapping the Nifty token
  const accessToken = jwt.sign({ niftyToken }, JWT_SECRET, { expiresIn: "30d" });

  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 30 * 24 * 60 * 60,
  });
});


// ── MCP endpoint ─────────────────────────────────────────────────────────────
app.use("/mcp", (req, _res, next) => {
  req.headers["accept"] = "application/json, text/event-stream";
  next();
});

// GET /mcp — Claude.ai probes this first; return 401 with WWW-Authenticate so it
// knows where to do OAuth before attempting to connect
app.get("/mcp", (_req, res) => {
  res
    .set("WWW-Authenticate", `Bearer realm="${BASE_URL}", resource_metadata_url="${BASE_URL}/.well-known/oauth-protected-resource"`)
    .status(401)
    .json({ error: "unauthorized", resource_metadata_url: `${BASE_URL}/.well-known/oauth-authorization-server` });
});

// POST requires a valid JWT
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

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

// In-memory store: auth_code → nifty_access_token (cleared after use)
const pendingCodes = new Map<string, string>();

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

// ── OAuth discovery ───────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ── Step 1: Redirect to Nifty's real OAuth authorize page ─────────────────────
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;

  // Store Claude's redirect_uri + state in a short-lived param passed through Nifty's state
  const proxyState = Buffer.from(JSON.stringify({ redirect_uri, state, code_challenge, code_challenge_method })).toString("base64url");

  const niftyAuthUrl = new URL("https://nifty.pm/authorize");
  niftyAuthUrl.searchParams.set("response_type", "code");
  niftyAuthUrl.searchParams.set("client_id", NIFTY_CLIENT_ID);
  niftyAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  niftyAuthUrl.searchParams.set("scope", NIFTY_SCOPES);
  niftyAuthUrl.searchParams.set("state", proxyState);

  res.redirect(niftyAuthUrl.toString());
});

// ── Step 2: Nifty redirects here after user approves ─────────────────────────
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.status(400).send(`Authorization failed: ${error || "missing code"}`);
  }

  let claudeRedirectUri: string;
  let claudeState: string;

  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    claudeRedirectUri = parsed.redirect_uri;
    claudeState = parsed.state;
  } catch {
    return res.status(400).send("Invalid state parameter");
  }

  // Exchange Nifty code for Nifty access token
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
    return res.status(500).send("Failed to exchange token with Nifty");
  }

  // Issue our own short-lived code that maps to the Nifty token
  const ourCode = crypto.randomUUID();
  pendingCodes.set(ourCode, niftyAccessToken);
  setTimeout(() => pendingCodes.delete(ourCode), 5 * 60 * 1000); // expire in 5 min

  // Redirect back to Claude.ai with our code
  const callbackUrl = new URL(claudeRedirectUri);
  callbackUrl.searchParams.set("code", ourCode);
  if (claudeState) callbackUrl.searchParams.set("state", claudeState);

  res.redirect(callbackUrl.toString());
});

// ── Step 3: Claude.ai exchanges our code for a JWT ───────────────────────────
app.post("/oauth/token", (req, res) => {
  const { code, grant_type } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const niftyToken = pendingCodes.get(code);
  if (!niftyToken) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code not found or expired" });
  }

  pendingCodes.delete(code);

  // Wrap the Nifty token in a JWT — Claude.ai sends this on every /mcp request
  const accessToken = jwt.sign({ niftyToken }, JWT_SECRET, { expiresIn: "30d" });

  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 30 * 24 * 60 * 60,
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok" });
});

// ── MCP endpoint ─────────────────────────────────────────────────────────────
app.use("/mcp", (req, res, next) => {
  req.headers["accept"] = "application/json, text/event-stream";
  next();
});

// GET is public — Claude.ai checks this before it has a token
app.get("/mcp", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok" });
});

// POST requires a valid JWT
app.post("/mcp", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  let niftyToken: string;
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { niftyToken: string };
    niftyToken = payload.niftyToken;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
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

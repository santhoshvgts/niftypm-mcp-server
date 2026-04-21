import 'dotenv/config';
import serverlessHttp from "serverless-http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNiftyClient } from "../../src/services/niftyClient.js";
import { registerProjectTools } from "../../src/tools/projects.js";
import { registerTaskTools } from "../../src/tools/tasks.js";
import { registerMilestoneTools } from "../../src/tools/milestones.js";
import { registerTimelogTools } from "../../src/tools/timelogs.js";
import { AxiosInstance } from "axios";

const BASE_URL = process.env.URL || "https://niftypm-mcp.netlify.app";
const NIFTY_API_TOKEN = process.env.NIFTY_API_TOKEN;
let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!NIFTY_API_TOKEN) throw new Error("NIFTY_API_TOKEN is not set");
  if (!client) client = createNiftyClient(NIFTY_API_TOKEN);
  return client;
}

const mcpServer = new McpServer({ name: "nifty-mcp-server", version: "1.0.0" });
registerProjectTools(mcpServer, getClient);
registerTaskTools(mcpServer, getClient);
registerMilestoneTools(mcpServer, getClient);
registerTimelogTools(mcpServer, getClient);

const app = express();
app.use(express.json());

// OAuth discovery — Claude.ai checks this before connecting
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

// OAuth authorize — immediately redirect back with a code
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  const code = "nifty-static-code";
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// OAuth token — exchange code for a static token
app.post("/oauth/token", (_req, res) => {
  res.json({
    access_token: "nifty-static-token",
    token_type: "bearer",
    expires_in: 86400 * 365,
  });
});

// Health check
app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok", token_configured: !!NIFTY_API_TOKEN });
});

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

export const handler = serverlessHttp(app);

import 'dotenv/config';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { AxiosInstance } from "axios";
import { createNiftyClient } from "./services/niftyClient.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerMilestoneTools } from "./tools/milestones.js";
import { registerTimelogTools } from "./tools/timelogs.js";

// ── Token setup ──────────────────────────────────────────────────────────────
const NIFTY_API_TOKEN = process.env.NIFTY_API_TOKEN;

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!NIFTY_API_TOKEN) {
    throw new Error("NIFTY_API_TOKEN environment variable is not set. Please set it before starting the server.");
  }
  if (!client) {
    client = createNiftyClient(NIFTY_API_TOKEN);
  }
  return client;
}

// ── Server setup ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "nifty-mcp-server",
  version: "1.0.0",
});

// Register all tool groups
registerProjectTools(server, getClient);
registerTaskTools(server, getClient);
registerMilestoneTools(server, getClient);
registerTimelogTools(server, getClient);

// ── Transport: HTTP (for Vercel / AWS / remote) ───────────────────────────────
async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get("/", (_req, res) => {
    res.json({
      name: "nifty-mcp-server",
      status: "ok",
      token_configured: !!NIFTY_API_TOKEN,
    });
  });

  // MCP endpoint — stateless, new transport per request
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || "3000");
  app.listen(port, () => {
    console.error(`✅ Nifty MCP server running on http://localhost:${port}/mcp`);
    if (!NIFTY_API_TOKEN) {
      console.error("⚠️  WARNING: NIFTY_API_TOKEN is not set. All tool calls will fail until it is configured.");
    }
  });
}

// ── Transport: stdio (for Claude Desktop / local) ────────────────────────────
async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nifty MCP server running on stdio");
}

// ── Entry point ──────────────────────────────────────────────────────────────
const transport = process.env.TRANSPORT || "http";
if (transport === "stdio") {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}

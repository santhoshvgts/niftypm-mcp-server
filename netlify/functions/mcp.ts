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

app.get("/", (_req, res) => {
  res.json({ name: "nifty-mcp-server", status: "ok", token_configured: !!NIFTY_API_TOKEN });
});

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
